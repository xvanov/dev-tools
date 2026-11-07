"""Tests for the ``stalled_stories`` liveness detector.

This detector closes the monitoring blind spot where a silently-stuck factory
emitted no events, the windowed detectors saw an empty window, and the watcher
reported "quiet, healthy." These tests assert it fires on ABSOLUTE state aging
regardless of event activity.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from factory.manager.detectors import DETECTORS
from factory.manager.detectors.stalled_stories import stalled_stories


def _make_db(root: Path, rows: list[tuple[int, str, str]]) -> None:
    """Seed a minimal stories table. rows = (id, state, updated_at_iso)."""
    (root / "state").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(root / "state" / "factory.db"))
    conn.execute(
        "CREATE TABLE stories (id INTEGER PRIMARY KEY, state TEXT, app TEXT, "
        "slug TEXT, updated_at TEXT)"
    )
    conn.executemany(
        "INSERT INTO stories (id, state, app, slug, updated_at) VALUES (?,?,?,?,?)",
        [(i, st, "sacrifice", f"s{i}", ts) for (i, st, ts) in rows],
    )
    conn.commit()
    conn.close()


def _write_tick(root: Path, ts: datetime) -> None:
    stream = root / "state" / "events" / "ticks.ndjson"
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_text(json.dumps({"ts": ts.isoformat(), "event": "tick"}) + "\n")


def test_is_registered() -> None:
    assert "stalled_stories" in DETECTORS


def test_empty_when_everything_fresh(tmp_path: Path) -> None:
    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    fresh = (now - timedelta(minutes=2)).isoformat()
    _make_db(tmp_path, [(1, "dev_in_progress", fresh), (2, "sm_done", fresh)])
    _write_tick(tmp_path, now - timedelta(minutes=1))

    res = stalled_stories(root=tmp_path, now=now)
    assert res["alarms"] == []
    assert res["stuck_in_progress"] == []
    assert res["stalled"] == []
    assert res["no_tick_recently"] is False


def test_stuck_in_progress_fires(tmp_path: Path) -> None:
    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    old = (now - timedelta(minutes=45)).isoformat()
    _make_db(tmp_path, [(7, "dev_in_progress", old)])
    _write_tick(tmp_path, now - timedelta(minutes=1))

    res = stalled_stories(root=tmp_path, now=now)
    assert len(res["stuck_in_progress"]) == 1
    assert res["stuck_in_progress"][0]["story_id"] == 7
    assert res["alarms"], "a stuck-in-progress story must raise an alarm"


def test_stalled_nonterminal_fires(tmp_path: Path) -> None:
    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    old = (now - timedelta(minutes=200)).isoformat()
    _make_db(tmp_path, [(9, "sm_done", old)])
    _write_tick(tmp_path, now - timedelta(minutes=1))

    res = stalled_stories(root=tmp_path, now=now)
    assert len(res["stalled"]) == 1
    assert res["stalled"][0]["story_id"] == 9
    assert res["alarms"]


def test_terminal_states_never_alarm(tmp_path: Path) -> None:
    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    ancient = (now - timedelta(days=3)).isoformat()
    _make_db(
        tmp_path,
        [
            (1, "deployed", ancient),
            (2, "blocked_review_nonconvergent", ancient),
            (3, "blocked_tests_need_clarification", ancient),
            # A dual-draft loser and a budget-exhausted story are terminal too:
            # aging in them must NOT raise a stall alarm (else concern-spam).
            (4, "superseded_by_sibling", ancient),
            (5, "blocked_budget_exceeded", ancient),
            # A dependency-deferral CAP park: the cap's whole design is to park
            # a capped dependent here to await a human, so it is now a NORMAL
            # destination, not a rarity. Aging here must not re-alarm either.
            (6, "blocked_dependency_unmet", ancient),
        ],
    )
    _write_tick(tmp_path, now - timedelta(minutes=1))

    res = stalled_stories(root=tmp_path, now=now)
    assert res["alarms"] == []
    assert res["non_terminal_total"] == 0


def test_no_tick_recently_fires_even_with_no_stories(tmp_path: Path) -> None:
    """The core blind-spot case: nothing in flight, but the drive loop is dead.
    The old windowed watcher reported 'quiet'; this must report an alarm."""
    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    _make_db(tmp_path, [])
    _write_tick(tmp_path, now - timedelta(minutes=42))

    res = stalled_stories(root=tmp_path, now=now)
    assert res["no_tick_recently"] is True
    assert res["minutes_since_last_tick"] == 42.0
    assert any("drive loop" in a for a in res["alarms"])


def test_does_not_depend_on_event_window(tmp_path: Path) -> None:
    """Unlike the windowed detectors, stalled_stories takes no ``since`` and
    fires purely on absolute aging — proving it sees a silent stall."""
    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    old = (now - timedelta(minutes=300)).isoformat()
    _make_db(tmp_path, [(1, "tests_green", old), (2, "reviewer_in_progress", old)])
    # No tick stream at all → minutes_since_last_tick is None, not an alarm.
    res = stalled_stories(root=tmp_path, now=now)
    assert res["minutes_since_last_tick"] is None
    assert res["no_tick_recently"] is False
    # But the two aged non-terminal stories still alarm.
    assert len(res["stalled"]) + len(res["stuck_in_progress"]) == 2
    assert res["alarms"]


def test_aged_backlog_suppressed_while_actively_draining(tmp_path: Path) -> None:
    """Old queued stories are NOT an alarm while the factory is visibly
    working: recent tick + a recently-updated story means the queue is
    draining serially. Alarming here caused an L1->L2->L3 churn loop on
    every watcher cycle during a healthy post-recovery drain (2026-06-11)."""
    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    old = (now - timedelta(hours=10)).isoformat()
    fresh = (now - timedelta(minutes=3)).isoformat()
    _make_db(
        tmp_path,
        [(1, "sm_done", old), (2, "sm_done", old), (3, "tests_green", fresh)],
    )
    _write_tick(tmp_path, now - timedelta(minutes=1))

    res = stalled_stories(root=tmp_path, now=now)
    assert res["draining"] is True
    assert res["stalled"] == [], "not presented as 'stalled' while draining"
    assert res["aged_backlog_while_draining"], "aged stories still reported, neutrally"
    assert res["alarms"] == [], "and not alarmed while draining"


def test_aged_backlog_still_alarms_when_factory_idle(tmp_path: Path) -> None:
    """The original blind spot stays covered: a dead factory (no recent story
    updates, no recent tick) with an aged backlog must alarm."""
    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    old = (now - timedelta(hours=10)).isoformat()
    _make_db(tmp_path, [(1, "sm_done", old), (2, "tests_green", old)])
    _write_tick(tmp_path, now - timedelta(hours=9))

    res = stalled_stories(root=tmp_path, now=now)
    assert res["draining"] is False
    assert any("no state change" in a for a in res["alarms"])
    assert any("no orchestrator tick" in a for a in res["alarms"])


def test_long_inflight_tick_with_live_handler_is_not_tick_silence(tmp_path: Path) -> None:
    """A serial tick can run >tick_silence_minutes with only tick_start
    written. With a live handler row present (a dev sandbox mid-run), that
    silence is expected — no no-tick alarm."""
    import json as _json

    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    old = (now - timedelta(hours=10)).isoformat()
    _make_db(tmp_path, [(1, "sm_done", old), (2, "dev_in_progress", (now - timedelta(minutes=5)).isoformat())])
    conn = sqlite3.connect(str(tmp_path / "state" / "factory.db"))
    conn.execute("CREATE TABLE live_handlers (id INTEGER PRIMARY KEY, persona TEXT)")
    conn.execute("INSERT INTO live_handlers (persona) VALUES ('dev')")
    conn.commit()
    conn.close()
    stream = tmp_path / "state" / "events" / "ticks.ndjson"
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_text(
        _json.dumps({"ts": (now - timedelta(minutes=40)).isoformat(), "event": "tick_start"}) + "\n"
    )

    res = stalled_stories(root=tmp_path, now=now)
    assert res["tick_in_flight"] is True
    assert res["live_handlers_active"] == 1
    assert res["no_tick_recently"] is False
    assert res["alarms"] == []


def test_crashed_tick_dangling_start_still_alarms(
    tmp_path: Path, monkeypatch
) -> None:
    """A tick_start with no tick_end AND no live handlers AND no recent
    story updates AND no running tick process is a crashed tick — silence
    must still alarm. (The process check is monkeypatched: a real factory
    tick may be running on the host during the test.)"""
    import json as _json
    import sys

    # detectors/__init__ re-exports the function under the submodule's name,
    # so attribute-style import resolves to the function; go via sys.modules.
    mod = sys.modules["factory.manager.detectors.stalled_stories"]
    monkeypatch.setattr(mod, "_tick_process_alive", lambda: False)

    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    old = (now - timedelta(hours=10)).isoformat()
    _make_db(tmp_path, [(1, "sm_done", old)])
    stream = tmp_path / "state" / "events" / "ticks.ndjson"
    stream.parent.mkdir(parents=True, exist_ok=True)
    stream.write_text(
        _json.dumps({"ts": (now - timedelta(hours=2)).isoformat(), "event": "tick_start"}) + "\n"
    )

    res = stalled_stories(root=tmp_path, now=now)
    assert res["tick_in_flight"] is True
    assert res["no_tick_recently"] is True
    assert any("no orchestrator tick" in a for a in res["alarms"])


# ---------------------------------------------------------------------------
# healthy_drain (WS0.2)
# ---------------------------------------------------------------------------


def _write_idle(root: Path, ts: datetime) -> None:
    """Append an app_idle event to state/events/idle.ndjson."""
    stream = root / "state" / "events" / "idle.ndjson"
    stream.parent.mkdir(parents=True, exist_ok=True)
    with stream.open("a", encoding="utf-8") as fh:
        fh.write(
            json.dumps({"ts": ts.isoformat(), "event": "app_idle", "app": "sacrifice"})
            + "\n"
        )


def test_healthy_drain_true_on_drained_idle(tmp_path: Path) -> None:
    """No alarms + draining + recent app_idle -> healthy_drain=true."""
    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    fresh = (now - timedelta(minutes=2)).isoformat()  # keeps the chain "draining"
    aged = (now - timedelta(hours=4)).isoformat()  # aged backlog, non-terminal
    _make_db(tmp_path, [(1, "story_created", fresh), (2, "story_created", aged)])
    _write_tick(tmp_path, now - timedelta(minutes=1))
    _write_idle(tmp_path, now - timedelta(minutes=3))

    res = stalled_stories(root=tmp_path, now=now)
    assert res["alarms"] == []
    assert res["draining"] is True
    assert res["idle_recently"] is True
    assert res["healthy_drain"] is True
    # The aged story is surfaced under the neutral key, not as a stall.
    assert res["stalled"] == []
    assert res["aged_backlog_while_draining"]


def test_healthy_drain_false_without_recent_idle(tmp_path: Path) -> None:
    """Draining but no recent app_idle -> healthy_drain=false."""
    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    fresh = (now - timedelta(minutes=2)).isoformat()
    aged = (now - timedelta(hours=4)).isoformat()
    _make_db(tmp_path, [(1, "story_created", fresh), (2, "story_created", aged)])
    _write_tick(tmp_path, now - timedelta(minutes=1))
    # No idle event at all.

    res = stalled_stories(root=tmp_path, now=now)
    assert res["draining"] is True
    assert res["idle_recently"] is False
    assert res["healthy_drain"] is False


def test_healthy_drain_false_on_real_stall(tmp_path: Path, monkeypatch) -> None:
    """A genuine stall (tick loop dead) never reads as a healthy drain, even
    with a stale idle event on disk."""
    import sys

    mod = sys.modules["factory.manager.detectors.stalled_stories"]
    monkeypatch.setattr(mod, "_tick_process_alive", lambda: False)

    now = datetime(2026, 5, 30, 12, 0, tzinfo=UTC)
    old = (now - timedelta(hours=10)).isoformat()
    _make_db(tmp_path, [(1, "sm_done", old)])
    _write_tick(tmp_path, now - timedelta(hours=2))  # no recent tick -> stall
    _write_idle(tmp_path, now - timedelta(hours=2))  # stale idle

    res = stalled_stories(root=tmp_path, now=now)
    assert res["alarms"]  # a real stall alarms
    assert res["draining"] is False
    assert res["healthy_drain"] is False
