"""Watchable API-runtime runs (native plan E2): OpenHands events -> a
stream-json-shaped file -> the claude_session pretty renderer, a read-only
termhub follower, and the session link on the run's ``runs`` row.

No paid calls: the SDK events are fakes named like the real classes (the
mapper dispatches on the class name), and ``sandbox_run`` runs against a fake
SDK as in ``test_runner_iteration_cap.py``.
"""

from __future__ import annotations

import asyncio
import json
import shlex
import sqlite3
import subprocess
import sys
import types
from pathlib import Path
from typing import Any

import pytest

from factory import api_watch
from factory.api_watch import ApiStream, follow_command, map_event, start_watch
from factory.claude_session import pretty
from factory.claude_session.stream import render_event

# --------------------------------------------------------------------------- #
# Fake SDK events (class names match openhands.sdk.event)
# --------------------------------------------------------------------------- #


class _Text:
    def __init__(self, text: str) -> None:
        self.text = text


class _Call:
    def __init__(self, arguments: str) -> None:
        self.arguments = arguments


class ActionEvent:
    source = "agent"

    def __init__(self, tool: str, args: dict[str, Any], thought: str = "", rid: str = "r1") -> None:
        self.tool_name = tool
        self.tool_call_id = f"call-{tool}"
        self.tool_call = _Call(json.dumps(args))
        self.thought = [_Text(thought)] if thought else []
        self.llm_response_id = rid


class _Obs:
    def __init__(self, text: str, is_error: bool = False) -> None:
        self.content = [_Text(text)]
        self.is_error = is_error


class ObservationEvent:
    source = "environment"

    def __init__(self, tool: str, text: str, is_error: bool = False) -> None:
        self.tool_name = tool
        self.tool_call_id = f"call-{tool}"
        self.observation = _Obs(text, is_error)


class AgentErrorEvent:
    source = "agent"
    tool_name = "terminal"
    tool_call_id = "call-x"
    error = "tool exploded"


class _Msg:
    def __init__(self, text: str) -> None:
        self.content = [_Text(text)]


class MessageEvent:
    def __init__(self, source: str, text: str, rid: str | None = None) -> None:
        self.source = source
        self.llm_message = _Msg(text)
        self.llm_response_id = rid
        self.id = f"ev-{text[:5]}"


class ConversationErrorEvent:
    source = "environment"
    code = "LLMRateLimitError"
    detail = "slow down"


class SystemPromptEvent:
    source = "agent"


# --------------------------------------------------------------------------- #
# map_event + render_event
# --------------------------------------------------------------------------- #


def test_action_maps_to_assistant_tool_use_and_renders() -> None:
    [rec] = map_event(ActionEvent("file_editor", {"path": "a.py"}, thought="edit a"))
    assert rec["type"] == "assistant"
    parts = rec["message"]["content"]
    assert parts[0] == {"type": "text", "text": "edit a"}
    assert parts[1]["type"] == "tool_use" and parts[1]["name"] == "file_editor"
    assert parts[1]["input"] == {"path": "a.py"}
    text = render_event(rec)
    assert text is not None and "edit a" in text and "file_editor" in text and "a.py" in text


def test_observation_and_errors_map_to_tool_results() -> None:
    [ok] = map_event(ObservationEvent("terminal", "3 passed"))
    [bad] = map_event(ObservationEvent("terminal", "boom", is_error=True))
    [agent_err] = map_event(AgentErrorEvent())
    for rec in (ok, bad, agent_err):
        assert rec["type"] == "user"
        assert rec["message"]["content"][0]["type"] == "tool_result"
    assert "✓ 3 passed" in (render_event(ok) or "")
    assert "✗ boom" in (render_event(bad) or "")
    assert "✗ tool exploded" in (render_event(agent_err) or "")


def test_messages_conversation_errors_and_ignored_events() -> None:
    [said] = map_event(MessageEvent("agent", "all done", rid="r9"))
    assert said["type"] == "assistant" and render_event(said) == "all done"
    [prompt] = map_event(MessageEvent("user", "Implement the story " + "x" * 2000))
    assert prompt["subtype"] == "prompt" and len(prompt["text"]) <= 600
    assert (render_event(prompt) or "").startswith("── user: Implement the story")
    [err] = map_event(ConversationErrorEvent())
    assert "LLMRateLimitError" in (render_event(err) or "")
    assert map_event(SystemPromptEvent()) == []
    assert map_event(MessageEvent("agent", "   ")) == []


