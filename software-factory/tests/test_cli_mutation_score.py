"""Tests for ``factory mutation-score``.

These exist because the measurement itself said they were missing. The first
clean run of the instrument on this very branch reported
``factory/cli.py::mutation_score_cmd`` as **survived** — its body could be
replaced by a raise and the suite stayed green — while
``factory/chain/mutation.py::measure`` was killed. That is the tool working:
the CLI wrapper had no test, and the score said so.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from factory.chain.mutation import MutationReport
from factory.cli import app

runner = CliRunner()


@pytest.fixture
def factory_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A factory root with one app config the command can load."""
    app_dir = tmp_path / "apps" / "toy"
    app_dir.mkdir(parents=True)
    (app_dir / "config.yaml").write_text(
        "name: toy\nrepo: o/r\ngates:\n  test_command: 'python -m pytest -q'\n",
        encoding="utf-8",
    )
    monkeypatch.setattr("factory.cli._FACTORY_ROOT", tmp_path)
    return tmp_path


def _fake_measure(captured: dict[str, object], report: MutationReport):  # type: ignore[no-untyped-def]
    def _inner(**kwargs: object) -> MutationReport:
        captured.update(kwargs)
        return report

    return _inner


def test_it_reports_a_measured_score(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, object] = {}
    report = MutationReport(
        status="measured",
        reason="mutation score 0.50 (1 killed / 2 measured)",
        score=0.5,
        killed=["a.py::f"],
        survived=["b.py::g"],
        candidates=2,
        baseline="green",
        tree_source="git-clone",
    )
    monkeypatch.setattr("factory.chain.mutation.measure", _fake_measure(captured, report))

    result = runner.invoke(
        app,
        ["mutation-score", "--app", "toy", "--repo-root", str(factory_root), "--base", "main"],
    )
    assert result.exit_code == 0, result.output
    assert "0.50" in result.output
    assert "a.py::f" in result.output
    assert "b.py::g" in result.output
    # The app's configured command is what gets measured, and the state root is
    # the factory root (so the cache is not written into some cwd).
    assert captured["test_command"] == "python -m pytest -q"
    assert captured["software_factory_root"] == factory_root
    assert captured["app"] == "toy"


def test_test_command_override_wins_over_app_config(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The factory's own ``uv run pytest -q`` is NOT self-sufficient in a fresh
    clone (pytest is a dev extra), so the override is load-bearing, not sugar."""
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        "factory.chain.mutation.measure",
        _fake_measure(captured, MutationReport(status="no_symbols", reason="x")),
    )
    result = runner.invoke(
        app,
        [
            "mutation-score",
            "--app",
            "toy",
            "--repo-root",
            str(factory_root),
            "--test-command",
            "uv sync --all-extras && uv run pytest -q",
        ],
    )
    assert result.exit_code == 0, result.output
    assert captured["test_command"] == "uv sync --all-extras && uv run pytest -q"


def test_json_output_is_the_raw_report(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report = MutationReport(
        status="skipped_baseline_red",
        reason="baseline suite is red",
        baseline="red",
        baseline_output="FAILED tests/test_x.py::test_y",
    )
    monkeypatch.setattr(
        "factory.chain.mutation.measure", _fake_measure({}, report)
    )
    result = runner.invoke(
        app,
        ["mutation-score", "--app", "toy", "--repo-root", str(factory_root), "--json"],
    )
    assert result.exit_code == 0, result.output
    payload = json.loads(result.output)
    assert payload["mutation_status"] == "skipped_baseline_red"
    assert payload["mutation_score"] is None
    # A skipped run must carry the evidence for WHY, not just the label.
    assert "FAILED tests/test_x.py::test_y" in payload["baseline_output"]


def test_a_skipped_run_shows_the_baseline_output(
    factory_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report = MutationReport(
        status="skipped_baseline_infra",
        reason="baseline suite is infra",
        baseline="infra",
        baseline_output="pytest: command not found",
        notes=["score withheld: the precondition for measuring did not hold"],
    )
    monkeypatch.setattr("factory.chain.mutation.measure", _fake_measure({}, report))
    result = runner.invoke(
        app, ["mutation-score", "--app", "toy", "--repo-root", str(factory_root)]
    )
    assert result.exit_code == 0, result.output
    assert "n/a" in result.output  # never a number
    assert "command not found" in result.output
    assert "score withheld" in result.output
