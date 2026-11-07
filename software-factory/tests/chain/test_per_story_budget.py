"""WS1.1 GLOBAL per-story budget circuit breaker.

The composed chain loops each have their OWN counter — dev retries
(``_MAX_DEV_RETRIES``), reviewer cycles (``_MAX_REVIEW_CYCLES``),
auto-recovery re-dispatch (``_MAX_AUTO_RECOVERIES``), CI-fix — but none of
them can see the aggregate. A pathological story can therefore burn the
*product* of every loop's budget. The breaker adds one shared per-story
ceiling on both attempts and spend; crossing it routes the story to the
terminal ``BLOCKED_BUDGET_EXCEEDED`` sink (no auto-recovery) with an
evidence event, so a broken story stops burning spend instead of looping.

These tests cover three layers:
  * the pure transition table (``advance`` + terminality),
  * the pure breaker-decision helper + ledger-spend helper,
  * the orchestrator dispatch path (over-cap trips before any handler runs;
    under-cap dispatches normally; an evidence event is emitted).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlmodel import Session, SQLModel, create_engine

from factory.chain import handlers as H
from factory.chain import orchestrator as O
from factory.chain.state_machine import (
    EVENT_BUDGET_EXCEEDED,
    EVENT_DEPLOY_STARTED,
    IllegalTransitionError,
    StoryRecord,
    StoryState,
    advance,
    is_terminal,
    list_transitions_from,
)
from factory.settings.loader import CapsConfig

# The dispatch states the breaker meters (mirrors
# ``orchestrator._BUDGET_METERED_STATES``). DEPLOY_PENDING is deliberately
# absent — a merged story must still be allowed to deploy.
_METERED_STATES = [
    StoryState.STORY_CREATED,
    StoryState.SM_DONE,
    StoryState.DEV_RETRY,
    StoryState.REVIEWER_REQUESTED_CHANGES,
    StoryState.TESTS_GREEN,
    StoryState.REVIEWER_DONE,
    StoryState.TECH_WRITER_DONE,
    StoryState.DOCS_SM_DONE,
    StoryState.DOCS_ONBOARDER_DONE,
]


def _story(state: StoryState = StoryState.STORY_CREATED, **kw: object) -> StoryRecord:
    fields: dict[str, object] = {
        "direction_id": "007",
        "app": "sacrifice",
        "title": "t",
        "slug": "s",
        "scope": "backend",
        "state": state.value,
    }
    fields.update(kw)
    return StoryRecord(**fields)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Transition table
# --------------------------------------------------------------------------- #


def test_every_metered_state_advances_to_blocked_budget_exceeded() -> None:
    for src in _METERED_STATES:
        s = _story(src)
        assert advance(s, EVENT_BUDGET_EXCEEDED) == StoryState.BLOCKED_BUDGET_EXCEEDED, src


def test_blocked_budget_exceeded_is_terminal() -> None:
    assert is_terminal(StoryState.BLOCKED_BUDGET_EXCEEDED)
    assert list_transitions_from(StoryState.BLOCKED_BUDGET_EXCEEDED) == []


def test_deploy_pending_is_not_budget_metered() -> None:
    """A merged story in DEPLOY_PENDING must still deploy — the breaker must
    NOT have an edge out of it, otherwise merged work strands un-deployed."""
    s = _story(StoryState.DEPLOY_PENDING)
    with pytest.raises(IllegalTransitionError):
        advance(s, EVENT_BUDGET_EXCEEDED)
    # ...and the normal deploy transition is intact.
    assert advance(s, EVENT_DEPLOY_STARTED) == StoryState.DEPLOY_PENDING


def test_advance_does_not_mutate_story() -> None:
    s = _story(StoryState.SM_DONE)
    nxt = advance(s, EVENT_BUDGET_EXCEEDED)
    assert s.state == StoryState.SM_DONE.value  # unchanged — advance() is pure
    assert nxt == StoryState.BLOCKED_BUDGET_EXCEEDED


# --------------------------------------------------------------------------- #
# Pure breaker-decision helper
# --------------------------------------------------------------------------- #


def test_breaker_reason_none_under_cap() -> None:
    caps = CapsConfig(per_story_attempts=20, per_story_spend_usd=5.0)
    s = _story(StoryState.SM_DONE, total_attempts=5, total_spend_usd=1.0)
    assert O._story_budget_breaker_reason(s, caps) is None


def test_breaker_reason_trips_on_attempts() -> None:
    caps = CapsConfig(per_story_attempts=20, per_story_spend_usd=5.0)
    s = _story(StoryState.SM_DONE, total_attempts=20, total_spend_usd=0.0)
    reason = O._story_budget_breaker_reason(s, caps)
    assert reason is not None and "per_story_attempts" in reason


def test_breaker_reason_trips_on_spend() -> None:
    caps = CapsConfig(per_story_attempts=20, per_story_spend_usd=5.0)
    s = _story(StoryState.DEV_RETRY, total_attempts=1, total_spend_usd=5.0)
    reason = O._story_budget_breaker_reason(s, caps)
    assert reason is not None and "per_story_spend_usd" in reason


def test_breaker_reason_ignores_non_metered_state() -> None:
    """Even wildly over cap, a story that already reached DEPLOY_PENDING is
    never budget-blocked."""
    caps = CapsConfig(per_story_attempts=1, per_story_spend_usd=0.01)
    s = _story(StoryState.DEPLOY_PENDING, total_attempts=999, total_spend_usd=999.0)
    assert O._story_budget_breaker_reason(s, caps) is None


def test_breaker_disabled_when_cap_is_zero() -> None:
    """A cap of 0 disables that dimension (opt-out), it does not block everything."""
    caps = CapsConfig(per_story_attempts=0, per_story_spend_usd=0.0)
    s = _story(StoryState.SM_DONE, total_attempts=10_000, total_spend_usd=10_000.0)
    assert O._story_budget_breaker_reason(s, caps) is None


# --------------------------------------------------------------------------- #
# Ledger-derived spend helper
# --------------------------------------------------------------------------- #


def _seed_db(tmp_path: Path, rows: list[object]) -> Path:
    db = tmp_path / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(eng)
    with Session(eng) as session:
        for r in rows:
            session.add(r)
        session.commit()
    return db


def test_ledger_spend_sums_runs_for_story(tmp_path: Path) -> None:
    from factory.runner import Run

    story = _story(StoryState.SM_DONE)
    db = _seed_db(tmp_path, [story])
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        sid = session.exec(__import__("sqlmodel").select(StoryRecord)).one().id
    assert sid is not None
    with Session(eng) as session:
        session.add(Run(ts="2026-07-19T00:00:00", persona="dev", model="m", mode="sandbox",
                         cost_usd=1.5, story_id=sid))
        session.add(Run(ts="2026-07-19T00:01:00", persona="review", model="m", mode="text",
                        cost_usd=2.25, story_id=sid))
        session.add(Run(ts="2026-07-19T00:02:00", persona="dev", model="m", mode="sandbox",
                        cost_usd=9.9, story_id=99999))  # other story — excluded
        session.commit()
    assert O._story_ledger_spend_usd(db, sid) == pytest.approx(3.75)


def test_ledger_spend_zero_for_unsaved_story(tmp_path: Path) -> None:
    db = _seed_db(tmp_path, [])
    assert O._story_ledger_spend_usd(db, None) == 0.0


# --------------------------------------------------------------------------- #
# Orchestrator dispatch path
# --------------------------------------------------------------------------- #


def _write_app_and_settings(tmp_path: Path, *, per_story_attempts: int, per_story_spend: float) -> None:
    apps_dir = tmp_path / "apps" / "sacrifice"
    apps_dir.mkdir(parents=True)
    (apps_dir / "config.yaml").write_text(
        "name: sacrifice\nrepo: ssh://placeholder\nrepo_path: /tmp/sacrifice-nonexistent\n",
        encoding="utf-8",
    )
    (tmp_path / "factory_settings.yaml").write_text(
        "caps:\n"
        "  global_concurrent_agents: 2\n"
        "  per_repo_concurrent_agents: 2\n"
        "  daily_spend_usd: 100\n"
        "  hourly_spend_usd: 100\n"
        f"  per_story_attempts: {per_story_attempts}\n"
        f"  per_story_spend_usd: {per_story_spend}\n",
        encoding="utf-8",
    )


def test_over_attempt_cap_trips_before_any_handler_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_app_and_settings(tmp_path, per_story_attempts=3, per_story_spend=100.0)
    story = _story(StoryState.STORY_CREATED, slug="hot", total_attempts=3)
    db = _seed_db(tmp_path, [story])
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        sid = session.exec(__import__("sqlmodel").select(StoryRecord)).one().id

    def _must_not_run(*_a: object, **_k: object) -> H.HandlerResult:
        raise AssertionError("handler dispatched despite budget breaker")

    monkeypatch.setattr(H, "handle_sm", _must_not_run)

    events: list[tuple[int | None, str, dict]] = []
    _real = O.log_story_event

    def _capture(story_id, event_type, payload=None, **kw):  # type: ignore[no-untyped-def]
        events.append((story_id, event_type, payload or {}))
        return _real(story_id, event_type, payload, **kw)

    monkeypatch.setattr(O, "log_story_event", _capture)

    O.tick(tmp_path, "sacrifice", db_path=db, max_advances_per_story=3)

    with Session(eng) as session:
        refreshed = session.get(StoryRecord, sid)
    assert refreshed is not None
    assert refreshed.state == StoryState.BLOCKED_BUDGET_EXCEEDED.value
    budget_events = [e for e in events if e[1] == "budget_exceeded"]
    assert budget_events, "an evidence event must be emitted"
    payload = budget_events[0][2]
    assert payload["total_attempts"] == 3
    assert payload["per_story_attempts"] == 3
    assert "per_story_attempts" in payload["reason"]


def test_over_spend_cap_trips_before_any_handler_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_app_and_settings(tmp_path, per_story_attempts=1000, per_story_spend=5.0)
    story = _story(StoryState.SM_DONE, slug="spendy", total_spend_usd=6.0)
    db = _seed_db(tmp_path, [story])
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        sid = session.exec(__import__("sqlmodel").select(StoryRecord)).one().id

    monkeypatch.setattr(
        H, "handle_dev", lambda *a, **k: (_ for _ in ()).throw(AssertionError("dispatched"))
    )

    O.tick(tmp_path, "sacrifice", db_path=db, max_advances_per_story=3)

    with Session(eng) as session:
        refreshed = session.get(StoryRecord, sid)
    assert refreshed is not None
    assert refreshed.state == StoryState.BLOCKED_BUDGET_EXCEEDED.value
    assert refreshed.last_rejection_reason is not None
    assert "per_story_spend_usd" in refreshed.last_rejection_reason


def test_under_cap_dispatches_normally_and_counts_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_app_and_settings(tmp_path, per_story_attempts=20, per_story_spend=5.0)
    story = _story(StoryState.STORY_CREATED, slug="fresh")
    db = _seed_db(tmp_path, [story])
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        sid = session.exec(__import__("sqlmodel").select(StoryRecord)).one().id

    ran: list[bool] = []

    def _fake_sm(story: StoryRecord, *_a: object, **_k: object) -> H.HandlerResult:
        ran.append(True)
        story.state = StoryState.SM_DONE.value
        H.persist_story(story, db_path=db)
        return H.HandlerResult(next_state=StoryState.SM_DONE)

    monkeypatch.setattr(H, "handle_sm", _fake_sm)

    O.tick(tmp_path, "sacrifice", db_path=db, max_advances_per_story=1)

    assert ran, "handler should have been dispatched for an under-cap story"
    with Session(eng) as session:
        refreshed = session.get(StoryRecord, sid)
    assert refreshed is not None
    assert refreshed.state == StoryState.SM_DONE.value
    # WS1.1 advance-decay: the dispatch bumped total_attempts to 1, but it also
    # advanced the story to a NEW happy-path milestone (SM_DONE), so the attempt
    # counter is reset to 0 and the progress high-water mark is recorded. An
    # advancing story is deliberately never penalised on the attempt budget.
    assert refreshed.total_attempts == 0
    assert refreshed.max_progress_ordinal == O._progress_ordinal(
        StoryState.SM_DONE.value
    )


# --------------------------------------------------------------------------- #
# Metered-set derivation invariant + transition coverage
# --------------------------------------------------------------------------- #


def test_metered_set_is_derived_from_dispatch() -> None:
    """The breaker's metered set MUST be derived from the single source of
    truth (``_DISPATCH``) minus DEPLOY_PENDING, so a future dispatch state
    can't silently escape the breaker."""
    assert O._BUDGET_METERED_STATES == frozenset(O._DISPATCH) - {StoryState.DEPLOY_PENDING}
    # DEPLOY_PENDING is a dispatch state that is deliberately NOT metered.
    assert StoryState.DEPLOY_PENDING in O._DISPATCH
    assert StoryState.DEPLOY_PENDING not in O._BUDGET_METERED_STATES


