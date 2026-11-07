"""Tests for the gate-block exhaustion cap + skip (019 blocker S2).

Before this fix, a "missing gate labels" ``MergeAction`` was a dead end: the
story stayed in ``PR_OPEN`` (not in ``_AUTO_RECOVERABLE_STATES``), a gate
failure is not a CI failure so ``_handle_ci_failure`` never fired for it, and
``merge_actions`` rows were written but never read back as a counter — so the
SAME PR got fully re-evaluated (tests-green + smoke-green, 600s each) on every
tick, forever. Measured live 2026-08-07: PR 88 alone re-evaluated 436 times on
'missing gate labels: [smoke-green]'.

These tests pin: three consecutive blocks on the SAME head sha park the story
in ``blocked_ci_unresolved`` with the labels recorded in ``error``; a NEW head
sha resets the counter; and the cheap skip stops paying for
``evaluate_all_gates`` at all once a block is already on file for this head.

Real-run (``dry_run=False``) is required to exercise the cap/skip at all (see
``_evaluate_one_pr``'s ``gate_block_tracked`` guard), so every call here injects
``pr_merged_query`` — the worker's own seam for "is this PR ACTUALLY merged on
GitHub" — to keep the suite off the network; that query is unrelated to what
these tests are pinning.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from sqlmodel import Session, create_engine, select

from factory.chain import auto_merge as am
from factory.chain.event_log import read_story_events
from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState


def _never_merged(**_kw: object) -> bool:
    return False


@pytest.fixture
def factory_root(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: o/r\n", encoding="utf-8")
    (tmp_path / "state").mkdir()
    return tmp_path


def _pr_open_story(db: Path, *, slug: str = "s", pr_number: int = 77) -> StoryRecord:
    """No tech_writer record -> ``docs-current`` fails -> always a required
    gate short of green, so every evaluation blocks deterministically."""
    return persist_story(
        StoryRecord(
            direction_id="019",
            app="sacrifice",
            title="t",
            slug=slug,
            scope="backend",
            state=StoryState.PR_OPEN.value,
            github_pr_number=pr_number,
            test_plan_json=json.dumps({"test_plan": [{"name": "t", "key_steps": ["x"]}]}),
        ),
        db,
    )


def _fixture(story: StoryRecord, *, head_sha: str, pr_number: int = 77) -> am.FixturePR:
    return am.FixturePR(
        pr_number=pr_number,
        head_sha=head_sha,
        base_branch="main",
        labels=[],
        files_changed=["src/foo.py"],
        ci_state="success",
        story=story,
    )


def _tick(
    factory_root: Path, db: Path, fixture: am.FixturePR, *, dry_run: bool = False, **kw: Any
) -> list[am.MergeAction]:
    return am.auto_merge_tick(
        factory_root,
        "sacrifice",
        dry_run=dry_run,
        fixture_prs=[fixture],
        db_path=db,
        pr_merged_query=_never_merged,
        **kw,
    )


def test_first_two_blocks_do_not_park(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    story = _pr_open_story(db)
    head_sha = "cafe0001"

    for _ in range(2):
        actions = _tick(factory_root, db, _fixture(story, head_sha=head_sha))
        assert len(actions) == 1
        assert not actions[0].merged
        assert "missing gate labels" in actions[0].reason
        assert "exhausted" not in actions[0].reason

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.PR_OPEN.value


def test_three_consecutive_blocks_parks_the_story(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    story = _pr_open_story(db)
    head_sha = "cafe0002"

    actions: list[am.MergeAction] = []
    for _ in range(3):
        actions = _tick(factory_root, db, _fixture(story, head_sha=head_sha))

    assert len(actions) == 1
    assert not actions[0].merged
    assert "gate block exhausted" in actions[0].reason
    assert "parked" in actions[0].reason.lower()

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.BLOCKED_CI_UNRESOLVED.value
    assert r.last_rejection_reason is not None
    assert "gate_block_exhausted" in r.last_rejection_reason
    assert r.error is not None
    assert "docs-current" in r.error

    events = read_story_events(story.id, software_factory_root=factory_root, slug_hint=story.slug)
    assert any(e.get("event") == "gate_block_exhausted" for e in events)


def test_a_fourth_tick_never_happens_because_the_story_left_mergeable_states(
    factory_root: Path,
) -> None:
    """Once parked, the story-state guard (and the outer mergeable-state
    query on the real tick path) stop it from ever being evaluated again on
    the SAME PR — the cap is a hard stop, not a slow-down."""
    db = factory_root / "state" / "factory.db"
    story = _pr_open_story(db)
    head_sha = "cafe0003"

    for _ in range(3):
        _tick(factory_root, db, _fixture(story, head_sha=head_sha))

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    actions = _tick(factory_root, db, _fixture(r, head_sha=head_sha))
    assert len(actions) == 1
    assert "not in mergeable states" in actions[0].reason


def test_new_head_sha_resets_the_counter(factory_root: Path) -> None:
    db = factory_root / "state" / "factory.db"
    story = _pr_open_story(db)

    # Two blocks on the FIRST head sha...
    for _ in range(2):
        _tick(factory_root, db, _fixture(story, head_sha="cafe0004"))
    # ...a new commit lands (new head sha) — the streak must NOT carry over,
    # so this is block #1 of the NEW streak, not #3.
    actions = _tick(factory_root, db, _fixture(story, head_sha="beef0005"))
    assert len(actions) == 1
    assert "missing gate labels" in actions[0].reason
    assert "exhausted" not in actions[0].reason

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.PR_OPEN.value  # still not parked


def test_unchanged_head_skip_prevents_a_second_full_gate_evaluation(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cheap short-circuit: once a block is on file for this exact head
    sha, a second tick must NOT re-invoke ``evaluate_all_gates`` (the
    tests-green / smoke-green 600s-a-piece re-run this whole fix exists to
    stop)."""
    calls = {"n": 0}
    real_evaluate_all_gates = am.evaluate_all_gates

    def _spy(pr_ctx: object, cfg: object) -> object:
        calls["n"] += 1
        return real_evaluate_all_gates(pr_ctx, cfg)  # type: ignore[arg-type]

    monkeypatch.setattr(am, "evaluate_all_gates", _spy)

    db = factory_root / "state" / "factory.db"
    story = _pr_open_story(db)
    head_sha = "cafe0006"

    _tick(factory_root, db, _fixture(story, head_sha=head_sha))
    assert calls["n"] == 1

    _tick(factory_root, db, _fixture(story, head_sha=head_sha))
    # Second tick, SAME head sha: the gate evaluator must not run again.
    assert calls["n"] == 1


def test_dry_run_never_tracked_or_capped(factory_root: Path) -> None:
    """A dry-run preview must never park a story — existing dry-run tests
    already exercise 'missing gate labels' fixtures repeatedly across the
    suite and must keep behaving exactly as before."""
    db = factory_root / "state" / "factory.db"
    story = _pr_open_story(db)
    head_sha = "cafe0007"

    for _ in range(5):
        actions = _tick(factory_root, db, _fixture(story, head_sha=head_sha), dry_run=True)
        assert "missing gate labels" in actions[0].reason

    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == story.id)).one()
    assert r.state == StoryState.PR_OPEN.value
