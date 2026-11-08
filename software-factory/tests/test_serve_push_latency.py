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
