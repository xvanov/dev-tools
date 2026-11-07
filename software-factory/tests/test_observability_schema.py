"""Tests for the observability schema migration helper."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest


def _columns(db: Path, table: str) -> set[str]:
    conn = sqlite3.connect(str(db))
    try:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    finally:
        conn.close()


def _tables(db: Path) -> set[str]:
    conn = sqlite3.connect(str(db))
    try:
        return {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
    finally:
        conn.close()


def test_migrate_creates_new_tables_from_scratch(tmp_path: Path) -> None:
    """Calling migrate() on an empty file creates the new observability and
    directions tables."""
    from factory.observability.schema import migrate

    db = tmp_path / "factory.db"
    migrate(db)

    tables = _tables(db)
    assert "live_handlers" in tables
    assert "handler_baselines" in tables
    assert "directions" in tables


def test_migrate_is_idempotent(tmp_path: Path) -> None:
    """Running migrate() twice is a no-op (no ALTER errors, no duplicate cols)."""
    from factory.observability.schema import migrate

    db = tmp_path / "factory.db"
    migrate(db)
    migrate(db)
    migrate(db)
    # Live_handlers schema should be present and unchanged.
    cols = _columns(db, "live_handlers")
    assert {"started_at", "persona", "pid", "story_id", "app", "direction_id"} <= cols


def test_migrate_adds_columns_to_existing_runs_table(tmp_path: Path) -> None:
    """migrate() adds duration_s/story_id/model_tier onto a pre-existing runs table."""
    from factory.observability.schema import migrate

    db = tmp_path / "factory.db"
    # Simulate a pre-existing DB without the new columns.
    conn = sqlite3.connect(str(db))
    conn.execute(
        """
        CREATE TABLE runs (
            id INTEGER PRIMARY KEY,
            ts TEXT, persona TEXT, model TEXT, mode TEXT,
            tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
            success INTEGER, story_path TEXT, repo_path TEXT, error TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE stories (
            id INTEGER PRIMARY KEY,
            direction_id TEXT, app TEXT, title TEXT, slug TEXT,
            scope TEXT, state TEXT, chain_kind TEXT,
            dev_retries INTEGER, current_model_tier TEXT,
            created_at TEXT, updated_at TEXT,
            story_file_path TEXT,
            harness_precheck_passed INTEGER DEFAULT 0
        )
        """
    )
    conn.execute("INSERT INTO runs (ts, persona, model, mode) VALUES ('t', 'pm', 'x', 'text')")
    conn.commit()
    conn.close()

    migrate(db)

    cols = _columns(db, "runs")
    assert {"duration_s", "story_id", "model_tier", "direction_id", "app"} <= cols
    cols2 = _columns(db, "stories")
    assert {"points", "estimated_seconds"} <= cols2

    # Existing row survived.
    conn = sqlite3.connect(str(db))
    n = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    conn.close()
    assert n == 1


def test_migrate_adds_direction_id_and_app_without_data_loss(tmp_path: Path) -> None:
    """D003: ``direction_id``/``app`` are added onto a pre-existing ``runs``
    table (simulating the live ``state/factory.db``, which predates these
    columns) idempotently and without dropping the existing row."""
    from factory.observability.schema import migrate

    db = tmp_path / "factory.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        """
        CREATE TABLE runs (
            id INTEGER PRIMARY KEY,
            ts TEXT, persona TEXT, model TEXT, mode TEXT,
            tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
            success INTEGER, story_path TEXT, repo_path TEXT, error TEXT,
            duration_s REAL, story_id INTEGER, model_tier TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO runs (ts, persona, model, mode, story_id) VALUES ('t', 'dev', 'x', 'sandbox', 42)"
    )
    conn.commit()
    conn.close()

    # Run twice — must be idempotent (no duplicate-column ALTER errors).
    migrate(db)
    migrate(db)

    cols = _columns(db, "runs")
    assert {"direction_id", "app"} <= cols

    conn = sqlite3.connect(str(db))
    row = conn.execute(
        "SELECT story_id, direction_id, app FROM runs WHERE persona='dev'"
    ).fetchone()
    n = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
    conn.close()
    assert n == 1
    # Old data preserved; new columns default to NULL for pre-existing rows.
    assert row == (42, None, None)


@pytest.mark.parametrize("call_count", [1, 3])
def test_migrate_preserves_existing_data(tmp_path: Path, call_count: int) -> None:
    """Calling migrate() any number of times does not drop rows."""
    from factory.observability.schema import migrate

    db = tmp_path / "factory.db"
    migrate(db)
    conn = sqlite3.connect(str(db))
    conn.execute(
        "INSERT INTO live_handlers (started_at, persona, model, mode, pid) VALUES (?, ?, ?, ?, ?)",
        ("2026-05-26T00:00:00+00:00", "dev", "claude-opus-4-7", "sandbox", 999),
    )
    conn.commit()
    conn.close()

    for _ in range(call_count):
        migrate(db)

    conn = sqlite3.connect(str(db))
    n = conn.execute("SELECT COUNT(*) FROM live_handlers").fetchone()[0]
    conn.close()
    assert n == 1
