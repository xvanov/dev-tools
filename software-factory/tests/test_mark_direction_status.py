"""Tests for ``mark_direction_status`` — DB-authoritative write + best-effort
state.yaml projection (story D012 write-path slice)."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from sqlmodel import Session

from factory.directions.parser import Direction
from factory.directions.schema import get_direction
from factory.directions.watcher import _engine, mark_direction_status

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_direction(
    *,
    app: str = "factory",
    direction_id: str = "012",
    slug: str = "test-direction",
    dir_path: Path,
    status: str = "created",
    state: dict | None = None,
) -> Direction:
    """Build a minimal Direction whose dir_path is inside a tmp tree that
    mirrors the canonical layout ``<root>/apps/<app>/directions/<id>-<slug>/``.
    """
    dir_path = Path(dir_path)
    dir_path.mkdir(parents=True, exist_ok=True)
    return Direction(
        id=direction_id,
        slug=slug,
        title="Test Direction",
        type_tag=None,
        why=None,
        has_flow=False,
        has_api_spec=False,
        acceptance=[],
        explore_tag=False,
        artifacts_paths=[],
        app=app,
        status=status,
        raw_frontmatter={},
        raw_body="",
        dir_path=dir_path,
        state=state or {},
    )


# ---------------------------------------------------------------------------
# DB write success + file projection success
# ---------------------------------------------------------------------------


def test_db_write_success_and_file_projection_success(tmp_path: Path) -> None:
    """AC6.1: mark_direction_status writes the DB row AND state.yaml."""
    apps_dir = tmp_path / "apps" / "factory" / "directions" / "012-test-direction"
    direction = _make_direction(dir_path=apps_dir)

    mark_direction_status(direction, "pm-validated", by="test-runner")

    # DB row exists with correct fields
    db_path = tmp_path / "state" / "factory.db"
    engine = _engine(db_path)
    with Session(engine) as session:
        row = get_direction(session, "factory", "012")
        assert row is not None
        assert row.status == "pm-validated"
        assert row.slug == "test-direction"
        assert row.updated_by == "test-runner"

    # state.yaml exists with same status
    state_path = apps_dir / "state.yaml"
    assert state_path.exists()
    state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "pm-validated"

    # In-memory record updated
    assert direction.status == "pm-validated"


def test_db_write_preserves_existing_state_yaml_keys(tmp_path: Path) -> None:
    """state.yaml projection preserves existing keys (tracker_issue, pm_result)."""
    apps_dir = tmp_path / "apps" / "factory" / "directions" / "012-test-direction"
    apps_dir.mkdir(parents=True, exist_ok=True)
    existing = {"tracker_issue": 42, "pm_result": {"confidence": 0.9}}
    (apps_dir / "state.yaml").write_text(yaml.safe_dump(existing))

    direction = _make_direction(dir_path=apps_dir, state=existing)

    mark_direction_status(direction, "closed", by="gc")

    state = yaml.safe_load((apps_dir / "state.yaml").read_text(encoding="utf-8"))
    assert state["status"] == "closed"
    assert state["tracker_issue"] == 42
    assert state["pm_result"] == {"confidence": 0.9}
    assert "audit" in state
    assert len(state["audit"]) == 1
    assert state["audit"][0]["by"] == "gc"
    assert state["audit"][0]["event"] == "status -> closed"


def test_db_write_persists_transition_fields(tmp_path: Path) -> None:
    """DB row carries status, tracker_issue, created_at, updated_at, updated_by."""
    apps_dir = tmp_path / "apps" / "factory" / "directions" / "012-test-direction"
    direction = _make_direction(dir_path=apps_dir, state={"tracker_issue": 7})

    mark_direction_status(direction, "pm-validated", by="pm-sync")

    db_path = tmp_path / "state" / "factory.db"
    engine = _engine(db_path)
    with Session(engine) as session:
        row = get_direction(session, "factory", "012")
        assert row is not None
        assert row.status == "pm-validated"
        assert row.tracker_issue == 7
        assert row.created_at is not None
        assert row.updated_at is not None
        assert row.updated_by == "pm-sync"


# ---------------------------------------------------------------------------
# DB write success + file projection failure (best-effort)
# ---------------------------------------------------------------------------


def test_file_projection_failure_does_not_fail_transition(tmp_path: Path) -> None:
    """When state.yaml write fails, the transition still succeeds (DB written)."""
    apps_dir = tmp_path / "apps" / "factory" / "directions" / "012-test-direction"
    direction = _make_direction(dir_path=apps_dir)

    state_path = apps_dir / "state.yaml"
    # Pre-create state.yaml as a directory so write fails with OSError
    # _read_state_yaml handles this gracefully (returns {})
    state_path.mkdir()

    mark_direction_status(direction, "pm-validated", by="test-runner")

    # DB row must exist despite file failure
    db_path = tmp_path / "state" / "factory.db"
    engine = _engine(db_path)
    with Session(engine) as session:
        row = get_direction(session, "factory", "012")
        assert row is not None
        assert row.status == "pm-validated"

    # In-memory record updated
    assert direction.status == "pm-validated"


# ---------------------------------------------------------------------------
# DB write failure => transition fails
# ---------------------------------------------------------------------------


def test_db_write_failure_fails_transition(tmp_path: Path) -> None:
    """When the DB write fails, the exception propagates — transition fails."""
    import sqlite3

    from sqlalchemy.exc import SQLAlchemyError

    apps_dir = tmp_path / "apps" / "factory" / "directions" / "012-test-direction"
    direction = _make_direction(dir_path=apps_dir)

    # Make the DB path a directory so that sqlite cannot create the db file
    db_dir = tmp_path / "state"
    db_dir.mkdir(parents=True, exist_ok=True)
    (db_dir / "factory.db").mkdir()

    # ``sqlite3.Error`` is in the tuple because ``watcher._engine`` now runs
    # ``observability.schema.migrate`` (raw sqlite3) before handing back an
    # engine, so an unopenable DB surfaces one layer earlier as sqlite's own
    # ``OperationalError`` rather than as a SQLAlchemy wrapper. The assertion
    # itself is unchanged: it must RAISE, and it must not write state.yaml.
    with pytest.raises((SQLAlchemyError, OSError, sqlite3.Error)):
        mark_direction_status(direction, "pm-validated", by="test-runner")

    # state.yaml must NOT have been written (DB is authoritative)
    state_path = apps_dir / "state.yaml"
    assert not state_path.exists()


# ---------------------------------------------------------------------------
# Status survives state.yaml deletion (AC3.1)
# ---------------------------------------------------------------------------


def test_status_survives_state_yaml_deletion(tmp_path: Path) -> None:
    """AC3.1: After DB write, deleting state.yaml doesn't lose status."""
    apps_dir = tmp_path / "apps" / "factory" / "directions" / "012-test-direction"
    direction = _make_direction(dir_path=apps_dir)

    mark_direction_status(direction, "pm-validated", by="pm-sync")

    # Delete state.yaml
    state_path = apps_dir / "state.yaml"
    state_path.unlink()
    assert not state_path.exists()

    # Status still resolved from DB
    db_path = tmp_path / "state" / "factory.db"
    engine = _engine(db_path)
    from factory.directions.watcher import _resolve_status

    resolved = _resolve_status("factory", "012", "created", engine)
    assert resolved == "pm-validated"


