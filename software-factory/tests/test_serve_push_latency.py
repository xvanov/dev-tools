"""E3: a job's stage reaches the PA within a second of the transition.

The transition is a real story write to ``factory.db`` (as a tick makes it),
read back by the real ``list_jobs`` and POSTed to a fake PA over HTTP.
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

import factory.cli_jobs as cli_jobs
import factory.jobs.github as gh_mod
from factory.chain.handlers import persist_story
from factory.chain.state_machine import StoryRecord, StoryState
from factory.jobs.common import state_db_path
from factory.scheduler import api


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "apps" / "demo"
    d.mkdir(parents=True)
    (d / "config.yaml").write_text("name: demo\nrepo: acme/demo\ndelivery:\n  default: draft_pr\n", encoding="utf-8")
    (tmp_path / "state").mkdir()
    monkeypatch.setattr(cli_jobs, "_FACTORY_ROOT", tmp_path)
    monkeypatch.setenv("FACTORY_STATE_ROOT", str(tmp_path))

    def gh_down(args: list[str]) -> subprocess.CompletedProcess[str]:
        raise FileNotFoundError("gh")

    monkeypatch.setattr(gh_mod, "_run_gh", gh_down)
    return tmp_path


def _submit(title: str) -> str:
    from factory.cli import app

    res = CliRunner().invoke(app, [
        "job", "submit", "--json", "--app", "demo", "--title", title, "--ask", "Do it.",
        "--done", "It is done", "--source", "pa",
    ])
    assert res.exit_code == 0, res.stdout
    return str(json.loads(res.stdout)["job_id"])


class FakePA:
    """``POST /api/factory/events``: records each pushed job with its arrival time."""

    def __init__(self) -> None:
        self.received: list[tuple[float, dict[str, Any]]] = []
        self.arrived = threading.Condition()
        pa = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args: Any) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                t = time.perf_counter()
                with pa.arrived:
                    pa.received.extend((t, j) for j in body["jobs"])
                    pa.arrived.notify_all()
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}/api/factory/events"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def wait_for(self, job_id: str, state: str, timeout: float = 5.0) -> float | None:
        deadline = time.perf_counter() + timeout
        with self.arrived:
            while True:
                for t, j in self.received:
                    if j["job_id"] == job_id and j["state"] == state:
                        return t
                left = deadline - time.perf_counter()
                if left <= 0:
                    return None
                self.arrived.wait(left)

    def close(self) -> None:
        self.srv.shutdown()
        self.srv.server_close()


def _story(root: Path, direction_id: str, state: str, slug: str) -> None:
    persist_story(
        StoryRecord(direction_id=direction_id, app="demo", title="t", slug=slug, scope="backend", state=state),
        state_db_path(root),
    )


def _watch(root: Path, url: str, logs: list[str] | None = None) -> api.JobStateWatch:
    db = state_db_path(root)
    pusher = api.JobStatePusher(root, url, log=(logs.append if logs is not None else lambda m: None))
    w = api.JobStateWatch(pusher, [db, db.with_name(db.name + "-wal")], full_every_s=60.0).start()
    deadline = time.monotonic() + 30
    while pusher._seen is None and time.monotonic() < deadline:  # the baseline (first list_jobs) is in
        time.sleep(0.02)
    return w


def test_a_story_transition_reaches_the_pa_within_a_second(root: Path) -> None:
    for i in range(3):  # finished jobs, which the fast check skips
        old = _submit(f"Old job {i}")
        _story(root, old.split(":")[1], StoryState.DEPLOYED.value, slug=f"old-{i}")
    live = [_submit(f"Live job {i}") for i in range(3)]
    pa = FakePA()
    watch = _watch(root, pa.url)
    latencies: list[float] = []
    try:
        for i, job in enumerate(live):
            time.sleep(0.3)  # apart, so each one is its own transition
            t0 = time.perf_counter()
            _story(root, job.split(":")[1], StoryState.DEV_IN_PROGRESS.value, slug=f"s-{i}")
            t1 = pa.wait_for(job, "in_progress")
            assert t1 is not None, f"{job}=in_progress never reached the PA; got {pa.received}"
            latencies.append(t1 - t0)
    finally:
        watch.stop()
        pa.close()
    print(f"\nE3 push latency, story write -> PA: {', '.join(f'{x * 1000:.0f} ms' for x in latencies)}")
    assert max(latencies) < 1.0, latencies
    assert sorted({j["job_id"] for _t, j in pa.received}) == sorted(live)  # only the jobs that moved


def test_a_transition_is_unaffected_when_the_pa_is_down(root: Path) -> None:
    job = _submit("Add dark mode")
    logs: list[str] = []
    watch = _watch(root, "http://127.0.0.1:9/api/factory/events", logs)
    try:
        t0 = time.perf_counter()
        _story(root, job.split(":")[1], StoryState.DEV_IN_PROGRESS.value, slug="s-1")
        assert time.perf_counter() - t0 < 1.0  # the write never waits on the push
        deadline = time.monotonic() + 5
        while not any("not delivered" in m for m in logs) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert any("not delivered" in m for m in logs), logs
        assert watch._thread is not None and watch._thread.is_alive()
    finally:
        watch.stop()


def test_a_poke_runs_a_full_check_and_includes_terminal_jobs(tmp_path: Path) -> None:
    states = {"a:001": "done", "a:002": "in_progress"}
    skips: list[frozenset[str]] = []

    def list_fn(_root: Path, skip: frozenset[str]) -> list[dict[str, Any]]:
        skips.append(skip)
        return [{"job_id": k, "state": v} for k, v in states.items() if k not in skip]

    sent: list[dict[str, Any]] = []
    pusher = api.JobStatePusher(tmp_path, "u", list_fn=list_fn, post=lambda url, body, t: sent.append(body) or 200)
    watch = api.JobStateWatch(pusher, [tmp_path / "factory.db"], full_every_s=60.0).start()

    def settle() -> None:
        n = len(skips)
        deadline = time.monotonic() + 5
        while len(skips) == n and time.monotonic() < deadline:
            time.sleep(0.02)

    try:
        settle()  # the baseline
        states["a:001"] = "in_progress"  # resumed outside serve's API
        watch.poke()
        settle()
        assert skips[-1] == {"a:001"} and sent == []  # the fast check still believes it done
        watch.poke(full=True)
        settle()
    finally:
        watch.stop()
    assert skips[-1] == frozenset()
    assert [j["job_id"] for b in sent for j in b["jobs"]] == ["a:001"]


def _github(monkeypatch: pytest.MonkeyPatch, *, pr_state: str = "OPEN", delay_s: float = 0.0) -> list[list[str]]:
    """``gh`` answering for acme/demo's PR #5 (green CI), each call after ``delay_s``."""
    calls: list[list[str]] = []

    def gh(args: list[str]) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        time.sleep(delay_s)
        out = ""
        if args[:2] == ["pr", "list"]:
            out = json.dumps([{"number": 5, "state": pr_state, "url": "https://github.com/acme/demo/pull/5", "headRefName": "factory/s-5"}])
        elif args[:3] == ["pr", "view", "5"] and "statusCheckRollup" in args:
            out = json.dumps({"statusCheckRollup": [{"__typename": "CheckRun", "name": "ci", "status": "COMPLETED", "conclusion": "SUCCESS"}]})
        return subprocess.CompletedProcess(["gh", *args], 0 if out else 1, out, "" if out else "not faked")

    monkeypatch.setattr(gh_mod, "_run_gh", gh)
    return calls