def test_every_metered_state_has_budget_transition() -> None:
    """Every metered state must have an EVENT_BUDGET_EXCEEDED edge to the
    terminal sink — otherwise ``advance`` would raise IllegalTransitionError
    at dispatch time and crash a live tick. This test catches a new dispatch
    state added without its breaker transition."""
    for src in O._BUDGET_METERED_STATES:
        s = _story(src)
        assert advance(s, EVENT_BUDGET_EXCEEDED) == StoryState.BLOCKED_BUDGET_EXCEEDED, src


# --------------------------------------------------------------------------- #
# Transient ledger-read fail-safe (MAJOR 1)
# --------------------------------------------------------------------------- #


def test_ledger_spend_returns_none_on_read_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A transient read failure must return None (caller keeps prior value),
    NEVER a sentinel like inf that would poison the accumulator."""
    monkeypatch.setattr("time.sleep", lambda *_a, **_k: None)  # don't actually sleep
    bad_db = tmp_path / "not-a-db-dir"
    bad_db.mkdir()  # a directory is not a usable sqlite file → OperationalError
    assert O._story_ledger_spend_usd(bad_db, story_id=123) is None


def test_transient_read_does_not_poison_accumulator_or_trip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end: if the ledger read fails during a dispatch, the story keeps
    its prior (healthy, under-cap) total_spend_usd and advances normally — a
    transient sqlite lock must NOT trip the terminal breaker."""
    _write_app_and_settings(tmp_path, per_story_attempts=20, per_story_spend=5.0)
    story = _story(StoryState.STORY_CREATED, slug="healthy", total_spend_usd=2.0)
    db = _seed_db(tmp_path, [story])
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        sid = session.exec(__import__("sqlmodel").select(StoryRecord)).one().id

    def _fake_sm(story: StoryRecord, *_a: object, **_k: object) -> H.HandlerResult:
        story.state = StoryState.SM_DONE.value
        H.persist_story(story, db_path=db)
        return H.HandlerResult(next_state=StoryState.SM_DONE)

    monkeypatch.setattr(H, "handle_sm", _fake_sm)
    # Simulate a transient read failure for the whole tick.
    monkeypatch.setattr(O, "_story_ledger_spend_usd", lambda *_a, **_k: None)

    O.tick(tmp_path, "sacrifice", db_path=db, max_advances_per_story=1)

    with Session(eng) as session:
        refreshed = session.get(StoryRecord, sid)
    assert refreshed is not None
    # Advanced normally — NOT tripped into the terminal budget sink.
    assert refreshed.state == StoryState.SM_DONE.value
    # Prior accumulator preserved (not overwritten with a sentinel).
    assert refreshed.total_spend_usd == pytest.approx(2.0)