# ---------------------------------------------------------------------------
# state.yaml regeneration from DB (AC6.2)
# ---------------------------------------------------------------------------


def test_state_yaml_regenerated_from_db_without_status_drift(tmp_path: Path) -> None:
    """AC6.2: state.yaml can be regenerated from the database without changing
    status.  The on-disk projection reflects the DB-backed status."""
    apps_dir = tmp_path / "apps" / "factory" / "directions" / "012-test-direction"
    direction = _make_direction(dir_path=apps_dir)

    mark_direction_status(direction, "pm-validated", by="pm-sync")

    # Delete state.yaml, then re-call mark with same status to regenerate
    state_path = apps_dir / "state.yaml"
    state_path.unlink()

    # Re-mark with the same status — this regenerates state.yaml from scratch
    # while the DB row already has "pm-validated"
    mark_direction_status(direction, "pm-validated", by="regenerator")

    # Verify DB status unchanged
    db_path = tmp_path / "state" / "factory.db"
    engine = _engine(db_path)
    with Session(engine) as session:
        row = get_direction(session, "factory", "012")
        assert row is not None
        assert row.status == "pm-validated"

    # state.yaml is back with correct status
    assert state_path.exists()
    state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    assert state["status"] == "pm-validated"


# ---------------------------------------------------------------------------
# pm-sync does NOT re-triage when state.yaml is missing but DB has status
# (AC3.2)
# ---------------------------------------------------------------------------


def test_pm_sync_does_not_retriage_when_db_has_status(tmp_path: Path) -> None:
    """AC3.2: After state.yaml is deleted, _resolve_status returns the DB
    status, so pending_directions won't see 'created' and pm-sync won't
    re-triage."""
    apps_dir = tmp_path / "apps" / "factory" / "directions" / "012-test-direction"
    direction = _make_direction(dir_path=apps_dir)

    mark_direction_status(direction, "pm-validated", by="pm-sync")

    # Delete state.yaml
    (apps_dir / "state.yaml").unlink()

    # Now pending_directions should NOT return this direction (status is
    # pm-validated in DB, which isn't pending)
    db_path = tmp_path / "state" / "factory.db"
    from factory.directions.watcher import pending_directions

    pending = pending_directions("factory", tmp_path, db_path)
    ids = [d.id for d in pending]
    assert "012" not in ids


# ---------------------------------------------------------------------------
# DB-authoritative: state.yaml stale status is overridden by DB
# ---------------------------------------------------------------------------


def test_db_status_overrides_stale_state_yaml(tmp_path: Path) -> None:
    """When DB has a newer status than state.yaml, the DB wins."""
    apps_dir = tmp_path / "apps" / "factory" / "directions" / "012-test-direction"
    direction = _make_direction(dir_path=apps_dir)

    # Write to DB only (bypass state.yaml to simulate stale disk)
    mark_direction_status(direction, "closed", by="gc")

    # Manually rewrite state.yaml with a stale status
    (apps_dir / "state.yaml").write_text(yaml.safe_dump({"status": "created"}))

    # Resolution should prefer DB
    db_path = tmp_path / "state" / "factory.db"
    engine = _engine(db_path)
    from factory.directions.watcher import _resolve_status

    resolved = _resolve_status("factory", "012", "created", engine)
    assert resolved == "closed"
