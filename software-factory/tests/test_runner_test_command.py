"""``_run_pytest`` honors a configured ``test_command``.

Sacrifice (and other monorepo apps) hold their pytest config in
``backend/`` not at the repo root. The legacy fallback in ``_run_pytest``
short-circuits with ``"no tests directory"`` for those layouts and
always returns ``test_run_passed=False`` — which makes the Dev chain
exhaust retries even when the in-sandbox pytest run is green. The fix
lets ``app_config.gates.test_command`` flow through to ``_run_pytest``.
"""

from __future__ import annotations

from pathlib import Path

from factory.runner import _run_pytest


def test_no_test_command_no_tests_directory(tmp_path: Path) -> None:
    # Empty repo, no test_command → legacy "no tests directory" path.
    passed, output = _run_pytest(tmp_path)
    assert passed is False
    assert "no tests directory" in output


def test_test_command_overrides_layout_check(tmp_path: Path) -> None:
    # Repo has no tests/ dir but the configured command is a shell pipeline
    # that exits cleanly — _run_pytest should obey it and report green.
    passed, output = _run_pytest(tmp_path, test_command="true")
    assert passed is True


def test_test_command_failure_reports_red(tmp_path: Path) -> None:
    passed, output = _run_pytest(tmp_path, test_command="false")
    assert passed is False


def test_test_command_captures_output(tmp_path: Path) -> None:
    passed, output = _run_pytest(tmp_path, test_command="echo hello-from-suite && false")
    assert passed is False
    assert "hello-from-suite" in output


def test_test_command_runs_in_repo_path(tmp_path: Path) -> None:
    # Confirm cwd plumbing — `pwd` should print tmp_path.
    passed, output = _run_pytest(tmp_path, test_command="pwd")
    assert passed is True
    assert str(tmp_path) in output
