"""Tests for the directions table schema and persistence skeleton."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, create_engine, select

from factory.observability.schema import migrate

BASE_TS = datetime(2025, 1, 1)
CREATED_TS = datetime(2025, 6, 1, 10, 0)
UPDATED_TS = datetime(2025, 6, 15, 12, 0)
TRANSITION_TS = datetime(2025, 6, 20, 10, 0)


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


def _indexes(db: Path, table: str) -> list[tuple[str, bool]]:
    """Return [(index_name, unique), ...] for a table."""
    conn = sqlite3.connect(str(db))
    try:
        rows = conn.execute(f"PRAGMA index_list({table})").fetchall()
        return [(row[1], bool(row[2])) for row in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Schema presence tests (AC1.1)
# ---------------------------------------------------------------------------


def test_directions_table_exists_after_schema_init(tmp_path: Path) -> None:
    """AC1.1: WHEN the application schema is initialized, THE database SHALL
    contain a ``directions`` table.

    Drives ``migrate()`` — what every CLI entry point calls — rather than a
    hand-rolled ``SQLModel.metadata.create_all``. That distinction IS the test:
    a bare create_all would pass or fail on this file's own imports and prove
    nothing about production, where the table was in fact never created.
    """

    db = tmp_path / "factory.db"
    migrate(db)

    tables = _tables(db)
    assert "directions" in tables


def test_directions_table_has_minimum_columns(tmp_path: Path) -> None:
    """AC1.3: Minimum columns — id, app, direction_id, slug, status,
    tracker_issue, created_at, updated_at, updated_by — are present."""

    db = tmp_path / "factory.db"
    migrate(db)

    cols = _columns(db, "directions")
    assert {
        "id",
        "app",
        "direction_id",
        "slug",
        "status",
        "tracker_issue",
        "created_at",
        "updated_at",
        "updated_by",
    } <= cols


def test_directions_unique_constraint_on_app_and_direction_id(tmp_path: Path) -> None:
    """Unique constraint on (app, direction_id) is enforced."""
    from factory.directions.schema import DirectionRecord

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)
    with Session(engine) as session:
        session.add(
            DirectionRecord(
                app="factory",
                direction_id="012",
                slug="test-slug",
                status="created",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.commit()

        dup = DirectionRecord(
            app="factory",
            direction_id="012",
            slug="test-slug-2",
            status="created",
            created_at=BASE_TS,
            updated_at=BASE_TS,
        )
        session.add(dup)
        with pytest.raises(IntegrityError):
            session.commit()


def test_directions_index_on_app_and_status(tmp_path: Path) -> None:
    """Index on (app, status) is present."""

    db = tmp_path / "factory.db"
    migrate(db)

    idxs = _indexes(db, "directions")
    idx_names = [name for name, _unique in idxs]
    # SQLModel auto-names indexes; look for one on app+status
    assert any("app" in name and "status" in name for name in idx_names), (
        f"No (app, status) index found among: {idx_names}"
    )


# ---------------------------------------------------------------------------
# Schema column nullability (AC1.2, AC1.3)
# ---------------------------------------------------------------------------


def test_directions_not_null_columns(tmp_path: Path) -> None:
    """app, direction_id, slug, status, created_at, updated_at are NOT NULL."""

    db = tmp_path / "factory.db"
    migrate(db)

    conn = sqlite3.connect(str(db))
    try:
        col_info = {
            row[1]: row[3]  # name -> notnull flag
            for row in conn.execute("PRAGMA table_info(directions)").fetchall()
        }
    finally:
        conn.close()

    for col in ["app", "direction_id", "slug", "status", "created_at", "updated_at"]:
        assert col_info.get(col) == 1, f"{col} should be NOT NULL, got {col_info.get(col)}"

    # tracker_issue and updated_by are nullable
    for col in ["tracker_issue", "updated_by"]:
        assert col_info.get(col) == 0, f"{col} should be nullable, got {col_info.get(col)}"


# ---------------------------------------------------------------------------
# Persistence skeleton tests — row round-trip (AC1.2)
# ---------------------------------------------------------------------------


def _seeded_engine(db_path: Path):
    """Create a migrated DB and return a SQLModel engine for sessions."""
    migrate(db_path)
    return create_engine(f"sqlite:///{db_path}", echo=False)


def test_insert_and_read_direction_row(tmp_path: Path) -> None:
    """Insert a direction row and read it back via Session.get."""
    from factory.directions.schema import DirectionRecord

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    with Session(engine) as session:
        row = DirectionRecord(
            app="sacrifice",
            direction_id="007",
            slug="pushup-counter",
            status="pm-validated",
            tracker_issue=42,
            created_at=CREATED_TS,
            updated_at=UPDATED_TS,
            updated_by="factory.chain.pm_sync",
        )
        session.add(row)
        session.commit()
        pk = row.id
        assert pk is not None

    with Session(engine) as session:
        fetched = session.get(DirectionRecord, pk)
        assert fetched is not None
        assert fetched.app == "sacrifice"
        assert fetched.direction_id == "007"
        assert fetched.slug == "pushup-counter"
        assert fetched.status == "pm-validated"
        assert fetched.tracker_issue == 42
        assert fetched.created_at == CREATED_TS
        assert fetched.updated_at == UPDATED_TS
        assert fetched.updated_by == "factory.chain.pm_sync"


def test_different_apps_same_direction_id_is_allowed(tmp_path: Path) -> None:
    """AC1.2: one row per direction keyed by app AND direction_id — different
    apps can share the same direction_id."""
    from factory.directions.schema import DirectionRecord

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    with Session(engine) as session:
        session.add(
            DirectionRecord(
                app="factory",
                direction_id="001",
                slug="alpha",
                status="created",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.add(
            DirectionRecord(
                app="sacrifice",
                direction_id="001",
                slug="beta",
                status="created",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.commit()

    with Session(engine) as session:
        count = len(
            session.exec(select(DirectionRecord).where(DirectionRecord.direction_id == "001")).all()
        )
        assert count == 2


def test_status_check_constraint_enforces_documented_set(tmp_path: Path) -> None:
    """Only the documented status set is accepted by the table contract."""
    from factory.directions.schema import DirectionRecord

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    allowed = ["created", "pm-validated", "needs-direction", "closed"]
    with Session(engine) as session:
        for idx, status in enumerate(allowed, start=1):
            session.add(
                DirectionRecord(
                    app="factory",
                    direction_id=f"099-{idx}",
                    slug=f"test-{status}",
                    status=status,
                    created_at=BASE_TS,
                    updated_at=BASE_TS,
                )
            )
        session.commit()

    with Session(engine) as session:
        session.add(
            DirectionRecord(
                app="factory",
                direction_id="199",
                slug="unsupported-status",
                status="completed",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        with pytest.raises(IntegrityError):
            session.commit()


def test_upsert_direction_rejects_unsupported_status(tmp_path: Path) -> None:
    """upsert_direction rejects statuses outside the documented contract set."""
    from factory.directions.schema import upsert_direction

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    with Session(engine) as session:
        with pytest.raises(ValueError, match="unsupported direction status"):
            upsert_direction(
                session,
                app="factory",
                direction_id="016",
                slug="invalid",
                status="completed",
            )


def test_update_direction_row(tmp_path: Path) -> None:
    """Update a direction row's status and updated_by, read it back."""
    from factory.directions.schema import DirectionRecord

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    with Session(engine) as session:
        row = DirectionRecord(
            app="factory",
            direction_id="010",
            slug="test-update",
            status="created",
            created_at=BASE_TS,
            updated_at=BASE_TS,
        )
        session.add(row)
        session.commit()
        pk = row.id

    with Session(engine) as session:
        row = session.get(DirectionRecord, pk)
        row.status = "pm-validated"
        row.updated_at = TRANSITION_TS
        row.updated_by = "factory.chain.pm_sync"
        session.add(row)
        session.commit()

    with Session(engine) as session:
        fetched = session.get(DirectionRecord, pk)
        assert fetched.status == "pm-validated"
        assert fetched.updated_at == TRANSITION_TS
        assert fetched.updated_by == "factory.chain.pm_sync"


