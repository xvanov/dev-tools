"""The ``claude_session`` runtime (docs/JOBS-API.md v1.2).

No ``claude`` binary and no termhub are needed: the launcher is the seam. A fake
launcher "runs" a round synchronously by writing the stream-json and exit files
the real round script would write.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from factory.claude_session import cli as claude_cli
from factory.claude_session import ledger
from factory.claude_session import run as claude_run
from factory.claude_session.conversation import run_conversation
from factory.claude_session.launcher import (
    RoundPlan,
    SessionInfo,
    build_claude_argv,
    build_round_script,
    round_plan,
)
from factory.claude_session.stream import parse_stream, render_event
from factory.jobs.kinds import split_claude_model
from factory.runner import GateVerdict

# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _stream(
    *,
    session: str = "sess-1",
    cost: float = 0.25,
    error: bool = False,
    text: str = "done",
    out_tokens: int = 40,
) -> str:
    events = [
        {"type": "system", "subtype": "init", "session_id": session, "model": "claude-x"},
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": text},
                    {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
                ]
            },
        },
        {
            "type": "result",
            "subtype": "error_during_execution" if error else "success",
            "is_error": error,
            "result": text,
            "session_id": session,
            "total_cost_usd": cost,
            "num_turns": 3,
            "duration_ms": 1200,
            "usage": {
                "input_tokens": 10,
                "cache_creation_input_tokens": 5,
                "cache_read_input_tokens": 100,
                "output_tokens": out_tokens,
            },
        },
    ]
    return "\n".join(json.dumps(e) for e in events) + "\n"


class FakeLauncher:
    """Each round: optional side effect on the tree, then stream + exit files."""

    def __init__(self, rounds: list[dict[str, Any]] | None = None) -> None:
        self.rounds = rounds or [{}]
        self.started: list[int] = []
        self.killed = False
        self.alive_answer: bool | None = True

    def _run(self, plan: RoundPlan, cwd: Path) -> None:
        spec = self.rounds[min(plan.round_no - 1, len(self.rounds) - 1)]
        self.started.append(plan.round_no)
        if spec.get("hang"):
            return  # never writes exit (killed by wall clock / cancel)
        if spec.get("write"):
            (cwd / spec["write"]).write_text(f"round {plan.round_no}\n", encoding="utf-8")
        if not spec.get("no_result"):
            plan.stream_path.write_text(
                _stream(
                    cost=spec.get("cost", 0.25),
                    error=spec.get("error", False),
                    text=spec.get("text", "done"),
                    out_tokens=spec.get("out_tokens", 40),
                ),
                encoding="utf-8",
            )
        plan.exit_path.write_text("0\n", encoding="utf-8")

    def start(self, plan: RoundPlan, *, cwd: Path, title: str) -> SessionInfo:
        self._run(plan, cwd)
        return SessionInfo(machine="box", termhub_session_id="th-1", url="https://th/#session=th-1")

    def next_round(self, session: SessionInfo, plan: RoundPlan, *, cwd: Path) -> None:
        self._run(plan, cwd)

    def alive(self, session: SessionInfo) -> bool | None:
        return self.alive_answer

    def kill(self, session: SessionInfo, plans: list[RoundPlan]) -> None:
        self.killed = True


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


def _fp_files(path: Path) -> str:
    return "|".join(sorted(f"{p.name}:{p.read_text()}" for p in path.iterdir() if p.is_file()))


def _conv(tmp_path: Path, launcher: Any, **kw: Any) -> Any:
    cwd = tmp_path / "wt"
    cwd.mkdir(exist_ok=True)
    clock = FakeClock()
    kw.setdefault("fingerprint", _fp_files)
    return run_conversation(
        cwd=cwd,
        run_dir=tmp_path / "run",
        prompt="do it",
        title="t",
        launcher=launcher,
        claude_bin="/usr/bin/claude",
        clock=clock,
        sleep=clock.sleep,
        **kw,
    )


# --------------------------------------------------------------------------- #
# pure parts
# --------------------------------------------------------------------------- #


def test_parse_stream_reads_cost_tokens_and_session() -> None:
    res = parse_stream(_stream(cost=1.5) + "not json\n")
    assert res.found and not res.is_error
    assert res.session_id == "sess-1"
    assert res.total_cost_usd == 1.5
    assert res.tokens_in == 115 and res.cached_input_tokens == 100 and res.tokens_out == 40
    assert res.model == "claude-x"
    assert res.tool_calls[0]["tool"] == "Bash"


def test_parse_stream_without_result_is_not_found() -> None:
    res = parse_stream('{"type": "system", "subtype": "init", "session_id": "s"}\n')
    assert not res.found and res.session_id == "s"


def test_parse_stream_error_result() -> None:
    assert parse_stream(_stream(error=True)).is_error


def test_render_event_lines() -> None:
    lines = [render_event(json.loads(line)) for line in _stream().splitlines()]
    assert "session sess-1" in lines[0]
    assert "▸ Bash" in lines[1]
    assert "api-equivalent $0.2500" in lines[2]


def test_argv_and_script_unset_api_keys_and_resume(tmp_path: Path) -> None:
    argv = build_claude_argv("/c", model="claude-sonnet-x", session_uuid="u", resume=None)
    assert argv[:5] == ["/c", "-p", "--output-format", "stream-json", "--verbose"]
    assert "--session-id" in argv and "--resume" not in argv
    assert argv[argv.index("--model") + 1] == "claude-sonnet-x"
    argv2 = build_claude_argv("/c", model=None, session_uuid="u", resume="s1")
    assert "--resume" in argv2 and "--session-id" not in argv2 and "--model" not in argv2

    plan = round_plan(tmp_path, 2)
    script = build_round_script(plan, cwd=tmp_path, claude_argv=argv2, title="job x")
    assert "unset ANTHROPIC_API_KEY" in script
    assert str(plan.stream_path) in script and "PIPESTATUS[0]" in script
    assert "factory.claude_session.pretty" in script
    assert f"mv {plan.exit_path}.tmp {plan.exit_path}" in script.replace("'", "")


def test_split_claude_model() -> None:
    rest, model = split_claude_model(["dev=azure/x", "claude_session=claude-opus-x"])
    assert rest == ["dev=azure/x"] and model == "claude-opus-x"
    rest, model = split_claude_model(["claude_session=a", "claude_session=b"])
    assert model is None and len(rest) == 2  # duplicate left for the parser to refuse


@pytest.mark.parametrize(
    ("code", "out", "ok"),
    [
        (0, '{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "team"}', True),
        (1, '{"loggedIn": false}', False),
        (0, '{"loggedIn": true, "authMethod": "api_key"}', False),
        (0, "garbage", False),
    ],
)
def test_check_available(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, code: int, out: str, ok: bool
) -> None:
    binary = tmp_path / "claude"
    binary.write_text("")
    monkeypatch.setenv("FACTORY_CLAUDE_BIN", str(binary))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
    seen: dict[str, Any] = {}

    def probe(argv: list[str], env: dict[str, str]) -> tuple[int, str]:
        seen["argv"], seen["env"] = argv, env
        return code, out

    monkeypatch.setattr(claude_cli, "probe", probe)
    assert claude_cli.check_available()[0] is ok
    assert seen["argv"][1:] == ["auth", "status"]
    assert "ANTHROPIC_API_KEY" not in seen["env"]


def test_check_available_without_binary(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("FACTORY_CLAUDE_BIN", str(tmp_path / "missing"))
    ok, why = claude_cli.check_available()
    assert not ok and "not on PATH" in why


# --------------------------------------------------------------------------- #
# the conversation driver
# --------------------------------------------------------------------------- #


def test_single_round_without_gate(tmp_path: Path) -> None:
    launcher = FakeLauncher()
    seen: list[SessionInfo] = []
    res = _conv(tmp_path, launcher, on_session=seen.append)
    assert res.stop_reason == "done"
    assert res.subscription_equiv_usd == 0.25 and res.session_id == "sess-1"
    assert seen and seen[0].termhub_session_id == "th-1"
    assert (tmp_path / "run" / "prompt-1.md").read_text() == "do it"


def test_gate_feedback_resumes_the_same_session_until_green(tmp_path: Path) -> None:
    launcher = FakeLauncher([{"write": "a.txt"}, {"write": "b.txt"}])
    cwd = tmp_path / "wt"
    cwd.mkdir()
    calls = {"n": 0}

    def gate() -> GateVerdict:
        calls["n"] += 1
        return GateVerdict(passed=(cwd / "b.txt").exists(), reason="need b.txt")

    res = _conv(tmp_path, launcher, gate_check=gate, max_gate_rounds=3)
    assert res.stop_reason == "green" and launcher.started == [1, 2]
    assert [r["passed"] for r in res.gate_rounds] == [False, True]
    script2 = (tmp_path / "run" / "round-2.sh").read_text()
    assert "--resume sess-1" in script2.replace("'", "")
    assert "GATE RESULT" in (tmp_path / "run" / "prompt-2.md").read_text()
    assert res.subscription_equiv_usd == 0.5


def test_round_that_changes_nothing_ends_the_run(tmp_path: Path) -> None:
    launcher = FakeLauncher([{"write": "a.txt"}, {}])
    res = _conv(
        tmp_path,
        launcher,
        gate_check=lambda: GateVerdict(passed=False, reason="red"),
        max_gate_rounds=3,
    )
    assert res.stop_reason == "no_progress_between_rounds" and launcher.started == [1, 2]


def test_rounds_are_capped(tmp_path: Path) -> None:
    launcher = FakeLauncher([{"write": "a.txt"}, {"write": "b.txt"}, {"write": "c.txt"}])
    res = _conv(
        tmp_path,
        launcher,
        gate_check=lambda: GateVerdict(passed=False, reason="red"),
        max_gate_rounds=2,
    )
    assert res.stop_reason == "rounds_exhausted" and launcher.started == [1, 2]


def test_wall_clock_kills_and_grades(tmp_path: Path) -> None:
    launcher = FakeLauncher([{"hang": True}])
    res = _conv(
        tmp_path,
        launcher,
        wall_clock_s=60,
        gate_check=lambda: GateVerdict(passed=False, reason="red"),
        max_gate_rounds=3,
    )
    assert res.stop_reason == "wall_clock" and res.timed_out and launcher.killed
    assert res.gate_rounds[-1]["after"] == "wall_clock"


def test_cancel_kills_and_does_not_grade(tmp_path: Path) -> None:
    launcher = FakeLauncher([{"hang": True}])
    graded: list[int] = []

    def gate() -> GateVerdict:
        graded.append(1)
        return GateVerdict(passed=True, reason="ok")

    polls = {"n": 0}

    def cancelled() -> bool:
        polls["n"] += 1
        return polls["n"] > 3

    res = _conv(tmp_path, launcher, gate_check=gate, max_gate_rounds=3, cancelled=cancelled)
    assert res.cancelled and res.stop_reason == "cancelled" and launcher.killed
    assert not graded


def test_no_progress_abort_in_first_round(tmp_path: Path) -> None:
    launcher = FakeLauncher([{"hang": True}])
    res = _conv(
        tmp_path,
        launcher,
        no_progress_abort_s=10,
        gate_check=lambda: GateVerdict(passed=False, reason="red"),
        max_gate_rounds=3,
    )
    assert res.stop_reason == "no_progress_first_write" and launcher.killed


def test_lost_session_is_reported(tmp_path: Path) -> None:
    launcher = FakeLauncher([{"hang": True}])
    launcher.alive_answer = False
    res = _conv(tmp_path, launcher)
    assert res.stop_reason == "session_lost" and "ended without finishing" in (res.error or "")


def test_round_without_result_event(tmp_path: Path) -> None:
    res = _conv(tmp_path, FakeLauncher([{"no_result": True}]))
    assert res.stop_reason == "no_result" and not res.any_result


# --------------------------------------------------------------------------- #
# ledger + the dev adapter
# --------------------------------------------------------------------------- #


def _runs(db: Path) -> list[dict[str, Any]]:
    import sqlite3

    con = sqlite3.connect(db)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute("SELECT * FROM runs ORDER BY id")]
    finally:
        con.close()


def test_ledger_rows_are_subscription_billed(tmp_path: Path) -> None:
    db = tmp_path / "state" / "factory.db"
    rid = ledger.open_run(
        db, persona="dev", model=None, story_id=7, app="demo", direction_id="001", repo_path="/x"
    )
    row = _runs(db)[0]
    assert row["runtime"] == "claude_session" and row["billing"] == "subscription"
    assert row["error"].startswith("in progress")
    ledger.set_session(db, rid, {"machine": "box", "termhub_session_id": "t", "url": "u"})
    ledger.close_run(
        db,
        rid,
        success=True,
        error=None,
        tokens_in=5,
        tokens_out=6,
        cached_input_tokens=1,
        subscription_equiv_usd=2.5,
        duration_s=3.0,
        usage_reliable=True,
        model="claude-x",
    )
    row = _runs(db)[0]
    assert row["cost_usd"] == 0.0 and row["subscription_equiv_usd"] == 2.5
    assert row["success"] and row["error"] is None
    assert row["model"] == "claude_session/claude-x"
    assert json.loads(row["session_json"])["termhub_session_id"] == "t"


@pytest.fixture
def fake_claude(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> FakeLauncher:
    launcher = FakeLauncher([{"write": "impl.py"}])
    monkeypatch.setattr(claude_run, "launcher_factory", lambda: (launcher, None))
    monkeypatch.setattr(claude_cli, "claude_binary", lambda env=None: "/usr/bin/claude")
    return launcher


def test_claude_dev_run_returns_a_run_result(tmp_path: Path, fake_claude: FakeLauncher) -> None:
    repo = tmp_path / "wt"
    repo.mkdir()
    story = tmp_path / "story.md"
    story.write_text("# Story\nDo the thing.\n")
    db = tmp_path / "state" / "factory.db"
    res = claude_run.claude_dev_run(
        story_path=story,
        repo_path=repo,
        software_factory_root=tmp_path,
        db_path=db,
        model="claude-opus-x",
        test_command="true",
        story_id=3,
        app="demo",
        direction_id="001",
        wall_clock_timeout_s=5400,
        gate_check=lambda: GateVerdict(passed=(repo / "impl.py").exists(), reason="no impl"),
        max_gate_rounds=3,
        brief_addendum="# Solo pipeline",
        spend_cap_usd=1.0,
    )
    assert res.test_run_passed is True and res.success
    assert res.cost_usd == 0.0 and res.gate_stop_reason == "green"
    assert not res.premodel_infra
    rows = _runs(db)
    assert rows[0]["subscription_equiv_usd"] == 0.25 and rows[0]["story_id"] == 3
    assert rows[0]["model"] == "claude_session/claude-opus-x"
    prompt = next((tmp_path / "state" / "claude_runs").glob("demo-3-*/prompt-1.md")).read_text()
    assert "Do the thing." in prompt and "# Solo pipeline" in prompt
    assert "Do NOT push" in prompt


def test_claude_dev_run_with_no_result_is_premodel_infra(
    tmp_path: Path, fake_claude: FakeLauncher
) -> None:
    fake_claude.rounds = [{"no_result": True}]
    repo = tmp_path / "wt"
    repo.mkdir()
    story = tmp_path / "story.md"
    story.write_text("s")
    res = claude_run.claude_dev_run(
        story_path=story,
        repo_path=repo,
        software_factory_root=tmp_path,
        db_path=tmp_path / "state" / "factory.db",
        model=None,
        test_command="true",
        story_id=1,
        app="demo",
        direction_id="001",
    )
    from factory.chain.handlers import _is_premodel_infra_failure

    assert res.premodel_infra and res.test_run_passed is None
    assert _is_premodel_infra_failure(res)


def test_job_cancel_probe_reads_only_the_durable_row(tmp_path: Path) -> None:
    from factory.chain.delivery_gate import mark_job_cancelled

    db = tmp_path / "factory.db"
    probe = claude_run.job_cancel_probe(db, "demo", "001")
    assert probe() is False  # no db at all: not cancelled (unlike the merge guard)
    mark_job_cancelled(db, "demo", "001", by="t")
    assert probe() is True
    assert claude_run.job_cancel_probe(db, "demo", "002")() is False


# --------------------------------------------------------------------------- #
# Claude Code error results (observed live 2026-11-06: usage_limit_reached)
# --------------------------------------------------------------------------- #

_LIMIT = "You've hit your individual spend limit"


def test_error_result_stops_without_a_gate_round(tmp_path: Path) -> None:
    launcher = FakeLauncher([{"error": True, "text": _LIMIT, "out_tokens": 0}])
    graded: list[int] = []

    def gate() -> GateVerdict:
        graded.append(1)
        return GateVerdict(passed=False, reason="no report")

    res = _conv(tmp_path, launcher, gate_check=gate, max_gate_rounds=3)
    assert res.stop_reason == "claude_error" and launcher.started == [1]
    assert _LIMIT in (res.error or "") and not graded and not res.gate_rounds


def test_error_result_after_work_is_still_graded(tmp_path: Path) -> None:
    launcher = FakeLauncher([{"error": True, "text": "API error", "write": "a.txt"}])
    res = _conv(
        tmp_path,
        launcher,
        gate_check=lambda: GateVerdict(passed=True, reason="ok"),
        max_gate_rounds=3,
    )
    assert res.stop_reason == "claude_error" and res.final_verdict.passed
    assert res.gate_rounds[-1]["after"] == "claude_error"


def test_usage_limit_on_the_dev_step_is_infrastructure(
    tmp_path: Path, fake_claude: FakeLauncher
) -> None:
    fake_claude.rounds = [{"error": True, "text": _LIMIT, "out_tokens": 0}]
    repo = tmp_path / "wt"
    repo.mkdir()
    story = tmp_path / "story.md"
    story.write_text("s")
    res = claude_run.claude_dev_run(
        story_path=story,
        repo_path=repo,
        software_factory_root=tmp_path,
        db_path=tmp_path / "state" / "factory.db",
        model=None,
        test_command="true",
        story_id=1,
        app="demo",
        direction_id="001",
        gate_check=lambda: GateVerdict(passed=False, reason="red"),
        max_gate_rounds=3,
    )
    assert res.premodel_infra and res.test_run_passed is None and _LIMIT in (res.error or "")
