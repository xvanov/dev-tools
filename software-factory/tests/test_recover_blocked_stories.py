"""``_recover_blocked_stories`` re-dispatches blocked stories (loop-3).

A blocked story is a factory defect, never a real outcome. When the chain code
is fixed, stories already sitting in a terminal blocked state from the old
regime have no transition out — they'd stay blocked forever absent a manual DB
reset. This pass re-enters them into the TDD chain so the fix reaches them,
bounded per story so a genuinely unsatisfiable story escalates instead of
recycling forever.
"""

from __future__ import annotations

from pathlib import Path

from sqlmodel import SQLModel, create_engine

from factory.chain.event_log import log_story_event, read_story_events
from factory.chain.handlers import persist_story
from factory.chain.orchestrator import _MAX_AUTO_RECOVERIES, _recover_blocked_stories
from factory.chain.state_machine import StoryRecord, StoryState


def _seed(tmp_path: Path) -> Path:
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}", echo=False))
    return db


def _blocked_story(db: Path, *, state: str, slug: str, dev_retries: int = 6) -> StoryRecord:
    return persist_story(
        StoryRecord(
            direction_id="099", app="sacrifice", title="t", slug=slug,
            scope="backend", state=state, dev_retries=dev_retries,
            reviewer_cycles=6, error="dev exhausted retries (6)",
        ),
        db,
    )


def test_recovers_blocked_tests_need_clarification_to_sm_done(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _blocked_story(db, state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, slug="a")

    out = _recover_blocked_stories(db, "sacrifice", root=tmp_path)

    assert out == [("a", StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, StoryState.SM_DONE.value)]
    # Reload and verify the clean slate.
    from sqlmodel import Session, select
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == s.id)).one()
    assert r.state == StoryState.SM_DONE.value
    assert r.dev_retries == 0 and r.reviewer_cycles == 0 and r.error is None
    assert r.harness_precheck_passed is False
    events = read_story_events(s.id, software_factory_root=tmp_path, slug_hint=s.slug)
    assert [e for e in events if e.get("event") == "auto_recovery"]