def test_factory_records_render() -> None:
    assert "1200 in (200 cached) / 80 out · $0.0123" in (
        render_event(
            {
                "type": "factory",
                "subtype": "usage",
                "tokens_in": 1200,
                "tokens_out": 80,
                "cached_input_tokens": 200,
                "cost_usd": 0.0123,
            }
        )
        or ""
    )
    diff = render_event(
        {
            "type": "factory",
            "subtype": "diff",
            "files": [{"path": "a.py", "added": 3, "deleted": 1}],
            "insertions": 3,
            "deletions": 1,
            "untracked": ["b.py"],
        }
    )
    assert diff is not None and "a.py +3/-1" in diff and "b.py (new)" in diff
    gate = render_event(
        {
            "type": "factory",
            "subtype": "gate",
            "round": 2,
            "passed": False,
            "reason": "red",
            "checks": ["tests"],
        }
    )
    assert gate == "── gate round 2: FAIL [tests] — red"
    init = render_event(
        {
            "type": "system",
            "subtype": "init",
            "runtime": "api",
            "session_id": "s",
            "model": "m",
            "cwd": "/w",
            "title": "factory dev",
        }
    )
    assert init is not None and init.startswith("── API run s") and "read-only" in init
    # Claude Code's own records render exactly as before.
    assert render_event({"type": "system", "subtype": "init", "session_id": "x"}).startswith(  # type: ignore[union-attr]
        "── Claude Code session x"
    )


# --------------------------------------------------------------------------- #
# ApiStream
# --------------------------------------------------------------------------- #


def _records(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_stream_writes_turns_usage_diff_gate_and_one_result(tmp_path: Path) -> None:
    usage = iter([(100, 10, 0, 0.01), (100, 10, 0, 0.01), (300, 40, 50, 0.05)])
    diffs = iter(
        [
            {
                "files": [{"path": "a.py", "added": 1, "deleted": 0}],
                "insertions": 1,
                "deletions": 0,
                "untracked": [],
            },
        ]
    )
    last_diff: dict[str, Any] = {}

    def diff_fn() -> dict[str, Any]:
        try:
            last_diff.update(next(diffs))
        except StopIteration:
            pass
        return dict(last_diff)

    s = ApiStream(tmp_path / "run" / "stream.jsonl", usage_fn=lambda: next(usage), diff_fn=diff_fn)
    s.init(run_id="r", model="azure/deepseek", cwd="/w", persona="dev", title="t")
    s(ActionEvent("file_editor", {"path": "a.py"}, rid="r1"))
    s(ObservationEvent("file_editor", "edited"))
    s(ActionEvent("terminal", {"command": "pytest"}, rid="r1"))  # same LLM response: same turn
    s(MessageEvent("agent", "done", rid="r2"))
    s.gate(round_no=1, passed=True, reason="", checks=["tests"])
    s.end(
        success=True,
        error=None,
        tokens_in=300,
        tokens_out=40,
        cached_input_tokens=50,
        cost_usd=0.05,
    )
    s(MessageEvent("agent", "late event from an orphaned thread"))  # dropped after the end

    recs = _records(s.path)
    kinds = [(r["type"], r.get("subtype")) for r in recs]
    assert kinds[0] == ("system", "init")
    assert kinds[-1] == ("result", "success")
    assert sum(1 for k in kinds if k[0] == "result") == 1
    usages = [r for r in recs if r.get("subtype") == "usage"]
    assert [u["tokens_in"] for u in usages] == [100, 300]  # unchanged usage is not repeated
    assert [r for r in recs if r.get("subtype") == "diff"][0]["files"][0]["path"] == "a.py"
    assert any(r.get("subtype") == "gate" and r["passed"] for r in recs)
    result = recs[-1]
    assert result["num_turns"] == 2
    assert result["total_cost_usd"] == 0.05
    assert result["usage"] == {
        "input_tokens": 250,
        "cache_read_input_tokens": 50,
        "output_tokens": 40,
    }
    assert "late event" not in s.path.read_text(encoding="utf-8")
    assert "cost $0.0500 (metered)" in (render_event(result) or "")


def test_stream_never_raises(tmp_path: Path) -> None:
    def boom() -> Any:
        raise RuntimeError("stats gone")

    s = ApiStream(tmp_path / "s.jsonl", usage_fn=boom, diff_fn=boom)
    s(ActionEvent("terminal", {}))
    s(object())
    s.gate(round_no=1, passed=False, reason="x", checks=[])
    s.end(success=False, error="e", tokens_in=0, tokens_out=0, cached_input_tokens=0, cost_usd=0)
    assert _records(s.path)[-1]["type"] == "result"


def test_git_diff_summary_on_a_real_repo(tmp_path: Path) -> None:
    repo = tmp_path / "r"
    repo.mkdir()

    def git(*a: str) -> None:
        subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True)

    git("init", "-q")
    (repo / "a.txt").write_text("1\n", encoding="utf-8")
    git("add", "a.txt")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
    (repo / "a.txt").write_text("1\n2\n3\n", encoding="utf-8")
    (repo / "b.txt").write_text("new\n", encoding="utf-8")
    summary = api_watch.git_diff_summary(repo)
    assert summary == {
        "files": [{"path": "a.txt", "added": 2, "deleted": 0}],
        "insertions": 2,
        "deletions": 0,
        "untracked": ["b.txt"],
    }
    assert api_watch.git_diff_summary(tmp_path / "not-a-repo") is None


