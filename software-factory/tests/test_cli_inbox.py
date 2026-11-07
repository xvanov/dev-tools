"""Tests for ``factory inbox`` CLI command."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlmodel import Session, create_engine, select
from typer.testing import CliRunner

from factory.chain.handlers import persist_story
from factory.chain.orchestrator import _STALE_THRESHOLD_SECONDS
from factory.chain.state_machine import StoryRecord, StoryState


@pytest.fixture
def seeded_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway software-factory root with an apps/sacrifice/ config and
    a few seeded stories + a needs-direction direction."""
    monkeypatch.setenv("FACTORY_WEBHOOK_LAZY", "1")
    # Prevent Rich from truncating table cells under small TTY widths.
    monkeypatch.setenv("COLUMNS", "240")
    monkeypatch.setenv("TERM", "xterm-256color")
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True, exist_ok=True)
    (apps / "config.yaml").write_text(
        "name: sacrifice\nrepo: x/y\ndefault_branch: main\n", encoding="utf-8"
    )

    # Direction in needs-direction status.
    direction = apps / "directions" / "010-vague"
    direction.mkdir(parents=True, exist_ok=True)
    (direction / "direction.md").write_text(
        "---\ntitle: vague thought\n---\n\n# vague\n",
        encoding="utf-8",
    )
    (direction / "state.yaml").write_text(
        "status: needs-direction\nmissing: [user_flow, api_spec]\n",
        encoding="utf-8",
    )

    db = tmp_path / "state" / "factory.db"
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug="story-blocked-by-cap",
            scope="backend",
            state=StoryState.STORY_CREATED.value,
            last_rejection_reason="daily_spend_cap_exceeded",
        ),
        db,
    )
    persist_story(
        StoryRecord(
            direction_id="002",
            app="sacrifice",
            title="t",
            slug="story-in-blocked-state",
            scope="backend",
            state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
        ),
        db,
    )
    return tmp_path


def _seed_in_progress_story(root: Path, *, slug: str, state: str, age_seconds: float) -> None:
    """Seed a ``*_in_progress`` StoryRecord whose ``updated_at`` is
    ``age_seconds`` in the past. ``persist_story`` always stamps
    ``updated_at = now()``, so the desired age is forced via a raw update
    afterwards — same technique ``tests/test_stale_state_recovery.py`` uses."""
    db = root / "state" / "factory.db"
    persist_story(
        StoryRecord(
            direction_id="172",
            app="sacrifice",
            title="t",
            slug=slug,
            scope="backend",
            state=state,
        ),
        db,
    )
    eng = create_engine(f"sqlite:///{db}", echo=False)
    old_ts = (datetime.now(UTC) - timedelta(seconds=age_seconds)).isoformat()
    with Session(eng) as session:
        row = session.exec(select(StoryRecord).where(StoryRecord.slug == slug)).one()
        row.updated_at = old_ts
        session.add(row)
        session.commit()


def _seed_closed_direction_with_open_tracker(root: Path, *, tracker_issue: int = 999) -> None:
    """Seed a ``closed`` DirectionRecord with a tracker issue recorded, so
    the E1 GitHub-tracker-check section has something to look up."""
    from factory.directions.schema import DirectionRecord
    from factory.directions.watcher import _engine as directions_engine

    db = root / "state" / "factory.db"
    eng = directions_engine(db)
    with Session(eng) as session:
        session.add(
            DirectionRecord(
                app="sacrifice",
                direction_id="099",
                slug="099-old-direction",
                status="closed",
                tracker_issue=tracker_issue,
            )
        )
        session.commit()


def _runner_with_root(root: Path) -> tuple[CliRunner, object]:
    """Re-import the CLI module with _FACTORY_ROOT pinned to ``root``."""
    import importlib

    import factory.cli as cli_mod

    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


def test_inbox_lists_rejection_reasons_and_needs_direction(seeded_root: Path) -> None:
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["inbox"])
    assert result.exit_code == 0
    # Stories with rejection / blocked appear:
    assert "story-blocked-by-cap" in result.stdout
    assert "daily_spend_cap_exceeded" in result.stdout
    assert "story-in-blocked-state" in result.stdout
    # needs-direction tracker is listed:
    assert "010-vague" in result.stdout


def test_inbox_app_filter(seeded_root: Path) -> None:
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["inbox", "--app", "sacrifice"])
    assert result.exit_code == 0
    assert "story-blocked-by-cap" in result.stdout


