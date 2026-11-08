"""``factory serve``: the in-process tick scheduler (replaces systemd timers).

On Linux the factory ticks from systemd user timers (``factory-tick@<app>.timer``,
every 5 minutes; a oneshot service, so ticks of one app never overlap). Windows
has no systemd, so ``factory serve`` does the same job in one long-lived
process. Linux keeps its timers; serve refuses to run beside them.

What it does, every ``poll_s`` (1 s):

* **Ticks.** Each app is ticked as a FRESH subprocess (``python -m factory tick
  --app <app>``), like the systemd unit, so a ``git pull`` of chain code is
  picked up on the next tick and a crash in one tick cannot take the scheduler
  down. One app's ticks never overlap; different apps tick in parallel. An app
  is due every ``interval_s`` (default 300 s) after its last tick STARTED.
* **Wake.** ``factory job submit`` / ``resume`` drop a file in
  ``state/scheduler/wake.d/`` (:func:`request_wake`). Serve sees it within one
  poll, starts queued research/report jobs at once (``dispatch_tasks``, no LLM,
  milliseconds), and ticks the named app (or every app) without waiting for the
  interval. A wake for an app that is mid-tick re-ticks it as soon as that tick
  ends, so the submission is never missed.
* **Dispatch.** ``dispatch_tasks`` also runs every interval in-process, so
  research/report jobs start and dead workers are reaped even when a tick cannot
  run (a machine with no LLM provider key: ``factory tick`` exits 2 before its
  own dispatch).
* **Lease.** Only one serve runs per factory root: it holds an exclusive lock on
  ``state/locks/serve.lock`` for its lifetime (released by the OS if it dies, so
  there is never a stale lease). Each tick it starts also takes
  ``state/locks/tick-<app>.lock`` (``FACTORY_TICK_LOCK=1``), so a tick orphaned
  by a killed serve is never doubled by the next serve.
* **Timeout.** A tick running longer than ``tick_timeout_s`` (default 3600 s)
  is killed (whole tree).

``factory serve --status`` reports the lease holder (``state/scheduler/serve.json``).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import IO, Any

from factory.oscompat import (
    IS_WINDOWS,
    detached_popen_kwargs,
    kill_tree,
    lock_file,
    pid_alive,
    unlock_file,
)

DEFAULT_INTERVAL_S = 300.0
DEFAULT_POLL_S = 1.0
DEFAULT_TICK_TIMEOUT_S = 3600.0
#: Env var that makes ``factory tick`` take the per-app tick lock.
TICK_LOCK_ENV = "FACTORY_TICK_LOCK"
ALL_APPS = "*"


def scheduler_dir(root: Path) -> Path:
    return Path(root) / "state" / "scheduler"


def wake_dir(root: Path) -> Path:
    return scheduler_dir(root) / "wake.d"


def status_path(root: Path) -> Path:
    return scheduler_dir(root) / "serve.json"


def lease_path(root: Path) -> Path:
    return Path(root) / "state" / "locks" / "serve.lock"


def tick_lock_path(root: Path, app: str) -> Path:
    return Path(root) / "state" / "locks" / f"tick-{app}.lock"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# Wake trigger (writers: submit / resume; reader: serve)
# --------------------------------------------------------------------------- #


def request_wake(root: Path, app: str | None = None, *, reason: str = "") -> None:
    """Ask a running ``factory serve`` to act now. Never raises.

    One file per request (no shared file to race on); serve consumes them.
    Harmless when no serve runs (Linux/systemd): the directory just collects a
    few bytes until the next serve, which treats them as one wake.
    """
    try:
        d = wake_dir(root)
        d.mkdir(parents=True, exist_ok=True)
        name = f"{time.time_ns()}-{uuid.uuid4().hex[:8]}"
        tmp = d / f".{name}.tmp"
        tmp.write_text(
            json.dumps({"app": app or ALL_APPS, "reason": reason, "at": _now_iso()}),
            encoding="utf-8",
        )
        os.replace(tmp, d / f"{name}.wake")
    except Exception:  # noqa: BLE001 - a wake is an optimisation, never a failure
        pass


def consume_wakes(root: Path) -> set[str]:
    """Read and delete pending wake files; return the app names (``*`` = all)."""
    d = wake_dir(root)
    apps: set[str] = set()
    try:
        entries = sorted(d.glob("*.wake"))
    except OSError:
        return apps
    for p in entries:
        try:
            data = json.loads(p.read_text(encoding="utf-8") or "{}")
            apps.add(str(data.get("app") or ALL_APPS))
        except (OSError, ValueError):
            apps.add(ALL_APPS)
        try:
            p.unlink()
        except OSError:
            pass
    return apps


# --------------------------------------------------------------------------- #
# Lease
# --------------------------------------------------------------------------- #


class LeaseHeld(RuntimeError):
    pass


class Lease:
    """Exclusive, process-lifetime lock on ``state/locks/serve.lock``."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._fh: IO[str] | None = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = self.path.open("a+")
        try:
            lock_file(fh, blocking=False)
        except BlockingIOError as exc:
            fh.close()
            raise LeaseHeld(f"another factory serve holds {self.path}") from exc
        self._fh = fh

    def release(self) -> None:
        if self._fh is not None:
            unlock_file(self._fh)
            self._fh.close()
            self._fh = None

    def __enter__(self) -> Lease:
        self.acquire()
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()