# --------------------------------------------------------------------------- #
# pretty --follow
# --------------------------------------------------------------------------- #


def test_follow_renders_until_result(tmp_path: Path) -> None:
    path = tmp_path / "stream.jsonl"
    s = ApiStream(path)
    s.init(run_id="r", model="m", cwd="/w", persona="dev", title="t")
    s(ActionEvent("terminal", {"command": "ls"}))
    out: list[str] = []
    writes = iter(
        [
            lambda: s(ObservationEvent("terminal", "file.txt")),
            lambda: s.end(
                success=True,
                error=None,
                tokens_in=1,
                tokens_out=1,
                cached_input_tokens=0,
                cost_usd=0.001,
            ),
        ]
    )

    def sleep(_: float) -> None:  # the run keeps writing while the follower polls
        next(writes, lambda: None)()

    assert pretty.follow(path, emit=out.append, sleep=sleep, max_polls=10) is True
    text = "\n".join(out)
    assert "── API run r" in text and "terminal" in text and "✓ file.txt" in text
    assert out[-1].startswith("── result: success")


def test_follow_waits_for_the_file_and_gives_up_when_idle(tmp_path: Path) -> None:
    now = [0.0]

    def sleep(dt: float) -> None:
        now[0] += dt

    out: list[str] = []
    ended = pretty.follow(
        tmp_path / "missing.jsonl",
        emit=out.append,
        sleep=sleep,
        poll_s=600.0,
        idle_exit_s=1800.0,
        clock=lambda: now[0],
    )
    assert ended is False and "likely died" in out[-1]


def test_follow_cli_replays_a_finished_file(tmp_path: Path) -> None:
    path = tmp_path / "stream.jsonl"
    s = ApiStream(path)
    s.init(run_id="r", model="m", cwd="/w", persona="dev", title="t")
    s.end(
        success=False,
        error="tests red",
        tokens_in=0,
        tokens_out=0,
        cached_input_tokens=0,
        cost_usd=0,
    )
    root = Path(api_watch.__file__).resolve().parents[1]
    proc = subprocess.run(
        [sys.executable, "-m", "factory.claude_session.pretty", "--follow", str(path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        cwd=str(root),
        stdin=subprocess.DEVNULL,
    )
    assert proc.returncode == 0
    assert "── result: error" in proc.stdout and "tests red" in proc.stdout
    assert "read-only record" in proc.stdout


def test_pretty_stdin_mode_unchanged(monkeypatch: pytest.MonkeyPatch, capsys: Any) -> None:
    import io

    lines = [
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}),
        "not json",
        "",
    ]
    monkeypatch.setattr(sys, "stdin", io.StringIO("\n".join(lines) + "\n"))
    assert pretty.main([]) == 0
    assert capsys.readouterr().out.splitlines() == ["hi", "not json"]


