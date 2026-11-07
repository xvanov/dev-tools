"""Ingest a GitHub issue (labeled ``direction``) into a local direction dir.

Called directly for Phase 1 (via ``factory ingest-issue``). Phase 2's
webhook handler invokes the same function when an ``issues.labeled`` event
arrives with the ``direction`` label.

Body parsing strategy:

* The full issue body is dropped into ``direction.md`` verbatim (so nothing
  the user wrote is lost).
* If the body contains an ``## User flow`` heading, the lines under it (up to
  the next ``## `` heading) are extracted into ``flow.md``.
* If the body contains an ``## API spec`` heading, same for ``api_spec.md``.
* Frontmatter is synthesized from the issue title (``[DIRECTION] X`` → title
  ``X``), labels (``type`` and ``priority``), and the explore tag (``(explore)``
  in the title or body).
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from factory.directions.parser import (
    Direction,
    next_direction_id,
    parse_direction_dir,
    slugify,
)

_TITLE_PREFIX_RE = re.compile(r"^\s*\[DIRECTION\]\s*", re.IGNORECASE)
_EXPLORE_RE = re.compile(r"\(explore\)", re.IGNORECASE)


def _extract_section(body: str, heading: str) -> str | None:
    """Return the text under ``## {heading}`` up to the next ``## `` heading."""
    target = heading.strip().lower()
    lines = body.splitlines()
    collected: list[str] = []
    in_section = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("## "):
            if in_section:
                break
            heading_text = stripped[3:].strip().lower()
            if heading_text == target:
                in_section = True
                continue
        elif stripped.startswith("# ") and in_section:
            break
        if in_section:
            collected.append(line)
    text = "\n".join(collected).strip()
    return text or None


def _parse_priority_from_labels(labels: list[str]) -> str:
    for lbl in labels:
        if lbl.startswith("priority/"):
            return lbl.split("/", 1)[1]
    return "p2"


def _parse_type_from_labels(labels: list[str], valid_types: set[str]) -> str | None:
    for lbl in labels:
        if lbl in valid_types:
            return lbl
    return None


_VALID_TYPES = {
    "feature",
    "bug",
    "security",
    "refactor",
    "deploy",
    "chore",
    "infra",
    "ux",
    "docs",
}


def ingest_github_direction_issue(
    issue_number: int,
    app: str,
    software_factory_root: Path,
    github_client: Any,
    *,
    repo_full_name: str | None = None,
) -> Direction:
    """Fetch a GitHub issue and write the corresponding direction directory.

    ``github_client`` is a ``pygithub.Github`` instance (or duck-type mock).
    ``repo_full_name`` ("owner/name") is required if the client wasn't created
    bound to a specific repo. If omitted, we look it up via
    ``apps/<app>/config.yaml``.
    """
    if repo_full_name is None:
        from factory.app_config import load_app_config

        repo_full_name = load_app_config(app, software_factory_root).repo

    repo = github_client.get_repo(repo_full_name)
    issue = repo.get_issue(issue_number)

    raw_title = str(issue.title or "").strip()
    title = _TITLE_PREFIX_RE.sub("", raw_title).strip() or f"Direction {issue_number}"
    body = str(issue.body or "").strip()

    label_names: list[str] = []
    for lbl in issue.labels or []:
        name = getattr(lbl, "name", None)
        if isinstance(name, str):
            label_names.append(name)

    type_tag = _parse_type_from_labels(label_names, _VALID_TYPES)
    priority = _parse_priority_from_labels(label_names)
    explore = bool(_EXPLORE_RE.search(raw_title) or _EXPLORE_RE.search(body))

    use_id = next_direction_id(app, Path(software_factory_root))
    slug = slugify(title)
    dir_name = f"{use_id}-{slug}"
    dir_path = Path(software_factory_root) / "apps" / app / "directions" / dir_name
    if dir_path.exists():
        raise FileExistsError(f"Direction directory already exists: {dir_path}")
    dir_path.mkdir(parents=True, exist_ok=False)

    # Synthesize frontmatter, prepend to the verbatim issue body. We keep the
    # issue body intact so nothing the user wrote is lost; downstream personas
    # read raw_body, not just structured fields.
    frontmatter_dict: dict[str, Any] = {
        "title": title,
        "type": type_tag or "",
        "priority": priority,
        "explore": explore,
        "created_at": datetime.now(UTC).isoformat(),
        "source_issue": issue_number,
    }
    fm_yaml = yaml.safe_dump(frontmatter_dict, sort_keys=False).strip()
    direction_md_text = "---\n" + fm_yaml + "\n---\n\n" + body + "\n"
    (dir_path / "direction.md").write_text(direction_md_text, encoding="utf-8")

    # Pull out flow.md / api_spec.md if structured sections exist.
    flow_text = _extract_section(body, "User flow")
    if flow_text:
        (dir_path / "flow.md").write_text(
            "# User flow\n\n" + flow_text.rstrip() + "\n", encoding="utf-8"
        )
    api_text = _extract_section(body, "API spec")
    if api_text:
        (dir_path / "api_spec.md").write_text(
            "# API spec\n\n" + api_text.rstrip() + "\n", encoding="utf-8"
        )

    # state.yaml — record provenance.
    state = {
        "status": "created",
        "source": "github_issue",
        "source_issue": issue_number,
        "created_at": datetime.now(UTC).isoformat(),
        "audit": [
            {
                "ts": datetime.now(UTC).isoformat(),
                "by": "factory.directions.ingester",
                "event": "ingested",
                "details": {"issue": issue_number, "repo": repo_full_name},
            }
        ],
    }
    (dir_path / "state.yaml").write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")

    return parse_direction_dir(app, dir_path)
