"""Plan E5.2: a job's text step (PM triage, SM, ...) is watchable like an agent step."""

from __future__ import annotations

import json
import sqlite3
import sys
import types
from pathlib import Path
from typing import Any

import pytest

from factory import api_watch, runner


class _Resp(dict[str, Any]):
    _hidden_params = {"response_cost": 0.002}


def _fake_litellm(reply: str | Exception) -> types.ModuleType:
    mod = types.ModuleType("litellm")

    def completion(**_kw: Any) -> Any:
        if isinstance(reply, Exception):
            raise reply
        return _Resp(
            choices=[{"message": {"content": reply}, "finish_reason": "stop"}],
            usage={"prompt_tokens": 120, "completion_tokens": 30},
        )

    mod.completion = completion  # type: ignore[attr-defined]
    return mod


class _FakeClient:
    def __init__(self) -> None:
        self.sessions: list[dict[str, Any]] = []

    def create_session(self, **kw: Any) -> str:
        self.sessions.append(kw)
        return "th-1"

    def session_url(self, sid: str) -> str:
        return f"http://termhub/#session={sid}"


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "k")
    return tmp_path


def _rows(db: Path) -> list[sqlite3.Row]:
    c = sqlite3.connect(db)
    c.row_factory = sqlite3.Row
    return list(c.execute("select * from runs order by id"))


def _stream(root: Path) -> list[dict[str, Any]]:
    files = list((root / "state" / "api_runs").glob("*/stream.jsonl"))
    assert len(files) == 1
    return [json.loads(line) for line in files[0].read_text(encoding="utf-8").splitlines()]


def test_job_text_step_streams_and_links_its_session(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "litellm", _fake_litellm('{"ok": true}'))
    monkeypatch.setenv("FACTORY_API_WATCH", "auto")
    client = _FakeClient()
    monkeypatch.setattr(api_watch, "client_factory", lambda: (client, "box"))
    db = root / "state" / "factory.db"
    out = runner.text_run(
        "pm", "Triage this direction.", "deepseek/deepseek-chat", {"type": "object"},
        db_path=db, app="demo", direction_id="007", software_factory_root=root,
    )
    assert out == {"ok": True}
    recs = _stream(root)
    assert [r["type"] for r in recs] == ["system", "user", "assistant", "result"]
    assert "Triage this direction." in recs[1]["message"]["content"][0]["text"]
    assert recs[-1]["subtype"] == "success" and recs[-1]["total_cost_usd"] == 0.002
    # The live session names the step (E1 links) and the ONE final row keeps it.
    assert client.sessions and client.sessions[0]["links"]["job"] == "demo:007"
    rows = _rows(db)
    assert len(rows) == 1
    assert rows[0]["mode"] == "text" and rows[0]["success"] == 1
    assert json.loads(rows[0]["session_json"])["termhub_session_id"] == "th-1"


def test_failed_call_still_ends_the_stream_and_the_row(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "litellm", _fake_litellm(TimeoutError("provider down")))
    monkeypatch.setenv("FACTORY_API_WATCH", "auto")
    monkeypatch.setattr(api_watch, "client_factory", lambda: (_FakeClient(), "box"))
    db = root / "state" / "factory.db"
    with pytest.raises(TimeoutError):
        runner.text_run("sm", "Write the story.", "deepseek/deepseek-chat", db_path=db,
                        app="demo", story_id=3, software_factory_root=root)
    assert _stream(root)[-1]["type"] == "result" and _stream(root)[-1]["is_error"] is True
    rows = _rows(db)
    assert len(rows) == 1 and rows[0]["success"] == 0 and "provider down" in rows[0]["error"]


def test_text_call_outside_a_job_is_not_watched(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "litellm", _fake_litellm("hi"))
    called: list[int] = []
    monkeypatch.setattr(api_watch, "client_factory", lambda: called.append(1))
    runner.text_run("ralph", "scan", "deepseek/deepseek-chat", db_path=root / "state" / "factory.db",
                    software_factory_root=root)
    assert not (root / "state" / "api_runs").exists() and called == []