def test_inbox_surfaces_a_gate_block_parked_story(seeded_root: Path) -> None:
    """019 blocker S2: a story parked by ``auto_merge._park_gate_block_exhausted``
    sets ``last_rejection_reason``, and MUST reach the inbox despite
    ``blocked_ci_unresolved`` sitting on the tracker-closer's resolved-states
    allowlist — that allowlist is correct for the real-CI-failure park (which
    closes the PR), not for a gate-block park that leaves the PR open."""
    db = seeded_root / "state" / "factory.db"
    persist_story(
        StoryRecord(
            direction_id="019",
            app="sacrifice",
            title="t",
            slug="story-gate-block-parked",
            scope="backend",
            state=StoryState.BLOCKED_CI_UNRESOLVED.value,
            last_rejection_reason=(
                "gate_block_exhausted: required gate(s) ['smoke-green'] never "
                "passed after 3 consecutive evaluations of head cafe1234"
            ),
            error="auto-merge: gate_block_exhausted: ...",
        ),
        db,
    )
    # Regression pin: the REAL-CI-FAILURE park (no last_rejection_reason) must
    # stay invisible — that park already closed the PR, so there is nothing
    # left pending, and the tracker-closer / inbox must keep agreeing on that.
    persist_story(
        StoryRecord(
            direction_id="019",
            app="sacrifice",
            title="t",
            slug="story-ci-failure-parked",
            scope="backend",
            state=StoryState.BLOCKED_CI_UNRESOLVED.value,
        ),
        db,
    )

    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["inbox"])
    assert result.exit_code == 0
    assert "story-gate-block-parked" in result.stdout
    assert "gate_block_exhausted" in result.stdout
    assert "story-ci-failure-parked" not in result.stdout


# --------------------------------------------------------------------------- #
# E1 (stall visibility, BENCHMARK-READINESS-PLAN.md): pure-read surfacing of
# stale ``*_in_progress`` stories and terminal directions with a still-open
# GitHub tracker issue, both of which must work with the factory OFF (the
# only prior stale-detector runs inside a tick, so story 172 sat unnoticed
# for 255 minutes with no tick running).
# --------------------------------------------------------------------------- #


def test_inbox_shows_a_stale_in_progress_story(seeded_root: Path) -> None:
    _seed_in_progress_story(
        seeded_root,
        slug="story-stuck-172",
        state=StoryState.DEV_IN_PROGRESS.value,
        age_seconds=_STALE_THRESHOLD_SECONDS + 300,
    )
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["inbox"])
    assert result.exit_code == 0
    assert "story-stuck-172" in result.stdout
    assert "dev_in_progress" in result.stdout


def test_inbox_does_not_show_a_fresh_in_progress_story(seeded_root: Path) -> None:
    """A handler that started 30 seconds ago is still legitimately running —
    it must NOT appear as stale."""
    _seed_in_progress_story(
        seeded_root,
        slug="story-fresh-dev",
        state=StoryState.DEV_IN_PROGRESS.value,
        age_seconds=30,
    )
    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["inbox"])
    assert result.exit_code == 0
    assert "story-fresh-dev" not in result.stdout
    assert "No stale *_in_progress stories." in result.stdout


def test_inbox_tracker_check_error_path_prints_skip_note_not_a_crash(
    seeded_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A GitHub API error while checking a closed direction's tracker issue
    must never crash ``inbox`` — it must print exactly one skip note and
    keep going, never silently omit the section."""
    _seed_closed_direction_with_open_tracker(seeded_root, tracker_issue=999)

    class _ExplodingRepo:
        def get_issue(self, number: int) -> object:
            raise RuntimeError("simulated GitHub API failure")

    class _FakeGithubClient:
        def get_repo(self, name: str) -> _ExplodingRepo:
            return _ExplodingRepo()

    monkeypatch.setattr(
        "factory.providers.github.build_github_client",
        lambda: _FakeGithubClient(),
    )

    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["inbox"])
    assert result.exit_code == 0
    assert "tracker check skipped" in result.stdout
    assert "simulated GitHub API failure" in result.stdout


def test_inbox_tracker_check_reports_open_tracker_on_closed_direction(
    seeded_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The happy path: a closed direction whose tracker issue is still OPEN
    on GitHub must be surfaced, not silently dropped."""
    _seed_closed_direction_with_open_tracker(seeded_root, tracker_issue=42)

    class _FakeIssue:
        state = "open"

    class _FakeRepo:
        def get_issue(self, number: int) -> _FakeIssue:
            assert number == 42
            return _FakeIssue()

    class _FakeGithubClient:
        def get_repo(self, name: str) -> _FakeRepo:
            return _FakeRepo()

    monkeypatch.setattr(
        "factory.providers.github.build_github_client",
        lambda: _FakeGithubClient(),
    )

    runner, cli_mod = _runner_with_root(seeded_root)
    result = runner.invoke(cli_mod.app, ["inbox"])
    assert result.exit_code == 0
    assert "099" in result.stdout
    assert "#42" in result.stdout
    assert "tracker check skipped" not in result.stdout
