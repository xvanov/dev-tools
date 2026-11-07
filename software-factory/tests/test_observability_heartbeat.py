"""Tests for heartbeat start/end/reap helpers."""

from __future__ import annotations

import os
from pathlib import Path


def test_start_and_end_heartbeat_roundtrip(tmp_path: Path) -> None:
    from factory.observability.heartbeat import (
        end_heartbeat,
        live_handler,
        start_heartbeat,
    )
    from factory.observability.queries import live_handlers

    db = tmp_path / "factory.db"
    hb_id = start_heartbeat(
        db,
        persona="dev",
        model="claude-opus-4-7",
        mode="sandbox",
        story_id=42,
        app="sacrifice",
        direction_id="007-foo",
    )
    assert hb_id > 0

    rows = live_handlers(db)
    assert len(rows) == 1
    assert rows[0].persona == "dev"
    assert rows[0].story_id == 42
    assert rows[0].app == "sacrifice"
    assert rows[0].elapsed_seconds >= 0

    end_heartbeat(db, hb_id)
    assert live_handlers(db) == []

    # context-manager form
    with live_handler(db, persona="pm", model="claude-sonnet-4-6", mode="text"):
        assert len(live_handlers(db)) == 1
    assert live_handlers(db) == []


def test_reap_stale_heartbeats_removes_dead_pids(tmp_path: Path) -> None:
    from factory.observability.heartbeat import reap_stale_heartbeats
    from factory.observability.schema import migrate

    db = tmp_path / "factory.db"
    migrate(db)
    import sqlite3

    conn = sqlite3.connect(str(db))
    # Insert a row with our own pid (alive) and one with a guaranteed-dead pid.
    conn.execute(
        "INSERT INTO live_handlers (started_at, persona, model, mode, pid) "
        "VALUES (?, ?, ?, ?, ?)",
        ("2026-05-26T00:00:00+00:00", "dev", "x", "text", os.getpid()),
    )
    # 1 is init (usually unreachable for non-root); use a very large pid as a
    # safer "definitely dead" value across containerized + bare-metal hosts.
    conn.execute(
        "INSERT INTO live_handlers (started_at, persona, model, mode, pid) "
        "VALUES (?, ?, ?, ?, ?)",
        ("2026-05-26T00:00:00+00:00", "pm", "y", "text", 2_000_000),
    )
    conn.commit()
    conn.close()

    removed = reap_stale_heartbeats(db)
    assert removed == 1

    # Live row survived.
    conn = sqlite3.connect(str(db))
    rows = conn.execute("SELECT persona FROM live_handlers").fetchall()
    conn.close()
    assert [r[0] for r in rows] == ["dev"]