def test_a_jobs_end_reaches_the_pa_within_a_second(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """8.4.44: the last story's delivery was pushed as ``in_progress`` (the
    local view cannot confirm a PR) and the PA learned ``done`` 27 s later."""
    calls = _github(monkeypatch, delay_s=0.4)  # GitHub's answer takes a while
    job = _submit("Fix the review comments")
    rec = persist_story(
        StoryRecord(direction_id=job.split(":")[1], app="demo", title="t", slug="s-5", scope="backend",
                    state=StoryState.DEV_IN_PROGRESS.value),
        state_db_path(root),
    )
    pa = FakePA()
    watch = _watch(root, pa.url)
    try:
        rec.state = StoryState.DELIVERED_PR.value
        rec.github_pr_number = 5
        rec.github_branch = "factory/s-5"
        rec.delivery_level = "draft_pr"
        t0 = time.perf_counter()
        persist_story(rec, state_db_path(root))
        t1 = pa.wait_for(job, "done")
        assert t1 is not None, f"{job}=done never reached the PA; got {pa.received}"
        assert t1 - t0 < 1.0, t1 - t0
        deadline = time.monotonic() + 10
        while not any(a[:2] == ["pr", "list"] for a in calls) and time.monotonic() < deadline:
            time.sleep(0.05)
        time.sleep(1.5)  # GitHub's answer is in
    finally:
        watch.stop()
        pa.close()
    assert any(a[:2] == ["pr", "list"] for a in calls), "the end was confirmed on GitHub"
    assert [j["state"] for _t, j in pa.received if j["job_id"] == job] == ["done"]  # GitHub agreed: nothing more


def _ending(states: dict[str, Any], said: dict[str, Any]) -> tuple[api.JobStatePusher, list[dict[str, Any]], list[str]]:
    sent: list[dict[str, Any]] = []
    asked: list[str] = []

    def confirm(_root: Path, jid: str) -> dict[str, Any]:
        asked.append(jid)
        if isinstance(said.get(jid), Exception):
            raise said[jid]
        return said[jid]

    p = api.JobStatePusher(
        Path("."), "u", confirm_fn=confirm, post=lambda url, body, t: sent.extend(body["jobs"]) or 200,
        list_fn=lambda r, skip: [{"job_id": k, **v} for k, v in states.items() if k not in skip],
    )
    return p, sent, asked


_LOCAL_END = {
    "state": "in_progress",
    "why": "story 7 looks delivered locally (delivered_pr) but GitHub could not confirm it",
    "stories": [{"id": 7, "state": "delivered_pr"}],
}


def test_the_end_is_pushed_done_then_what_github_says(tmp_path: Path) -> None:
    states: dict[str, Any] = {"a:001": {"state": "in_progress", "why": "story 7 is dev_in_progress", "stories": [{"id": 7, "state": "dev_in_progress"}]}}
    said: dict[str, Any] = {"a:001": {"state": "done", "why": None}}
    p, sent, asked = _ending(states, said)
    p.check()
    states["a:001"] = dict(_LOCAL_END)
    p.check(full=False)
    assert [(j["state"], j["why"]) for j in sent] == [("done", "")] and asked == ["a:001"]
    for full in (False, True, True):  # the local view still reads in_progress: nothing more
        assert p.check(full=full) == []
    assert asked == ["a:001"], "a confirmed end is not asked again"
    # GitHub disagrees: its word is pushed, and stands.
    states["a:002"] = {"state": "queued", "why": "", "stories": []}
    p.check()
    said["a:002"] = {"state": "failed", "why": "PR #9 was closed without merging"}
    states["a:002"] = {**_LOCAL_END, "stories": [{"id": 9, "state": "delivered_pr"}]}
    sent.clear()
    p.check(full=False)
    assert [(j["job_id"], j["state"]) for j in sent] == [("a:002", "done"), ("a:002", "failed")]
    assert p.check() == []


def test_an_end_github_cannot_confirm_stays_as_pushed_and_one_still_waiting_is_asked_again(tmp_path: Path) -> None:
    states: dict[str, Any] = {"a:001": {"state": "in_progress", "why": "dev", "stories": [{"id": 1, "state": "dev_in_progress"}]}}
    said: dict[str, Any] = {"a:001": OSError("gh: no network")}
    p, sent, asked = _ending(states, said)
    p.check()
    states["a:001"] = {**_LOCAL_END, "stories": [{"id": 1, "state": "delivered_pr"}]}
    now = [0.0]
    p.clock = lambda: now[0]
    p.check(full=False)
    assert [j["state"] for j in sent] == ["done"]
    assert p.check() == [] and asked == ["a:001"], "GitHub down: the end stays as pushed"
    # CI still running on GitHub: its in_progress is pushed, and asked again on a full check after recheck_s.
    states["a:002"] = {"state": "in_progress", "why": "dev", "stories": [{"id": 2, "state": "dev_in_progress"}]}
    p.check()
    said["a:002"] = {"state": "in_progress", "why": "PR #3 is open; waiting for its CI (ci)"}
    states["a:002"] = {**_LOCAL_END, "stories": [{"id": 2, "state": "delivered_pr"}]}
    sent.clear()
    p.check(full=False)
    assert [(j["state"], j["why"][:9]) for j in sent] == [("done", ""), ("in_progress", "PR #3 is ")]
    now[0] = 10.0
    assert p.check() == []
    now[0] = 31.0
    assert p.check(full=False) == [], "only a full check asks again"
    said["a:002"] = {"state": "done", "why": None}
    assert [(j["job_id"], j["state"]) for j in p.check()] == [("a:002", "done")]
    assert asked == ["a:001", "a:002", "a:002"]


def test_jobs_that_ended_before_serve_started_are_not_announced(tmp_path: Path) -> None:
    states: dict[str, Any] = {f"a:{i:03}": dict(_LOCAL_END) for i in range(20)}
    p, sent, asked = _ending(states, {})
    p.check()
    for full in (False, True):
        assert p.check(full=full) == []
    assert sent == [] and asked == [], "no burst of pushes or GitHub reads after a restart"


def test_a_why_change_is_a_change(tmp_path: Path) -> None:
    rows = {"a:001": ("in_progress", "story 1: sm")}
    p = api.JobStatePusher(
        tmp_path, "u", post=lambda url, body, t: 200,
        list_fn=lambda r, s: [{"job_id": k, "state": st, "why": w} for k, (st, w) in rows.items()],
    )
    p.check()
    rows["a:001"] = ("in_progress", "story 1: dev")
    assert [c["why"] for c in p.check()] == ["story 1: dev"]
    assert p.check() == []
