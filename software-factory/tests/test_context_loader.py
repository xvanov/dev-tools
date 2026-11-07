"""compose_context_prelude behavior."""

from __future__ import annotations

from pathlib import Path

from factory.context.loader import compose_context_prelude
from factory.directions.parser import (
    Direction,
    MissingDirection,
    parse_direction_dir,
    resolve_direction_chain,
)


def _seed_repo(repo: Path) -> None:
    (repo / "context").mkdir(parents=True, exist_ok=True)
    (repo / "context" / "modules").mkdir(parents=True, exist_ok=True)
    (repo / "context" / "project.md").write_text("# project\nApp identity here.\n")
    (repo / "context" / "navigation.md").write_text(
        "## When working on auth\n"
        "- context/modules/auth.md\n"
        "\n"
        "## When working on payments\n"
        "- context/modules/payments.md\n"
    )
    (repo / "context" / "modules" / "auth.md").write_text("# auth module\nauth-body\n")
    (repo / "context" / "modules" / "payments.md").write_text("# payments\npayments-body\n")


def test_full_prelude_with_task_scope(tmp_path: Path) -> None:
    _seed_repo(tmp_path)
    out = compose_context_prelude(persona="dev", app_repo_path=tmp_path, task_scope="auth")

    assert "# Context for persona: dev" in out
    assert "## context/project.md" in out
    assert "App identity here." in out
    assert "## context/navigation.md" in out
    assert "When working on auth" in out
    # task-scoped section pulled the auth module file content in
    assert "auth-body" in out
    # the unmatched module is NOT pulled in
    assert "payments-body" not in out


def test_no_task_scope_skips_module_pull(tmp_path: Path) -> None:
    _seed_repo(tmp_path)
    out = compose_context_prelude(persona="dev", app_repo_path=tmp_path, task_scope=None)
    assert "auth-body" not in out
    assert "payments-body" not in out
    assert "## context/project.md" in out


def test_missing_files_returns_no_context_notice(tmp_path: Path) -> None:
    out = compose_context_prelude(persona="onboarder", app_repo_path=tmp_path)
    assert "NO CONTEXT AVAILABLE" in out


def test_task_scope_no_match_falls_through(tmp_path: Path) -> None:
    _seed_repo(tmp_path)
    out = compose_context_prelude(
        persona="dev", app_repo_path=tmp_path, task_scope="something-that-doesnt-exist"
    )
    assert "No navigation sections matched" in out


def test_case_insensitive_task_scope(tmp_path: Path) -> None:
    _seed_repo(tmp_path)
    out = compose_context_prelude(persona="dev", app_repo_path=tmp_path, task_scope="AUTH")
    assert "auth-body" in out


# ─── direction chain prelude tests ──────────────────────────────────────


def _seed_direction(
    root: Path,
    id_slug: str,
    *,
    title: str | None = None,
    body: str = "",
    acceptance: list[str] | None = None,
    parent_direction: str | None = None,
) -> Direction:
    import yaml

    base = root / "apps" / "sacrifice" / "directions" / id_slug
    base.mkdir(parents=True)
    fm: dict[str, object] = {
        "title": title or id_slug.replace("-", " ").title(),
        "type": "feature",
        "priority": "p2",
        "explore": False,
        "created_at": "2025-01-01T00:00:00+00:00",
    }
    if parent_direction:
        fm["parent_direction"] = parent_direction
    ac_lines = ""
    if acceptance is not None:
        ac_lines = "\n".join(f"- [ ] {item}" for item in acceptance)
    md = f"""---
{yaml.safe_dump(fm, sort_keys=False).strip()}
---

# {fm["title"]}

## Why

{body or "Because reasons."}

## Acceptance Criteria

{ac_lines}
"""
    (base / "direction.md").write_text(md, encoding="utf-8")
    return parse_direction_dir("sacrifice", base)


def test_chain_prelude_includes_parent_body(tmp_path: Path) -> None:
    _seed_repo(tmp_path)
    _seed_direction(
        tmp_path, "011-parent", title="Parent direction", body="Parent acceptance content."
    )
    child = _seed_direction(
        tmp_path, "012-iter-on-parent", title="Iteration", parent_direction="011-parent"
    )
    chain = resolve_direction_chain(child, tmp_path)
    assert len(chain) == 2

    out = compose_context_prelude(
        persona="dev",
        app_repo_path=tmp_path,
        direction_chain=chain,
        software_factory_root=tmp_path,
    )
    assert "## Direction chain context" in out
    assert "### Parent direction: 011-parent" in out
    assert "Parent acceptance content" in out


