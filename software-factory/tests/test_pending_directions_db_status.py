"""Tests for ``pending_directions`` DB-first status resolution (D012)."""

from __future__ import annotations

from pathlib import Path

import yaml
from sqlmodel import Session, SQLModel, create_engine

from factory.directions.creator import create_direction
from factory.directions.schema import upsert_direction
from factory.directions.watcher import pending_directions

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_app_dir(tmp_path: Path, app: str = "sacrifice") -> Path:
    """Create a minimal app directory so ``list_direction_dirs`` can find it."""
    apps_dir = tmp_path / "apps" / app / "directions"
    apps_dir.mkdir(parents=True)
    return apps_dir


def _make_db(tmp_path: Path) -> Path:
    """Create an empty SQLite DB with all tables."""
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(f"sqlite:///{db}", echo=False)
    SQLModel.metadata.create_all(engine)
    return db


def _seed_direction_on_disk(
    tmp_path: Path,
    app: str = "sacrifice",
    title: str = "add healthz endpoint",
    status: str | None = None,
) -> str:
    """Create a direction on disk via ``create_direction``, optionally
    overriding its ``state.yaml`` status. Returns the direction id (e.g. ``"001"``)."""
    created = create_direction(
        app=app,
        title=title,
        type_tag="feature",
        why="smoke test",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["should return 200"],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
    )
    dir_id = created.direction.id
    if status is not None and status != "created":
        state_path = created.dir_path / "state.yaml"
        state = yaml.safe_load(state_path.read_text(encoding="utf-8")) or {}
        state["status"] = status
        state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    return dir_id


def _insert_db_row(
    db_path: Path,
    app: str,
    direction_id: str,
    slug: str,
    status: str,
) -> None:
    """Insert a row directly into the ``directions`` table."""
    engine = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        upsert_direction(
            session,
            app=app,
            direction_id=direction_id,
            slug=slug,
            status=status,
        )


# ---------------------------------------------------------------------------
# AC1.1 — DB row status takes precedence over state.yaml
# ---------------------------------------------------------------------------


def test_db_status_wins_over_state_yaml(tmp_path: Path) -> None:
    """WHEN a direction has a matching DB row, its status comes from the DB."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    dir_id = _seed_direction_on_disk(tmp_path, status="needs-direction")
    # DB says pm-validated (not pending), state.yaml says needs-direction (pending)
    _insert_db_row(db, "sacrifice", dir_id, "test-slug", "pm-validated")

    result = pending_directions("sacrifice", tmp_path, db)
    # DB row says pm-validated — not a pending status, so it's excluded
    assert dir_id not in {d.id for d in result}


def test_db_status_created_makes_direction_pending(tmp_path: Path) -> None:
    """DB row with status 'created' → direction appears in pending."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    dir_id = _seed_direction_on_disk(tmp_path, status="pm-validated")
    # DB says created (pending), state.yaml says pm-validated (not pending)
    _insert_db_row(db, "sacrifice", dir_id, "test-slug", "created")

    result = pending_directions("sacrifice", tmp_path, db)
    assert dir_id in {d.id for d in result}
    assert next(d for d in result if d.id == dir_id).status == "created"


def test_db_status_needs_direction_makes_direction_pending(tmp_path: Path) -> None:
    """DB row with status 'needs-direction' → direction appears in pending."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    dir_id = _seed_direction_on_disk(tmp_path, status="pm-validated")
    _insert_db_row(db, "sacrifice", dir_id, "test-slug", "needs-direction")

    result = pending_directions("sacrifice", tmp_path, db)
    assert dir_id in {d.id for d in result}
    assert next(d for d in result if d.id == dir_id).status == "needs-direction"


# ---------------------------------------------------------------------------
# Fallback: no DB row → state.yaml → created
# ---------------------------------------------------------------------------


def test_fallback_to_state_yaml_when_no_db_row(tmp_path: Path) -> None:
    """WHEN no DB row exists, state.yaml status is used."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    dir_id = _seed_direction_on_disk(tmp_path, status="needs-direction")
    # No DB row inserted — state.yaml says needs-direction

    result = pending_directions("sacrifice", tmp_path, db)
    assert dir_id in {d.id for d in result}
    d = next(d for d in result if d.id == dir_id)
    assert d.status == "needs-direction"


def test_fallback_to_created_when_no_db_row_and_state_yaml_has_no_status(tmp_path: Path) -> None:
    """WHEN no DB row and state.yaml is missing status, default to 'created'."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    dir_id = _seed_direction_on_disk(tmp_path)
    # Delete the status key from state.yaml
    state_files = list((tmp_path / "apps" / "sacrifice" / "directions").glob("*/state.yaml"))
    for sf in state_files:
        state = yaml.safe_load(sf.read_text(encoding="utf-8")) or {}
        state.pop("status", None)
        sf.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")

    result = pending_directions("sacrifice", tmp_path, db)
    assert dir_id in {d.id for d in result}
    d = next(d for d in result if d.id == dir_id)
    assert d.status == "created"


def test_fallback_to_created_when_no_db_row_and_no_state_yaml(tmp_path: Path) -> None:
    """WHEN no DB row and no state.yaml file, default to 'created'."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    dir_id = _seed_direction_on_disk(tmp_path)
    # Delete state.yaml entirely
    state_files = list((tmp_path / "apps" / "sacrifice" / "directions").glob("*/state.yaml"))
    for sf in state_files:
        sf.unlink()

    result = pending_directions("sacrifice", tmp_path, db)
    assert dir_id in {d.id for d in result}
    d = next(d for d in result if d.id == dir_id)
    assert d.status == "created"