# --------------------------------------------------------------------------- #
# Accumulator hooks: exception-path increment + success-path spend refresh
# --------------------------------------------------------------------------- #


def test_crashing_handler_still_counts_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """total_attempts is bumped BEFORE invoking the handler, so a handler that
    advances to *_in_progress and then crashes still burns an attempt (and the
    story rolls back so the next tick can retry)."""
    _write_app_and_settings(tmp_path, per_story_attempts=20, per_story_spend=5.0)
    story = _story(StoryState.STORY_CREATED, slug="boom")
    db = _seed_db(tmp_path, [story])
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        sid = session.exec(__import__("sqlmodel").select(StoryRecord)).one().id

    def _boom_sm(story: StoryRecord, *_a: object, **_k: object) -> H.HandlerResult:
        story.state = StoryState.SM_IN_PROGRESS.value
        H.persist_story(story, db_path=db)
        raise RuntimeError("simulated crash")

    monkeypatch.setattr(H, "handle_sm", _boom_sm)

    O.tick(tmp_path, "sacrifice", db_path=db, max_advances_per_story=1)

    with Session(eng) as session:
        refreshed = session.get(StoryRecord, sid)
    assert refreshed is not None
    # Rolled back for retry, but the burned attempt is still counted.
    assert refreshed.state == StoryState.STORY_CREATED.value
    assert refreshed.total_attempts == 1


