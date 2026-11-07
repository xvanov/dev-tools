"""Tests for Phase 7 dual-draft PR flow.

Verifies the trigger conditions in ``should_spawn_dual_draft`` and the
end-to-end spawn-of-two behavior through ``handle_stories_spawned``:

  * ``(explore)``-tagged direction → 2 stories spawned
  * PM confidence < 0.6 → 2 stories spawned
  * confidence ≥ 0.6 + no explore → 1 story spawned (normal path)

The chain spawn tests run in dry-run mode (no GH client) so we exercise
the StoryRecord-creation path without any network.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from sqlmodel import Session, create_engine, select

from factory.app_config import AppConfig
from factory.chain.dual_draft import (
    CONFIDENCE_THRESHOLD,
    LINK_ALTERNATIVES_SENTINEL,
    Interpretation,
    link_alternatives,
    produce_interpretations,
    should_spawn_dual_draft,
)
from factory.chain.handlers import handle_stories_spawned
from factory.chain.state_machine import StoryRecord
from factory.directions.parser import Direction


def _mk_direction(*, explore: bool = False, title: str = "Make the thing better") -> Direction:
    return Direction(
        id="001",
        slug="make-it-better",
        title=title,
        type_tag=None,
        why="Because the metric is wrong.",
        has_flow=False,
        has_api_spec=False,
        acceptance=["Outcome is observably correct."],
        explore_tag=explore,
        artifacts_paths=[],
        app="sacrifice",
        status="pm-validated",
        raw_frontmatter={"title": title, "explore": explore},
        raw_body=f"# {title}",
        dir_path=Path("."),
        state={"tracker_issue": 42},
    )


def test_should_spawn_dual_draft_explore_tag_only() -> None:
    """An ``(explore)`` direction always fires dual-draft, even at high confidence."""
    d = _mk_direction(explore=True)
    assert should_spawn_dual_draft(d, {"confidence": 0.95}) is True


def test_should_spawn_dual_draft_low_confidence_only() -> None:
    """Non-explore direction below the confidence threshold fires dual-draft."""
    d = _mk_direction(explore=False)
    assert should_spawn_dual_draft(d, {"confidence": 0.5}) is True
    # Exactly at threshold = NOT ambiguous.
    assert should_spawn_dual_draft(d, {"confidence": CONFIDENCE_THRESHOLD}) is False


def test_should_spawn_dual_draft_high_confidence_no_explore() -> None:
    """High-confidence, non-explore → normal single-story path."""
    d = _mk_direction(explore=False)
    assert should_spawn_dual_draft(d, {"confidence": 0.85}) is False


def test_should_spawn_dual_draft_handles_missing_confidence() -> None:
    """Missing confidence + no explore → not ambiguous (assume PM was definite)."""
    d = _mk_direction(explore=False)
    assert should_spawn_dual_draft(d, {}) is False


def test_produce_interpretations_dry_run_returns_two() -> None:
    d = _mk_direction(explore=True)
    interps = produce_interpretations(d, {}, dry_run=True)
    assert len(interps) == 2
    assert all(isinstance(i, Interpretation) for i in interps)
    ids = sorted(i.interpretation_id for i in interps)
    assert ids == ["alt-a", "alt-b"]
    # Each interpretation must carry a non-trivial key_assumption_diff.
    for interp in interps:
        assert len(interp.key_assumption_diff) > 10
        assert d.title in interp.title


def test_produce_interpretations_real_run_passes_model_id() -> None:
    """Phase 7 NIT cleanup: real-run path must pass ``model_id`` to ``text_run``
    so the active provider (Azure or direct) is honored. Regression test for
    the missing argument flagged in P7 review.
    """
    d = _mk_direction(explore=True)
    captured: dict[str, Any] = {}

    def fake_text_run(persona: str, prompt: str, **kwargs: Any) -> dict[str, Any]:
        captured["persona"] = persona
        captured["model_id"] = kwargs.get("model_id")
        captured["schema_present"] = kwargs.get("schema") is not None
        return {
            "interpretations": [
                {
                    "interpretation_id": "alt-a",
                    "title": "narrow",
                    "body": "...",
                    "key_assumption_diff": "small scope",
                },
                {
                    "interpretation_id": "alt-b",
                    "title": "broad",
                    "body": "...",
                    "key_assumption_diff": "big scope",
                },
            ]
        }

    interps = produce_interpretations(d, {"confidence": 0.4}, dry_run=False, text_run=fake_text_run)
    assert len(interps) == 2
    assert captured["persona"] == "analyst"
    # model_id must be a non-empty string — the actual value tracks routes.yaml.
    assert isinstance(captured["model_id"], str)
    assert captured["model_id"]
    assert captured["schema_present"] is True


def _setup_dry_run_root(tmp_path: Path) -> tuple[Path, AppConfig]:
    """Sacrifice app config + state dir, no GH."""
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    cfg_text = yaml.safe_dump({"name": "sacrifice", "repo": "owner/sacrifice"})
    (apps / "config.yaml").write_text(cfg_text, encoding="utf-8")
    (tmp_path / "state").mkdir()
    cfg = AppConfig(name="sacrifice", repo="owner/sacrifice")
    return tmp_path, cfg


def _stories_for(app: str, db: Path) -> list[StoryRecord]:
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        return list(session.exec(select(StoryRecord).where(StoryRecord.app == app)).all())


def test_handle_stories_spawned_explore_spawns_two_stories(tmp_path: Path) -> None:
    root, cfg = _setup_dry_run_root(tmp_path)
    direction = _mk_direction(explore=True)
    pm_result = {
        "child_stories": [{"title": "Touch the thing", "scope": "backend"}],
        "confidence": 0.9,  # high — but explore overrides
    }
    stories = handle_stories_spawned(
        direction=direction,
        pm_result=pm_result,
        app_config=cfg,
        software_factory_root=root,
        dry_run=True,
    )
    assert len(stories) == 2, "expected 2 stories from dual-draft branch"
    slugs = sorted(s.slug for s in stories)
    assert any("alt-a" in s for s in slugs), f"alt-a missing in slugs={slugs}"
    assert any("alt-b" in s for s in slugs), f"alt-b missing in slugs={slugs}"

    # Dry-run is a pure preview: the two dual-draft stories are RETURNED for
    # inspection but never persisted to the DB (a persisted dry-run story is a
    # live dispatchable artifact — the 2026-07-20 self-tick incident).
    persisted = _stories_for("sacrifice", root / "state" / "factory.db")
    assert len(persisted) == 0


def test_long_title_preserves_distinct_alt_suffixes(tmp_path: Path) -> None:
    """Regression (dir 010 over-fire, 2026-07-21): for a LONG-titled direction
    the ``base-alt-a`` slug used to exceed the 60-char cap and the ``-alt-*``
    suffix was truncated OFF — both siblings collapsed to the SAME suffix-less
    slug, so ``_draft_alt_suffix`` returned None, sibling detection failed, and
    BOTH interpretations merged. The two slugs must stay <=60 chars, DISTINCT,
    and each carry a recognizable trailing ``-alt-*``."""
    from factory.chain.dual_draft import _draft_alt_suffix

    root, cfg = _setup_dry_run_root(tmp_path)
    long_title = "Add a factory version command printing the running git SHA and branch"
    direction = _mk_direction(explore=True, title=long_title)
    pm_result = {
        "child_stories": [{"title": long_title, "scope": "backend"}],
        "confidence": 0.9,
    }
    stories = handle_stories_spawned(
        direction=direction, pm_result=pm_result, app_config=cfg,
        software_factory_root=root, dry_run=True,
    )
    assert len(stories) == 2
    slugs = [s.slug for s in stories]
    assert all(len(s) <= 60 for s in slugs), f"slug over 60 chars: {slugs}"
    assert slugs[0] != slugs[1], f"siblings collapsed to identical slug: {slugs}"
    suffixes = sorted(_draft_alt_suffix(s) for s in slugs)
    assert suffixes == ["alt-a", "alt-b"], f"alt suffix lost/garbled: {slugs} -> {suffixes}"


def test_handle_stories_spawned_low_confidence_spawns_two_stories(tmp_path: Path) -> None:
    root, cfg = _setup_dry_run_root(tmp_path)
    direction = _mk_direction(explore=False)
    pm_result = {
        "child_stories": [{"title": "Touch the thing", "scope": "frontend"}],
        "confidence": 0.5,  # below 0.6 threshold
    }
    stories = handle_stories_spawned(
        direction=direction,
        pm_result=pm_result,
        app_config=cfg,
        software_factory_root=root,
        dry_run=True,
    )
    assert len(stories) == 2
    # scope of the first child must be carried into both spawn rows.
    assert all(s.scope == "frontend" for s in stories)


def test_handle_stories_spawned_high_confidence_spawns_one_story(tmp_path: Path) -> None:
    root, cfg = _setup_dry_run_root(tmp_path)
    direction = _mk_direction(explore=False)
    pm_result = {
        "child_stories": [{"title": "Touch the thing", "scope": "backend"}],
        "confidence": 0.85,
    }
    stories = handle_stories_spawned(
        direction=direction,
        pm_result=pm_result,
        app_config=cfg,
        software_factory_root=root,
        dry_run=True,
    )
    assert len(stories) == 1, "expected single-story path"
    assert "alt-a" not in stories[0].slug
    assert "alt-b" not in stories[0].slug


class _FakeComment:
    def __init__(self, body: str, cid: int) -> None:
        self.body = body
        self.id = cid


class _FakeIssue:
    def __init__(self) -> None:
        self.comments: list[_FakeComment] = []
        self._next_id = 100

    def get_comments(self) -> list[_FakeComment]:
        return list(self.comments)

    def create_comment(self, body: str) -> _FakeComment:
        c = _FakeComment(body, self._next_id)
        self._next_id += 1
        self.comments.append(c)
        return c


class _FakeRepo:
    def __init__(self, issue: _FakeIssue) -> None:
        self._issue = issue

    def get_issue(self, _n: int) -> _FakeIssue:
        return self._issue


class _FakeClient:
    def __init__(self, issue: _FakeIssue) -> None:
        self._repo = _FakeRepo(issue)

    def get_repo(self, _name: str) -> _FakeRepo:
        return self._repo


def _mk_story(issue_number: int) -> Any:
    class _S:
        pass

    s = _S()
    s.github_issue_number = issue_number
    return s


def test_link_alternatives_is_idempotent_via_sentinel() -> None:
    """Two consecutive ``link_alternatives`` calls produce exactly one comment.

    Phase 7 NIT cleanup: prior to this, the function appended a fresh
    comment every time it ran, so retries / webhook redeliveries would
    spam the Direction Tracker.
    """
    direction = _mk_direction(explore=True)
    interps = produce_interpretations(direction, {}, dry_run=True)
    issue = _FakeIssue()
    client = _FakeClient(issue)

    first = link_alternatives(
        _mk_story(11),
        _mk_story(12),
        interps,
        direction,
        client,
        app_repo="owner/sacrifice",
    )
    second = link_alternatives(
        _mk_story(11),
        _mk_story(12),
        interps,
        direction,
        client,
        app_repo="owner/sacrifice",
    )

    assert first is not None and second is not None
    assert first == second, "second call must return the existing comment's id"
    assert len(issue.comments) == 1, "no duplicate comment posted on rerun"
    assert LINK_ALTERNATIVES_SENTINEL in issue.comments[0].body


def test_link_alternatives_embeds_sentinel_marker() -> None:
    """Every new comment carries the sentinel HTML comment for future idempotency."""
    direction = _mk_direction(explore=True)
    interps = produce_interpretations(direction, {}, dry_run=True)
    issue = _FakeIssue()
    client = _FakeClient(issue)

    link_alternatives(
        _mk_story(1),
        _mk_story(2),
        interps,
        direction,
        client,
        app_repo="owner/sacrifice",
    )
    assert len(issue.comments) == 1
    assert issue.comments[0].body.startswith(LINK_ALTERNATIVES_SENTINEL)


_ = Any  # silence unused import
