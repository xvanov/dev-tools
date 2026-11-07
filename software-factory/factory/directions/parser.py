"""Direction directory → ``Direction`` record.

The directory layout (canonical) is::

    apps/<app>/directions/<id>-<slug>/
      direction.md            # required; YAML frontmatter + body
      flow.md                 # optional; user flow
      api_spec.md             # optional; API contract
      artifacts/              # optional; binaries/mockups
      state.yaml              # auto-managed (status, audit trail)

This module is the read-side: parse a directory into a ``Direction`` record
the rest of the factory can pass around. The write-side is ``creator.py``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import frontmatter
import yaml

_SLUG_RE = re.compile(r"^[A-Za-z0-9_\-]+$")
_ID_PREFIX_RE = re.compile(r"^(\d{3,})-(.+)$")


@dataclass
class Direction:
    """Parsed direction record. All fields populated from disk."""

    id: str
    slug: str
    title: str
    type_tag: str | None
    why: str | None
    has_flow: bool
    has_api_spec: bool
    acceptance: list[str]
    explore_tag: bool
    artifacts_paths: list[Path]
    app: str
    status: str
    raw_frontmatter: dict[str, Any]
    raw_body: str
    dir_path: Path = field(default_factory=lambda: Path("."))
    state: dict[str, Any] = field(default_factory=dict)
    parent_direction: str | None = None
    related_directions: list[str] = field(default_factory=list)

    @property
    def id_slug(self) -> str:
        """Return the canonical id-slug string (e.g. ``011-pushup-counter``)."""
        if self.id and self.slug:
            return f"{self.id}-{self.slug}"
        return self.slug or self.id or ""


@dataclass
class MissingDirection:
    """Sentinel returned by ``resolve_direction_chain`` when an ancestor id-slug
    directory doesn't exist on disk."""

    id_slug: str


class DirectionChainCycleError(ValueError):
    """Raised when a direction's ``parent_direction`` chain forms a cycle.

    The ``cycle_path`` attribute lists the id-slugs in the cycle (starting from
    the culprit direction), with the repeated node at the end to show the loop.
    """

    def __init__(self, direction_id_slug: str, cycle_path: list[str]) -> None:
        joined = " → ".join(cycle_path)
        super().__init__(
            f"Direction {direction_id_slug} has a parent_direction chain that "
            f"cycles: {joined}"
        )
        self.cycle_path = cycle_path


def _parse_acceptance(body: str) -> list[str]:
    """Extract bullets under an ``## Acceptance Criteria`` heading.

    Accepts ``- [ ]`` / ``- [x]`` / plain ``- `` bullets. Stops at the next
    heading line.

    A bullet's *continuation lines* — indented text that wraps a criterion
    onto multiple physical lines, as this repo's own directions do (see
    ``019-exteroception-v1-close-the-sensing-gap/direction.md`` AC1) — are
    joined onto the bullet with a single space. A new bullet, a heading, a
    blank line, or an un-indented line terminates the join, so a criterion's
    full text (not just its first line) reaches downstream consumers like the
    vacuity classifier, which needs the whole sentence to tell a bare status
    assertion from a positive-observable one.
    """
    out: list[str] = []
    in_section = False
    accumulating = False
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            if in_section:
                break
            heading_text = stripped.lstrip("#").strip().lower()
            if heading_text.startswith("acceptance criteria") or heading_text == "acceptance":
                in_section = True
            accumulating = False
            continue
        if not in_section:
            continue
        m = re.match(r"^[-*]\s*(?:\[[ xX]\]\s*)?(.+)$", stripped)
        if m:
            text = m.group(1).strip()
            if text:
                out.append(text)
                accumulating = True
            else:
                accumulating = False
            continue
        is_indented = line[:1] in (" ", "\t")
        if accumulating and stripped and is_indented:
            out[-1] = f"{out[-1]} {stripped}"
            continue
        # Blank line, un-indented text, or anything else that isn't a
        # continuation: the current bullet is closed.
        accumulating = False
    return out


def _parse_why(body: str) -> str | None:
    """Extract the prose under an ``## Why`` heading (case-insensitive)."""
    in_section = False
    collected: list[str] = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            if in_section:
                break
            heading_text = stripped.lstrip("#").strip().lower()
            if heading_text == "why":
                in_section = True
            continue
        if in_section:
            if stripped.startswith("<!--"):
                continue
            collected.append(line)
    text = "\n".join(collected).strip()
    return text or None


