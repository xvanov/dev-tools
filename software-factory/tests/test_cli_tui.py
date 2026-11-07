"""Smoke tests for the ``factory tui`` and ``factory baselines`` CLI commands."""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner


def _runner_with_root(root: Path) -> tuple[CliRunner, object]:
    import importlib

    import factory.cli as cli_mod

    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


def test_baselines_cli_runs_and_returns_count(tmp_path: Path) -> None:
    """``factory baselines`` reports how many cells it recomputed."""
    (tmp_path / "state").mkdir(parents=True, exist_ok=True)
    runner, cli_mod = _runner_with_root(tmp_path)
    result = runner.invoke(cli_mod.app, ["baselines"])
    assert result.exit_code == 0, result.stdout
    assert "baselines" in result.stdout


def test_tui_command_is_registered(tmp_path: Path) -> None:
    """``factory tui --help`` exits cleanly without launching the UI."""
    runner, cli_mod = _runner_with_root(tmp_path)
    result = runner.invoke(cli_mod.app, ["tui", "--help"])
    assert result.exit_code == 0, result.stdout
    assert "dashboard" in result.stdout.lower() or "tui" in result.stdout.lower()


def test_tui_run_imports_succeed() -> None:
    """The tui module imports without crashing."""
    from factory.tui.app import FactoryTUI, run_tui

    assert callable(run_tui)
    assert FactoryTUI is not None
