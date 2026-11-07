"""Direction 018 AC5 — ``factory directions-regenerate-state``.

``state.yaml`` is a gitignored projection of the authoritative ``directions``
row, so a fresh clone has ``direction.md`` and no projection. This command
rebuilds the missing ones from the database.
"""

from __future__ import annotations

import importlib
import subprocess
from pathlib import Path

import yaml
from typer.testing import CliRunner

from factory.directions.backfill import (
    RegenerateResult,
    directions_backfill,
    regenerate_state_files,
)


def _setup_root(tmp_path: Path) -> Path:
    (tmp_path / "state").mkdir()
    return tmp_path


def _write_direction(
    root: Path,
    direction_id: str,
    slug: str,
    *,
    app: str = "factory",
    state: dict | None = None,
) -> Path:
    d = root / "apps" / app / "directions" / f"{direction_id}-{slug}"
    d.mkdir(parents=True)
    (d / "direction.md").write_text(
        f"---\ntitle: {slug}\ntype: refactor\n---\n\n# {slug}\n",
        encoding="utf-8",
    )
    if state is not None:
        (d / "state.yaml").write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    return d


def _setup_cli_runner(tmp_path: Path) -> tuple[CliRunner, object]:
    import factory.cli as cli_mod
    from factory.settings.loader import reload_settings

    (tmp_path / "factory_settings.yaml").write_text(
        yaml.safe_dump({"caps": {}, "modes": {"default": "normal", "available": ["normal"]}}),
        encoding="utf-8",
    )
    reload_settings(tmp_path)
    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = tmp_path  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


# ---------------------------------------------------------------------------
# Core behaviour
# ---------------------------------------------------------------------------


def test_regenerates_missing_state_yaml_from_the_database(tmp_path: Path) -> None:
    """A direction with a row but no state.yaml gets its projection rebuilt."""
    root = _setup_root(tmp_path)
    db = root / "state" / "factory.db"
    direction_dir = _write_direction(
        root,
        "001",
        "first",
        # ``source`` is part of every real direction (``creator.py`` writes it at
        # creation) and the operator-approval gate reads it, so the fixture must
        # carry one — see tests/test_directions_source_roundtrip.py.
        state={"status": "pm-validated", "tracker_issue": 7, "source": "cli"},
    )
    directions_backfill("factory", root, db, dry_run=False)

    # Simulate the fresh clone: the gitignored projection is absent.
    (direction_dir / "state.yaml").unlink()
    assert not (direction_dir / "state.yaml").exists()

    result = regenerate_state_files("factory", root, db)

    assert result == RegenerateResult(written=1, present=0, no_row=0, no_source=0)
    loaded = yaml.safe_load((direction_dir / "state.yaml").read_text(encoding="utf-8"))
    assert loaded["status"] == "pm-validated"
    assert loaded["tracker_issue"] == 7
    assert loaded["source"] == "cli"
    assert loaded["regenerated_from"] == "database"
    assert loaded["audit"][-1]["event"] == "status -> pm-validated"


def test_regenerated_status_matches_the_source_repo(tmp_path: Path) -> None:
    """Flow step 6: statuses in the rebuilt projections match the database."""
    root = _setup_root(tmp_path)
    db = root / "state" / "factory.db"
    dirs = {
        "001": _write_direction(root, "001", "one", state={"status": "created"}),
        "002": _write_direction(root, "002", "two", state={"status": "pm-validated"}),
        "003": _write_direction(root, "003", "three", state={"status": "closed"}),
    }
    directions_backfill("factory", root, db, dry_run=False)
    for d in dirs.values():
        (d / "state.yaml").unlink()

    result = regenerate_state_files("factory", root, db)

    assert result.written == 3
    statuses = {
        did: yaml.safe_load((d / "state.yaml").read_text(encoding="utf-8"))["status"]
        for did, d in dirs.items()
    }
    assert statuses == {"001": "created", "002": "pm-validated", "003": "closed"}


