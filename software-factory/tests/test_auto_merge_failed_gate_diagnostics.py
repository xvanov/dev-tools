"""A blocked merge must be diagnosable.

Every gate computes a ``reason`` and ``details`` — the smoke gate's are the
command's exit code and output tail. The auto-merge worker kept only
``[label for label, r in results.items() if r.passed]`` and dropped the failing
``GateResult`` objects on the floor, and ``MergeActionRecord`` had no column for
them. So when a gate blocked a merge the factory could say WHICH gate failed
("missing gate labels: ['smoke-green']") and never WHY.

These tests pin the three places the diagnosis now has to survive: the returned
``MergeAction``, the ``merge_actions`` row, and the per-story event log.
"""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy import text
from sqlmodel import Session, create_engine, select

from factory.chain.auto_merge import (
    FixturePR,
    MergeAction,
    MergeActionRecord,
    _record_merge_action,
    auto_merge_tick,
)
from factory.chain.state_machine import StoryState
from tests.test_auto_merge import _good_fixture, _good_story, factory_root  # noqa: F401


def _blocked_fixture() -> FixturePR:
    """A fixture whose docs-current gate fails (no tech_writer record)."""
    story = _good_story()
    story.tech_writer_result_json = None
    return FixturePR(
        pr_number=4301,
        head_sha="cafe",
        base_branch="main",
        labels=[],
        files_changed=["src/foo.py"],
        ci_state="success",
        story=story,
    )


def test_failing_gate_reason_reaches_the_merge_action(factory_root: Path) -> None:  # noqa: F811
    actions = auto_merge_tick(
        factory_root, "sacrifice", dry_run=True, fixture_prs=[_blocked_fixture()]
    )
    action = actions[0]
    assert not action.merged
    assert action.gates_failed, "failing gate results were discarded"
    labels = {g["label"] for g in action.gates_failed}
    assert "docs-current" in labels
    failed = next(g for g in action.gates_failed if g["label"] == "docs-current")
    # The full GateResult shape, not just a label.
    assert failed["passed"] is False
    assert failed["reason"]
    assert "details" in failed
    # Passing gates are NOT in the failed list.
    assert labels.isdisjoint(set(action.gates_passed))


def test_failing_gate_diagnostics_are_persisted(factory_root: Path) -> None:  # noqa: F811
    auto_merge_tick(
        factory_root, "sacrifice", dry_run=True, fixture_prs=[_blocked_fixture()]
    )
    db = factory_root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(MergeActionRecord)).all()
    assert len(rows) == 1
    stored = json.loads(rows[0].gates_failed_json)
    assert {g["label"] for g in stored} >= {"docs-current"}
    assert all("reason" in g for g in stored)


def test_failing_gates_are_logged_as_a_story_event(factory_root: Path) -> None:  # noqa: F811
    """``factory trace <id>`` must show the diagnosis.

    Uses a PERSISTED story, as production does — the per-story event log is
    keyed on ``story.id``, which is None on a bare fixture record.
    """
    from factory.chain.event_log import read_story_events
    from factory.chain.handlers import persist_story

    fixture = _blocked_fixture()
    assert fixture.story is not None
    fixture.story = persist_story(fixture.story, factory_root / "state" / "factory.db")
    auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[fixture])
    events = read_story_events(
        fixture.story.id, software_factory_root=factory_root, slug_hint=fixture.story.slug
    )
    failed_events = [e for e in events if e.get("event") == "merge_gates_failed"]
    assert failed_events, "no merge_gates_failed event recorded"
    payload = failed_events[-1]
    assert payload["pr_number"] == 4301
    assert {g["label"] for g in payload["failed"]} >= {"docs-current"}


def test_clean_merge_records_an_empty_failed_list(factory_root: Path) -> None:  # noqa: F811
    """Fail-safe in the other direction: an all-green evaluation must not
    manufacture phantom failures."""
    from factory.chain.event_log import read_story_events

    pr = _good_fixture()
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[pr])
    assert actions[0].merged
    assert actions[0].gates_failed == []
    db = factory_root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(MergeActionRecord)).all()
    assert json.loads(rows[0].gates_failed_json) == []
    assert pr.story is not None
    events = read_story_events(
        pr.story.id, software_factory_root=factory_root, slug_hint=pr.story.slug
    )
    assert not [e for e in events if e.get("event") == "merge_gates_failed"]


def test_docs_chain_still_records_no_failures(factory_root: Path) -> None:  # noqa: F811
    """The docs chain skips the TDD evaluator entirely; that branch must still
    define ``gates_failed`` rather than blowing up on an unbound name."""
    story = _good_story()
    story.chain_kind = "docs"
    story.state = StoryState.PR_OPEN.value
    fixture = FixturePR(
        pr_number=4302,
        head_sha="d0c5",
        base_branch="main",
        labels=[],
        files_changed=["apps/sacrifice/context/project.md"],
        ci_state="success",
        story=story,
    )
    actions = auto_merge_tick(factory_root, "sacrifice", dry_run=True, fixture_prs=[fixture])
    assert actions[0].gates_failed == []


def test_migration_adds_the_column_to_a_preexisting_table(tmp_path: Path) -> None:
    """A live ``factory.db`` predates this column. ``SQLModel.create_all`` only
    creates missing TABLES, so without an explicit ALTER every insert would
    fail with 'no such column'."""
    db = tmp_path / "old.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    # Build the OLD table shape by hand — no gates_failed_json.
    with eng.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE merge_actions ("
                "id INTEGER PRIMARY KEY, app VARCHAR, pr_number INTEGER, "
                "head_sha VARCHAR, merged BOOLEAN, reason VARCHAR, "
                "gates_passed_json VARCHAR, blocking_labels_json VARCHAR, ts VARCHAR)"
            )
        )
    eng.dispose()

    _record_merge_action(
        MergeAction(
            app="sacrifice",
            pr_number=99,
            merged=False,
            reason="blocked",
            gates_failed=[{"label": "smoke-green", "passed": False, "reason": "exit=1"}],
        ),
        "sha",
        db,
    )

    eng2 = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng2) as session:
        rows = session.exec(select(MergeActionRecord)).all()
    assert len(rows) == 1
    assert json.loads(rows[0].gates_failed_json)[0]["label"] == "smoke-green"


def test_migration_is_idempotent(tmp_path: Path) -> None:
    """Adding a column twice raises; the tick runs this on every evaluation."""
    db = tmp_path / "twice.db"
    for pr_number in (1, 2, 3):
        _record_merge_action(
            MergeAction(app="sacrifice", pr_number=pr_number, merged=False, reason="x"),
            "sha",
            db,
        )
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(MergeActionRecord)).all()
    assert len(rows) == 3