def test_direction_row_with_nullable_fields_none(tmp_path: Path) -> None:
    """tracker_issue and updated_by can be None."""
    from factory.directions.schema import DirectionRecord

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    with Session(engine) as session:
        row = DirectionRecord(
            app="factory",
            direction_id="011",
            slug="no-tracker",
            status="needs-direction",
            created_at=BASE_TS,
            updated_at=BASE_TS,
        )
        session.add(row)
        session.commit()
        pk = row.id

    with Session(engine) as session:
        fetched = session.get(DirectionRecord, pk)
        assert fetched.tracker_issue is None
        assert fetched.updated_by is None


# ---------------------------------------------------------------------------
# Persistence skeleton function tests
# ---------------------------------------------------------------------------


def test_get_direction_by_app_and_direction_id(tmp_path: Path) -> None:
    """get_direction returns the row for (app, direction_id), or None."""
    from factory.directions.schema import DirectionRecord, get_direction

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    with Session(engine) as session:
        session.add(
            DirectionRecord(
                app="factory",
                direction_id="012",
                slug="my-dir",
                status="created",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.commit()

    with Session(engine) as session:
        row = get_direction(session, "factory", "012")
        assert row is not None
        assert row.slug == "my-dir"
        assert row.status == "created"

        missing = get_direction(session, "factory", "999")
        assert missing is None


def test_upsert_direction_creates_new_row(tmp_path: Path) -> None:
    """upsert_direction on a missing (app, direction_id) inserts a new row."""
    from factory.directions.schema import get_direction, upsert_direction

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    with Session(engine) as session:
        row = upsert_direction(
            session,
            app="factory",
            direction_id="013",
            slug="new-dir",
            status="pm-validated",
            tracker_issue=99,
            updated_by="test-runner",
        )
        assert row.id is not None
        assert row.app == "factory"
        assert row.direction_id == "013"
        assert row.slug == "new-dir"
        assert row.status == "pm-validated"
        assert row.tracker_issue == 99
        assert row.updated_by == "test-runner"
        assert row.created_at == row.updated_at  # same on create

    # Read back through get_direction
    with Session(engine) as session:
        fetched = get_direction(session, "factory", "013")
        assert fetched is not None
        assert fetched.slug == "new-dir"
        assert fetched.status == "pm-validated"


def test_upsert_direction_updates_existing_row(tmp_path: Path) -> None:
    """upsert_direction on an existing (app, direction_id) updates it."""
    from factory.directions.schema import DirectionRecord, get_direction, upsert_direction

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    # Seed a row
    with Session(engine) as session:
        session.add(
            DirectionRecord(
                app="factory",
                direction_id="014",
                slug="before",
                status="created",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.commit()

    # Upsert it
    with Session(engine) as session:
        row = upsert_direction(
            session,
            app="factory",
            direction_id="014",
            slug="after",
            status="closed",
            tracker_issue=77,
            updated_by="test-runner",
        )
        assert row.slug == "after"
        assert row.status == "closed"
        assert row.tracker_issue == 77
        assert row.updated_by == "test-runner"
        assert row.updated_at != row.created_at  # updated_at changed

    # Verify in DB
    with Session(engine) as session:
        fetched = get_direction(session, "factory", "014")
        assert fetched.slug == "after"
        assert fetched.status == "closed"


def test_upsert_direction_idempotent(tmp_path: Path) -> None:
    """Running upsert_direction twice with the same args is safe."""
    from sqlmodel import select as _select

    from factory.directions.schema import DirectionRecord, upsert_direction

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    args = dict(
        app="factory",
        direction_id="015",
        slug="idem",
        status="needs-direction",
        tracker_issue=5,
        updated_by="x",
    )

    with Session(engine) as session:
        upsert_direction(session, **args)

    with Session(engine) as session:
        upsert_direction(session, **args)

    with Session(engine) as session:
        count = len(
            session.exec(
                _select(DirectionRecord).where(
                    DirectionRecord.app == "factory",
                    DirectionRecord.direction_id == "015",
                )
            ).all()
        )
        assert count == 1


def test_list_directions_by_app(tmp_path: Path) -> None:
    """list_directions returns all rows for an app."""
    from factory.directions.schema import DirectionRecord, list_directions

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    with Session(engine) as session:
        session.add(
            DirectionRecord(
                app="factory",
                direction_id="001",
                slug="a",
                status="created",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.add(
            DirectionRecord(
                app="factory",
                direction_id="002",
                slug="b",
                status="closed",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.add(
            DirectionRecord(
                app="sacrifice",
                direction_id="001",
                slug="c",
                status="created",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.commit()

    with Session(engine) as session:
        factory_rows = list_directions(session, "factory")
        assert len(factory_rows) == 2
        assert {r.slug for r in factory_rows} == {"a", "b"}

        sacrifice_rows = list_directions(session, "sacrifice")
        assert len(sacrifice_rows) == 1


def test_list_directions_by_app_and_status(tmp_path: Path) -> None:
    """list_directions with status filter returns only matching rows."""
    from factory.directions.schema import DirectionRecord, list_directions

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    with Session(engine) as session:
        session.add(
            DirectionRecord(
                app="factory",
                direction_id="001",
                slug="a",
                status="created",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.add(
            DirectionRecord(
                app="factory",
                direction_id="002",
                slug="b",
                status="pm-validated",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.add(
            DirectionRecord(
                app="factory",
                direction_id="003",
                slug="c",
                status="pm-validated",
                created_at=BASE_TS,
                updated_at=BASE_TS,
            )
        )
        session.commit()

    with Session(engine) as session:
        pending = list_directions(session, "factory", "pm-validated")
        assert len(pending) == 2
        assert {r.direction_id for r in pending} == {"002", "003"}

        created = list_directions(session, "factory", "created")
        assert len(created) == 1


def test_list_directions_empty_app(tmp_path: Path) -> None:
    """list_directions on unknown app returns empty list."""
    from factory.directions.schema import list_directions

    db = tmp_path / "factory.db"
    engine = _seeded_engine(db)

    with Session(engine) as session:
        assert list_directions(session, "nonexistent") == []