def test_existing_projection_is_never_overwritten(tmp_path: Path) -> None:
    """An on-disk state.yaml carries more than the row — leave it alone."""
    root = _setup_root(tmp_path)
    db = root / "state" / "factory.db"
    rich_state = {
        "status": "pm-validated",
        "source": "operator",
        "pm_result": {"confidence": 0.9},
    }
    direction_dir = _write_direction(root, "001", "first", state=rich_state)
    directions_backfill("factory", root, db, dry_run=False)
    before = (direction_dir / "state.yaml").read_text(encoding="utf-8")

    result = regenerate_state_files("factory", root, db)

    assert result == RegenerateResult(written=0, present=1, no_row=0)
    assert (direction_dir / "state.yaml").read_text(encoding="utf-8") == before


def test_idempotent_second_run_writes_nothing(tmp_path: Path) -> None:
    root = _setup_root(tmp_path)
    db = root / "state" / "factory.db"
    direction_dir = _write_direction(root, "001", "first", state={"status": "created"})
    directions_backfill("factory", root, db, dry_run=False)
    (direction_dir / "state.yaml").unlink()

    first = regenerate_state_files("factory", root, db)
    second = regenerate_state_files("factory", root, db)

    assert first.written == 1
    assert second == RegenerateResult(written=0, present=1, no_row=0)


def test_direction_without_a_row_is_reported_not_invented(tmp_path: Path) -> None:
    """No row means nothing to project from — say so instead of faking a status."""
    root = _setup_root(tmp_path)
    db = root / "state" / "factory.db"
    _write_direction(root, "001", "imported", state={"status": "created", "source": "cli"})
    directions_backfill("factory", root, db, dry_run=False)
    hand_written = _write_direction(root, "002", "hand-written")
    (root / "apps" / "factory" / "directions" / "001-imported" / "state.yaml").unlink()

    result = regenerate_state_files("factory", root, db)

    assert result == RegenerateResult(written=1, present=0, no_row=1, no_source=0)
    assert not (hand_written / "state.yaml").exists()


def test_missing_database_writes_nothing(tmp_path: Path) -> None:
    """Fail safe: no database, no invented projections."""
    root = _setup_root(tmp_path)
    direction_dir = _write_direction(root, "001", "first")

    result = regenerate_state_files("factory", root, root / "state" / "factory.db")

    assert result == RegenerateResult(written=0, present=0, no_row=1)
    assert not (direction_dir / "state.yaml").exists()


def test_dry_run_touches_no_disk(tmp_path: Path) -> None:
    root = _setup_root(tmp_path)
    db = root / "state" / "factory.db"
    direction_dir = _write_direction(
        root, "001", "first", state={"status": "created", "source": "cli"}
    )
    directions_backfill("factory", root, db, dry_run=False)
    (direction_dir / "state.yaml").unlink()

    result = regenerate_state_files("factory", root, db, dry_run=True)

    assert result == RegenerateResult(written=1, present=0, no_row=0, no_source=0)
    assert not (direction_dir / "state.yaml").exists()


def test_scoped_to_the_requested_app(tmp_path: Path) -> None:
    root = _setup_root(tmp_path)
    db = root / "state" / "factory.db"
    factory_dir = _write_direction(root, "001", "one", state={"status": "created"})
    sacrifice_dir = _write_direction(
        root, "001", "one", app="sacrifice", state={"status": "created"}
    )
    directions_backfill("factory", root, db, dry_run=False)
    directions_backfill("sacrifice", root, db, dry_run=False)
    (factory_dir / "state.yaml").unlink()
    (sacrifice_dir / "state.yaml").unlink()

    result = regenerate_state_files("factory", root, db)

    assert result.written == 1
    assert (factory_dir / "state.yaml").exists()
    assert not (sacrifice_dir / "state.yaml").exists()


