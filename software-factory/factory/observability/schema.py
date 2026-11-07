"""DB schema for the observability subsystem.

Two new tables (``live_handlers``, ``handler_baselines``) plus idempotent
ALTERs that add columns onto pre-existing ``runs`` and ``stories`` tables
without dropping data.

The migration helper runs at TUI startup and inside the runner so existing
state DBs upgrade transparently on the next factory invocation. SQLite ALTER
TABLE only supports ADD COLUMN, which is enough for our purposes.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from sqlmodel import Field, SQLModel


class LiveHandler(SQLModel, table=True):
    """A handler that is *currently executing*.

    Inserted on entry to ``sandbox_run`` / ``text_run`` and deleted on exit.
    The TUI polls this table to show what each persona is doing right now —
    elapsed = ``now - started_at``. Rows from dead processes are reaped by
    ``reap_stale_heartbeats`` (any row whose ``pid`` is no longer alive).
    """

    __tablename__ = "live_handlers"

    id: int | None = Field(default=None, primary_key=True)
    started_at: str = Field(index=True)
    persona: str = Field(index=True)
    model: str
    mode: str
    story_id: int | None = Field(default=None, index=True)
    app: str | None = Field(default=None, index=True)
    direction_id: str | None = Field(default=None, index=True)
    pid: int


class HandlerBaseline(SQLModel, table=True):
    """Median wall-clock seconds per (persona, points) bucket.

    Recomputed periodically from completed runs by
    ``estimator.recompute_baselines``. The Monte Carlo ETA reads this to
    seed each remaining handler's expected duration; velocity samples
    then perturb it per simulation run.
    """

    __tablename__ = "handler_baselines"

    id: int | None = Field(default=None, primary_key=True)
    persona: str = Field(index=True)
    points: int = Field(index=True)
    median_seconds: float
    sample_count: int
    updated_at: str


_RUNS_NEW_COLUMNS: list[tuple[str, str]] = [
    ("duration_s", "REAL"),
    ("story_id", "INTEGER"),
    ("model_tier", "VARCHAR"),
    # D003 — per-unit cost/token/time accounting. ``direction_id`` +
    # ``app`` complete the attribution chain (story_id alone is not enough
    # to roll up spend per direction or per app when a run predates a
    # story, e.g. PM/analyst calls). Added via ALTER so the live
    # ``state/factory.db`` gains them without a rebuild.
    ("direction_id", "VARCHAR"),
    ("app", "VARCHAR"),
    # D003 follow-up — the cached/fresh prompt-token SPLIT, not just the
    # blended cost_usd. Some models price cache-read tokens at an ESTIMATED
    # rate (see factory_cost_note in factory/providers/azure_foundry.py);
    # storing the split makes cost_usd recomputable once a real rate is
    # confirmed, instead of the guess being baked in unrecoverably.
    ("cached_input_tokens", "INTEGER"),
    # Usage honesty. Both are NULLable three-state flags, NOT booleans with a
    # default: NULL means "this row predates the columns", so a reader can tell
    # a legacy row from one that genuinely recorded False. Without these,
    # ``cost_usd = 0`` conflates a dry-run, a pre-model infra failure, and a
    # real call whose cost we could not read.
    ("premodel_infra", "BOOLEAN"),
    ("usage_reliable", "BOOLEAN"),
]

_STORIES_NEW_COLUMNS: list[tuple[str, str]] = [
    ("points", "INTEGER"),
    ("estimated_seconds", "REAL"),
    # D002 Karpathy Layer-2 runtime verifier — dev records the smoke journey
    # result here; the smoke-green gate reads it in dry-run. Added via ALTER so
    # existing live DBs (state/factory.db) gain the column without a rebuild.
    ("smoke_passed", "BOOLEAN"),
]


_DIRECTIONS_NEW_COLUMNS: list[tuple[str, str]] = [
    # WHO filed the direction. The ``directions`` table shipped (D012) without
    # it, then D018 gitignored the ``state.yaml`` that was the only other place
    # it lived, then the operator-approval gate started reading it — so the
    # documented ``directions-regenerate-state`` recovery path silently dropped
    # it and parked every direction. ALTERed in (not create_all'd) so the live
    # ``state/factory.db`` gains it without a rebuild; NULL = "row predates the
    # column", which the gate treats as unknown-and-therefore-parked.
    ("source", "VARCHAR"),
]


def stories_migration_columns() -> list[tuple[str, str]]:
    """Every ``ALTER TABLE stories ADD COLUMN`` this codebase knows about.

    Two modules independently migrate the ``stories`` table: this one (via
    :func:`migrate`, called from ``runner._engine``) and
    ``factory.chain.handlers._ensure_story_columns`` (called from its own
    ``_engine``). They carried DIFFERENT column lists, so which columns a live
    ``factory.db`` actually gained depended on which engine happened to open it
    first. No column is missing today, but the divergence is a live trap: a
    column added to one list is invisible to the other's callers.

    Merging here makes both paths apply the identical set. The chain's dict is
    imported lazily — ``handlers`` is heavy and imports ``runner``, which
    imports this module.
    """
    merged: dict[str, str] = dict(_STORIES_NEW_COLUMNS)
    try:
        from factory.chain.handlers import _MIGRATION_COLUMNS

        for name, sql_type in _MIGRATION_COLUMNS.items():
            merged.setdefault(name, sql_type)
    except Exception:  # noqa: BLE001 - a migration must not hard-fail on import
        pass
    return list(merged.items())


def _existing_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    cur = conn.execute(f"PRAGMA table_info({table})")
    return {row[1] for row in cur.fetchall()}


def _ensure_columns(conn: sqlite3.Connection, table: str, columns: list[tuple[str, str]]) -> None:
    existing = _existing_columns(conn, table)
    for name, sql_type in columns:
        if name in existing:
            continue
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}")


def migrate(db_path: Path) -> None:
    """Run idempotent schema migrations against ``db_path``.

    Adds new columns onto ``runs``, ``stories`` and ``directions`` if missing,
    and ensures the new ``live_handlers`` / ``handler_baselines`` tables exist via
    ``SQLModel.metadata.create_all``. Safe to call on every CLI entry.
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    try:
        existing_tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        if "runs" in existing_tables:
            _ensure_columns(conn, "runs", _RUNS_NEW_COLUMNS)
        if "stories" in existing_tables:
            _ensure_columns(conn, "stories", stories_migration_columns())
        if "directions" in existing_tables:
            _ensure_columns(conn, "directions", _DIRECTIONS_NEW_COLUMNS)
        conn.commit()
    finally:
        conn.close()

    from sqlmodel import create_engine

    # Import every model module for its SIDE EFFECT before create_all: a
    # SQLModel subclass registers itself in ``SQLModel.metadata`` at class-
    # definition time, so a table whose module was never imported is silently
    # ABSENT from the metadata and therefore never created. No error is raised —
    # the table is simply missing, and the failure surfaces later at the first
    # write. Keep this list in step with new tables.
    from factory.directions import schema as _directions_schema  # noqa: F401

    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