def parse_direction_dir(
    app: str,
    dir_path: Path,
    *,
    software_factory_root: Path | None = None,
) -> Direction:
    """Read a direction directory from disk and return a ``Direction`` record.

    Robust to missing optional files. Raises ``FileNotFoundError`` if
    ``direction.md`` itself is missing. If ``software_factory_root`` is
    provided, performs a chain-cycle check on ``parent_direction`` links.
    """
    dir_path = Path(dir_path)
    direction_md = dir_path / "direction.md"
    if not direction_md.exists():
        raise FileNotFoundError(f"direction.md missing in {dir_path}")

    # ID + slug from the directory name (e.g. "001-add-healthz-endpoint")
    name = dir_path.name
    m = _ID_PREFIX_RE.match(name)
    if m:
        id_ = m.group(1)
        slug = m.group(2)
    else:
        # Tolerate ungrouped names — id becomes ""
        id_ = ""
        slug = name

    post = frontmatter.load(str(direction_md))
    raw_frontmatter: dict[str, Any] = dict(post.metadata or {})
    raw_body = post.content or ""

    title = str(raw_frontmatter.get("title") or "").strip()
    if not title:
        # Fall back to the first ``# heading`` line in the body
        for line in raw_body.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
    if not title:
        title = slug.replace("-", " ").title()

    type_tag_raw = raw_frontmatter.get("type")
    type_tag = str(type_tag_raw).strip() if type_tag_raw not in (None, "") else None

    explore_tag = bool(raw_frontmatter.get("explore"))

    flow_path = dir_path / "flow.md"
    has_flow = flow_path.exists() and flow_path.stat().st_size > 0

    api_spec_path = dir_path / "api_spec.md"
    has_api_spec = api_spec_path.exists() and api_spec_path.stat().st_size > 0

    artifacts_dir = dir_path / "artifacts"
    artifacts_paths: list[Path] = []
    if artifacts_dir.is_dir():
        artifacts_paths = sorted(p for p in artifacts_dir.iterdir() if p.is_file())

    state_path = dir_path / "state.yaml"
    state: dict[str, Any] = {}
    status = "created"
    if state_path.exists():
        try:
            loaded = yaml.safe_load(state_path.read_text(encoding="utf-8")) or {}
            if isinstance(loaded, dict):
                state = loaded
                if "status" in state and isinstance(state["status"], str):
                    status = state["status"]
        except yaml.YAMLError:
            # Corrupt state.yaml: keep defaults so the watcher can re-process
            state = {}

    parent_direction_raw = raw_frontmatter.get("parent_direction")
    parent_direction: str | None = None
    if isinstance(parent_direction_raw, str) and parent_direction_raw.strip():
        parent_direction = parent_direction_raw.strip()

    related_directions_raw = raw_frontmatter.get("related_directions", [])
    related_directions: list[str] = []
    if isinstance(related_directions_raw, list):
        related_directions = [str(r).strip() for r in related_directions_raw if str(r).strip()]

    direction = Direction(
        id=id_,
        slug=slug,
        title=title,
        type_tag=type_tag,
        why=_parse_why(raw_body),
        has_flow=has_flow,
        has_api_spec=has_api_spec,
        acceptance=_parse_acceptance(raw_body),
        explore_tag=explore_tag,
        artifacts_paths=artifacts_paths,
        app=app,
        status=status,
        raw_frontmatter=raw_frontmatter,
        raw_body=raw_body,
        dir_path=dir_path,
        state=state,
        parent_direction=parent_direction,
        related_directions=related_directions,
    )

    if parent_direction is not None:
        _validate_chain_self_reference(direction)
        if software_factory_root is not None:
            _check_chain_cycle(direction, software_factory_root)

    return direction


def next_direction_id(app: str, software_factory_root: Path) -> str:
    """Return the next zero-padded numeric id for a new direction.

    Scans ``<root>/apps/<app>/directions/`` for the highest ``NNN-`` prefix
    and returns ``NNN+1`` zero-padded to width 3 (or wider, if existing ids
    already exceed 3 digits).
    """
    directions_dir = Path(software_factory_root) / "apps" / app / "directions"
    if not directions_dir.exists():
        return "001"
    max_id = 0
    width = 3
    for entry in directions_dir.iterdir():
        if not entry.is_dir():
            continue
        m = _ID_PREFIX_RE.match(entry.name)
        if not m:
            continue
        try:
            n = int(m.group(1))
        except ValueError:
            continue
        if n > max_id:
            max_id = n
        if len(m.group(1)) > width:
            width = len(m.group(1))
    return str(max_id + 1).zfill(width)


