"""FACTORY_SANDBOX wiring (5.2): claude_session runs start claude inside the
run's sandbox when the flag is on, never unsandboxed when it fails to start,
and exactly as before when it is off."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import pytest

from factory.claude_session import cli as claude_cli
from factory.claude_session import run as claude_run
from factory.runner import GateVerdict
from tests.test_claude_session import FakeLauncher, _runs


class FakeSandbox:
    def __init__(self) -> None:
        self.closed = False
        self.kw: dict[str, Any] = {}

    def wrap(self, cmd: list[str]) -> list[str]:
        return ["SBX-EXEC", "--", *cmd]

    def close(self) -> None:
        self.closed = True


@pytest.fixture
def launcher(monkeypatch: pytest.MonkeyPatch) -> FakeLauncher:
    fake = FakeLauncher([{"write": "impl.py"}])
    monkeypatch.setattr(claude_run, "launcher_factory", lambda: (fake, None))
    monkeypatch.setattr(claude_cli, "claude_binary", lambda env=None: "/usr/bin/claude")
    return fake


def _dev_run(tmp_path: Path) -> Any:
    repo = tmp_path / "wt"
    repo.mkdir(exist_ok=True)
    story = tmp_path / "story.md"
    story.write_text("# Story\nDo it.\n")
    return claude_run.claude_dev_run(
        story_path=story, repo_path=repo, software_factory_root=tmp_path,
        db_path=tmp_path / "state" / "factory.db", model="m", test_command="true",
        story_id=5, app="demo", direction_id="001", wall_clock_timeout_s=600,
        gate_check=lambda: GateVerdict(passed=(repo / "impl.py").exists(), reason="no impl"),
    )


def _round_script(tmp_path: Path) -> str:
    run_dir = next((tmp_path / "state" / "claude_runs").glob("demo-5-*"))
    return next(p for p in run_dir.iterdir() if p.name.startswith("round-1")).read_text()


def test_flag_on_wraps_claude_in_the_sandbox(tmp_path, launcher, monkeypatch):
    sb = FakeSandbox()
    calls: list[dict[str, Any]] = []

    def start(**kw: Any) -> FakeSandbox:
        calls.append(kw)
        return sb

    monkeypatch.setenv("FACTORY_SANDBOX", "on")
    monkeypatch.setattr(claude_run, "start_run_sandbox", start)
    res = _dev_run(tmp_path)
    assert res.success
    script = _round_script(tmp_path)
    # bash script (POSIX) or JSON spec (Windows): claude's argv follows the wrap
    assert re.search(r"SBX-EXEC\W+--\W+/usr/bin/claude", script), script
    assert sb.closed
    (kw,) = calls
    assert kw["workdir"] == tmp_path / "wt" and "/usr/bin/claude" in kw["extra_readable"]


def test_flag_on_but_sandbox_fails_never_runs_unsandboxed(tmp_path, launcher, monkeypatch):
    def boom(**_kw: Any) -> None:
        raise OSError("bwrap missing")

    monkeypatch.setenv("FACTORY_SANDBOX", "on")
    monkeypatch.setattr(claude_run, "start_run_sandbox", boom)
    res = _dev_run(tmp_path)
    assert not res.success and launcher.started == []
    assert "sandbox did not start" in (res.error or "")
    assert "sandbox did not start" in _runs(tmp_path / "state" / "factory.db")[0]["error"]


class FakeAgent:
    def __init__(self, tools: list[Any]) -> None:
        self.tools = tools

    def model_copy(self, update: dict[str, Any]) -> FakeAgent:
        return FakeAgent(update["tools"])


@pytest.mark.skipif(sys.platform != "win32", reason="the Windows refusal")
def test_api_terminal_is_refused_on_windows_not_half_applied(tmp_path):
    from factory.runner import sandbox_terminal

    with pytest.raises(OSError, match="not sandboxed on Windows"):
        sandbox_terminal(FakeAgent([]), repo_path=tmp_path, state_dir=tmp_path / "s")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX terminal backend")
def test_api_terminal_runs_bash_through_the_sandbox(tmp_path, monkeypatch):
    from openhands.sdk import Tool

    import factory.sandbox.host as host
    from factory.runner import sandbox_terminal

    class FakeRun:
        def __init__(self, **kw: Any) -> None:
            self.kw = kw
            self.policy_path = tmp_path / "s" / "policy.json"

        def start(self) -> FakeRun:
            Path(self.kw["state_dir"]).mkdir(parents=True, exist_ok=True)
            return self

        def close(self) -> None:
            return

    monkeypatch.setattr(host, "SandboxRun", FakeRun)
    agent = FakeAgent([Tool(name="terminal"), Tool(name="file_editor")])
    out = sandbox_terminal(agent, repo_path=tmp_path, state_dir=tmp_path / "s")
    term = next(t for t in out.tools if t.name == "terminal")
    assert term.params["terminal_type"] == "subprocess"
    script = Path(term.params["shell_path"]).read_text()
    assert "factory.sandbox.exec" in script and "/bin/bash" in script and str(FakeRun(state_dir="x").policy_path) in script
    assert next(t for t in out.tools if t.name == "file_editor").params in ({}, None)


@pytest.mark.parametrize("value", [None, "off", "0", "nope"])
def test_flag_off_is_todays_behaviour(tmp_path, launcher, monkeypatch, value):
    if value is None:
        monkeypatch.delenv("FACTORY_SANDBOX", raising=False)
    else:
        monkeypatch.setenv("FACTORY_SANDBOX", value)
    monkeypatch.setattr(claude_run, "start_run_sandbox", lambda **_k: pytest.fail("sandbox started"))
    assert _dev_run(tmp_path).success
    assert "SBX-EXEC" not in _round_script(tmp_path)
