"""``_prune_stale_in_progress`` recovers stories stranded in ``*_in_progress``.

Real-world trigger: a tick gets killed mid-sandbox, or the retry cap is
lowered while a row is mid-attempt. The row's state stays in
``dev_in_progress`` / ``sm_in_progress`` / etc. forever — the dispatch
table returns ``None`` for those states, so the chain can't nudge them
forward without operator surgery.

These tests exercise the recovery pass end-to-end against a real
SQLite DB seeded with the relevant edge cases.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine, select

from factory.chain.handlers import _MAX_DEV_RETRIES, persist_story
from factory.chain.orchestrator import _STALE_THRESHOLD_SECONDS, _prune_stale_in_progress
from factory.chain.state_machine import StoryRecord, StoryState
from factory.settings.loader import FactorySettings


def _seed_db(tmp_path: Path) -> Path:
    db = tmp_path / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(eng)
    return db


def _story(
    db: Path,
    *,
    state: str,
    updated_at: datetime,
    dev_retries: int = 0,
    app: str = "sacrifice",
    slug: str = "s",
) -> StoryRecord:
    record = StoryRecord(
        direction_id="099",
        app=app,
        title="t",
        slug=slug,
        scope="backend",
        state=state,
        dev_retries=dev_retries,
    )
    saved = persist_story(record, db)
    # ``persist_story`` stamps ``updated_at = now`` — defeats the staleness
    # fixture. Force the desired timestamp via a raw update so the recovery
    # pass sees the row as old.
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        row = session.exec(
            select(StoryRecord).where(StoryRecord.id == saved.id)
        ).one()
        row.updated_at = updated_at.isoformat()
        row.created_at = updated_at.isoformat()
        session.add(row)
        session.commit()
        session.refresh(row)
    return row


def test_old_dev_in_progress_recovers_to_dev_retry(tmp_path: Path) -> None:
    """The headline case: a dev_in_progress row stranded longer than the
    threshold gets rolled back to DEV_RETRY so the chain can re-dispatch."""
    db = _seed_db(tmp_path)
    old = datetime.now(UTC) - timedelta(seconds=_STALE_THRESHOLD_SECONDS + 1)
    _story(db, state="dev_in_progress", updated_at=old, dev_retries=2)

    recovered = _prune_stale_in_progress(
        db, "sacrifice", settings=FactorySettings(), root=tmp_path
    )
    assert len(recovered) == 1
    slug, from_state, to_state = recovered[0]
    assert from_state == "dev_in_progress"
    assert to_state == "dev_retry"


def test_fresh_in_progress_is_left_alone(tmp_path: Path) -> None:
    """A handler that started 30 seconds ago is still running — recovering
    it would race the live sandbox."""
    db = _seed_db(tmp_path)
    fresh = datetime.now(UTC) - timedelta(seconds=30)
    _story(db, state="dev_in_progress", updated_at=fresh, dev_retries=1)

    recovered = _prune_stale_in_progress(
        db, "sacrifice", settings=FactorySettings(), root=tmp_path
    )
    assert recovered == []


def test_terminal_states_are_skipped(tmp_path: Path) -> None:
    db = _seed_db(tmp_path)
    old = datetime.now(UTC) - timedelta(hours=24)
    _story(db, state="deployed", updated_at=old, slug="done")
    _story(db, state="blocked_tests_need_clarification", updated_at=old, slug="blocked")
    _story(db, state="pr_open", updated_at=old, slug="pr")

    recovered = _prune_stale_in_progress(
        db, "sacrifice", settings=FactorySettings(), root=tmp_path
    )
    assert recovered == []


def test_dev_retries_clamps_to_cap_minus_one_when_over(tmp_path: Path) -> None:
    """A row stranded under the OLD cap=10 regime should be clamped to
    ``_MAX_DEV_RETRIES - 1`` so the next dispatch gives it one fresh shot
    instead of insta-exhausting on a stale count."""
    db = _seed_db(tmp_path)
    old = datetime.now(UTC) - timedelta(hours=2)
    _story(db, state="dev_in_progress", updated_at=old, dev_retries=9, slug="bigretries")

    _prune_stale_in_progress(db, "sacrifice", settings=FactorySettings(), root=tmp_path)

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        row = session.exec(
            select(StoryRecord).where(StoryRecord.slug == "bigretries")
        ).one()
    assert row.dev_retries == _MAX_DEV_RETRIES - 1
    assert row.state == "dev_retry"


def test_dev_retries_under_cap_is_preserved(tmp_path: Path) -> None:
    """If the stranded row's retries are already under the cap, leave the
    counter alone — the operator's diagnostic relies on the actual count."""
    db = _seed_db(tmp_path)
    old = datetime.now(UTC) - timedelta(hours=2)
    _story(db, state="dev_in_progress", updated_at=old, dev_retries=1, slug="lowretries")

    _prune_stale_in_progress(db, "sacrifice", settings=FactorySettings(), root=tmp_path)

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        row = session.exec(
            select(StoryRecord).where(StoryRecord.slug == "lowretries")
        ).one()
    assert row.dev_retries == 1


