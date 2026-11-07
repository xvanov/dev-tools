"""Tests for ``factory.deploy.runner`` — the subprocess utility.

Exercises the real subprocess path (with safe commands) so we know
the run_command pipeline truly works end-to-end, including timeout
enforcement and the destructive-pattern refusal short-circuit.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from factory.deploy.runner import (
    CommandResult,
    is_destructive,
    run_command,
    run_command_sequence,
)


def test_run_command_echo_succeeds(tmp_path: Path) -> None:
    """A simple `echo` returns exit_code=0 and captures stdout."""
    result = run_command("echo hello-world", cwd=tmp_path)
    assert result.passed is True
    assert result.exit_code == 0
    assert "hello-world" in result.stdout
    assert result.duration_seconds >= 0.0
    assert result.refused is False
    assert result.timed_out is False


def test_run_command_nonzero_exit_marks_not_passed(tmp_path: Path) -> None:
    """``false`` exits 1 — not passed."""
    result = run_command("false", cwd=tmp_path)
    assert result.passed is False
    assert result.exit_code == 1


def test_run_command_timeout_is_enforced(tmp_path: Path) -> None:
    """A command that sleeps past the timeout is killed and marked timed_out."""
    result = run_command("sleep 5", cwd=tmp_path, timeout=1)
    assert result.timed_out is True
    assert result.passed is False
    # Duration should be near the timeout, not the full sleep.
    assert result.duration_seconds < 3.0


def test_run_command_refuses_destructive_pattern(tmp_path: Path) -> None:
    """A `rm -rf /` substring is refused before subprocess.run is called."""
    result = run_command("rm -rf /", cwd=tmp_path)
    assert result.refused is True
    assert result.refused_reason == "destructive_pattern"
    assert result.passed is False


def test_is_destructive_detects_known_patterns() -> None:
    assert is_destructive("rm -rf /") is True
    assert is_destructive("some-prefix && rm -rf /home && other") is True
    assert is_destructive("mkfs.ext4 /dev/sda1") is True
    # Innocuous: `rm -rf ./build` is NOT in the destructive set.
    assert is_destructive("rm -rf ./build") is False
    assert is_destructive("docker compose up") is False


def test_run_command_passes_through_path_env(tmp_path: Path) -> None:
    """The runner forwards PATH so `which sh` resolves."""
    result = run_command("sh -c 'exit 0'", cwd=tmp_path)
    assert result.exit_code == 0


def test_run_command_passthrough_env_var(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """``env_var_passthrough`` forwards only the named vars."""
    monkeypatch.setenv("SECRET_FOO", "from-parent")
    monkeypatch.setenv("OTHER_BAR", "should-not-appear")
    result = run_command(
        'echo "$SECRET_FOO|$OTHER_BAR"',
        cwd=tmp_path,
        env_var_passthrough=["SECRET_FOO"],
    )
    assert "from-parent|" in result.stdout
    # OTHER_BAR was NOT in passthrough → child sees empty.
    assert "should-not-appear" not in result.stdout


def test_run_command_sequence_stops_on_first_failure(tmp_path: Path) -> None:
    """A failing step short-circuits the rest of the sequence."""
    results = run_command_sequence(
        ["echo first", "false", "echo never-runs"],
        cwd=tmp_path,
    )
    assert len(results) == 2
    assert results[0].passed is True
    assert results[1].passed is False
    assert results[1].exit_code == 1


def test_run_command_sequence_all_pass(tmp_path: Path) -> None:
    results = run_command_sequence(
        ["echo a", "echo b", "true"],
        cwd=tmp_path,
    )
    assert len(results) == 3
    assert all(r.passed for r in results)


def test_command_result_to_dict_truncates_large_output(tmp_path: Path) -> None:
    """to_dict() emits truncated excerpts so DB rows stay small."""
    huge = "x" * 10_000
    cr = CommandResult(
        command="echo huge",
        exit_code=0,
        stdout=huge,
        stderr="",
        duration_seconds=0.01,
    )
    d = cr.to_dict()
    assert "stdout_excerpt" in d
    assert len(d["stdout_excerpt"]) <= 4000