# --------------------------------------------------------------------------- #
# start_watch
# --------------------------------------------------------------------------- #


class _FakeClient:
    def __init__(self, fail: bool = False) -> None:
        self.created: list[dict[str, str]] = []
        self.fail = fail

    def create_session(
        self, *, cwd: str, command: str, title: str, links: dict[str, str] | None = None
    ) -> str:
        if self.fail:
            raise RuntimeError("termhub 500")
        self.created.append({"cwd": cwd, "command": command, "title": title, "links": links})
        return "th-1"

    def session_url(self, sid: str) -> str:
        return f"https://termhub.example/#session={sid}"


def _start(tmp_path: Path, **kw: Any) -> Any:
    return start_watch(
        software_factory_root=tmp_path,
        repo_path=tmp_path,
        persona="dev",
        model="azure/deepseek-v4-pro",
        app="factory",
        story_id=7,
        direction_id="042",
        **kw,
    )


def test_start_watch_opens_a_follower_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FACTORY_API_WATCH", "auto")
    client = _FakeClient()
    monkeypatch.setattr(api_watch, "client_factory", lambda: (client, "k-911"))
    watch = _start(tmp_path)
    assert watch.session == {
        "machine": "k-911",
        "termhub_session_id": "th-1",
        "url": "https://termhub.example/#session=th-1",
        "stream": str(watch.stream.path),
    }
    [made] = client.created
    assert made["command"] == follow_command(watch.stream.path)
    assert made["cwd"] == str(api_watch.FACTORY_ROOT)  # where ``-m factory`` resolves
    assert "story 7" in made["title"]
    assert watch.stream.path.parent.parent == tmp_path / "state" / "api_runs"
    assert _records(watch.stream.path)[0]["subtype"] == "init"
    assert (
        json.loads((watch.stream.path.parent / "session.json").read_text())["termhub_session_id"]
        == "th-1"
    )


def test_start_watch_falls_back_to_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FACTORY_API_WATCH", "auto")
    monkeypatch.setattr(api_watch, "client_factory", lambda: None)
    watch = _start(tmp_path)
    assert watch.session is None and "file only" in (watch.warning or "")
    assert watch.stream.path.exists()

    monkeypatch.setattr(api_watch, "client_factory", lambda: (_FakeClient(fail=True), "m"))
    watch = _start(tmp_path)
    assert watch.session is None and "termhub 500" in (watch.warning or "")

    monkeypatch.setenv("FACTORY_API_WATCH", "file")
    called: list[int] = []
    monkeypatch.setattr(api_watch, "client_factory", lambda: called.append(1))
    assert _start(tmp_path).session is None and not called

    monkeypatch.setenv("FACTORY_API_WATCH", "off")
    assert _start(tmp_path) is None


_TAIL = "-m factory.claude_session.pretty --follow"


def test_follow_command_posix() -> None:
    cmd = follow_command(
        "/tmp/has space/it's.jsonl", platform="linux", python_exe="/opt/py env/bin/python3"
    )
    root = shlex.quote(str(api_watch.FACTORY_ROOT))
    assert cmd == (
        f"PYTHONPATH={root} '/opt/py env/bin/python3' {_TAIL} "
        "'/tmp/has space/it'\"'\"'s.jsonl' < /dev/null"
    )


def test_follow_command_windows_powershell() -> None:
    # Default Windows shell is PowerShell (termhub prefers pwsh, then powershell).
    cmd = follow_command(
        r"C:\f\state\api_runs\a-1-dev-$x\it's.jsonl",
        platform="win32",
        python_exe=r"C:\Program Files\Python313\python.exe",
    )
    assert cmd == (
        r"& 'C:\Program Files\Python313\python.exe' "
        f"{_TAIL} "
        r"'C:\f\state\api_runs\a-1-dev-$x\it''s.jsonl'"
    )
    assert "/dev/null" not in cmd
    # A plain interpreter path needs no call operator.
    plain = follow_command(r"C:\s.jsonl", platform="win32", python_exe=r"C:\py\python.exe")
    assert plain == rf"C:\py\python.exe {_TAIL} 'C:\s.jsonl'"


