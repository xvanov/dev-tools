"""factory serve: interval ticks, wake on submit, lease, per-app tick lock."""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from factory.scheduler import serve


class FakeProc:
    _next_pid = 1000

    def __init__(self) -> None:
        FakeProc._next_pid += 1
        self.pid = FakeProc._next_pid
        self.rc: int | None = None

    def poll(self) -> int | None:
        return self.rc

    def wait(self, timeout: float | None = None) -> int:
        return self.rc or 0


@pytest.fixture(autouse=True)
def _no_real_kills(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Fake pids must never reach the real kill_tree (taskkill / killpg)."""
    killed: list[int] = []
    monkeypatch.setattr(serve, "kill_tree", lambda pid, force=False: killed.append(pid) or True)
    return killed


class Harness:
    def __init__(
        self, root: Path, apps: list[str], interval: float = 300.0, timeout: float = 10_000.0
    ) -> None:
        self.now = 0.0
        self.spawned: list[tuple[str, FakeProc, dict[str, str]]] = []
        self.dispatches = 0
        self.lines: list[str] = []
        self.sched = serve.Scheduler(
            serve.ServeConfig(root=root, apps=apps, interval_s=interval, tick_timeout_s=timeout),
            spawn=self._spawn,
            dispatch=self._dispatch,
            clock=lambda: self.now,
            out=self.lines.append,
        )

    def _spawn(self, argv: list[str], cwd: Path, log: Any, env: dict[str, str]) -> FakeProc:
        proc = FakeProc()
        self.spawned.append((argv[-1], proc, env))
        return proc

    def _dispatch(self, root: Path) -> dict[str, Any]:
        self.dispatches += 1
        return {"started": [], "reaped": []}

    def apps_started(self) -> list[str]:
        return [a for a, _, _ in self.spawned]


def test_first_step_ticks_every_app_and_dispatches(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a", "b"])
    h.sched.step()
    assert h.apps_started() == ["a", "b"]
    assert h.dispatches == 1
    _, _, env = h.spawned[0]
    assert env[serve.TICK_LOCK_ENV] == "1"


def test_ticks_never_overlap_and_repeat_on_interval(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a"], interval=300)
    h.sched.step()
    h.now = 400  # due again, but still running
    h.sched.step()
    assert h.apps_started() == ["a"]
    h.spawned[0][1].rc = 0
    h.sched.step()  # reaped and due -> next tick
    assert h.apps_started() == ["a", "a"]
    h.spawned[1][1].rc = 0
    h.now = 500
    h.sched.step()  # finished, but not due until 700
    assert h.apps_started() == ["a", "a"]


def test_wake_ticks_the_named_app_now_and_dispatches(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a", "b"])
    h.sched.step()
    for _, p, _ in h.spawned:
        p.rc = 0
    h.now = 10
    h.sched.step()  # reaps; nothing due
    assert len(h.spawned) == 2
    d0 = h.dispatches
    h.sched.step(["b"])
    assert h.apps_started() == ["a", "b", "b"]
    assert h.dispatches == d0 + 1


def test_wake_during_a_running_tick_reticks_when_it_ends(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a"])
    h.sched.step()
    h.now = 5
    h.sched.step([serve.ALL_APPS])
    assert h.apps_started() == ["a"]  # still running
    h.spawned[0][1].rc = 0
    h.now = 6
    h.sched.step()
    assert h.apps_started() == ["a", "a"]


def test_progress_rewakes_are_capped_until_an_interval_tick(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a"], interval=300)
    h.sched.cfg.max_wake_burst = 2
    h.sched.step()  # interval tick
    for t in (1, 2, 3, 4):
        h.spawned[-1][1].rc = 0
        h.now = t
        h.sched.step(["a"])  # each finished tick made progress and re-woke its app
    # interval, wake, wake, then wakes ignored (burst cap 2)
    assert len(h.spawned) == 3
    h.spawned[-1][1].rc = 0
    h.now = 400  # interval due: resets the burst
    h.sched.step()
    h.spawned[-1][1].rc = 0
    h.now = 401
    h.sched.step(["a"])
    assert len(h.spawned) == 5


def test_wake_for_an_unserved_app_only_dispatches(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a"])
    h.sched.step()
    h.spawned[0][1].rc = 0
    h.now = 1
    h.sched.step(["other"])
    assert h.apps_started() == ["a"]
    assert h.dispatches == 2


def test_tick_over_timeout_is_killed(tmp_path: Path, _no_real_kills: list[int]) -> None:
    killed = _no_real_kills
    h = Harness(tmp_path, ["a"], timeout=100.0)
    h.sched.step()
    proc = h.spawned[0][1]
    h.now = 150  # timeout is 100

    def _wait(timeout: float | None = None) -> int:
        proc.rc = -9
        return -9

    proc.wait = _wait  # type: ignore[method-assign]
    h.sched.step()
    assert killed == [proc.pid]
    assert "a" not in h.sched.running or h.sched.running["a"].proc is not proc


def test_request_and_consume_wakes(tmp_path: Path) -> None:
    serve.request_wake(tmp_path, "x", reason="t")
    serve.request_wake(tmp_path, None)
    assert serve.consume_wakes(tmp_path) == {"x", serve.ALL_APPS}
    assert serve.consume_wakes(tmp_path) == set()


def test_request_wake_never_raises(tmp_path: Path) -> None:
    blocker = tmp_path / "state"
    blocker.write_text("not a dir")
    serve.request_wake(tmp_path, "x")  # cannot create state/scheduler: swallowed


_HOLD = """
import sys, time
sys.path.insert(0, {src!r})
from factory.scheduler.serve import Lease
from pathlib import Path
with Lease(Path({path!r})):
    print("held", flush=True)
    time.sleep(30)
"""


def test_lease_is_exclusive_and_freed_when_holder_dies(tmp_path: Path) -> None:
    path = serve.lease_path(tmp_path)
    src = str(Path(__file__).resolve().parents[1])
    holder = subprocess.Popen(
        [sys.executable, "-c", _HOLD.format(src=src, path=str(path))],
        stdout=subprocess.PIPE, text=True,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "held"
        assert serve.read_status(tmp_path)["lease_held"] is True
        with pytest.raises(serve.LeaseHeld):
            serve.Lease(path).acquire()
    finally:
        holder.kill()
        holder.wait(timeout=10)
    # The OS frees a dead holder's lock (asynchronously on Windows): no stale lease.
    lease = serve.Lease(path)
    deadline = time.monotonic() + 10
    while True:
        try:
            lease.acquire()
            break
        except serve.LeaseHeld:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.05)
    lease.release()
    assert serve.read_status(tmp_path)["lease_held"] is False


def test_serve_forever_drains_and_writes_status(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a"])
    steps = {"n": 0}

    def stop() -> bool:
        steps["n"] += 1
        if steps["n"] == 3:
            for _, p, _ in h.spawned:
                p.rc = 0
        return steps["n"] > 3

    serve.request_wake(tmp_path, "a")
    serve.serve_forever(h.sched, stop=stop, sleep=lambda s: None, drain_timeout_s=1)
    status = serve.read_status(tmp_path)
    assert status["apps"] == ["a"]
    assert "stopped_at" in status
    assert h.apps_started()[0] == "a"


def test_tick_argv_runs_the_factory_module() -> None:
    assert serve.tick_argv("x")[1:] == ["-m", "factory", "tick", "--app", "x"]


def test_python_m_factory_runs_the_cli() -> None:
    proc = subprocess.run(
        [sys.executable, "-m", "factory", "--help"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        cwd=str(Path(__file__).resolve().parents[1]),
    )
    assert proc.returncode == 0
    assert "serve" in proc.stdout
