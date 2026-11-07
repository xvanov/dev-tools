"""Direction creator — interactive + programmatic.

Two surfaces:

* ``create_direction(...)`` — pure: takes already-collected fields and writes
  the directory + files. Used by the CLI driver, by tests, and by the GitHub
  issue ingester.

* ``run_interactive(...)`` — Typer/Rich-driven prompt loop, used by
  ``factory new-direction``. Opens ``$EDITOR`` on the final ``direction.md``
  for a review pass before returning.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
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

_ARTIFACTS_DIR = Path(__file__).resolve().parent.parent / "artifacts"


@dataclass
class CreatedDirection:
    """Tuple-ish bundle returned by ``create_direction``: the parsed Direction +
    the absolute directory path on disk."""

    direction: Direction
    dir_path: Path


def _write_initial_state_yaml(dir_path: Path, *, source: str) -> None:
    state = {
        "status": "created",
        "source": source,
        "created_at": datetime.now(UTC).isoformat(),
        "audit": [
            {
                "ts": datetime.now(UTC).isoformat(),
                "by": "factory.directions.creator",
                "event": "created",
                "details": {"source": source},
            }
        ],
    }
    (dir_path / "state.yaml").write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")


def _build_direction_md(
    *,
    title: str,
    type_tag: str | None,
    why: str,
    acceptance: list[str],
    explore: bool,
    priority: str = "p2",
    extra_frontmatter: dict[str, Any] | None = None,
) -> str:
    frontmatter_dict: dict[str, Any] = {
        "title": title,
        "type": type_tag or "",
        "priority": priority,
        "explore": bool(explore),
        "created_at": datetime.now(UTC).isoformat(),
    }
    # Extra keys (e.g. ``factory job submit``'s source/external_id/pipeline/
    # delivery/models) never override the canonical ones above.
    for key, value in (extra_frontmatter or {}).items():
        frontmatter_dict.setdefault(key, value)
    fm_yaml = yaml.safe_dump(frontmatter_dict, sort_keys=False).strip()

    lines: list[str] = []
    # NOTE: frontmatter MUST be the first block — python-frontmatter requires
    # the file to start with `---`. The optional-siblings comment goes after.
    lines.append("---")
    lines.append(fm_yaml)
    lines.append("---")
    lines.append("")
    lines.append(
        "<!-- Optional sibling files: flow.md (user flow), api_spec.md (API "
        "contract), artifacts/ (binaries) -->"
    )
    lines.append("")
    lines.append(f"# {title}")
    lines.append("")
    lines.append("## Why")
    lines.append("")
    lines.append(why.strip() if why else "<!-- one paragraph -->")
    lines.append("")
    lines.append("## Acceptance Criteria")
    lines.append("")
    if acceptance:
        for item in acceptance:
            lines.append(f"- [ ] {item.strip()}")
    else:
        # No placeholder bullets — the parser would treat them as real AC.
        # Leave the section empty so the validator surfaces the gap.
        lines.append("<!-- fill in: one observable criterion per bullet -->")
    lines.append("")
    return "\n".join(lines)


def _build_flow_md(steps: list[str]) -> str:
    lines = ["# User flow", ""]
    if steps:
        for i, s in enumerate(steps, 1):
            lines.append(f"{i}. {s.strip()}")
    else:
        lines.append("<!-- numbered steps; each step is what the user does or sees -->")
    lines.append("")
    return "\n".join(lines)


def _build_api_spec_md(lines_in: list[str]) -> str:
    out = ["# API spec", ""]
    if lines_in:
        out.extend(line.rstrip() for line in lines_in)
    else:
        out.append("<!-- endpoint table or bullets: method, path, body, response, statuses -->")
    out.append("")
    return "\n".join(out)


def create_direction(
    app: str,
    *,
    title: str,
    type_tag: str | None,
    why: str,
    has_ui: bool,
    flow_steps: list[str] | None,
    has_api: bool,
    api_spec_lines: list[str] | None,
    acceptance: list[str],
    explore: bool,
    attach_files: list[Path] | None,
    software_factory_root: Path,
    priority: str = "p2",
    source: str = "cli",
    direction_id: str | None = None,
    slug: str | None = None,
) -> CreatedDirection:
    """Create a direction directory on disk and return the parsed result.

    All inputs are taken as-provided; no interactive prompting happens here.
    """
    root = Path(software_factory_root)
    if not title.strip():
        raise ValueError("title is required")

    use_id = direction_id or next_direction_id(app, root)
    use_slug = slug or slugify(title)
    dir_name = f"{use_id}-{use_slug}"
    dir_path = root / "apps" / app / "directions" / dir_name
    if dir_path.exists():
        raise FileExistsError(f"Direction directory already exists: {dir_path}")
    dir_path.mkdir(parents=True, exist_ok=False)

    try:
        # direction.md
        (dir_path / "direction.md").write_text(
            _build_direction_md(
                title=title,
                type_tag=type_tag,
                why=why,
                acceptance=acceptance,
                explore=explore,
                priority=priority,
            ),
            encoding="utf-8",
        )

        # flow.md
        if has_ui:
            (dir_path / "flow.md").write_text(_build_flow_md(flow_steps or []), encoding="utf-8")

        # api_spec.md
        if has_api:
            (dir_path / "api_spec.md").write_text(
                _build_api_spec_md(api_spec_lines or []), encoding="utf-8"
            )

        # artifacts/
        if attach_files:
            artifacts_dir = dir_path / "artifacts"
            artifacts_dir.mkdir(exist_ok=True)
            for src in attach_files:
                src_path = Path(src)
                if not src_path.exists():
                    # skip silently; the user already saw the prompt confirm them
                    continue
                shutil.copy2(src_path, artifacts_dir / src_path.name)

        # state.yaml
        _write_initial_state_yaml(dir_path, source=source)

        parsed = parse_direction_dir(app, dir_path)
    except Exception:
        # A partial write (ENOSPC, a disk quota, a bad attach_files copy, an
        # unparseable result, ...) must not leave an orphaned directory
        # behind: every subsequent caller-retry would burn a fresh direction
        # ID on the same failure forever, and any dedupe scan that treats a
        # dir with no readable direction.md as untrustworthy (see
        # ``factory.chain.detector_watch._open_detector_signatures``) would
        # then refuse to file ANYTHING for this app until a human notices
        # and removes it by hand. Best-effort cleanup; the ORIGINAL exception
        # is what the caller sees (019 AC7 review round 2, S3).
        shutil.rmtree(dir_path, ignore_errors=True)
        raise
    return CreatedDirection(direction=parsed, dir_path=dir_path)


def _open_in_editor(path: Path) -> None:
    """Open ``path`` in the user's ``$EDITOR``. Best-effort; no exceptions surface.

    If ``$EDITOR`` is unset or missing, the function returns without doing
    anything (the directory has already been written to disk; the user can
    open it manually).
    """
    editor = os.environ.get("EDITOR")
    if not editor:
        return
    import subprocess

    try:
        subprocess.run([editor, str(path)], check=False)
    except FileNotFoundError:
        return


def run_interactive(
    app: str,
    software_factory_root: Path,
    *,
    open_editor: bool = True,
) -> CreatedDirection:
    """Interactive driver. Imported lazily by the CLI so tests don't need typer."""
    import typer
    from rich.console import Console
    from rich.panel import Panel

    console = Console()

    console.print(
        Panel.fit(
            f"[bold]Create direction[/bold] — app=[bold]{app}[/bold]\n"
            "Answer the prompts. Blank line ends multi-line inputs.",
            title="factory new-direction",
        )
    )

    title = typer.prompt("Title")
    while not title.strip():
        console.print("[red]Title is required.[/red]")
        title = typer.prompt("Title")

    valid_types = [
        "feature",
        "bug",
        "security",
        "refactor",
        "deploy",
        "chore",
        "infra",
        "ux",
        "docs",
    ]
    console.print("Types: " + ", ".join(valid_types))
    type_tag = typer.prompt("Type", default="feature")
    while type_tag and type_tag not in valid_types:
        console.print(f"[red]Pick one of:[/red] {', '.join(valid_types)}")
        type_tag = typer.prompt("Type", default="feature")

    console.print("Why does this matter? (one paragraph; single line OK)")
    why = typer.prompt("Why")

    has_ui = typer.confirm("Has UI? (writes flow.md)", default=False)
    flow_steps: list[str] = []
    if has_ui:
        console.print("Enter flow steps one per line. Blank line to finish.")
        while True:
            step = typer.prompt("flow step", default="", show_default=False)
            if not step.strip():
                break
            flow_steps.append(step.strip())

    has_api = typer.confirm("Has API? (writes api_spec.md)", default=False)
    api_lines: list[str] = []
    if has_api:
        console.print(
            "Enter API spec lines (one per line; can be markdown table rows or "
            "bullets). Blank line to finish."
        )
        while True:
            ln = typer.prompt("api line", default="", show_default=False)
            if not ln.strip():
                break
            api_lines.append(ln)

    console.print("Acceptance criteria. One per line, blank to finish.")
    acceptance: list[str] = []
    while True:
        ac = typer.prompt("AC", default="", show_default=False)
        if not ac.strip():
            break
        acceptance.append(ac.strip())

    attach_files: list[Path] = []
    if typer.confirm("Attach files into artifacts/?", default=False):
        console.print("Enter file paths one per line. Blank line to finish.")
        while True:
            f = typer.prompt("file", default="", show_default=False)
            if not f.strip():
                break
            attach_files.append(Path(f.strip()).expanduser())

    explore = typer.confirm("Explore mode? (loosens backpressure rule)", default=False)

    created = create_direction(
        app=app,
        title=title.strip(),
        type_tag=type_tag.strip() or None,
        why=why.strip(),
        has_ui=has_ui,
        flow_steps=flow_steps,
        has_api=has_api,
        api_spec_lines=api_lines,
        acceptance=acceptance,
        explore=explore,
        attach_files=attach_files,
        software_factory_root=software_factory_root,
        source="cli",
    )

    console.print(
        Panel.fit(
            f"Wrote [bold]{created.dir_path}[/bold]\n"
            f"Files:\n" + "\n".join(f"  - {p.name}" for p in sorted(created.dir_path.iterdir())),
            title="created",
            style="green",
        )
    )

    if open_editor:
        _open_in_editor(created.dir_path / "direction.md")

    # Re-parse after potential editor edits.
    final = parse_direction_dir(app, created.dir_path)
    return CreatedDirection(direction=final, dir_path=created.dir_path)
