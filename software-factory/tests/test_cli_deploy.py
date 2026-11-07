"""Tests for ``factory deploy`` and ``factory deploys`` CLI subcommands.

Uses Typer's CliRunner against the live ``factory.cli.app`` to exercise
the full wire-up — argparse, panel printing, DeployActionRecord
persistence — without subprocesses.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from sqlmodel import Session, create_engine, select
from typer.testing import CliRunner

from factory.cli import app as cli_app
from factory.deploy.models import DeployActionRecord


def _write_sacrifice_root(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    cfg = {
        "name": "sacrifice",
        "repo": "o/r",
        "default_branch": "main",
        "deploy": {
            "enabled": True,
            "pre_deploy_commands": ["echo prep"],
            "deploy_command": "echo deploy",
            "health_check_command": "echo healthy",
            "smoke_test_command": "echo smoke",
            "rollback_command": "echo rollback",
        },
    }
    (apps / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    (tmp_path / "factory_settings.yaml").write_text(
        "modes:\n  default: normal\n  available: [normal, fix-only, paused, deploy-frozen]\n",
        encoding="utf-8",
    )
    (tmp_path / "state").mkdir()
    return tmp_path


def _patch_factory_root(monkeypatch: pytest.MonkeyPatch, root: Path) -> None:
    """Re-point the CLI's _FACTORY_ROOT and the settings cache at tmp_path."""
    import factory.cli as cli_mod
    from factory.settings.loader import reload_settings

    monkeypatch.setattr(cli_mod, "_FACTORY_ROOT", root)
    reload_settings(root)


def test_factory_deploy_dry_run_produces_action(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`factory deploy --app sacrifice --dry-run --sha abc` records a DeployAction."""
    root = _write_sacrifice_root(tmp_path)
    _patch_factory_root(monkeypatch, root)

    runner = CliRunner()
    result = runner.invoke(
        cli_app,
        ["deploy", "--app", "sacrifice", "--dry-run", "--sha", "deadbeef" * 5],
    )
    assert result.exit_code == 0, result.output
    assert "deploy" in result.output

    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(DeployActionRecord)).all()
    assert len(rows) == 1
    assert rows[0].sha == "deadbeef" * 5
    assert rows[0].status == "deployed"


def test_factory_deploys_lists_recorded_actions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`factory deploys` lists the action created by `factory deploy`."""
    root = _write_sacrifice_root(tmp_path)
    _patch_factory_root(monkeypatch, root)

    runner = CliRunner()
    # 1. Create a deploy action.
    res1 = runner.invoke(cli_app, ["deploy", "--app", "sacrifice", "--dry-run", "--sha", "z" * 40])
    assert res1.exit_code == 0, res1.output

    # 2. List it.
    res2 = runner.invoke(cli_app, ["deploys", "--app", "sacrifice"])
    assert res2.exit_code == 0, res2.output
    # First 12 hex of the sha is shown.
    assert ("z" * 12) in res2.output
    assert "deployed" in res2.output


def test_factory_deploy_under_deploy_frozen_mode_skipped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Mode `deploy-frozen` returns status='skipped' and persists that row."""
    root = _write_sacrifice_root(tmp_path)
    _patch_factory_root(monkeypatch, root)
    from factory.settings.modes import set_mode

    set_mode("deploy-frozen", root)

    runner = CliRunner()
    result = runner.invoke(
        cli_app,
        ["deploy", "--app", "sacrifice", "--dry-run", "--sha", "abc" * 14],
    )
    assert result.exit_code == 0, result.output
    assert "skipped" in result.output

    db = root / "state" / "factory.db"
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(DeployActionRecord)).all()
    assert len(rows) == 1
    assert rows[0].status == "skipped"
    assert rows[0].skipped_reason == "mode_blocks_deploy"


def test_factory_deploys_empty_emits_friendly_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`factory deploys --app x` with no DB rows says so plainly."""
    root = _write_sacrifice_root(tmp_path)
    _patch_factory_root(monkeypatch, root)

    runner = CliRunner()
    result = runner.invoke(cli_app, ["deploys", "--app", "sacrifice"])
    assert result.exit_code == 0, result.output
    assert "No DeployAction rows" in result.output


def test_factory_deploy_with_no_candidate_sha_emits_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without --sha and without a merged_action row, deploy reports no candidate."""
    root = _write_sacrifice_root(tmp_path)
    _patch_factory_root(monkeypatch, root)

    runner = CliRunner()
    result = runner.invoke(cli_app, ["deploy", "--app", "sacrifice", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert "No candidate SHA" in result.output
