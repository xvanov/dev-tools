"""The shell-less round runner (Windows) and the termhub command line per OS."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from factory.claude_session import round as round_mod
from factory.claude_session.launcher import (
    build_round_script,
    round_argv,
    round_command,
    round_plan,
)

# A stand-in for `claude -p --output-format stream-json`: echoes stream-json
# lines (one with non-ASCII text), reports whether an API key leaked into its
# env, and exits with the code given on argv.
_FAKE_CLAUDE = r"""
import json, os, sys
prompt = sys.stdin.read()
leak = "ANTHROPIC_API_KEY" in os.environ
sys.stderr.write("diag line\n")
lines = [
    {"type": "system", "subtype": "init", "session_id": "sess-9", "model": "m"},
    {"type": "assistant", "message": {"content": [{"type": "text", "text": "héllo — " + prompt}]}},
    {"type": "result", "subtype": "success", "is_error": False, "session_id": "sess-9",
     "total_cost_usd": 0.01, "result": "leak=%s" % leak},
]
for ev in lines:
    sys.stdout.buffer.write((json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8"))
sys.stdout.flush()
sys.exit(int(sys.argv[1]))
"""


def _spec(tmp_path: Path, rc: int, cwd: Path | None = None) -> tuple[Path, dict]:
    fake = tmp_path / "fake_claude.py"
    fake.write_text(_FAKE_CLAUDE, encoding="utf-8")
    run = tmp_path / "run"
    run.mkdir(exist_ok=True)
    plan = round_plan(run, 1, windows=True)
    plan.prompt_path.write_text("do it", encoding="utf-8")
    text = build_round_script(
        plan, cwd=cwd or tmp_path, claude_argv=[sys.executable, str(fake), str(rc)],
        title="job x", windows=True,
    )
    plan.script_path.write_text(text, encoding="utf-8")
    return plan.script_path, json.loads(text)


def test_windows_plan_is_a_json_spec(tmp_path: Path) -> None:
    plan = round_plan(tmp_path, 3, windows=True)
    assert plan.script_path.name == "round-3.json"
    assert round_plan(tmp_path, 3, windows=False).script_path.name == "round-3.sh"
    spec = json.loads(build_round_script(plan, cwd=tmp_path, claude_argv=["c", "-p"], title="t", windows=True))
    assert spec["argv"] == ["c", "-p"]
    assert spec["exit_path"] == str(plan.exit_path)
    assert spec["stream_path"] == str(plan.stream_path)


def test_round_runner_end_to_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    spec_path, spec = _spec(tmp_path, rc=3)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-must-not-reach-claude")
    proc = subprocess.run(
        [sys.executable, "-m", "factory.claude_session.round", str(spec_path)],
        capture_output=True, timeout=120, cwd=str(Path(__file__).resolve().parents[1]),
    )
    assert proc.returncode == 3
    out = proc.stdout.decode("utf-8", errors="replace")
    assert "round 1" in out and "finished (exit 3)" in out
    # Byte-faithful stream (UTF-8, no re-encoding), the billing key removed.
    stream = Path(spec["stream_path"]).read_bytes().decode("utf-8")
    assert "héllo — do it" in stream
    assert '"leak=False"' in stream
    assert Path(spec["exit_path"]).read_text().strip() == "3"
    assert not Path(spec["exit_path"] + ".tmp").exists()
    assert "diag line" in Path(spec["stderr_path"]).read_text()
    assert int(Path(spec["pid_path"]).read_text().strip()) > 0


def test_round_runner_bad_cwd_exits_97(tmp_path: Path) -> None:
    spec_path, spec = _spec(tmp_path, rc=0, cwd=tmp_path / "missing")
    assert round_mod.main(["round", str(spec_path)]) == 97
    assert Path(spec["exit_path"]).read_text().strip() == "97"


def test_round_runner_missing_binary_exits_127(tmp_path: Path) -> None:
    spec_path, spec = _spec(tmp_path, rc=0)
    spec["argv"] = [str(tmp_path / "no-such-claude.exe")]
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    cwd = os.getcwd()
    try:
        assert round_mod.main(["round", str(spec_path)]) == 127
    finally:
        os.chdir(cwd)
    assert Path(spec["exit_path"]).read_text().strip() == "127"
    assert "could not start claude" in Path(spec["stderr_path"]).read_text()


def test_round_command_per_os(tmp_path: Path) -> None:
    run = tmp_path / "my run"
    plan = round_plan(run, 1, windows=True)
    ps = round_command(plan, windows=True, shell="powershell", python_exe=r"C:\py dir\python.exe")
    assert ps.startswith("& 'C:\\py dir\\python.exe' -I -m factory.claude_session.round '")
    assert ps.endswith("round-1.json'")
    cmd = round_command(plan, windows=True, shell="cmd", python_exe=r"C:\py dir\python.exe")
    assert cmd.startswith('"C:\\py dir\\python.exe" -I -m factory.claude_session.round "')
    posix = round_command(round_plan(run, 1, windows=False), windows=False)
    assert posix.startswith("bash ") and posix.endswith("round-1.sh'")


def test_round_argv_isolates_from_the_run_cwd(tmp_path: Path) -> None:
    argv = round_argv(round_plan(tmp_path, 1, windows=True), python_exe="py")
    assert argv[:4] == ["py", "-I", "-m", "factory.claude_session.round"]
