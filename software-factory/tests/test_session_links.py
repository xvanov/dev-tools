"""E1 (docs/native/PLAN.md): one id chain, job -> step -> session.

A claude_session run's termhub session is started with ``links`` (the job, the
step's ``runs`` row, the story, the job's external id), so termhub returns them
in ``GET /api/sessions`` and the session leads back to its job without reading
its title; the same links are stored with the run's session and come back in
``job status`` ``runs[].session.links``. An older termhub client signature (no
``links``) must keep working: links are only sent when there are some.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from factory.claude_session import cli as claude_cli
from factory.claude_session import run as claude_run
from factory.claude_session.launcher import RoundPlan, SessionInfo, TermhubLauncher
from factory.claude_session.termhub import TermhubClient


def test_session_links_names_job_step_story_and_extras() -> None:
    links = claude_run.session_links(
        app="dev-tools", direction_id="031", story_id=7, row_id=9001,
        extra={"external": "inst-12", "empty": None, "blank": "", "job": "ignored"},
    )  # fmt: skip
    assert links == {"job": "dev-tools:031", "step": "9001", "story": "7", "external": "inst-12"}
    # A research job: no story; the job id is <app>:<task id>.
    assert claude_run.session_links(
        app="scratch", direction_id="r0003", story_id=None, row_id=4
    ) == {"job": "scratch:r0003", "step": "4"}
    assert claude_run.session_links(app=None, direction_id=None, story_id=None, row_id=None) is None


class _Client:
    def __init__(self, *, accepts_links: bool = True) -> None:
        self.calls: list[dict[str, Any]] = []
        self.accepts_links = accepts_links

    def create_session(self, **kw: Any) -> str:
        if "links" in kw and not self.accepts_links:
            raise TypeError("unexpected keyword argument 'links'")
        self.calls.append(kw)
        return "th-9"

    def session_url(self, sid: str) -> str:
        return f"https://th/#session={sid}"


def _plan(tmp_path: Path) -> RoundPlan:
    from factory.claude_session.launcher import round_plan

    return round_plan(tmp_path, 1)


def test_termhub_launcher_sends_links_and_keeps_them_on_the_session(tmp_path: Path) -> None:
    client = _Client()
    launcher = TermhubLauncher(client, "box")
    launcher.links = {"job": "a:001", "step": "5"}
    info = launcher.start(_plan(tmp_path), cwd=tmp_path, title="t")
    assert client.calls[0]["links"] == {"job": "a:001", "step": "5"}
    assert info.as_json() == {
        "machine": "box", "termhub_session_id": "th-9", "url": "https://th/#session=th-9",
        "links": {"job": "a:001", "step": "5"},
    }  # fmt: skip


def test_termhub_launcher_without_links_calls_the_old_signature(tmp_path: Path) -> None:
    client = _Client(accepts_links=False)
    info = TermhubLauncher(client, "box").start(_plan(tmp_path), cwd=tmp_path, title="t")
    assert "links" not in client.calls[0]
    assert "links" not in (info.as_json() or {})


def test_termhub_client_puts_links_in_the_body(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[Any] = []

    def fake_call(self: TermhubClient, path: str, *, method: str = "GET", body: Any = None) -> Any:
        sent.append(body)
        return {"id": "s1"}

    monkeypatch.setattr(TermhubClient, "_call", fake_call)
    c = TermhubClient(base="http://127.0.0.1:7010")
    assert c.create_session(cwd="/w", command="x", title="t", links={"job": "a:1"}) == "s1"
    assert c.create_session(cwd="/w", command="x", title="t") == "s1"
    assert sent[0]["links"] == {"job": "a:1"}
    assert "links" not in sent[1]


class _LinkLauncher:
    """Ends each round at once; reports the links it was given."""

    def __init__(self) -> None:
        self.links: dict[str, str] | None = None

    def start(self, plan: RoundPlan, *, cwd: Path, title: str) -> SessionInfo:
        plan.exit_path.write_text("0\n", encoding="utf-8")
        return SessionInfo(
            machine="box", termhub_session_id="th-1", url="https://u", links=self.links
        )

    def next_round(self, session: SessionInfo, plan: RoundPlan, *, cwd: Path) -> None:
        plan.exit_path.write_text("0\n", encoding="utf-8")

    def alive(self, session: SessionInfo) -> bool | None:
        return True

    def kill(self, session: SessionInfo, plans: list[RoundPlan]) -> None:
        pass


def test_run_claude_gives_the_session_its_links_and_stores_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launcher = _LinkLauncher()
    monkeypatch.setattr(claude_run, "launcher_factory", lambda: (launcher, None))
    monkeypatch.setattr(claude_cli, "claude_binary", lambda env=None: "/usr/bin/claude")
    db = tmp_path / "state" / "factory.db"
    out = claude_run.run_claude(
        db_path=db, persona="dev", cwd=tmp_path, run_dir=tmp_path / "run", prompt="p",
        title="t", model=None, wall_clock_s=60, story_id=3, app="demo", direction_id="001",
        links={"external": "inst-5"},
    )  # fmt: skip
    step = str(out.run_row_id)
    assert launcher.links == {"job": "demo:001", "step": step, "story": "3", "external": "inst-5"}
    con = sqlite3.connect(db)
    try:
        (raw,) = con.execute(
            "SELECT session_json FROM runs WHERE id = ?", (out.run_row_id,)
        ).fetchone()
    finally:
        con.close()
    assert json.loads(raw)["links"] == launcher.links