def test_chain_prelude_missing_direction_sentinel(tmp_path: Path) -> None:
    _seed_repo(tmp_path)
    child = _seed_direction(
        tmp_path, "012-iter-on-missing", title="Iteration", parent_direction="999-noexist"
    )
    chain = resolve_direction_chain(child, tmp_path)
    assert len(chain) == 2
    assert isinstance(chain[0], MissingDirection)

    out = compose_context_prelude(
        persona="dev",
        app_repo_path=tmp_path,
        direction_chain=chain,
        software_factory_root=tmp_path,
    )
    assert "### Parent direction: 999-noexist" in out
    assert "_(parent direction not found: 999-noexist)_" in out


def test_no_chain_prelude_when_none_passed(tmp_path: Path) -> None:
    _seed_repo(tmp_path)
    out = compose_context_prelude(persona="dev", app_repo_path=tmp_path)
    assert "Direction chain context" not in out
    assert "## context/project.md" in out


# ─── ancestor-story context via DB ───────────────────────────────────────


def _db_engine(db_path: Path):
    """Return a SQLModel engine and ensure tables exist."""
    from sqlmodel import SQLModel
    from sqlmodel import create_engine as _ce

    # Ensure tables are registered in SQLModel.metadata
    from factory.chain.state_machine import StoryRecord  # noqa: F401
    from factory.directions import schema as _directions_schema  # noqa: F401

    db_path.parent.mkdir(parents=True, exist_ok=True)
    eng = _ce(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    return eng


def _seed_db_with_story(
    db_path: Path,
    *,
    direction_id: str,
    app: str = "sacrifice",
    state: str = "deployed",
    story_file_path: str = "stories/1-test-story.md",
    title: str = "Test Story",
    slug: str = "test-story",
    scope: str = "backend",
) -> None:
    """Insert a StoryRecord directly into the stories table."""
    from sqlmodel import Session

    from factory.chain.state_machine import StoryRecord

    eng = _db_engine(db_path)
    with Session(eng) as session:
        session.add(
            StoryRecord(
                direction_id=direction_id,
                app=app,
                title=title,
                slug=slug,
                scope=scope,
                state=state,
                story_file_path=story_file_path,
            )
        )
        session.commit()


def _seed_story_file(root: Path, app: str, story_file_path: str, content: str = "") -> None:
    full = root / "apps" / app / story_file_path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content or "# Merged story content\n\nStory body here.\n")


def test_db_ancestor_appends_merged_section(tmp_path: Path) -> None:
    """AC5.1: ancestor with deployed story → Merged Story section appended."""
    _seed_repo(tmp_path)
    db = tmp_path / "state" / "factory.db"
    # direction_id in DB is ancestor.id (just "011"), not id_slug ("011-parent")
    _seed_db_with_story(
        db, direction_id="011", state="deployed", story_file_path="stories/1-shipped.md"
    )
    _seed_story_file(
        tmp_path,
        "sacrifice",
        "stories/1-shipped.md",
        "# Shipped story\n\nThis story was deployed.\n",
    )

    _seed_direction(tmp_path, "011-parent", title="Parent", body="Parent body.")
    child = _seed_direction(
        tmp_path,
        "012-iter",
        title="Iteration",
        parent_direction="011-parent",
    )
    chain = resolve_direction_chain(child, tmp_path)

    out = compose_context_prelude(
        persona="dev",
        app_repo_path=tmp_path,
        direction_chain=chain,
        software_factory_root=tmp_path,
        db_path=db,
    )
    assert "## Direction chain context" in out
    assert "### Parent direction: 011-parent" in out
    assert "Parent body" in out
    # The merged story section
    assert "Merged Story / Dev Agent Record" in out
    assert "Shipped story" in out
    assert "This story was deployed" in out


