"""Tests for ``factory.chain.orchestrator._resolve_job_kind`` and the
fix-only mode integration with bug-typed directions."""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.chain.handlers import persist_story
from factory.chain.orchestrator import _resolve_job_kind, tick
from factory.chain.state_machine import StoryRecord, StoryState
from factory.directions.parser import Direction


def _fake_direction(*, type_tag: str | None) -> Direction:
    return Direction(
        id="002",
        slug="my-dir",
        title="t",
        type_tag=type_tag,
        why=None,
        has_flow=False,
        has_api_spec=False,
        acceptance=[],
        explore_tag=False,
        artifacts_paths=[],
        app="sacrifice",
        status="created",
        raw_frontmatter={},
        raw_body="",
    )


def _fake_story(*, scope: str = "backend") -> StoryRecord:
    return StoryRecord(
        direction_id="002",
        app="sacrifice",
        title="t",
        slug="s",
        scope=scope,
        state=StoryState.STORY_CREATED.value,
    )


# --- pure helper coverage ------------------------------------------------- #


def test_resolve_job_kind_bug_direction_appends_suffix() -> None:
    story = _fake_story()
    direction = _fake_direction(type_tag="bug")
    assert _resolve_job_kind(story, direction, "dev") == "dev-bug"
    assert _resolve_job_kind(story, direction, "review") == "review-bug"
    assert _resolve_job_kind(story, direction, "sm") == "sm-bug"


def test_resolve_job_kind_feature_direction_no_suffix() -> None:
    story = _fake_story()
    direction = _fake_direction(type_tag="feature")
    assert _resolve_job_kind(story, direction, "dev") == "dev"
    assert _resolve_job_kind(story, direction, "review") == "review"


def test_resolve_job_kind_unknown_direction_no_suffix() -> None:
    """A missing direction (rare) must not suffix — feature path is the safe
    default. Lets the enforcer's normal mode rules drive."""
    story = _fake_story()
    assert _resolve_job_kind(story, None, "dev") == "dev"


def test_resolve_job_kind_bug_scope_appends_suffix() -> None:
    """Even when the direction is missing/feature-typed, a bug-scoped story
    still routes as a bug fix. Lets scheduled-persona-filed bug stories
    route correctly."""
    story = _fake_story(scope="bug")
    direction = _fake_direction(type_tag="feature")
    assert _resolve_job_kind(story, direction, "dev") == "dev-bug"


def test_resolve_job_kind_passthrough_for_non_bug_aware_kinds() -> None:
    """Handler kinds without a bug variant (tech_writer, docs_enforcer)
    pass through unchanged so the enforcer's normal mode rules apply."""
    story = _fake_story()
    direction = _fake_direction(type_tag="bug")
    assert _resolve_job_kind(story, direction, "tech_writer") == "tech_writer"
    assert _resolve_job_kind(story, direction, "docs_enforcer") == "docs_enforcer"


# --- integration: fix-only mode + bug direction --------------------------- #


