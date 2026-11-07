"""Tests for ``factory why`` CLI command."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState


@pytest.fixture
def seeded_root(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True, exist_ok=True)
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: x/y\n", encoding="utf-8")
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    return tmp_path


def _runner_with_root(root: Path) -> tuple[CliRunner, object]:
    import importlib

    import factory.cli as cli_mod

    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


def test_why_reports_rejection_reason(seeded_root: Path) -> None:
    db = seeded_root / "state" / "factory.db"
    story = persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug="stuck-story",
            scope="backend",
            state=StoryState.STORY_CREATED.value,
            last_rejection_reason="daily_spend_cap_exceeded",
        ),
        db,
    )
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["why", str(story.id)])
    assert result.exit_code == 0
    assert "daily_spend_cap_exceeded" in result.stdout
    # Lists next legal transitions for STORY_CREATED.
    assert "sm_started" in result.stdout
    assert "sm_in_progress" in result.stdout


def test_why_accepts_slug(seeded_root: Path) -> None:
    db = seeded_root / "state" / "factory.db"
    persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug="by-slug",
            scope="backend",
            state=StoryState.DEV_RETRY.value,
        ),
        db,
    )
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["why", "by-slug"])
    assert result.exit_code == 0
    assert "dev_retry" in result.stdout


def test_why_projects_would_dispatch_under_normal_mode(seeded_root: Path) -> None:
    """Story in STORY_CREATED under default settings should be 'would dispatch'."""
    db = seeded_root / "state" / "factory.db"
    story = persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug="ready-story",
            scope="backend",
            state=StoryState.STORY_CREATED.value,
        ),
        db,
    )
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["why", str(story.id)])
    assert result.exit_code == 0
    # Output contains the projection line.
    assert "would dispatch" in result.stdout
    assert "job_kind=sm" in result.stdout


def test_why_projects_would_be_blocked_when_paused(seeded_root: Path) -> None:
    """When factory mode is 'paused', the projection is 'would be blocked'."""
    db = seeded_root / "state" / "factory.db"
    story = persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug="paused-story",
            scope="backend",
            state=StoryState.STORY_CREATED.value,
        ),
        db,
    )
    # Flip the mode to paused — set_mode persists in the local state.db.
    from factory.settings.modes import set_mode

    set_mode("paused", seeded_root, db_path=db)

    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["why", str(story.id)])
    assert result.exit_code == 0
    assert "would be blocked" in result.stdout
    assert "mode_paused_blocks_sm" in result.stdout


def test_why_projects_would_be_blocked_terminal_state(seeded_root: Path) -> None:
    """A terminal-from-dispatch state (PR_OPEN) prints 'terminal' projection."""
    db = seeded_root / "state" / "factory.db"
    story = persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug="terminal-story",
            scope="backend",
            state=StoryState.PR_OPEN.value,
        ),
        db,
    )
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["why", str(story.id)])
    assert result.exit_code == 0
    assert "terminal" in result.stdout