def test_successful_dispatch_refreshes_spend_from_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After a successful dispatch, total_spend_usd is refreshed from the D003
    per-run ledger (runs.cost_usd attributed to this story)."""
    from factory.runner import Run

    _write_app_and_settings(tmp_path, per_story_attempts=20, per_story_spend=100.0)
    story = _story(StoryState.STORY_CREATED, slug="costed")
    db = _seed_db(tmp_path, [story])
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        sid = session.exec(__import__("sqlmodel").select(StoryRecord)).one().id
    # Seed a ledger row attributed to this story (as a real handler run would).
    with Session(eng) as session:
        session.add(
            Run(ts="2026-07-19T00:00:00", persona="sm", model="m", mode="sandbox",
                cost_usd=1.25, story_id=sid)
        )
        session.commit()

    def _fake_sm(story: StoryRecord, *_a: object, **_k: object) -> H.HandlerResult:
        story.state = StoryState.SM_DONE.value
        H.persist_story(story, db_path=db)
        return H.HandlerResult(next_state=StoryState.SM_DONE)

    monkeypatch.setattr(H, "handle_sm", _fake_sm)

    O.tick(tmp_path, "sacrifice", db_path=db, max_advances_per_story=1)

    with Session(eng) as session:
        refreshed = session.get(StoryRecord, sid)
    assert refreshed is not None
    assert refreshed.state == StoryState.SM_DONE.value
    assert refreshed.total_spend_usd == pytest.approx(1.25)
