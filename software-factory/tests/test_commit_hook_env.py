"""A factory commit in a story worktree runs dev-tools' pre-commit hook.

Story 17 (dev-tools:019, 2026-11-08): the docs onboarder's commit ran the hook,
whose software-factory leg (``scripts/changed-pytest.py``) found no ``.venv`` in
the fresh worktree, fell back to ``uv run pytest`` (a bare sync, no dev extras)
with ``-n auto``, and pytest exited 4. So the hook now syncs the dev extras into
the tree's venv first, and every factory commit gets a timeout a hook fits in.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from factory.chain import branch as branch_module
from factory.chain import context_refresh as context_refresh_module
from factory.chain import delivery_gate as delivery_gate_module

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "changed-pytest.py"


@pytest.fixture
def cp() -> ModuleType:
    if not SCRIPT.exists():
        pytest.skip("scripts/changed-pytest.py is not in this checkout")
    spec = importlib.util.spec_from_file_location("changed_pytest_under_test", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _fake_env(
    cp: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    venv: tuple[bool, bool] | None,
    after_sync: tuple[bool, bool] | None,
    sync_ok: bool = True,
    system: tuple[bool, bool] = (False, False),
) -> dict[str, Any]:
    """A venv with (pytest, xdist) = ``venv`` (None: no venv), becoming ``after_sync``."""
    venv_py = tmp_path / ".venv" / "python"
    if venv is not None:
        venv_py.parent.mkdir(parents=True)
        venv_py.write_text("")
    seen: dict[str, Any] = {"syncs": 0, "env": venv}
    monkeypatch.setattr(cp, "VENV_PY", venv_py)

    def _probe(python: Path | str) -> tuple[bool, bool]:
        if str(python) == str(venv_py):
            return seen["env"] or (False, False)
        return system

    def _sync() -> bool:
        seen["syncs"] += 1
        if sync_ok and after_sync is not None:
            venv_py.parent.mkdir(parents=True, exist_ok=True)
            venv_py.write_text("")
            seen["env"] = after_sync
        return sync_ok

    monkeypatch.setattr(cp, "probe", _probe)
    monkeypatch.setattr(cp, "uv_sync", _sync)
    return seen


def test_a_complete_venv_is_used_as_is(cp: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    seen = _fake_env(cp, monkeypatch, tmp_path, venv=(True, True), after_sync=None)
    cmd, xdist = cp.pytest_command()
    assert cmd == [str(cp.VENV_PY), "-m", "pytest"] and xdist
    assert seen["syncs"] == 0


def test_a_worktree_without_a_venv_gets_the_dev_extras(
    cp: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The story-17 case: no .venv at all. Not `uv run pytest` (no extras), a sync."""
    seen = _fake_env(cp, monkeypatch, tmp_path, venv=None, after_sync=(True, True))
    cmd, xdist = cp.pytest_command()
    assert seen["syncs"] == 1
    assert cmd == [str(cp.VENV_PY), "-m", "pytest"] and xdist