def test_follow_command_windows_cmd() -> None:
    cmd = follow_command(
        r"C:\f\my runs\s.jsonl",
        platform="win32",
        shell="cmd",
        python_exe=r"C:\Program Files\Python313\python.exe",
    )
    assert cmd == rf'"C:\Program Files\Python313\python.exe" {_TAIL} "C:\f\my runs\s.jsonl"'
    assert "/dev/null" not in cmd and "&" not in cmd


def _finished_stream(path: Path) -> None:
    s = ApiStream(path)
    s.init(run_id="r", model="m", cwd="/w", persona="dev", title="t")
    s.end(success=True, error=None, tokens_in=1, tokens_out=1, cached_input_tokens=0, cost_usd=0)


def _run_in(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        cwd=str(api_watch.FACTORY_ROOT),
        stdin=subprocess.DEVNULL,
    )


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell")
def test_follow_command_runs_in_bash(tmp_path: Path) -> None:
    path = tmp_path / "a dir" / "s.jsonl"
    path.parent.mkdir()
    _finished_stream(path)
    proc = _run_in(["bash", "-c", follow_command(path)])
    assert proc.returncode == 0, proc.stderr
    assert "── result: success" in proc.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows shells")
@pytest.mark.parametrize("shell", ["powershell", "cmd"])
def test_follow_command_runs_in_windows_shells(tmp_path: Path, shell: str) -> None:
    path = tmp_path / "a dir" / "s.jsonl"
    path.parent.mkdir()
    _finished_stream(path)
    cmd = follow_command(path, shell=shell)
    if shell == "powershell":
        argv = ["powershell", "-NoProfile", "-Command", cmd]
    else:
        # A batch line is parsed like a line typed at the cmd prompt (``cmd /c
        # <line>`` would strip the outer quotes instead).
        bat = tmp_path / "follow.cmd"
        bat.write_text(f"@{cmd}\r\n", encoding="utf-8")
        argv = ["cmd", "/d", "/c", str(bat)]
    proc = _run_in(argv)
    assert proc.returncode == 0, proc.stderr
    assert "result: success" in proc.stdout


# --------------------------------------------------------------------------- #
# sandbox_run wiring
# --------------------------------------------------------------------------- #


def _fake_sdk(monkeypatch: pytest.MonkeyPatch, seen: dict[str, Any], db: Path) -> None:
    class _Stats:
        def get_combined_metrics(self) -> Any:
            tok = types.SimpleNamespace(
                prompt_tokens=500, completion_tokens=60, cache_read_tokens=100
            )
            return types.SimpleNamespace(accumulated_token_usage=tok, accumulated_cost=0.02)

    class _FakeConversation:
        def __init__(self, **kwargs: Any) -> None:
            seen["callbacks"] = kwargs.get("callbacks")
            self.state = types.SimpleNamespace(events=[])
            self.conversation_stats = _Stats()

        def send_message(self, text: str) -> None:
            for cb in seen["callbacks"] or []:
                cb(MessageEvent("user", text))

        def run(self) -> None:
            # The row (with its session) exists while the model is working.
            with sqlite3.connect(db) as con:
                seen["during"] = con.execute(
                    "SELECT error, session_json FROM runs ORDER BY id DESC LIMIT 1"
                ).fetchone()
            for cb in seen["callbacks"] or []:
                cb(ActionEvent("file_editor", {"path": "x.py"}, rid="r1"))
                cb(ObservationEvent("file_editor", "ok"))
                cb(MessageEvent("agent", "SELF_SUMMARY: done", rid="r2"))

        def pause(self) -> None:
            pass

        def close(self) -> None:
            pass

    fake_sdk = types.ModuleType("openhands.sdk")
    fake_sdk.LLM = lambda **_: object()  # type: ignore[attr-defined]
    fake_sdk.Conversation = _FakeConversation  # type: ignore[attr-defined]
    fake_sdk.LocalWorkspace = lambda **_: object()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openhands.sdk", fake_sdk)
    fake_tools = types.ModuleType("openhands.tools.preset.default")
    fake_tools.get_default_agent = lambda **_: object()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "openhands.tools.preset.default", fake_tools)
    fake_pydantic = types.ModuleType("pydantic")
    fake_pydantic.SecretStr = lambda s: s  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pydantic", fake_pydantic)


