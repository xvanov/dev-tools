"""Compose the per-persona context prelude.

A *context prelude* is a markdown string prepended to every persona's system
prompt before a real run. It contains the app's current-state truth as the
agent should see it: project identity, navigation index, and any task-scoped
module files.

Phase-0 contract:
  * Always read ``<repo>/context/project.md`` and ``<repo>/context/navigation.md``.
  * If ``task_scope`` is provided, match it (case-insensitive substring) against
    the scope_labels parsed out of navigation.md; concatenate every referenced
    file found on disk.
  * If project.md or navigation.md is missing (e.g. Onboarder runs before
    context exists), return a single ``NO CONTEXT AVAILABLE`` notice — the
    caller's persona prompt should already know what to do in that mode.
  * If ``direction_chain`` is provided, append each ancestor direction's
    ``direction.md`` body and merged story file (oldest first).
  * If ``db_path`` is provided and an ancestor direction has deployed stories,
    append a "Merged Story / Dev Agent Record" section resolved via
    ``stories.direction_id``.
"""

from __future__ import annotations

from pathlib import Path

from factory.chain.state_machine import StoryRecord, StoryState
from factory.context.navigator import parse_navigation
from factory.directions.parser import Direction, MissingDirection

_NO_CONTEXT_NOTICE = (
    "# Context\n"
    "\n"
    "**NO CONTEXT AVAILABLE.**\n"
    "\n"
    "This app repo has no `context/project.md` and/or no `context/navigation.md` "
    "yet. You are likely the Onboarder persona running on a fresh codebase. "
    "Build context from the code itself; populate `context/project.md`, "
    "`context/navigation.md`, and the rest of the canonical context set on this "
    "run. Subsequent personas will rely on what you write here.\n"
)


def _read_text(p: Path) -> str | None:
    try:
        return p.read_text(encoding="utf-8")
    except (FileNotFoundError, IsADirectoryError):
        return None


def _append_merged_story_section(
    parts: list[str],
    ancestor: Direction,
    db_path: Path | None,
    software_factory_root: Path | None,
) -> None:
    """Append "Merged Story / Dev Agent Record" for deployed ancestor stories.

    Only appends when ``db_path`` is provided and at least one deployed story
    exists for the ancestor direction (resolved via ``stories.direction_id``).
    """
    if db_path is None or software_factory_root is None:
        return

    from sqlmodel import Session, create_engine, select

    engine = create_engine(f"sqlite:///{db_path}", echo=False)
    with Session(engine) as session:
        deployed_stories = list(
            session.exec(
                select(StoryRecord).where(
                    StoryRecord.direction_id == ancestor.id,
                    StoryRecord.state == StoryState.DEPLOYED.value,
                )
            )
        )

    if not deployed_stories:
        return

    parts.append("\n### Merged Story / Dev Agent Record\n")
    parts.append(
        "_The following story (deployed from this ancestor direction) "
        "represents prior art. Its acceptance criteria and Dev Agent Record "
        "are relevant context._\n"
    )

    for story in deployed_stories:
        story_content = _read_story_content(story, software_factory_root)
        parts.append(f"\n#### {story.title} (`{story.slug}`)\n")
        parts.append(story_content.rstrip() + "\n")


def _read_story_content(story: StoryRecord, software_factory_root: Path) -> str:
    """Return the story markdown file content, capped, with fallback."""
    if not story.story_file_path:
        return "(no story_file_path on record)"
    story_path = software_factory_root / "apps" / story.app / story.story_file_path
    try:
        content = story_path.read_text(encoding="utf-8")
    except (OSError, FileNotFoundError) as exc:
        return f"(story file unreadable at {story_path}: {exc!r})"
    # Cap at 32KB to avoid bloating the context prelude
    _STORY_CONTENT_CAP = 32 * 1024
    if len(content) > _STORY_CONTENT_CAP:
        content = content[:_STORY_CONTENT_CAP] + "\n...[truncated at 32KB]"
    return content


def compose_context_prelude(
    persona: str,
    app_repo_path: Path,
    task_scope: str | None = None,
    direction_chain: list[Direction | MissingDirection] | None = None,
    software_factory_root: Path | None = None,
    db_path: Path | None = None,
) -> str:
    """Compose the markdown context prelude for ``persona`` against ``app_repo_path``.

    Returns a single string (terminated with one trailing newline) that callers
    prepend to the persona's system prompt.
    """
    repo = Path(app_repo_path)
    project_md = _read_text(repo / "context" / "project.md")
    navigation_md = _read_text(repo / "context" / "navigation.md")

    if project_md is None or navigation_md is None:
        return _NO_CONTEXT_NOTICE

    parts: list[str] = []
    parts.append(f"# Context for persona: {persona}\n")
    parts.append(
        "_The factory composed this prelude. It is current-state truth. "
        "If something here contradicts your priors, the context wins._\n"
    )
    parts.append("\n## context/project.md\n")
    parts.append(project_md.rstrip() + "\n")
    parts.append("\n## context/navigation.md\n")
    parts.append(navigation_md.rstrip() + "\n")

    if direction_chain and len(direction_chain) > 1:
        ancestors = direction_chain[:-1]
        if ancestors:
            parts.append("\n## Direction chain context\n")
            parts.append(
                "_This direction is an iteration. The sections below are the parent "
                "direction(s) that came before it (oldest first). Their acceptance "
                "criteria and deliverables are prior art — NOT optional._\n"
            )
            for ancestor in ancestors:
                if isinstance(ancestor, MissingDirection):
                    parts.append(f"\n### Parent direction: {ancestor.id_slug}\n")
                    parts.append(f"_(parent direction not found: {ancestor.id_slug})_\n")
                else:
                    parts.append(f"\n### Parent direction: {ancestor.id_slug}\n")
                    parts.append(ancestor.raw_body.rstrip() + "\n")
                    _append_merged_story_section(parts, ancestor, db_path, software_factory_root)

    if task_scope:
        sections = parse_navigation(navigation_md)
        scope_lower = task_scope.lower()
        matched_paths: list[str] = []
        seen: set[str] = set()
        for label, paths in sections:
            if scope_lower in label.lower():
                for p in paths:
                    if p not in seen:
                        seen.add(p)
                        matched_paths.append(p)

        if matched_paths:
            parts.append(f"\n## Task scope: {task_scope}\n")
            parts.append("_Files referenced by matching navigation sections:_\n\n")
            for rel in matched_paths:
                target = repo / rel
                content = _read_text(target)
                parts.append(f"### {rel}\n")
                if content is None:
                    parts.append(f"_(file referenced in navigation.md but not found: {rel})_\n")
                else:
                    parts.append(content.rstrip() + "\n")
                parts.append("\n")
        else:
            parts.append(
                f"\n## Task scope: {task_scope}\n"
                f"_No navigation sections matched. Use project.md + navigation.md as guidance._\n"
            )

    return "".join(parts).rstrip() + "\n"