def test_a_venv_without_xdist_is_synced(cp: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A bare `uv run` leaves a venv without the dev extras."""
    seen = _fake_env(cp, monkeypatch, tmp_path, venv=(False, False), after_sync=(True, True))
    cmd, xdist = cp.pytest_command()
    assert seen["syncs"] == 1 and xdist
    assert cmd is not None and cmd[0] == str(cp.VENV_PY)


def test_no_xdist_after_a_failed_sync_runs_serially(
    cp: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _fake_env(cp, monkeypatch, tmp_path, venv=(True, False), after_sync=None, sync_ok=False)
    tests = [cp.FACTORY / "tests" / f"test_{i}.py" for i in range(9)]
    monkeypatch.setattr(cp, "select", lambda since: (False, "", tests, tests))
    ran: list[list[str]] = []

    def _run(cmd: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        ran.append(cmd)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(cp.subprocess, "run", _run)
    assert cp.main([]) == 0
    assert len(ran) == 1 and "-n" not in ran[0]
    assert "running serially" in capsys.readouterr().err


def test_xdist_present_runs_in_parallel(cp: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _fake_env(cp, monkeypatch, tmp_path, venv=(True, True), after_sync=None)
    tests = [cp.FACTORY / "tests" / f"test_{i}.py" for i in range(9)]
    monkeypatch.setattr(cp, "select", lambda since: (False, "", tests, tests))
    ran: list[list[str]] = []
    monkeypatch.setattr(cp.subprocess, "run", lambda cmd, **kw: ran.append(cmd) or subprocess.CompletedProcess(cmd, 0))
    assert cp.main([]) == 0
    assert ran[0][ran[0].index("-n") + 1] == "auto"


def test_no_pytest_anywhere_fails_and_says_why(
    cp: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Never a silent pass: the hook must block and name the fix."""
    _fake_env(cp, monkeypatch, tmp_path, venv=None, after_sync=None, sync_ok=False)
    tests = [cp.FACTORY / "tests" / "test_x.py"]
    monkeypatch.setattr(cp, "select", lambda since: (False, "", tests, tests))
    ran: list[list[str]] = []
    monkeypatch.setattr(cp.subprocess, "run", lambda cmd, **kw: ran.append(cmd) or subprocess.CompletedProcess(cmd, 0))
    assert cp.main([]) == 1
    assert ran == []
    assert "uv sync --all-extras" in capsys.readouterr().err


def test_the_interpreter_running_the_script_is_the_fallback(
    cp: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _fake_env(cp, monkeypatch, tmp_path, venv=None, after_sync=None, sync_ok=False, system=(True, False))
    cmd, xdist = cp.pytest_command()
    assert cmd == [sys.executable, "-m", "pytest"] and not xdist


def test_probe_reads_a_real_interpreter(cp: ModuleType, tmp_path: Path) -> None:
    assert cp.probe(sys.executable) == (True, True)  # this suite runs with the dev extras
    assert cp.probe(tmp_path / "no-such-python") == (False, False)


def test_uv_missing_is_a_failed_sync_not_a_crash(cp: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    def _missing(*a: Any, **kw: Any) -> Any:
        raise FileNotFoundError("uv")

    monkeypatch.setattr(cp.subprocess, "run", _missing)
    assert cp.uv_sync() is False


# --------------------------------------------------------------------------- #
# Factory commits: a timeout the hook fits in
# --------------------------------------------------------------------------- #


def _capture_run(monkeypatch: pytest.MonkeyPatch, module: ModuleType, stderr: str = "", rc: int = 0) -> list[Any]:
    seen: list[Any] = []

    def _run(cmd: list[str], **kw: Any) -> subprocess.CompletedProcess[str]:
        seen.append((cmd, kw.get("timeout")))
        return subprocess.CompletedProcess(cmd, rc, stdout="", stderr=stderr)

    monkeypatch.setattr(module.subprocess, "run", _run)
    return seen


def test_run_git_gives_a_commit_the_hook_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The story-17 commit ran under 30 s: a 10 s sync plus a 15 s pytest leg does not fit."""
    seen = _capture_run(monkeypatch, branch_module)
    branch_module._run_git(tmp_path, "commit", "-m", "x")
    branch_module._run_git(tmp_path, "status", "--porcelain")
    branch_module._run_git(tmp_path, "commit", "-m", "x", timeout=5)
    assert [t for _, t in seen] == [branch_module.COMMIT_TIMEOUT_S, 30, 5]
    assert branch_module.COMMIT_TIMEOUT_S >= 600


def test_a_failed_commit_keeps_the_end_of_the_hook_output(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """The hook prints why it failed last; story 17's error cut that off at 300 chars."""
    stderr = "tests: software-factory: FAILED (exit 4)\n" + "x" * 2000 + "\nERROR: usage: pytest: unrecognized arguments: -n"
    _capture_run(monkeypatch, branch_module, stderr=stderr, rc=1)
    with pytest.raises(RuntimeError) as exc:
        branch_module._run_git(tmp_path, "commit", "-m", "x")
    msg = str(exc.value)
    assert "tests: software-factory: FAILED (exit 4)" in msg
    assert msg.endswith("unrecognized arguments: -n")
    assert len(msg) < 1300


def test_delivered_locally_commit_gets_the_hook_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    seen: list[Any] = []

    def _git(cwd: Path, *args: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
        seen.append((args[0], timeout))
        out = " M a.py" if args[0] == "status" and len([s for s in seen if s[0] == "status"]) == 1 else ""
        return subprocess.CompletedProcess(["git", *args], 0, stdout=out if args[0] != "rev-parse" else "abc", stderr="")

    monkeypatch.setattr(delivery_gate_module, "_git", _git)

    class _S:
        id = 1
        slug = "s"

    sha, err = delivery_gate_module.commit_local_work(tmp_path, _S())
    assert err is None and sha == "abc"
    assert ("commit", int(branch_module.COMMIT_TIMEOUT_S)) in seen


def test_context_refresh_commit_gets_the_hook_timeout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    seen = _capture_run(monkeypatch, context_refresh_module)
    context_refresh_module._git(tmp_path, "commit", "-m", "x")
    context_refresh_module._git(tmp_path, "status")
    assert [t for _, t in seen] == [branch_module.COMMIT_TIMEOUT_S, 120]