# ---------------------------------------------------------------------------
# AC1.2 — Same directions returned when DB is populated
# ---------------------------------------------------------------------------


def test_same_directions_returned_when_db_populated(tmp_path: Path) -> None:
    """WHEN the DB is populated with matching rows, the same directions are
    returned as before (the set of direction ids is unchanged)."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    # Create two directions on disk
    id1 = _seed_direction_on_disk(tmp_path, title="first", status="created")
    id2 = _seed_direction_on_disk(tmp_path, title="second", status="needs-direction")

    # Record what pending_directions returns WITHOUT DB rows
    result_without_db = pending_directions("sacrifice", tmp_path, db)
    ids_without_db = {d.id for d in result_without_db}
    assert ids_without_db == {id1, id2}

    # Now insert matching DB rows with the same statuses
    _insert_db_row(db, "sacrifice", id1, "first", "created")
    _insert_db_row(db, "sacrifice", id2, "second", "needs-direction")

    result_with_db = pending_directions("sacrifice", tmp_path, db)
    ids_with_db = {d.id for d in result_with_db}
    # Same set of direction ids
    assert ids_with_db == ids_without_db
    # Statuses match what was inserted in the DB
    statuses = {d.id: d.status for d in result_with_db}
    assert statuses[id1] == "created"
    assert statuses[id2] == "needs-direction"


def test_mixed_population_db_backed_and_file_only(tmp_path: Path) -> None:
    """Directions with AND without DB rows coexist in the same result."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    id_db = _seed_direction_on_disk(tmp_path, title="has-db-row", status="created")
    id_file = _seed_direction_on_disk(tmp_path, title="no-db-row", status="needs-direction")

    # Only one gets a DB row
    _insert_db_row(db, "sacrifice", id_db, "has-db-row", "needs-direction")

    result = pending_directions("sacrifice", tmp_path, db)
    ids = {d.id for d in result}
    assert ids == {id_db, id_file}

    statuses = {d.id: d.status for d in result}
    assert statuses[id_db] == "needs-direction"  # from DB
    assert statuses[id_file] == "needs-direction"  # from state.yaml


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_db_row_for_different_app_does_not_affect_status(tmp_path: Path) -> None:
    """A DB row for a different app must not change this app's direction status."""
    _seed_app_dir(tmp_path, "sacrifice")
    _seed_app_dir(tmp_path, "factory")
    db = _make_db(tmp_path)

    dir_id = _seed_direction_on_disk(tmp_path, app="sacrifice", status="created")
    # Insert DB row for same id but different app
    _insert_db_row(db, "factory", dir_id, "other-slug", "closed")

    result = pending_directions("sacrifice", tmp_path, db)
    assert dir_id in {d.id for d in result}
    d = next(d for d in result if d.id == dir_id)
    # Must still be "created" from state.yaml, not "closed" from factory's row
    assert d.status == "created"


def test_closed_status_in_db_filters_direction_out(tmp_path: Path) -> None:
    """A direction with DB status 'closed' is not pending."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    dir_id = _seed_direction_on_disk(tmp_path, status="created")
    _insert_db_row(db, "sacrifice", dir_id, "test-slug", "closed")

    result = pending_directions("sacrifice", tmp_path, db)
    assert dir_id not in {d.id for d in result}


def test_pm_validated_status_in_db_filters_direction_out(tmp_path: Path) -> None:
    """A direction with DB status 'pm-validated' is not pending."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    dir_id = _seed_direction_on_disk(tmp_path, status="created")
    _insert_db_row(db, "sacrifice", dir_id, "test-slug", "pm-validated")

    result = pending_directions("sacrifice", tmp_path, db)
    assert dir_id not in {d.id for d in result}


def test_empty_app_with_db_returns_empty(tmp_path: Path) -> None:
    """An app with no direction dirs but a DB path returns empty list."""
    _seed_app_dir(tmp_path)
    db = _make_db(tmp_path)

    result = pending_directions("sacrifice", tmp_path, db)
    assert result == []


def test_db_path_does_not_exist_yet(tmp_path: Path) -> None:
    """When the DB file doesn't exist yet, pending_directions creates it and
    falls back to state.yaml / created."""
    _seed_app_dir(tmp_path)
    dir_id = _seed_direction_on_disk(tmp_path, status="created")

    db = tmp_path / "state" / "nonexistent.db"
    # DB path doesn't exist yet, but _engine will create it
    result = pending_directions("sacrifice", tmp_path, db)
    assert dir_id in {d.id for d in result}
    d = next(d for d in result if d.id == dir_id)
    assert d.status == "created"