def list_direction_dirs(app: str, software_factory_root: Path) -> list[Path]:
    """Return all direction directories for ``app``, sorted by id."""
    directions_dir = Path(software_factory_root) / "apps" / app / "directions"
    if not directions_dir.exists():
        return []
    entries = [
        p
        for p in directions_dir.iterdir()
        if p.is_dir() and (p / "direction.md").exists() and _ID_PREFIX_RE.match(p.name)
    ]
    entries.sort(key=lambda p: p.name)
    return entries


def slugify(text: str) -> str:
    """Lowercase, hyphenate, drop non-alphanumerics. Caps at 60 chars."""
    s = re.sub(r"[^A-Za-z0-9]+", "-", text.strip().lower()).strip("-")
    if not s:
        s = "untitled"
    return s[:60].strip("-") or "untitled"


def validate_slug(slug: str) -> bool:
    """Slug must match ``[A-Za-z0-9_\\-]+``."""
    return bool(_SLUG_RE.match(slug))


def get_direction_chain(
    direction: Direction,
    software_factory_root: Path,
) -> list[Direction | MissingDirection] | None:
    """Resolve the direction chain for ``direction``, returning ``None`` when
    no ``parent_direction`` is set (avoids a useless single-element list)."""
    if not direction.parent_direction:
        return None
    return resolve_direction_chain(direction, software_factory_root)


def _validate_chain_self_reference(direction: Direction) -> None:
    """Reject a direction whose ``parent_direction`` points at itself."""
    if direction.parent_direction == direction.id_slug:
        raise ValueError(
            f"Direction {direction.id_slug} has parent_direction pointing to itself. "
            f"Self-referential chains are not allowed."
        )


def _check_chain_cycle(direction: Direction, software_factory_root: Path) -> None:
    """Raise ``DirectionChainCycleError`` if the direction's parent chain forms a cycle."""
    path: list[str] = [direction.id_slug]
    seen: set[str] = {direction.id_slug}
    current_id_slug = direction.parent_direction
    while current_id_slug is not None:
        if current_id_slug in seen:
            path.append(current_id_slug)
            raise DirectionChainCycleError(direction.id_slug, path)
        seen.add(current_id_slug)
        path.append(current_id_slug)
        parent_dir = _find_direction_dir(current_id_slug, software_factory_root)
        if parent_dir is None:
            break
        parent_direction = _read_parent_from_dir(parent_dir)
        current_id_slug = parent_direction


def _find_direction_dir(id_slug: str, software_factory_root: Path) -> Path | None:
    """Find a direction directory by id-slug anywhere under
    ``<root>/apps/*/directions/``. Returns the first match or ``None``."""
    apps_dir = software_factory_root / "apps"
    if not apps_dir.exists():
        return None
    for app_dir in apps_dir.iterdir():
        if not app_dir.is_dir():
            continue
        candidate = app_dir / "directions" / id_slug
        if candidate.is_dir() and (candidate / "direction.md").exists():
            return candidate
    return None


def _read_parent_from_dir(dir_path: Path) -> str | None:
    """Read the ``parent_direction`` frontmatter field from a direction directory
    without constructing a full ``Direction`` record."""
    direction_md = dir_path / "direction.md"
    if not direction_md.exists():
        return None
    post = frontmatter.load(str(direction_md))
    raw_frontmatter: dict[str, Any] = dict(post.metadata or {})
    raw = raw_frontmatter.get("parent_direction")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return None


def resolve_direction_chain(
    direction: Direction,
    software_factory_root: Path,
) -> list[Direction | MissingDirection]:
    """Walk ``parent_direction`` links recursively and return the chain from
    oldest ancestor to ``direction`` (inclusive), capped at depth 8.

    Returns a list of ``Direction`` records (ancestors + current) and/or
    ``MissingDirection`` sentinels for unparseable or missing directories.
    """
    chain: list[Direction | MissingDirection] = []
    visited: set[str] = set()
    current_ref = direction.parent_direction

    while current_ref is not None:
        if current_ref in visited:
            break
        visited.add(current_ref)

        if len(chain) >= 8:
            break

        parent_dir = _find_direction_dir(current_ref, software_factory_root)
        if parent_dir is None:
            chain.append(MissingDirection(id_slug=current_ref))
            break

        try:
            parent = parse_direction_dir(direction.app, parent_dir)
        except (FileNotFoundError, ValueError):
            chain.append(MissingDirection(id_slug=current_ref))
            break

        chain.append(parent)
        current_ref = parent.parent_direction

    chain.reverse()
    chain.append(direction)
    return chain