def test_backfill_still_imports_a_hand_written_direction(tmp_path: Path) -> None:
    """AC4 regression: the disk → DB path is unchanged by the new command."""
    root = _setup_root(tmp_path)
    db = root / "state" / "factory.db"
    _write_direction(root, "001", "hand-written")

    assert directions_backfill("factory", root, db, dry_run=False).imported == 1


# ---------------------------------------------------------------------------
# AC5: "running it on a clean tree produces no git diff"
# ---------------------------------------------------------------------------


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=str(repo), capture_output=True, text=True, timeout=30
    )
    result.check_returncode()
    return result.stdout


def test_regenerating_on_a_clean_tree_produces_no_git_diff(tmp_path: Path) -> None:
    """Both halves of AC5, in one real git repo.

    A fresh clone (projections absent) regenerates them and stays clean, because
    the ignore rules cover ``state.yaml``; and a second run on the now-populated
    clean tree writes nothing at all.
    """
    repo = tmp_path / "clone"
    repo.mkdir()
    _git(repo, "init", "--initial-branch=main")
    _git(repo, "config", "user.email", "test@factory.local")
    _git(repo, "config", "user.name", "Test Factory")
    # The real ignore rules, copied from this repository — not a synthetic string.
    (repo / ".gitignore").write_text(
        (Path(__file__).resolve().parents[1] / ".gitignore").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (repo / "state").mkdir()
    direction_dir = _write_direction(repo, "001", "first", state={"status": "pm-validated"})
    db = repo / "state" / "factory.db"
    directions_backfill("factory", repo, db, dry_run=False)

    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "human-authored sources only")
    assert _git(repo, "status", "--porcelain").strip() == ""

    # Fresh-clone shape: the gitignored projection is gone.
    (direction_dir / "state.yaml").unlink()

    first = regenerate_state_files("factory", repo, db)
    assert first.written == 1
    assert (direction_dir / "state.yaml").is_file()
    assert _git(repo, "status", "--porcelain").strip() == "", (
        "regenerating projections must leave the tree clean"
    )

    second = regenerate_state_files("factory", repo, db)
    assert second == RegenerateResult(written=0, present=1, no_row=0)
    assert _git(repo, "status", "--porcelain").strip() == ""


# ---------------------------------------------------------------------------
# CLI surface
# ---------------------------------------------------------------------------


def test_cli_command_regenerates_and_reports(tmp_path: Path) -> None:
    root = _setup_root(tmp_path)
    db = root / "state" / "factory.db"
    direction_dir = _write_direction(root, "001", "first", state={"status": "pm-validated"})
    directions_backfill("factory", root, db, dry_run=False)
    (direction_dir / "state.yaml").unlink()

    runner, cli_mod = _setup_cli_runner(root)
    result = runner.invoke(
        cli_mod.app,  # type: ignore[attr-defined]
        ["directions-regenerate-state", "--app", "factory"],
    )

    assert result.exit_code == 0, result.output
    assert "written=1" in result.output
    assert (direction_dir / "state.yaml").is_file()


def test_cli_dry_run_writes_nothing(tmp_path: Path) -> None:
    root = _setup_root(tmp_path)
    db = root / "state" / "factory.db"
    direction_dir = _write_direction(root, "001", "first", state={"status": "pm-validated"})
    directions_backfill("factory", root, db, dry_run=False)
    (direction_dir / "state.yaml").unlink()

    runner, cli_mod = _setup_cli_runner(root)
    result = runner.invoke(
        cli_mod.app,  # type: ignore[attr-defined]
        ["directions-regenerate-state", "--app", "factory", "--dry-run"],
    )

    assert result.exit_code == 0, result.output
    assert "DRY-RUN" in result.output
    assert not (direction_dir / "state.yaml").exists()


def test_cli_command_is_discoverable_in_help(tmp_path: Path) -> None:
    runner, cli_mod = _setup_cli_runner(_setup_root(tmp_path))
    result = runner.invoke(cli_mod.app, ["--help"])  # type: ignore[attr-defined]
    assert result.exit_code == 0
    assert "directions-regenerate-state" in result.output
