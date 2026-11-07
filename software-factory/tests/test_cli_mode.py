"""Tests for ``factory mode`` / ``factory pause`` / ``factory resume`` commands."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from factory.settings.modes import get_mode


@pytest.fixture
def root(tmp_path: Path) -> Path:
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True, exist_ok=True)
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: x/y\n", encoding="utf-8")
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    return tmp_path


def _runner_with_root(root: Path) -> tuple[CliRunner, object]:
    import importlib

    import factory.cli as cli_mod
    from factory.settings.loader import reload_settings

    # Bust the settings cache for this root WITHOUT reloading the module —
    # reloading rebinds FactorySettings and breaks isinstance() in other tests.
    reload_settings(root)
    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


def test_mode_no_arg_prints_current(root: Path) -> None:
    runner, cli_mod = _runner_with_root(root)
    result = runner.invoke(cli_mod.app, ["mode"])
    assert result.exit_code == 0
    assert "normal" in result.stdout


def test_mode_invalid_rejected(root: Path) -> None:
    runner, cli_mod = _runner_with_root(root)
    result = runner.invoke(cli_mod.app, ["mode", "not-a-mode"])
    assert result.exit_code == 2
    assert "not in allowed set" in result.stdout


def test_mode_valid_persists(root: Path) -> None:
    runner, cli_mod = _runner_with_root(root)
    result = runner.invoke(cli_mod.app, ["mode", "fix-only"])
    assert result.exit_code == 0
    assert "fix-only" in result.stdout
    # And subsequent "factory mode" reflects it.
    result2 = runner.invoke(cli_mod.app, ["mode"])
    assert "current mode: " in result2.stdout
    assert "fix-only" in result2.stdout
    assert get_mode(root) == "fix-only"


def test_pause_and_resume(root: Path) -> None:
    runner, cli_mod = _runner_with_root(root)
    p = runner.invoke(cli_mod.app, ["pause"])
    assert p.exit_code == 0
    assert get_mode(root) == "paused"
    r = runner.invoke(cli_mod.app, ["resume"])
    assert r.exit_code == 0
    assert get_mode(root) == "normal"
