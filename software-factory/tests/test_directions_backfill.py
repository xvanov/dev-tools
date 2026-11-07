"""Tests for ``factory directions-backfill`` CLI command."""

from __future__ import annotations

import importlib
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import yaml
from typer.testing import CliRunner

from factory.directions.backfill import BackfillResult, directions_backfill
from factory.observability.schema import migrate

# helpers


def _setup_cli_runner(tmp_path: Path) -> tuple[CliRunner, object]:
    """Set up a CliRunner pointed at a temp factory root with settings/state."""
    import factory.cli as cli_mod
    from factory.settings.loader import reload_settings

    (tmp_path / "factory_settings.yaml").write_text(
        yaml.safe_dump({"caps": {}, "modes": {"default": "normal", "available": ["normal"]}}),
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir()

    reload_settings(tmp_path)
    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = tmp_path  # type: ignore[attr-defined]

    return CliRunner(), cli_mod


def _rows_for_app(db_path: Path, app: str = "factory") -> list[sqlite3.Row]:
    migrate(db_path)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            """
            SELECT app, direction_id, slug, status, tracker_issue, created_at, updated_at, updated_by
            FROM directions
            WHERE app = ?
            ORDER BY direction_id
            """,
            (app,),
        ).fetchall()
    finally:
        conn.close()


def _count_rows(db_path: Path, app: str = "factory") -> int:
    return len(_rows_for_app(db_path, app))


def _row_for_direction(db_path: Path, app: str, direction_id: str) -> sqlite3.Row:
    rows = _rows_for_app(db_path, app)
    matches = [row for row in rows if row["direction_id"] == direction_id]
    assert len(matches) == 1
    return matches[0]


def _parse_db_utc(raw: str) -> datetime:
    parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


# CLI command invocation tests


def test_cli_dry_run_default_reports_no_writes(tmp_path):
    """AC1.2: dry-run is default, reports imported=N skipped=N, writes nothing."""
    runner, cli_mod = _setup_cli_runner(tmp_path)

    directions_dir = tmp_path / "apps" / "myapp" / "directions" / "001-test-dir"
    directions_dir.mkdir(parents=True)
    (directions_dir / "direction.md").write_text("# Test\n")

    result = runner.invoke(cli_mod.app, ["directions-backfill", "--app", "myapp"])
    assert result.exit_code == 0, result.output
    assert "imported=1" in result.output
    assert "skipped=0" in result.output
    assert "DRY-RUN" in result.output

    db = tmp_path / "state" / "factory.db"
    assert not db.exists()


def test_cli_real_run_writes_rows(tmp_path):
    """AC1.1 + AC1.2: --real-run writes rows and reports imported=N."""
    runner, cli_mod = _setup_cli_runner(tmp_path)

    directions_dir = tmp_path / "apps" / "myapp" / "directions" / "001-test-dir"
    directions_dir.mkdir(parents=True)
    (directions_dir / "direction.md").write_text("# Test\n")

    result = runner.invoke(cli_mod.app, ["directions-backfill", "--app", "myapp", "--real-run"])
    assert result.exit_code == 0, result.output
    assert "imported=1" in result.output
    assert "skipped=0" in result.output
    assert "REAL RUN" in result.output

    assert _count_rows(tmp_path / "state" / "factory.db", "myapp") == 1


def test_cli_idempotent_second_run(tmp_path):
    """AC1.3: running twice is safe; second run imports=0 skipped=N."""
    runner, cli_mod = _setup_cli_runner(tmp_path)

    directions_dir = tmp_path / "apps" / "myapp" / "directions" / "001-test-dir"
    directions_dir.mkdir(parents=True)
    (directions_dir / "direction.md").write_text("# Test\n")

    r1 = runner.invoke(cli_mod.app, ["directions-backfill", "--app", "myapp", "--real-run"])
    assert r1.exit_code == 0, r1.output
    assert "imported=1" in r1.output
    assert "skipped=0" in r1.output

    r2 = runner.invoke(cli_mod.app, ["directions-backfill", "--app", "myapp", "--real-run"])
    assert r2.exit_code == 0, r2.output
    assert "imported=0" in r2.output
    assert "skipped=1" in r2.output

    assert _count_rows(tmp_path / "state" / "factory.db", "myapp") == 1


