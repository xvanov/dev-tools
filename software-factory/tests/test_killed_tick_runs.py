"""A tick killed mid-step: its run row is closed, a live step is never recovered.

2026-11-08 (job dev-tools:013): serve killed the dev-tools tick 58 min into a
solo dev step. The step's provisional ``runs`` row (run 37) stayed ``running``
for good, and the next tick's stale pass moved the story to ``dev_retry``. The
recovery was right there (the tick was dead); these tests pin that it is only
ever right when the owning process is gone.
"""

from __future__ import annotations

import os
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine, select

from factory import runner
from factory.chain.handlers import persist_story
from factory.chain.orchestrator import _STALE_THRESHOLD_SECONDS, _prune_stale_in_progress
from factory.chain.state_machine import StoryRecord
from factory.jobs.status import _run_state
from factory.observability.heartbeat import start_heartbeat
from factory.observability.schema import migrate
from factory.settings.loader import FactorySettings

_DEAD_PID = 999_999_001


def _provisional(db: Path, *, story_id: int) -> int:
    row_id = runner._upsert_provisional_run(
        None,
        db_path=db,
        persona="dev",
        model="m",
        tokens_in=10,
        tokens_out=5,
        cached_input_tokens=0,
        cost_usd=2.98,
        duration_s=3478.0,
        story_path=None,
        repo_path=None,
        story_id=story_id,
        model_tier="standard",
        direction_id="d",
        app="dev-tools",
    )
    assert row_id is not None
    return row_id


def _rows(db: Path) -> dict[int, dict[str, object]]:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        return {int(r["id"]): dict(r) for r in conn.execute("SELECT * FROM runs")}
    finally:
        conn.close()


def test_provisional_row_records_its_owner(tmp_path: Path) -> None:
    db = tmp_path / "factory.db"
    rid = _provisional(db, story_id=11)
    assert _rows(db)[rid]["owner_pid"] == os.getpid()


def test_rows_of_a_dead_owner_are_closed_as_failed(tmp_path: Path) -> None:
    db = tmp_path / "factory.db"
    dead = _provisional(db, story_id=11)
    live = _provisional(db, story_id=12)
    unowned = _provisional(db, story_id=13)  # e.g. a claude_session row
    conn = sqlite3.connect(db)
    conn.execute("UPDATE runs SET owner_pid = ? WHERE id = ?", (_DEAD_PID, dead))
    conn.execute("UPDATE runs SET owner_pid = NULL WHERE id = ?", (unowned,))
    conn.commit()
    conn.close()

    closed = runner.close_orphaned_provisional_runs(
        db, reason="tick dev-tools killed after 3600s", alive=lambda pid: pid != _DEAD_PID
    )

    assert closed == [dead]
    rows = _rows(db)
    assert _run_state(rows[dead]) == "failed"
    assert "killed: owner process" in str(rows[dead]["error"])
    assert "tick dev-tools killed after 3600s" in str(rows[dead]["error"])
    assert rows[dead]["cost_usd"] == 2.98  # booked spend stays on the ledger
    assert _run_state(rows[live]) == "running"
    assert _run_state(rows[unowned]) == "running"
    # Idempotent: a second pass finds nothing left to close.
    assert (
        runner.close_orphaned_provisional_runs(db, reason="again", alive=lambda p: p != _DEAD_PID)
        == []
    )


def test_final_rows_are_never_touched(tmp_path: Path) -> None:
    db = tmp_path / "factory.db"
    rid = _provisional(db, story_id=11)
    conn = sqlite3.connect(db)
    conn.execute(
        "UPDATE runs SET error = NULL, success = 1, owner_pid = ? WHERE id = ?", (_DEAD_PID, rid)
    )
    conn.commit()
    conn.close()
    assert runner.close_orphaned_provisional_runs(db, reason="x", alive=lambda p: False) == []
    assert _rows(db)[rid]["success"] == 1


# --------------------------------------------------------------------------- #
# _prune_stale_in_progress must not recover a story whose step is still live
# --------------------------------------------------------------------------- #


def _stale_dev_story(db: Path) -> StoryRecord:
    saved = persist_story(
        StoryRecord(
            direction_id="099", app="dev-tools", title="t", slug="s", scope="backend",
            state="dev_in_progress",
        ),
        db,
    )
    old = (datetime.now(UTC) - timedelta(seconds=_STALE_THRESHOLD_SECONDS + 600)).isoformat()
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        row = session.exec(select(StoryRecord).where(StoryRecord.id == saved.id)).one()
        row.updated_at = old
        row.created_at = old
        session.add(row)
        session.commit()
        session.refresh(row)
    return row


def _db(tmp_path: Path) -> Path:
    db = tmp_path / "factory.db"
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}", echo=False))
    migrate(db)
    return db


def test_a_story_with_a_live_handler_is_not_recovered(tmp_path: Path) -> None:
    """A solo dev step runs 5400 s without touching the story row; a heartbeat
    from a live process (another tick still running it) must protect it."""
    db = _db(tmp_path)
    story = _stale_dev_story(db)
    start_heartbeat(db, persona="dev", model="m", mode="sandbox", story_id=story.id, app="dev-tools")

    assert _prune_stale_in_progress(db, "dev-tools", settings=FactorySettings(), root=tmp_path) == []


def test_a_story_whose_handler_died_is_recovered(tmp_path: Path) -> None:
    db = _db(tmp_path)
    story = _stale_dev_story(db)
    hb = start_heartbeat(
        db, persona="dev", model="m", mode="sandbox", story_id=story.id, app="dev-tools"
    )
    conn = sqlite3.connect(db)
    conn.execute("UPDATE live_handlers SET pid = ? WHERE id = ?", (_DEAD_PID, hb))
    conn.commit()
    conn.close()

    recovered = _prune_stale_in_progress(db, "dev-tools", settings=FactorySettings(), root=tmp_path)
    assert [(f, t) for _, f, t in recovered] == [("dev_in_progress", "dev_retry")]