def test_all_in_progress_states_have_recovery_mapping(tmp_path: Path) -> None:
    """Every ``*_in_progress`` state in the enum must have a recovery
    target — otherwise the cleanup pass leaves rows stranded."""
    from factory.chain.orchestrator import _STALE_RECOVERY_MAP

    in_progress_states = {
        s.value for s in StoryState if s.value.endswith("_in_progress")
    }
    missing = in_progress_states - set(_STALE_RECOVERY_MAP.keys())
    assert not missing, f"states without recovery mapping: {missing}"


def test_recovery_logs_event_per_story(tmp_path: Path) -> None:
    """The cleanup pass writes a ``stale_recovery`` JSONL line to each
    affected story's event log — operators can audit via ``factory trace``."""
    db = _seed_db(tmp_path)
    old = datetime.now(UTC) - timedelta(hours=1)
    _story(db, state="dev_in_progress", updated_at=old, slug="audited")

    _prune_stale_in_progress(db, "sacrifice", settings=FactorySettings(), root=tmp_path)

    log_path = tmp_path / "state" / "logs"
    assert log_path.exists()
    log_files = list(log_path.glob("*audited*.log"))
    assert log_files, f"expected a per-story log under {log_path}"
    body = log_files[0].read_text(encoding="utf-8")
    assert "stale_recovery" in body
    assert "dev_in_progress" in body
    assert "dev_retry" in body


def test_recovery_scoped_to_app(tmp_path: Path) -> None:
    """Stories belonging to a different app aren't touched by the
    sacrifice-scoped recovery pass."""
    db = _seed_db(tmp_path)
    old = datetime.now(UTC) - timedelta(hours=2)
    _story(db, state="dev_in_progress", updated_at=old, slug="s1", app="sacrifice")
    _story(db, state="dev_in_progress", updated_at=old, slug="o1", app="other_app")

    recovered = _prune_stale_in_progress(
        db, "sacrifice", settings=FactorySettings(), root=tmp_path
    )
    assert [r[0] for r in recovered] == ["s1"]


def test_recovery_handles_unparseable_timestamps(tmp_path: Path) -> None:
    """A row with a garbage ``updated_at`` is treated as ancient and
    recovered — better to nudge than to leave it stuck forever."""
    db = _seed_db(tmp_path)
    record = StoryRecord(
        direction_id="x",
        app="sacrifice",
        title="t",
        slug="garbo",
        scope="backend",
        state="dev_in_progress",
        dev_retries=2,
    )
    saved = persist_story(record, db)
    # Force garbage timestamps via raw update (persist_story stamps now).
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        row = session.exec(
            select(StoryRecord).where(StoryRecord.id == saved.id)
        ).one()
        row.updated_at = "not-a-timestamp"
        row.created_at = "also-broken"
        session.add(row)
        session.commit()

    recovered = _prune_stale_in_progress(
        db, "sacrifice", settings=FactorySettings(), root=tmp_path
    )
    assert recovered == [("garbo", "dev_in_progress", "dev_retry")]


def test_boundary_exactly_at_threshold_fires(tmp_path: Path) -> None:
    """E1 (BENCHMARK-READINESS-PLAN.md): the plan calls out that this pass has
    'never been observed firing' at exactly 10 min in a live run. Pin the exact
    boundary with an explicit ``now=`` so the check is deterministic, not a race
    against wall-clock time. The comparison in ``_prune_stale_in_progress`` is
    ``if (now - updated) < _STALE_THRESHOLD_SECONDS: continue`` — so a row whose
    age EQUALS the threshold is NOT skipped, i.e. it recovers on the dot."""
    db = _seed_db(tmp_path)
    fixed_now = datetime(2026, 1, 1, tzinfo=UTC)
    exactly_at_threshold = fixed_now - timedelta(seconds=_STALE_THRESHOLD_SECONDS)
    _story(db, state="dev_in_progress", updated_at=exactly_at_threshold, slug="boundary")

    recovered = _prune_stale_in_progress(
        db, "sacrifice", settings=FactorySettings(), root=tmp_path, now=fixed_now
    )
    assert len(recovered) == 1
    assert recovered[0][0] == "boundary"


def test_boundary_one_second_under_threshold_is_not_yet_stale(tmp_path: Path) -> None:
    """The other side of the same boundary: one second YOUNGER than the
    threshold must NOT recover, with the same fixed ``now=`` so the two tests
    bracket the exact cutover with no wall-clock slop."""
    db = _seed_db(tmp_path)
    fixed_now = datetime(2026, 1, 1, tzinfo=UTC)
    just_under_threshold = fixed_now - timedelta(seconds=_STALE_THRESHOLD_SECONDS - 1)
    _story(db, state="dev_in_progress", updated_at=just_under_threshold, slug="justunder")

    recovered = _prune_stale_in_progress(
        db, "sacrifice", settings=FactorySettings(), root=tmp_path, now=fixed_now
    )
    assert recovered == []


def test_recovery_idempotent_on_second_run(tmp_path: Path) -> None:
    """Recovering twice has no effect on the second pass — once a row is
    back in ``dev_retry`` it's no longer matched by the recovery map."""
    db = _seed_db(tmp_path)
    old = datetime.now(UTC) - timedelta(hours=1)
    _story(db, state="dev_in_progress", updated_at=old)

    first = _prune_stale_in_progress(
        db, "sacrifice", settings=FactorySettings(), root=tmp_path
    )
    second = _prune_stale_in_progress(
        db, "sacrifice", settings=FactorySettings(), root=tmp_path
    )
    assert len(first) == 1
    assert second == []
