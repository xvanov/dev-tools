"""Tests for ``factory halt`` (019 safety-mechanism rewire, post PR #247).

``factory.manager.halt.request_halt`` had ZERO production callers after PR
#247 deleted the L3 Diagnostician (its only caller) — the READ side
(``is_halted``, checked every tick) kept working, but nothing could WRITE a
halt any more. ``factory halt "<reason>"`` is the operator-facing writer,
mirroring ``factory resume``'s shape in reverse.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner


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

    reload_settings(root)
    importlib.reload(cli_mod)
    cli_mod._FACTORY_ROOT = root  # type: ignore[attr-defined]
    return CliRunner(), cli_mod


def test_halt_sets_the_halt(root: Path) -> None:
    from factory.manager.halt import is_halted

    runner, cli_mod = _runner_with_root(root)
    assert is_halted(root=root) is False

    result = runner.invoke(cli_mod.app, ["halt", "emergency stop for a soak test", "--yes"])

    assert result.exit_code == 0, result.stdout
    assert is_halted(root=root) is True


def test_halt_is_visible_on_an_operator_surface(root: Path) -> None:
    runner, cli_mod = _runner_with_root(root)
    runner.invoke(cli_mod.app, ["halt", "operator emergency stop", "--yes"])

    mode_result = runner.invoke(cli_mod.app, ["mode"])

    assert "halted" in mode_result.stdout.lower()
    assert "operator emergency stop" in mode_result.stdout


def test_halt_requires_confirmation_without_yes(root: Path) -> None:
    from factory.manager.halt import is_halted

    runner, cli_mod = _runner_with_root(root)
    result = runner.invoke(cli_mod.app, ["halt", "should not take effect"], input="n\n")

    assert result.exit_code == 0
    assert is_halted(root=root) is False


def test_halt_twice_is_a_noop_not_an_error(root: Path) -> None:
    runner, cli_mod = _runner_with_root(root)
    first = runner.invoke(cli_mod.app, ["halt", "first reason", "--yes"])
    assert first.exit_code == 0

    second = runner.invoke(cli_mod.app, ["halt", "second reason", "--yes"])

    assert second.exit_code == 0
    assert "already halted" in second.stdout.lower()


def test_resume_clears_a_halt_set_by_the_new_command(root: Path) -> None:
    from factory.manager.halt import is_halted

    runner, cli_mod = _runner_with_root(root)
    runner.invoke(cli_mod.app, ["halt", "will be resumed", "--yes"])
    assert is_halted(root=root) is True

    result = runner.invoke(cli_mod.app, ["resume", "--yes"])

    assert result.exit_code == 0, result.stdout
    assert is_halted(root=root) is False


def test_tick_reads_the_halt_this_command_wrote(root: Path) -> None:
    """End-to-end: the writer this PR adds and the reader that already
    existed (``factory.chain.orchestrator.tick``'s halt check) must agree —
    a halt set via ``factory halt`` must actually stop the next tick."""
    from factory.chain import orchestrator

    runner, cli_mod = _runner_with_root(root)
    runner.invoke(cli_mod.app, ["halt", "stop before tick", "--yes"])

    summary = orchestrator.tick(root, "sacrifice", dry_run=False)

    assert summary.halted is True
    assert summary.halt_reason == "stop before tick"