def read_status(root: Path) -> dict[str, Any]:
    """The last status serve wrote, plus whether its lease is held right now."""
    try:
        data: dict[str, Any] = json.loads(status_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    held = False
    lp = lease_path(root)
    if lp.exists():
        try:
            with lp.open("a+") as fh:
                try:
                    lock_file(fh, blocking=False)
                    unlock_file(fh)
                except BlockingIOError:
                    held = True
        except OSError:
            pass
    data["lease_held"] = held
    pid = data.get("pid")
    data["running"] = bool(held and pid and pid_alive(int(pid)))
    return data


# --------------------------------------------------------------------------- #
# The loop
# --------------------------------------------------------------------------- #


def tick_argv(app: str) -> list[str]:
    return [sys.executable, "-m", "factory", "tick", "--app", app]


@dataclass
class _Running:
    proc: subprocess.Popen[bytes]
    started: float
    log: IO[bytes]
    reason: str


@dataclass
class ServeConfig:
    root: Path
    apps: list[str]
    interval_s: float = DEFAULT_INTERVAL_S
    poll_s: float = DEFAULT_POLL_S
    tick_timeout_s: float = DEFAULT_TICK_TIMEOUT_S
    dispatch: bool = True


Spawn = Callable[[list[str], Path, IO[bytes], dict[str, str]], "subprocess.Popen[bytes]"]


def _default_spawn(
    argv: list[str], cwd: Path, log: IO[bytes], env: dict[str, str]
) -> subprocess.Popen[bytes]:
    return subprocess.Popen(  # noqa: S603 - our own interpreter and module
        argv, cwd=str(cwd), stdout=log, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, env=env, **detached_popen_kwargs(),
    )


def _default_dispatch(root: Path) -> dict[str, Any]:
    from factory.jobs.tasks import dispatch_tasks

    return dispatch_tasks(root)


@dataclass
class Scheduler:
    cfg: ServeConfig
    spawn: Spawn = _default_spawn
    dispatch: Callable[[Path], dict[str, Any]] = _default_dispatch
    clock: Callable[[], float] = time.monotonic
    out: Callable[[str], None] = field(default=lambda line: print(line, flush=True))
    running: dict[str, _Running] = field(default_factory=dict)
    next_due: dict[str, float] = field(default_factory=dict)
    pending: dict[str, str] = field(default_factory=dict)
    next_dispatch: float = 0.0
    ticks_started: int = 0

    def log(self, msg: str) -> None:
        self.out(f"{_now_iso()} serve: {msg}")

    # -- ticks ---------------------------------------------------------------- #

    def _start_tick(self, app: str, reason: str) -> None:
        log_dir = Path(self.cfg.root) / "state" / "logs" / "serve"
        log_dir.mkdir(parents=True, exist_ok=True)
        log = (log_dir / f"tick-{app}.log").open("ab")
        log.write(f"\n=== {_now_iso()} tick --app {app} ({reason}) ===\n".encode())
        log.flush()
        env = dict(os.environ)
        env[TICK_LOCK_ENV] = "1"
        env.setdefault("PYTHONUNBUFFERED", "1")
        try:
            proc = self.spawn(tick_argv(app), Path(self.cfg.root), log, env)
        except OSError as exc:
            log.close()
            self.log(f"could not start tick for {app}: {exc}")
            return
        now = self.clock()
        self.running[app] = _Running(proc=proc, started=now, log=log, reason=reason)
        self.next_due[app] = now + self.cfg.interval_s
        self.ticks_started += 1
        self.log(f"tick {app} started pid={proc.pid} ({reason})")

    def _reap(self) -> None:
        now = self.clock()
        for app, run in list(self.running.items()):
            rc = run.proc.poll()
            if rc is None and now - run.started > self.cfg.tick_timeout_s:
                self.log(f"tick {app} exceeded {self.cfg.tick_timeout_s:.0f}s; killing it")
                kill_tree(run.proc.pid, force=True)
                try:
                    rc = run.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    continue
            if rc is None:
                continue
            run.log.close()
            del self.running[app]
            self.log(f"tick {app} exited {rc} after {now - run.started:.1f}s")

    # -- one poll ------------------------------------------------------------- #

    def _dispatch(self, why: str) -> None:
        if not self.cfg.dispatch:
            return
        try:
            res = self.dispatch(Path(self.cfg.root))
        except Exception as exc:  # noqa: BLE001 - never die on dispatch
            self.log(f"dispatch ({why}) failed: {exc!r}")
            return
        if res.get("started") or res.get("reaped"):
            self.log(
                f"dispatch ({why}): started={res.get('started')} reaped={res.get('reaped')}"
            )

    def step(self, wakes: Iterable[str] = ()) -> None:
        """One poll: reap, apply wakes, dispatch if due, start due ticks."""
        self._reap()
        now = self.clock()
        woken = set(wakes)
        if woken:
            self._dispatch("wake")
            self.next_dispatch = now + self.cfg.interval_s
            targets = self.cfg.apps if ALL_APPS in woken else [a for a in woken if a in self.cfg.apps]
            for app in targets:
                self.pending[app] = "wake"
        elif now >= self.next_dispatch:
            self._dispatch("interval")
            self.next_dispatch = now + self.cfg.interval_s
        for app in self.cfg.apps:
            if app in self.running:
                continue
            if app in self.pending:
                self._start_tick(app, self.pending.pop(app))
            elif now >= self.next_due.get(app, 0.0):
                self._start_tick(app, "interval")

    def drain(self, timeout_s: float, sleep: Callable[[float], None] = time.sleep) -> None:
        """Wait for running ticks to finish, then kill what is left."""
        deadline = self.clock() + timeout_s
        while self.running and self.clock() < deadline:
            self._reap()
            if self.running:
                sleep(0.5)
        for app, run in list(self.running.items()):
            self.log(f"tick {app} still running at shutdown; killing it")
            kill_tree(run.proc.pid, force=True)
            run.log.close()
            del self.running[app]

    def snapshot(self) -> dict[str, Any]:
        return {
            "pid": os.getpid(),
            "updated_at": _now_iso(),
            "apps": list(self.cfg.apps),
            "interval_s": self.cfg.interval_s,
            "running": {a: r.proc.pid for a, r in self.running.items()},
            "ticks_started": self.ticks_started,
        }


def _write_status(root: Path, data: dict[str, Any]) -> None:
    try:
        p = status_path(root)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp, p)
    except OSError:
        pass