def test_sandbox_run_streams_and_links_the_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import factory.runner as runner
    from factory.jobs.status import runs_view

    root = tmp_path / "sf"
    db = root / "state" / "factory.db"
    repo = tmp_path / "repo"
    repo.mkdir()
    story = tmp_path / "story.md"
    story.write_text("# story\n", encoding="utf-8")
    seen: dict[str, Any] = {}
    _fake_sdk(monkeypatch, seen, db)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    monkeypatch.setenv("FACTORY_API_WATCH", "auto")
    client = _FakeClient()
    monkeypatch.setattr(api_watch, "client_factory", lambda: (client, "k-911"))
    monkeypatch.setattr(runner, "_run_pytest", lambda *_a, **_k: (True, "1 passed"))

    result = asyncio.run(
        runner.sandbox_run(
            persona="dev",
            story_path=story,
            repo_path=repo,
            llm_config=runner.LLMConfig(model="azure/gpt-5.4", api_key="x"),
            db_path=db,
            software_factory_root=root,
            story_id=7,
            app="factory",
            direction_id="042",
        )
    )
    assert result.success is True
    assert seen["callbacks"] and len(client.created) == 1

    # While running: a provisional row carrying the session.
    error_during, session_during = seen["during"]
    assert error_during == runner._PROVISIONAL_RUN_ERROR
    during = json.loads(session_during)
    assert during["termhub_session_id"] == "th-1"
    # JOBS-API v1.4 links: the step row existed before the session, so it is named.
    assert client.created[0]["links"] == during["links"]
    assert during["links"]["job"] == "factory:042" and during["links"]["story"] == "7"
    step_during = during["links"]["step"]

    # After: ONE finalised row that still links the (reviewable) session.
    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute("SELECT * FROM runs")]
    con.close()
    assert len(rows) == 1 and rows[0]["success"] == 1 and rows[0]["cost_usd"] == 0.02
    assert str(rows[0]["id"]) == step_during
    assert json.loads(rows[0]["session_json"])["links"]["step"] == step_during
    assert rows[0]["started_at"]
    [view] = runs_view(rows)
    assert view["state"] == "ok" and view["session"]["url"].endswith("#session=th-1")

    [stream_path] = list((root / "state" / "api_runs").glob("*/stream.jsonl"))
    recs = _records(stream_path)
    kinds = [(r["type"], r.get("subtype")) for r in recs]
    assert kinds[0] == ("system", "init")
    assert ("factory", "prompt") in kinds
    assert ("assistant", None) in kinds and ("user", None) in kinds
    assert ("factory", "usage") in kinds
    assert ("factory", "gate") in kinds
    assert kinds[-1] == ("result", "success")
    assert recs[-1]["total_cost_usd"] == 0.02 and recs[-1]["num_turns"] == 2


def test_sandbox_run_without_termhub_keeps_the_file_and_no_early_row(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import factory.runner as runner

    root = tmp_path / "sf"
    db = root / "state" / "factory.db"
    repo = tmp_path / "repo"
    repo.mkdir()
    story = tmp_path / "story.md"
    story.write_text("# story\n", encoding="utf-8")
    seen: dict[str, Any] = {}
    _fake_sdk(monkeypatch, seen, db)
    monkeypatch.setenv("AZURE_API_KEY", "test-key")
    # conftest sets FACTORY_API_WATCH=file
    monkeypatch.setattr(runner, "_run_pytest", lambda *_a, **_k: (False, "1 failed"))
    db.parent.mkdir(parents=True)
    runner._engine(db)  # create the schema so the during-run probe can query

    result = asyncio.run(
        runner.sandbox_run(
            persona="dev",
            story_path=story,
            repo_path=repo,
            llm_config=runner.LLMConfig(model="azure/gpt-5.4", api_key="x"),
            db_path=db,
            software_factory_root=root,
            story_id=7,
            app="factory",
        )
    )
    assert result.success is False
    assert seen["during"] is None  # unchanged behaviour: no row before spend
    [stream_path] = list((root / "state" / "api_runs").glob("*/stream.jsonl"))
    recs = _records(stream_path)
    assert recs[-1]["type"] == "result" and recs[-1]["is_error"] is True
    gate = next(r for r in recs if r.get("subtype") == "gate")
    assert gate["passed"] is False and "1 failed" in gate["reason"]