# Backfill logic unit tests


def test_dry_run_returns_counts_no_db_write(tmp_path):
    """Dry-run returns import/skip counts but writes nothing."""
    root = tmp_path
    db = root / "state" / "factory.db"
    apps_dir = root / "apps" / "myapp" / "directions"
    d001_dir = apps_dir / "001-first"
    d001_dir.mkdir(parents=True)
    (d001_dir / "direction.md").write_text("# First\n")
    d002_dir = apps_dir / "002-second"
    d002_dir.mkdir(parents=True)
    (d002_dir / "direction.md").write_text("# Second\n")

    result = directions_backfill("myapp", root, db, dry_run=True)
    assert result.imported == 2
    assert result.skipped == 0
    assert not db.exists()


def test_real_run_inserts_and_reports(tmp_path):
    """Real run inserts rows and reports correct counts."""
    root = tmp_path
    db = root / "state" / "factory.db"
    apps_dir = root / "apps" / "myapp" / "directions"
    d001_dir = apps_dir / "001-first"
    d001_dir.mkdir(parents=True)
    (d001_dir / "direction.md").write_text("# First\n")
    d002_dir = apps_dir / "002-second"
    d002_dir.mkdir(parents=True)
    (d002_dir / "direction.md").write_text("# Second\n")

    result = directions_backfill("myapp", root, db, dry_run=False)
    assert result.imported == 2
    assert result.skipped == 0
    assert _count_rows(db, "myapp") == 2


def test_real_run_idempotent(tmp_path):
    """Second real run imports nothing, skips all."""
    root = tmp_path
    db = root / "state" / "factory.db"
    apps_dir = root / "apps" / "myapp" / "directions"
    d001_dir = apps_dir / "001-first"
    d001_dir.mkdir(parents=True)
    (d001_dir / "direction.md").write_text("# First\n")

    r1 = directions_backfill("myapp", root, db, dry_run=False)
    assert r1.imported == 1
    assert r1.skipped == 0

    r2 = directions_backfill("myapp", root, db, dry_run=False)
    assert r2.imported == 0
    assert r2.skipped == 1

    assert _count_rows(db, "myapp") == 1


def test_imported_row_field_mapping(tmp_path):
    """AC2.1 + AC2.2: imported row has correct fields."""
    root = tmp_path
    db = root / "state" / "factory.db"
    apps_dir = root / "apps" / "myapp" / "directions"
    d001_dir = apps_dir / "001-first"
    d001_dir.mkdir(parents=True)
    (d001_dir / "direction.md").write_text("# First\n")

    result = directions_backfill("myapp", root, db, dry_run=False)
    assert result.imported == 1

    row = _row_for_direction(db, "myapp", "001")
    assert row["slug"] == "first"
    assert row["status"] == "created"
    assert row["app"] == "myapp"
    assert row["direction_id"] == "001"
    assert row["created_at"] is not None
    assert row["updated_at"] is not None


def test_imported_row_with_state_yaml_status(tmp_path):
    """Status from state.yaml is used when present."""
    root = tmp_path
    db = root / "state" / "factory.db"
    apps_dir = root / "apps" / "myapp" / "directions"
    d001_dir = apps_dir / "001-first"
    d001_dir.mkdir(parents=True)
    (d001_dir / "direction.md").write_text("# First\n")
    (d001_dir / "state.yaml").write_text(yaml.dump({"status": "pm-validated"}))

    result = directions_backfill("myapp", root, db, dry_run=False)
    assert result.imported == 1

    row = _row_for_direction(db, "myapp", "001")
    assert row["status"] == "pm-validated"


