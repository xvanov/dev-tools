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
        self.orphan_closes: list[str] = []
        self.sched = serve.Scheduler(
            serve.ServeConfig(root=root, apps=apps, interval_s=interval, tick_timeout_s=timeout),
            spawn=self._spawn,
            dispatch=self._dispatch,
            close_orphans=self._close_orphans,
            clock=lambda: self.now,
            out=self.lines.append,
        )

    def _close_orphans(self, root: Path, reason: str) -> list[int]:
        self.orphan_closes.append(reason)
        return [37]

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
    # The killed tick's in-flight run row must not stay "running".
    assert h.orphan_closes == ["tick a killed after 100s"]
    assert any("closed orphaned run rows [37]" in line for line in h.lines)


def test_a_tick_that_exits_by_itself_closes_nothing(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a"], timeout=100.0)
    h.sched.step()
    h.spawned[0][1].rc = 0
    h.now = 50
    h.sched.step()
    assert h.orphan_closes == []


def test_tick_budget_is_serve_timeout(tmp_path: Path) -> None:
    """The orchestrator sizes agent dispatch by FACTORY_TICK_BUDGET_S; serve
    hands it its own kill deadline so a step is never started past it."""
    h = Harness(tmp_path, ["a"], timeout=5000.0)
    h.sched.step()
    assert h.spawned[0][2][serve.TICK_BUDGET_ENV] == "5000"


def test_default_tick_timeout_fits_a_solo_dev_step() -> None:
    """2026-11-08: serve killed at 3600 s a solo dev step the orchestrator had
    budgeted 6900 s for (job dev-tools:013)."""
    from factory.chain import orchestrator as orch
    from factory.chain.solo import SOLO_DEV_WALL_CLOCK_S
    from factory.runner import _GATE_GRADING_GRACE_S

    assert serve.DEFAULT_TICK_TIMEOUT_S >= orch._DEFAULT_TICK_BUDGET_S
    assert serve.DEFAULT_TICK_TIMEOUT_S > SOLO_DEV_WALL_CLOCK_S + _GATE_GRADING_GRACE_S


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


def test_wake_starts_one_triage_lane_per_app_next_to_the_tick(tmp_path: Path) -> None:
    import threading

    release = threading.Event()
    seen: list[str] = []

    def triage(app: str) -> None:
        seen.append(app)
        release.wait(5)

    h = Harness(tmp_path, ["a", "b"])
    h.sched.triage = triage
    h.sched.step()  # interval ticks; no wake, no triage
    assert seen == []
    h.now = 1
    h.sched.step(["a"])
    h.sched.step(["a"])  # a second wake while a's lane runs: no second lane
    h.sched.step([serve.ALL_APPS])
    release.set()
    for t in h.sched.triaging.values():
        t.join(5)
    assert sorted(seen) == ["a", "b"]


def test_pm_sync_is_one_at_a_time_per_app(tmp_path: Path) -> None:
    from factory.chain import pm_sync
    from factory.oscompat import lock_file, unlock_file

    lock = tmp_path / "state" / "locks" / "pmsync-demo.lock"
    lock.parent.mkdir(parents=True)
    with lock.open("a+") as fh:
        lock_file(fh)
        try:
            assert pm_sync.maybe_auto_pm_sync("demo", tmp_path) == (None, "busy")
        finally:
            unlock_file(fh)


def test_choose_apps_is_opt_in(tmp_path: Path) -> None:
    # (Not "on"/"off": YAML reads those bare words as booleans.)
    for name, extra in (("ticked", "serve_tick: true\n"), ("idle", ""), ("broken", None)):
        d = tmp_path / "apps" / name
        d.mkdir(parents=True)
        body = "::not yaml::\n" if extra is None else (
            f"name: {name}\nrepo: o/{name}\ndefault_branch: main\n" + extra
        )
        (d / "config.yaml").write_text(body, encoding="utf-8")
    logs: list[str] = []
    assert serve.choose_apps(tmp_path, log=logs.append) == ["ticked"]  # never "every registered app"
    assert any("broken" in m for m in logs)
    assert serve.choose_apps(tmp_path, ["idle"]) == ["idle"]  # --app wins
    assert serve.choose_apps(tmp_path, None, "idle, ticked") == ["idle", "ticked"]  # then FACTORY_SERVE_APPS


def _join_triage(h: Harness) -> None:
    for t in h.sched.triaging.values():
        t.join(5)


def test_submit_wake_triages_without_starting_a_tick(tmp_path: Path) -> None:
    """A submit used to start a maintenance tick beside triage. That tick held
    the app, so the next step waited for it to exit (8.4.15)."""
    seen: list[str] = []
    h = Harness(tmp_path, ["a", "b"])
    h.sched.triage = lambda app: seen.append(app)
    h.sched.step()
    for _, p, _ in h.spawned:
        p.rc = 0
    h.now = 10
    h.sched.step()
    n = len(h.spawned)
    d0 = h.dispatches
    h.sched.step({"a": "submit job-1"})
    _join_triage(h)
    assert len(h.spawned) == n
    assert h.dispatches == d0 + 1
    assert seen == ["a"]
    h.sched.step({"a": "triaged"})
    assert h.apps_started()[-1] == "a"
    assert h.spawned[-1][2][serve.TICK_REASON_ENV] == "wake"


class _Apps:
    """A mutable app source: what choose_apps would answer right now."""

    def __init__(self, *apps: str) -> None:
        self.apps = list(apps)
        self.calls = 0

    def __call__(self) -> list[str]:
        self.calls += 1
        return list(self.apps)


def _dynamic(tmp_path: Path, source: _Apps, refresh_s: float = 10.0) -> Harness:
    h = Harness(tmp_path, source())
    h.sched.cfg.app_source = source
    h.sched.cfg.refresh_s = refresh_s
    return h


def test_a_new_active_app_is_ticked_without_a_restart(tmp_path: Path) -> None:
    """raven (2026-11-09): serve ticked only the apps it started with, so a
    job for a newly registered app sat queued forever."""
    src = _Apps("a")
    h = _dynamic(tmp_path, src)
    h.sched.step()
    assert h.apps_started() == ["a"]
    src.apps = ["a", "raven"]  # a job was submitted to raven (no serve_tick)
    h.now = 5
    h.sched.step()  # not due for a re-read yet
    assert h.apps_started() == ["a"]
    h.now = 11
    h.sched.step()
    assert h.apps_started() == ["a", "raven"]
    assert h.sched.snapshot()["apps"] == ["a", "raven"]
    assert h.sched.snapshot()["ticks_active_jobs"] is True
    # The job finished: raven leaves the set and is not ticked again.
    src.apps = ["a"]
    for _, p, _ in h.spawned:
        p.rc = 0
    h.now = 1000
    h.sched.step()
    assert h.apps_started()[2:] == ["a"]


def test_a_wake_for_an_unknown_app_re_reads_at_once(tmp_path: Path) -> None:
    src = _Apps("a")
    h = _dynamic(tmp_path, src, refresh_s=3600)
    h.sched.step()
    src.apps = ["a", "raven"]
    h.now = 1
    h.sched.step({"raven": "resume raven:001"})
    assert h.apps_started() == ["a", "raven"]
    assert h.spawned[-1][2][serve.TICK_REASON_ENV] == "wake"


def test_a_submit_to_a_new_app_triages_first(tmp_path: Path) -> None:
    """The submit starts triage; the new app's first tick waits for triage's
    wake instead of racing it with an interval tick (8.4.15)."""
    seen: list[str] = []
    src = _Apps("a")
    h = _dynamic(tmp_path, src, refresh_s=3600)
    h.sched.triage = lambda app: seen.append(app)
    h.sched.step()
    src.apps = ["a", "raven"]
    h.now = 1
    h.sched.step({"raven": "submit raven:001"})
    _join_triage(h)
    assert seen == ["raven"]
    assert h.apps_started() == ["a"]
    h.sched.step({"raven": "triaged"})
    assert h.apps_started() == ["a", "raven"]


def test_an_app_added_by_the_periodic_refresh_does_not_tick_beside_triage(
    tmp_path: Path,
) -> None:
    """The 10 s refresh can add the app before the submit wake arrives; it must
    not start an interval tick that races triage (8.4.15)."""
    src = _Apps("a")
    h = _dynamic(tmp_path, src, refresh_s=5)
    h.sched.triage = lambda app: None
    h.sched.step()
    src.apps = ["a", "raven"]
    h.now = 10
    h.sched.step()  # refresh adds raven; no wake yet
    assert h.apps_started() == ["a"]
    h.sched.step({"raven": "submit raven:001"})
    _join_triage(h)
    assert h.apps_started() == ["a"]


def test_admit_from_the_api_adds_the_app(tmp_path: Path) -> None:
    src = _Apps("a")
    h = _dynamic(tmp_path, src, refresh_s=3600)
    h.sched.triage = lambda app: None
    h.sched.step()
    assert h.sched.admit("raven", submit=True) is False  # no job yet
    src.apps = ["a", "raven"]
    assert h.sched.admit("raven", submit=True) is True
    assert h.sched.next_due["raven"] == h.now + h.sched.cfg.interval_s


def test_a_failing_app_source_keeps_the_current_set(tmp_path: Path) -> None:
    def boom() -> list[str]:
        raise RuntimeError("db locked")

    h = Harness(tmp_path, ["a"])
    h.sched.cfg.app_source = boom
    h.sched.step()
    assert h.apps_started() == ["a"] and h.sched.cfg.apps == ["a"]
    assert any("re-reading the app set failed" in line for line in h.lines)


def test_a_fixed_app_set_says_so(tmp_path: Path) -> None:
    assert Harness(tmp_path, ["a"]).sched.snapshot()["ticks_active_jobs"] is False


def test_interval_tick_does_not_carry_the_wake_reason(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a"])
    h.sched.step()
    assert serve.TICK_REASON_ENV not in h.spawned[0][2]


def test_a_progress_wake_beside_a_submit_still_ticks(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a"])
    h.sched.triage = lambda app: None
    h.sched.step()
    h.spawned[-1][1].rc = 0
    h.now = 10
    h.sched.step()
    serve.request_wake(tmp_path, "a", reason="submit job")
    serve.request_wake(tmp_path, "a", reason="progress")
    h.sched.step(serve.consume_wake_details(tmp_path))
    _join_triage(h)
    assert h.apps_started()[-1] == "a"
    assert h.spawned[-1][2][serve.TICK_REASON_ENV] == "wake"


def test_submit_without_a_triage_lane_still_ticks(tmp_path: Path) -> None:
    h = Harness(tmp_path, ["a"])
    h.sched.step()
    h.spawned[-1][1].rc = 0
    h.now = 10
    h.sched.step()
    h.sched.step({"a": "submit job"})
    assert h.apps_started()[-1] == "a"


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