@pytest.fixture
def factory_root_with_bug_direction(tmp_path: Path) -> Path:
    """Set up a factory root with a single bug-typed direction and a story
    parked in STORY_CREATED so the orchestrator will attempt to dispatch ``sm``.
    """
    apps = tmp_path / "apps" / "sacrifice"
    (apps / "directions" / "002-fix-broken-button").mkdir(parents=True)
    (apps / "directions" / "002-fix-broken-button" / "direction.md").write_text(
        "---\ntitle: fix-broken-button\ntype: bug\n---\n\n## Why\n\nit's broken\n",
        encoding="utf-8",
    )
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: x/y\n", encoding="utf-8")
    (tmp_path / "factory_settings.yaml").write_text(
        "caps:\n  global_concurrent_agents: 5\n  per_repo_concurrent_agents: 5\n"
        "  daily_spend_usd: 100\n  hourly_spend_usd: 20\n"
        "modes:\n  default: normal\n  available: [normal, fix-only, paused]\n",
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir()
    return tmp_path


@pytest.fixture
def factory_root_with_feature_direction(tmp_path: Path) -> Path:
    """Same shape but with a feature-typed direction."""
    apps = tmp_path / "apps" / "sacrifice"
    (apps / "directions" / "002-add-healthz").mkdir(parents=True)
    (apps / "directions" / "002-add-healthz" / "direction.md").write_text(
        "---\ntitle: add-healthz\ntype: feature\n---\n\n## Why\n\nuptime\n",
        encoding="utf-8",
    )
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: x/y\n", encoding="utf-8")
    (tmp_path / "factory_settings.yaml").write_text(
        "caps:\n  global_concurrent_agents: 5\n  per_repo_concurrent_agents: 5\n"
        "  daily_spend_usd: 100\n  hourly_spend_usd: 20\n"
        "modes:\n  default: normal\n  available: [normal, fix-only, paused]\n",
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir()
    return tmp_path


def _seed_story(root: Path, direction_id: str, slug: str) -> StoryRecord:
    db = root / "state" / "factory.db"
    s = StoryRecord(
        direction_id=direction_id,
        app="sacrifice",
        title="t",
        slug=slug,
        scope="backend",
        state=StoryState.STORY_CREATED.value,
        story_file_path=f"stories/0-{slug}.md",
    )
    return persist_story(s, db)


def test_fix_only_mode_allows_bug_direction(factory_root_with_bug_direction: Path) -> None:
    """In fix-only mode, a bug-typed direction's story advances through the
    bug-aware handlers. Loop-4 collapsed the chain to ``sm`` → ``dev`` →
    ``review`` (no separate ``test_design``/``test_impl``), so the story makes
    3 advances and then parks at ``tech_writer`` because tech_writer has no bug
    variant — that's the enforcer's contract, not a bug-tag failure."""
    from factory.settings.loader import reload_settings
    from factory.settings.modes import set_mode

    root = factory_root_with_bug_direction
    reload_settings(root)
    _seed_story(root, "002", "fix-broken-button")
    set_mode("fix-only", root)

    summary = tick(root, "sacrifice", dry_run=True)

    # The bug-aware handlers must all advance: sm, dev, review (3 transitions
    # in the collapsed Loop-4 chain). Without bug-tag plumbing, the FIRST sm
    # dispatch would have been rejected by ``mode_fix_only_blocks_sm``.
    assert summary.stories_advanced >= 3, (
        f"expected >= 3 advances (bug-aware chain), got "
        f"{summary.stories_advanced}; runs={summary.handler_runs!r}"
    )
    # Specifically: no rejection mentioning mode_fix_only_blocks_sm /
    # _blocks_dev / _blocks_review (the bug-aware handler kinds).
    blocking_reasons = {r for _, r in summary.rejected}
    for blocked_kind in ("sm", "dev", "review"):
        assert f"mode_fix_only_blocks_{blocked_kind}" not in blocking_reasons, (
            f"bug story should not be blocked by fix-only at {blocked_kind!r}"
        )


def test_fix_only_mode_blocks_feature_direction(factory_root_with_feature_direction: Path) -> None:
    """In fix-only mode, a feature-typed direction's story is rejected by the
    enforcer with mode_fix_only_blocks_sm."""
    from factory.settings.loader import reload_settings
    from factory.settings.modes import set_mode

    root = factory_root_with_feature_direction
    reload_settings(root)
    _seed_story(root, "002", "add-healthz")
    set_mode("fix-only", root)

    summary = tick(root, "sacrifice", dry_run=True)

    assert summary.stories_advanced == 0, "feature story must not advance under fix-only"
    assert summary.rejected, "expected a rejection from fix-only"
    slug, reason = summary.rejected[0]
    assert slug == "add-healthz"
    assert "mode_fix_only_blocks_sm" == reason