def systemd_timers_active() -> list[str]:
    """Active ``factory-tick@*.timer`` units (POSIX). ``[]`` when none or no systemd."""
    if IS_WINDOWS:
        return []
    try:
        proc = subprocess.run(
            ["systemctl", "--user", "list-units", "factory-tick@*.timer",
             "--state=active", "--no-legend", "--plain"],
            capture_output=True, text=True, timeout=15, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return [ln.split()[0] for ln in (proc.stdout or "").splitlines() if ln.strip()]


def serve_forever(
    sched: Scheduler,
    *,
    stop: Callable[[], bool],
    sleep: Callable[[float], None] = time.sleep,
    drain_timeout_s: float = 300.0,
    status_every_s: float = 10.0,
) -> None:
    root = Path(sched.cfg.root)
    last_status = -1e18
    try:
        while not stop():
            sched.step(consume_wakes(root))
            now = sched.clock()
            if now - last_status >= status_every_s:
                _write_status(root, sched.snapshot())
                last_status = now
            sleep(sched.cfg.poll_s)
    finally:
        sched.log("stopping: no new ticks; draining running ones")
        sched.drain(drain_timeout_s, sleep=sleep)
        snap = sched.snapshot()
        snap["stopped_at"] = _now_iso()
        _write_status(root, snap)


__all__ = [
    "ALL_APPS",
    "DEFAULT_INTERVAL_S",
    "Lease",
    "LeaseHeld",
    "Scheduler",
    "ServeConfig",
    "TICK_LOCK_ENV",
    "consume_wakes",
    "lease_path",
    "read_status",
    "request_wake",
    "serve_forever",
    "systemd_timers_active",
    "tick_lock_path",
    "tick_argv",
]