def test_imported_row_with_tracker_issue(tmp_path):
    """Tracker issue is pulled from state.yaml when present."""
    root = tmp_path
    db = root / "state" / "factory.db"
    apps_dir = root / "apps" / "myapp" / "directions"
    d001_dir = apps_dir / "001-first"
    d001_dir.mkdir(parents=True)
    (d001_dir / "direction.md").write_text("# First\n")
    (d001_dir / "state.yaml").write_text(yaml.dump({"tracker_issue": 42}))

    result = directions_backfill("myapp", root, db, dry_run=False)
    assert result.imported == 1

    row = _row_for_direction(db, "myapp", "001")
    assert row["tracker_issue"] == 42


def test_imported_row_with_last_updated_by(tmp_path):
    """Last audit 'by' is pulled from state.yaml into updated_by."""
    root = tmp_path
    db = root / "state" / "factory.db"
    apps_dir = root / "apps" / "myapp" / "directions"
    d001_dir = apps_dir / "001-first"
    d001_dir.mkdir(parents=True)
    (d001_dir / "direction.md").write_text("# First\n")
    (d001_dir / "state.yaml").write_text(
        yaml.dump({"audit": [{"by": "openhands"}, {"by": "amelia"}]})
    )

    result = directions_backfill("myapp", root, db, dry_run=False)
    assert result.imported == 1

    row = _row_for_direction(db, "myapp", "001")
    assert row["updated_by"] == "amelia"


def test_dry_run_then_real_run_counts_match(tmp_path):
    """Dry-run counts match real-run counts for a first import."""
    root = tmp_path
    db = root / "state" / "factory.db"
    apps_dir = root / "apps" / "myapp" / "directions"
    for i in range(3):
        d_dir = apps_dir / f"{i:03d}-dir-{i}"
        d_dir.mkdir(parents=True)
        (d_dir / "direction.md").write_text(f"# Dir {i}\n")

    dry = directions_backfill("myapp", root, db, dry_run=True)
    real = directions_backfill("myapp", root, db, dry_run=False)
    assert dry.imported == real.imported
    assert dry.skipped == real.skipped
    assert dry.imported == 3


def test_dry_run_reports_existing_rows_as_skipped(tmp_path):
    """Dry-run reads existing DB rows for accurate imported/skipped counts."""
    root = tmp_path
    db = root / "state" / "factory.db"
    apps_dir = root / "apps" / "myapp" / "directions"
    d001_dir = apps_dir / "001-first"
    d001_dir.mkdir(parents=True)
    (d001_dir / "direction.md").write_text("# First\n")

    first = directions_backfill("myapp", root, db, dry_run=False)
    assert first == BackfillResult(imported=1, skipped=0)

    dry = directions_backfill("myapp", root, db, dry_run=True)
    assert dry == BackfillResult(imported=0, skipped=1)
    assert _count_rows(db, "myapp") == 1


def test_imported_row_maps_transition_timestamp_and_actor(tmp_path):
    """Backfill preserves created_at plus last audit ts/by into the row."""
    root = tmp_path
    db = root / "state" / "factory.db"
    apps_dir = root / "apps" / "myapp" / "directions"
    d001_dir = apps_dir / "001-first"
    d001_dir.mkdir(parents=True)
    (d001_dir / "direction.md").write_text("# First\n")

    created_ts = "2026-07-20T12:00:00+00:00"
    last_ts = "2026-07-21T15:45:33+00:00"
    (d001_dir / "state.yaml").write_text(
        yaml.safe_dump(
            {
                "status": "needs-direction",
                "created_at": created_ts,
                "audit": [
                    {"ts": "2026-07-20T12:00:00+00:00", "by": "pm"},
                    {"ts": last_ts, "by": "reviewer"},
                ],
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )

    result = directions_backfill("myapp", root, db, dry_run=False)
    assert result == BackfillResult(imported=1, skipped=0)

    row = _row_for_direction(db, "myapp", "001")
    assert row["status"] == "needs-direction"
    assert row["updated_by"] == "reviewer"
    assert _parse_db_utc(row["created_at"]) == datetime.fromisoformat(created_ts).astimezone(UTC)
    assert _parse_db_utc(row["updated_at"]) == datetime.fromisoformat(last_ts).astimezone(UTC)
