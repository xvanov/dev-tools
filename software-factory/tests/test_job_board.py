"""Build's board (native plan 8.8, JOBS-API v1.11): the one event normalizer for
both runtimes' streams, the paginated step read, the board snapshot, and the
verbs on ``factory serve``.

No model calls: Claude Code records are literal stream-json lines; API records
come from ``factory.api_watch`` itself (its mapper and writer), so a change to
what the API runtime writes is caught here too.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from factory import cli_board
from factory.api_watch import ApiStream, map_event
from factory.claude_session.stream import normalize_event, render_event
from factory.jobs import board
from factory.jobs.common import JobError
from factory.observability.schema import migrate
from factory.scheduler import api

# --------------------------------------------------------------------------- #
# normalize_event: Claude Code stream-json
# --------------------------------------------------------------------------- #

CLAUDE_LINES: list[dict[str, Any]] = [
    {"type": "system", "subtype": "init", "session_id": "s-1", "model": "claude-opus-5", "cwd": "/w"},
    {"type": "assistant", "message": {"content": [
        {"type": "thinking", "thinking": "let me look"},
        {"type": "text", "text": "Reading the file."},
        {"type": "tool_use", "id": "tu1", "name": "Read", "input": {"file_path": "a.py"}},
    ]}},
    {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "tu1", "content": [{"type": "text", "text": "x = 1"}]},
    ]}},
    {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "tu2", "is_error": True, "content": "boom"},
    ]}},
    {"type": "result", "subtype": "success", "is_error": False, "num_turns": 3, "duration_ms": 1200,
     "total_cost_usd": 0.42, "usage": {"input_tokens": 10, "cache_creation_input_tokens": 5,
                                        "cache_read_input_tokens": 100, "output_tokens": 7}},
]


def test_claude_records_normalize_to_turns() -> None:
    out = [e for rec in CLAUDE_LINES for e in normalize_event(rec)]
    kinds = [e["kind"] for e in out]
    assert kinds == ["init", "thinking", "text", "tool_call", "tool_result", "tool_result", "result"]
    init, _, text, call, ok, bad, res = out
    assert init["runtime"] == "claude_session" and init["model"] == "claude-opus-5"
    assert text["text"] == "Reading the file."
    assert call["name"] == "Read" and json.loads(call["input"]) == {"file_path": "a.py"}
    assert ok["tool_use_id"] == "tu1" and ok["text"] == "x = 1" and ok["is_error"] is False
    assert bad["is_error"] is True and bad["text"] == "boom"
    # A Claude Code run's cost is what it WOULD cost at API prices: notional.
    assert res["billing"] == "notional" and res["cost_usd"] == 0.42 and res["ok"] is True
    assert res["tokens_in"] == 115 and res["cached_input_tokens"] == 100 and res["tokens_out"] == 7


def test_long_texts_are_capped_with_their_full_length() -> None:
    rec = {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t", "content": "y" * 5000}]}}
    (short,) = normalize_event(rec)
    assert len(short["text"]) == 1500 and short["full_len"] == 5000
    (full,) = normalize_event(rec, full=True)
    assert len(full["text"]) == 5000 and "full_len" not in full


def test_malformed_records_never_raise() -> None:
    for rec in ({"type": "assistant", "message": "nope"}, {"type": "user", "message": {"content": 7}},
                {"type": "result", "usage": "x"}, {"type": "factory", "subtype": "diff", "files": [1]},
                {"type": "weird"}, {}):
        assert isinstance(normalize_event(rec), list)


# --------------------------------------------------------------------------- #
# normalize_event: the API runtime (records written by factory.api_watch)
# --------------------------------------------------------------------------- #


class _Text:
    def __init__(self, text: str) -> None:
        self.text = text


class _Call:
    def __init__(self, arguments: str) -> None:
        self.arguments = arguments


class ActionEvent:
    source = "agent"

    def __init__(self) -> None:
        self.tool_name = "terminal"
        self.tool_call_id = "call-1"
        self.tool_call = _Call(json.dumps({"command": "pytest -q"}))
        self.thought = [_Text("run the tests")]
        self.llm_response_id = "r1"


class _Obs:
    content = [_Text("3 passed")]
    is_error = False


class ObservationEvent:
    source = "environment"
    tool_name = "terminal"
    tool_call_id = "call-1"
    observation = _Obs()


def _api_stream(path: Path) -> None:
    s = ApiStream(path, usage_fn=lambda: (100, 20, 50, 0.0123),
                  diff_fn=lambda: {"files": [{"path": "a.py", "added": 3, "deleted": 1}],
                                   "insertions": 3, "deletions": 1, "untracked": ["b.py"]})
    s.init(run_id="run-1", model="azure/deepseek", cwd="/w", persona="dev", title="factory dev")
    s.on_event(ActionEvent())
    s.on_event(ObservationEvent())
    s.gate(round_no=1, passed=False, reason="2 tests fail", checks=["pytest"])
    s.end(success=True, error=None, tokens_in=100, tokens_out=20, cached_input_tokens=50, cost_usd=0.0123)


def test_api_records_normalize_through_the_same_parser(tmp_path: Path) -> None:
    path = tmp_path / "stream.jsonl"
    _api_stream(path)
    recs = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    out = [e for rec in recs for e in normalize_event(rec)]
    kinds = [e["kind"] for e in out]
    assert kinds[0] == "init" and out[0]["runtime"] == "api"
    for k in ("text", "tool_call", "usage", "tool_result", "diff", "gate", "result"):
        assert k in kinds, (k, kinds)
    call = next(e for e in out if e["kind"] == "tool_call")
    assert call["name"] == "terminal" and json.loads(call["input"]) == {"command": "pytest -q"}
    result = next(e for e in out if e["kind"] == "tool_result")
    assert result["name"] == "terminal" and result["text"] == "3 passed"
    gate = next(e for e in out if e["kind"] == "gate")
    assert gate["passed"] is False and gate["checks"] == ["pytest"]
    diff = next(e for e in out if e["kind"] == "diff")
    assert diff["files"][0]["path"] == "a.py" and diff["untracked"] == ["b.py"]
    end = out[-1]
    assert end["kind"] == "result" and end["billing"] == "metered" and end["cost_usd"] == 0.0123
    # The terminal renderer still reads every one of these records.
    assert all(render_event(r) is not None for r in recs if r.get("type") != "factory" or r.get("subtype") != "usage")


def test_api_mapper_output_normalizes_one_to_one() -> None:
    (rec,) = map_event(ObservationEvent())
    (ev,) = normalize_event(rec)
    assert ev["kind"] == "tool_result" and ev["tool_use_id"] == "call-1"


# --------------------------------------------------------------------------- #
# The step read: files, cursor, pagination, long poll
# --------------------------------------------------------------------------- #


def _root(tmp_path: Path) -> Path:
    root = tmp_path / "sf"
    (root / "state").mkdir(parents=True)
    migrate(root / "state" / "factory.db")
    return root


def _add_run(root: Path, **cols: Any) -> int:
    base = {"ts": "2026-11-09T10:00:00+00:00", "persona": "dev", "model": "m", "mode": "sandbox",
            "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0, "success": 1}
    base.update(cols)
    conn = sqlite3.connect(root / "state" / "factory.db")
    try:
        cur = conn.execute(
            f"INSERT INTO runs ({', '.join(base)}) VALUES ({', '.join('?' * len(base))})",
            tuple(base.values()),
        )
        conn.commit()
        return int(cur.lastrowid or 0)
    finally:
        conn.close()


def _write(path: Path, records: list[dict[str, Any]], tail: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records) + tail, encoding="utf-8")


def test_claude_rounds_read_in_order_and_paginate(tmp_path: Path) -> None:
    root = _root(tmp_path)
    run_dir = tmp_path / "run"
    _write(run_dir / "stream-1.jsonl", CLAUDE_LINES)
    _write(run_dir / "stream-2.jsonl", CLAUDE_LINES[1:3])
    (run_dir / "stream-10.jsonl").write_text("", encoding="utf-8")  # numeric, not lexical, order
    sid = _add_run(root, runtime="claude_session", stream_path=str(run_dir), app="a", direction_id="001")
    assert [p.name for p in board.stream_files({"stream_path": str(run_dir)})] == [
        "stream-1.jsonl", "stream-2.jsonl", "stream-10.jsonl"]

    seen: list[dict[str, Any]] = []
    cursor = None
    for _ in range(20):
        page = board.step_events(root, sid, cursor=cursor, limit=2)
        seen += page["events"]
        cursor = page["cursor"]
        if not page["more"]:
            break
    assert page["done"] is True and page["step"]["job_id"] == "a:001"
    assert [e["kind"] for e in seen].count("tool_call") == 2  # once per round
    assert len({e["at"] for e in seen}) == len(CLAUDE_LINES) + 2 - 0  # one `at` per line
    # The cursor only ever moves forward: a re-read from it returns nothing new.
    assert board.step_events(root, sid, cursor=cursor)["events"] == []


def test_a_partial_line_is_not_read_until_it_ends(tmp_path: Path) -> None:
    root = _root(tmp_path)
    path = tmp_path / "api_runs" / "x" / "stream.jsonl"
    _write(path, CLAUDE_LINES[:2], tail='{"type": "assistant", "mess')
    sid = _add_run(root, stream_path=str(path), error="in progress (provisional spend checkpoint; final row pending)", success=0)
    first = board.step_events(root, sid)
    assert first["step"]["state"] == "running" and first["done"] is False
    n = len(first["events"])
    with path.open("a", encoding="utf-8") as fh:
        fh.write('age": {"content": [{"type": "text", "text": "later"}]}}\n')
    nxt = board.step_events(root, sid, cursor=first["cursor"])
    assert [e["text"] for e in nxt["events"]] == ["later"] and n == 4


def test_at_reads_one_record_uncapped(tmp_path: Path) -> None:
    root = _root(tmp_path)
    path = tmp_path / "s.jsonl"
    _write(path, [CLAUDE_LINES[0], {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t", "content": "z" * 9000}]}}])
    sid = _add_run(root, stream_path=str(path))
    page = board.step_events(root, sid)
    capped = page["events"][-1]
    assert capped["full_len"] == 9000
    one = board.step_events(root, sid, at=capped["at"])
    assert len(one["events"]) == 1 and len(one["events"][0]["text"]) == 9000


def test_wait_long_polls_a_running_step_and_returns_on_new_data(tmp_path: Path) -> None:
    root = _root(tmp_path)
    path = tmp_path / "s.jsonl"
    _write(path, [CLAUDE_LINES[0]])
    sid = _add_run(root, stream_path=str(path), success=0,
                   error="in progress (provisional spend checkpoint; final row pending)")
    cursor = board.step_events(root, sid)["cursor"]
    t = [0.0]
    sleeps: list[float] = []

    def sleep(s: float) -> None:
        sleeps.append(s)
        t[0] += s
        if len(sleeps) == 3:  # a line arrives while the read waits
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(CLAUDE_LINES[1]) + "\n")

    page = board.step_events(root, sid, cursor=cursor, wait_s=10, sleep=sleep, clock=lambda: t[0])
    assert len(sleeps) == 3 and [e["kind"] for e in page["events"]] == ["thinking", "text", "tool_call"]
    # Nothing new: it gives up at the deadline, and never waits past 25 s.
    t[0] = 0.0
    sleeps.clear()
    page = board.step_events(root, sid, cursor=page["cursor"], wait_s=999, sleep=lambda s: (sleeps.append(s), t.__setitem__(0, t[0] + s)), clock=lambda: t[0])
    assert page["events"] == [] and 24 <= sum(sleeps) <= 25.5


def test_a_finished_step_does_not_wait(tmp_path: Path) -> None:
    root = _root(tmp_path)
    path = tmp_path / "s.jsonl"
    _write(path, CLAUDE_LINES)
    sid = _add_run(root, stream_path=str(path))
    cursor = board.step_events(root, sid)["cursor"]
    page = board.step_events(root, sid, cursor=cursor, wait_s=10,
                             sleep=lambda s: pytest.fail("waited on a finished step"))
    assert page["done"] is True


def test_step_without_a_stream_and_errors(tmp_path: Path) -> None:
    root = _root(tmp_path)
    sid = _add_run(root)
    page = board.step_events(root, sid)
    assert page["has_stream"] is False and page["events"] == [] and page["done"] is True
    # A pre-v1.11 api step: its termhub session named the stream.
    path = tmp_path / "old.jsonl"
    _write(path, CLAUDE_LINES[:1])
    old = _add_run(root, session_json=json.dumps({"machine": "m", "stream": str(path)}))
    assert board.step_events(root, old)["has_stream"] is True
    with pytest.raises(JobError) as e:
        board.step_events(root, 99999)
    assert e.value.code == "not_found"
    with pytest.raises(JobError) as e:
        board.step_events(root, sid, cursor="../etc")
    assert e.value.code == "invalid_cursor"


# --------------------------------------------------------------------------- #
# The board snapshot
# --------------------------------------------------------------------------- #


def test_board_snapshot_spend_on_both_runtimes_and_recent_steps(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import UTC, datetime

    board.clear_cache()
    root = _root(tmp_path)
    now = datetime.now(UTC)
    _add_run(root, ts=now.isoformat(), cost_usd=1.5, runtime="api", app="a", direction_id="001")
    _add_run(root, ts=now.isoformat(), cost_usd=0.0, subscription_equiv_usd=2.25, runtime="claude_session",
             billing="subscription", stream_path=str(tmp_path / "run"), app="a", direction_id="001")
    monkeypatch.setattr(board, "_paused", lambda r: [{"runtime": "claude_session", "until": "x", "why": "paused: Claude limit"}])
    snap = board.board_snapshot(root, now=now)
    assert snap["spend"]["today"] == {"metered_usd": 1.5, "notional_usd": 2.25}
    assert snap["spend"]["week"]["notional_usd"] == 2.25
    assert snap["paused"][0]["runtime"] == "claude_session"
    rec = snap["recent_runs"]
    assert [r["runtime"] for r in rec] == ["claude_session", "api"]
    assert rec[0]["viewable"] is True and rec[1]["viewable"] is False and rec[0]["job_id"] == "a:001"
    assert isinstance(snap["directions"], list) and isinstance(snap["velocity"], list)
    # Cached for 2 s: a burst of page loads costs one read.
    monkeypatch.setattr(board, "_recent", lambda db, limit=15: pytest.fail("not cached"))
    assert board.board_snapshot(root, now=now)["spend"] == snap["spend"]
    board.clear_cache()


def test_a_stale_board_is_answered_at_once_and_rebuilt_behind_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import time as _time

    board.clear_cache()
    root = _root(tmp_path)
    t = [100.0]
    first = board.board_snapshot(root, monotonic=lambda: t[0])
    builds: list[int] = []
    real_build = board._build

    def slow_build(*a: Any, **k: Any) -> dict[str, Any]:
        builds.append(1)
        _time.sleep(0.3)
        return real_build(*a, **k)

    monkeypatch.setattr(board, "_build", slow_build)
    t[0] = 110.0  # 10 s old: stale but usable
    t0 = _time.perf_counter()
    again = board.board_snapshot(root, monotonic=lambda: t[0])
    assert _time.perf_counter() - t0 < 0.2, "a stale snapshot must not wait for the rebuild"
    assert again["as_of"] == first["as_of"]
    deadline = _time.time() + 5
    while board._building and _time.time() < deadline:
        _time.sleep(0.02)
    assert builds == [1] and not board._building
    # Too old (over 30 s): built in line.
    t[0] = 500.0
    board.board_snapshot(root, monotonic=lambda: t[0])
    assert builds == [1, 1]
    board.clear_cache()


# --------------------------------------------------------------------------- #
# The verbs, on the CLI and on factory serve
# --------------------------------------------------------------------------- #


def test_fast_path_parses_only_what_it_knows() -> None:
    assert cli_board.parse_fast(["job", "board", "--json"]) == {"verb": "board", "json": True}
    assert cli_board.parse_fast(["job", "board"]) is None
    opts = cli_board.parse_fast(["job", "step", "12", "--json", "--cursor", "0:10", "--limit", "50", "--wait", "5"])
    assert opts == {"verb": "step", "json": True, "step": "12", "cursor": "0:10", "limit": 50, "wait": 5.0, "at": None}
    assert cli_board.parse_fast(["job", "step", "12", "--json", "--bogus"]) is None
    assert cli_board.parse_fast(["job", "step", "12", "--json", "--limit", "x"]) is None
    assert api.allowed(["job", "board", "--json"]) and api.allowed(["job", "step", "1", "--json"])


def test_serve_answers_board_and_step(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from factory import capture

    board.clear_cache()
    root = _root(tmp_path)
    path = tmp_path / "s.jsonl"
    _write(path, CLAUDE_LINES)
    sid = _add_run(root, stream_path=str(path))
    monkeypatch.setattr(cli_board, "_root", lambda: root)
    capture.install()
    res = api.run_cli(["job", "step", str(sid), "--json", "--limit", "2"])
    body = json.loads(res["stdout"])
    assert res["code"] == 0 and body["more"] is True and body["events"][0]["kind"] == "init"
    res = api.run_cli(["job", "board", "--json"])
    assert res["code"] == 0 and "spend" in json.loads(res["stdout"])
    res = api.run_cli(["job", "step", "abc", "--json"])
    assert json.loads(res["stdout"])["error"] == "invalid_step_id"
    board.clear_cache()