def test_recovers_review_nonconvergent(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    _blocked_story(db, state=StoryState.BLOCKED_REVIEW_NONCONVERGENT.value, slug="b")
    out = _recover_blocked_stories(db, "sacrifice", root=tmp_path)
    assert out and out[0][2] == StoryState.SM_DONE.value


def test_deploy_failed_is_not_auto_recovered(tmp_path: Path) -> None:
    """deploy_failed is handled at the merge layer (auto_merge reconcile), not here."""
    db = _seed(tmp_path)
    _blocked_story(db, state=StoryState.BLOCKED_DEPLOY_FAILED.value, slug="c")
    assert _recover_blocked_stories(db, "sacrifice", root=tmp_path) == []


def test_recovery_is_bounded_then_escalates(tmp_path: Path) -> None:
    db = _seed(tmp_path)
    s = _blocked_story(db, state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, slug="d")

    # Simulate the story having already been recovered the max number of times
    # under the CURRENT regime (re-entry at sm_done).
    for i in range(_MAX_AUTO_RECOVERIES):
        log_story_event(
            s.id, "auto_recovery",
            {"attempt": i + 1, "to_state": StoryState.SM_DONE.value},
            software_factory_root=tmp_path, slug_hint=s.slug,
        )

    out = _recover_blocked_stories(db, "sacrifice", root=tmp_path)
    assert out == []  # cap reached → not recovered again
    events = read_story_events(s.id, software_factory_root=tmp_path, slug_hint=s.slug)
    assert [e for e in events if e.get("event") == "auto_recovery_exhausted"]


def test_old_regime_recoveries_do_not_consume_budget(tmp_path: Path) -> None:
    """A chain redesign changes the re-entry target; attempts burnt under the
    old regime (e.g. to_state=tests_red, pre-Loop-4) must not count against
    the new regime's budget — the new chain deserves its own honest attempts."""
    db = _seed(tmp_path)
    s = _blocked_story(db, state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, slug="e")

    for i in range(_MAX_AUTO_RECOVERIES):
        log_story_event(
            s.id, "auto_recovery",
            {"attempt": i + 1, "to_state": "tests_red"},  # old re-entry point
            software_factory_root=tmp_path, slug_hint=s.slug,
        )

    out = _recover_blocked_stories(db, "sacrifice", root=tmp_path)
    assert out == [
        ("e", StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, StoryState.SM_DONE.value)
    ]


def test_signal_changed_guard_allows_first_recovery_with_signature(tmp_path: Path) -> None:
    """First recovery is always allowed and records a failure_signature on
    the auto_recovery event, even though no prior recovery exists yet."""
    import json as _json

    db = _seed(tmp_path)
    s = persist_story(
        StoryRecord(
            direction_id="099", app="sacrifice", title="t", slug="g",
            scope="backend", state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
            dev_retries=6, reviewer_cycles=6,
            dev_attempts_json=_json.dumps(
                [{"attempt": 1, "test_output_tail": "AssertionError: foo != bar"}]
            ),
        ),
        db,
    )

    out = _recover_blocked_stories(db, "sacrifice", root=tmp_path)

    assert out == [("g", StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, StoryState.SM_DONE.value)]
    events = read_story_events(s.id, software_factory_root=tmp_path, slug_hint=s.slug)
    auto_recovery_events = [e for e in events if e.get("event") == "auto_recovery"]
    assert len(auto_recovery_events) == 1
    assert auto_recovery_events[0].get("failure_signature")


def test_signal_changed_guard_blocks_recovery_on_identical_failure(tmp_path: Path) -> None:
    """A second block with the SAME failure signature as the last recovery
    must NOT recover again — it must escalate as auto_recovery_exhausted
    instead of burning another full dev cycle on a dead end."""
    import json as _json

    db = _seed(tmp_path)
    same_tail = "AssertionError: foo != bar\nFile line 42"
    s = persist_story(
        StoryRecord(
            direction_id="099", app="sacrifice", title="t", slug="h",
            scope="backend", state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
            dev_retries=6, reviewer_cycles=6,
            dev_attempts_json=_json.dumps(
                [{"attempt": 1, "test_output_tail": same_tail}]
            ),
        ),
        db,
    )

    out1 = _recover_blocked_stories(db, "sacrifice", root=tmp_path)
    assert out1 == [("h", StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, StoryState.SM_DONE.value)]

    # Story blocks again with the identical failure output.
    from sqlmodel import Session, select

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as ses:
        story = ses.exec(select(StoryRecord).where(StoryRecord.id == s.id)).one()
        story.state = StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value
        story.dev_attempts_json = _json.dumps(
            [{"attempt": 1, "test_output_tail": same_tail},
             {"attempt": 2, "test_output_tail": same_tail}]
        )
        story.dev_retries = 6
        story.reviewer_cycles = 6
        ses.add(story)
        ses.commit()

    out2 = _recover_blocked_stories(db, "sacrifice", root=tmp_path)
    assert out2 == []  # NOT recovered again — identical signature

    events = read_story_events(s.id, software_factory_root=tmp_path, slug_hint=s.slug)
    auto_recovery_events = [e for e in events if e.get("event") == "auto_recovery"]
    exhausted_events = [e for e in events if e.get("event") == "auto_recovery_exhausted"]
    assert len(auto_recovery_events) == 1  # only the first recovery happened
    assert len(exhausted_events) == 1
    assert exhausted_events[0].get("reason") == "identical_failure_signature"

    with Session(eng) as ses:
        story = ses.exec(select(StoryRecord).where(StoryRecord.id == s.id)).one()
    assert story.state == StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value  # untouched


def test_signal_changed_guard_allows_recovery_on_different_failure(tmp_path: Path) -> None:
    """A second block with a DIFFERENT failure signature is genuine new
    signal — it must recover again (counters reset), not escalate."""
    import json as _json

    db = _seed(tmp_path)
    s = persist_story(
        StoryRecord(
            direction_id="099", app="sacrifice", title="t", slug="i",
            scope="backend", state=StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
            dev_retries=6, reviewer_cycles=6,
            dev_attempts_json=_json.dumps(
                [{"attempt": 1, "test_output_tail": "AssertionError: foo != bar"}]
            ),
        ),
        db,
    )

    out1 = _recover_blocked_stories(db, "sacrifice", root=tmp_path)
    assert out1 == [("i", StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, StoryState.SM_DONE.value)]

    # Story blocks again with a DIFFERENT failure — progress was made.
    from sqlmodel import Session, select

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as ses:
        story = ses.exec(select(StoryRecord).where(StoryRecord.id == s.id)).one()
        story.state = StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value
        story.dev_attempts_json = _json.dumps(
            [{"attempt": 1, "test_output_tail": "AssertionError: foo != bar"},
             {"attempt": 2, "test_output_tail": "TypeError: unexpected keyword argument 'x'"}]
        )
        story.dev_retries = 6
        story.reviewer_cycles = 6
        ses.add(story)
        ses.commit()

    out2 = _recover_blocked_stories(db, "sacrifice", root=tmp_path)
    assert out2 == [("i", StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value, StoryState.SM_DONE.value)]

    events = read_story_events(s.id, software_factory_root=tmp_path, slug_hint=s.slug)
    auto_recovery_events = [e for e in events if e.get("event") == "auto_recovery"]
    assert len(auto_recovery_events) == 2  # both recoveries happened
    assert auto_recovery_events[0]["failure_signature"] != auto_recovery_events[1]["failure_signature"]

    with Session(eng) as ses:
        story = ses.exec(select(StoryRecord).where(StoryRecord.id == s.id)).one()
    assert story.state == StoryState.SM_DONE.value
    assert story.dev_retries == 0 and story.reviewer_cycles == 0


def test_recovery_preserves_reviewer_findings(tmp_path: Path) -> None:
    """The last reviewer verdict survives recovery: the worktree still holds
    the rejected code, and handle_dev feeds findings into the prompt whenever
    they exist — clearing them made the first post-recovery dev pass blind
    and burned a cycle rediscovering the same objections."""
    import json

    db = _seed(tmp_path)
    s = persist_story(
        StoryRecord(
            direction_id="099", app="sacrifice", title="t", slug="f",
            scope="backend", state=StoryState.BLOCKED_REVIEW_NONCONVERGENT.value,
            dev_retries=6, reviewer_cycles=6,
            reviewer_result_json=json.dumps({"verdict": "request_changes",
                                             "findings": [{"severity": "medium", "what": "x"}]}),
        ),
        db,
    )
    out = _recover_blocked_stories(db, "sacrifice", root=tmp_path)
    assert out
    from sqlmodel import Session, select
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        r = ses.exec(select(StoryRecord).where(StoryRecord.id == s.id)).one()
    assert r.reviewer_cycles == 0 and r.dev_retries == 0
    assert r.reviewer_result_json is not None
    assert "request_changes" in r.reviewer_result_json