def test_db_ancestor_omits_when_no_deployed_story(tmp_path: Path) -> None:
    """AC5.2: ancestor with no deployed story → no Merged Story section."""
    _seed_repo(tmp_path)
    db = tmp_path / "state" / "factory.db"
    # Story exists but is NOT deployed — direction_id matches ancestor.id ("011")
    _seed_db_with_story(
        db, direction_id="011", state="dev_in_progress", story_file_path="stories/1-wip.md"
    )
    _seed_story_file(
        tmp_path, "sacrifice", "stories/1-wip.md", "# WIP story\n\nNot deployed yet.\n"
    )

    _seed_direction(tmp_path, "011-parent", title="Parent", body="Parent body.")
    child = _seed_direction(
        tmp_path,
        "012-iter",
        title="Iteration",
        parent_direction="011-parent",
    )
    chain = resolve_direction_chain(child, tmp_path)

    out = compose_context_prelude(
        persona="dev",
        app_repo_path=tmp_path,
        direction_chain=chain,
        software_factory_root=tmp_path,
        db_path=db,
    )
    assert "### Parent direction: 011-parent" in out
    assert "Parent body" in out
    # No deployed story → no merged section
    assert "Merged Story / Dev Agent Record" not in out


def test_db_ancestor_omits_when_no_db_path(tmp_path: Path) -> None:
    """AC5.3: no db_path → no DB-backed ancestor-story context."""
    _seed_repo(tmp_path)
    db = tmp_path / "state" / "factory.db"
    _seed_db_with_story(
        db, direction_id="011", state="deployed", story_file_path="stories/1-shipped.md"
    )
    _seed_story_file(
        tmp_path, "sacrifice", "stories/1-shipped.md", "# Shipped story\n\nDeployed.\n"
    )

    _seed_direction(tmp_path, "011-parent", title="Parent", body="Parent body.")
    child = _seed_direction(
        tmp_path,
        "012-iter",
        title="Iteration",
        parent_direction="011-parent",
    )
    chain = resolve_direction_chain(child, tmp_path)

    out = compose_context_prelude(
        persona="dev",
        app_repo_path=tmp_path,
        direction_chain=chain,
        software_factory_root=tmp_path,
        # no db_path
    )
    assert "### Parent direction: 011-parent" in out
    assert "Parent body" in out
    # No db_path → no merged section even though DB has a deployed story
    assert "Merged Story / Dev Agent Record" not in out
    assert "Shipped story" not in out


def test_db_ancestor_omits_when_ancestor_is_missing(tmp_path: Path) -> None:
    """MissingDirection ancestor → no crash, no merged section."""
    _seed_repo(tmp_path)
    db = tmp_path / "state" / "factory.db"
    # MissingDirection has empty id, so "999-noexist" won't match
    _seed_db_with_story(
        db, direction_id="999-noexist", state="deployed", story_file_path="stories/1-orphan.md"
    )

    child = _seed_direction(
        tmp_path,
        "012-iter",
        title="Iteration",
        parent_direction="999-noexist",
    )
    chain = resolve_direction_chain(child, tmp_path)
    assert len(chain) == 2
    assert isinstance(chain[0], MissingDirection)

    out = compose_context_prelude(
        persona="dev",
        app_repo_path=tmp_path,
        direction_chain=chain,
        software_factory_root=tmp_path,
        db_path=db,
    )
    assert "### Parent direction: 999-noexist" in out
    assert "_(parent direction not found: 999-noexist)_" in out
    # Missing direction → no merged section
    assert "Merged Story / Dev Agent Record" not in out


def test_db_ancestor_multiple_deployed_stories(tmp_path: Path) -> None:
    """Multiple deployed stories for one ancestor → all appended."""
    _seed_repo(tmp_path)
    db = tmp_path / "state" / "factory.db"
    _seed_db_with_story(
        db, direction_id="011", state="deployed", story_file_path="stories/1-first.md"
    )
    _seed_db_with_story(
        db,
        direction_id="011",
        state="deployed",
        story_file_path="stories/2-second.md",
        title="Second Story",
        slug="second-story",
    )
    _seed_story_file(
        tmp_path, "sacrifice", "stories/1-first.md", "# First shipped\n\nFirst body.\n"
    )
    _seed_story_file(
        tmp_path, "sacrifice", "stories/2-second.md", "# Second shipped\n\nSecond body.\n"
    )

    _seed_direction(tmp_path, "011-parent", title="Parent", body="Parent body.")
    child = _seed_direction(
        tmp_path,
        "012-iter",
        title="Iteration",
        parent_direction="011-parent",
    )
    chain = resolve_direction_chain(child, tmp_path)

    out = compose_context_prelude(
        persona="dev",
        app_repo_path=tmp_path,
        direction_chain=chain,
        software_factory_root=tmp_path,
        db_path=db,
    )
    assert "Merged Story / Dev Agent Record" in out
    assert "First shipped" in out
    assert "Second shipped" in out
