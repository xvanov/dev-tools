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

import contextlib
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
from factory.state_dir import state_dir

DEFAULT_INTERVAL_S = 300.0
DEFAULT_POLL_S = 1.0
DEFAULT_TICK_TIMEOUT_S = 3600.0
#: Env var that makes ``factory tick`` take the per-app tick lock.
TICK_LOCK_ENV = "FACTORY_TICK_LOCK"
ALL_APPS = "*"


def scheduler_dir(root: Path) -> Path:
    return state_dir(Path(root)) / "scheduler"


def wake_dir(root: Path) -> Path:
    return scheduler_dir(root) / "wake.d"


def status_path(root: Path) -> Path:
    return scheduler_dir(root) / "serve.json"


def lease_path(root: Path) -> Path:
    return state_dir(Path(root)) / "locks" / "serve.lock"


def tick_lock_path(root: Path, app: str) -> Path:
    return state_dir(Path(root)) / "locks" / f"tick-{app}.lock"


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


def leases_db(root: Path) -> Path:
    return scheduler_dir(root) / "leases.db"


class DbLease:
    """A named lease row in ``state/scheduler/leases.db`` (plan 2.2).

    ``acquire`` takes the row when it is free, expired, already ours, or held
    by a pid on THIS host that is no longer alive (a crashed serve need not wait
    out the TTL). ``renew`` must run well inside ``ttl_s`` and returns False
    once the lease is no longer ours (then the holder must stop). ``release``
    deletes our row. Every write is one ``BEGIN IMMEDIATE`` transaction, so two
    contenders serialise on SQLite's own lock.
    """

    def __init__(self, path: Path, name: str = "factory-serve", ttl_s: float = 30.0,
                 *, clock: Callable[[], float] = time.time) -> None:
        import socket

        self.path = Path(path)
        self.name = name
        self.ttl_s = ttl_s
        self.clock = clock
        self.host = socket.gethostname()
        self.pid = os.getpid()
        self.holder = f"{self.host}:{self.pid}:{uuid.uuid4().hex[:8]}"

    def _conn(self) -> Any:
        import sqlite3

        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.path), timeout=10, isolation_level=None)
        conn.execute(
            "create table if not exists leases (name text primary key, holder text not null,"
            " host text, pid integer, acquired_at real, expires_at real not null)"
        )
        return conn

    def acquire(self) -> bool:
        now = self.clock()
        conn = self._conn()
        try:
            conn.execute("begin immediate")
            row = conn.execute(
                "select holder, host, pid, expires_at from leases where name = ?", (self.name,)
            ).fetchone()
            free = (
                row is None
                or row[0] == self.holder
                or row[3] < now
                or (row[1] == self.host and row[2] and not pid_alive(int(row[2])))
            )
            if free:
                conn.execute(
                    "insert into leases (name, holder, host, pid, acquired_at, expires_at)"
                    " values (?, ?, ?, ?, ?, ?) on conflict(name) do update set holder=excluded.holder,"
                    " host=excluded.host, pid=excluded.pid, acquired_at=excluded.acquired_at,"
                    " expires_at=excluded.expires_at",
                    (self.name, self.holder, self.host, self.pid, now, now + self.ttl_s),
                )
            conn.execute("commit")
            return bool(free)
        except Exception:
            with contextlib.suppress(Exception):
                conn.execute("rollback")
            raise
        finally:
            conn.close()

    def renew(self) -> bool:
        conn = self._conn()
        try:
            cur = conn.execute(
                "update leases set expires_at = ? where name = ? and holder = ?",
                (self.clock() + self.ttl_s, self.name, self.holder),
            )
            return bool(cur.rowcount == 1)
        finally:
            conn.close()

    def release(self) -> None:
        with contextlib.suppress(Exception):
            conn = self._conn()
            try:
                conn.execute("delete from leases where name = ? and holder = ?", (self.name, self.holder))
            finally:
                conn.close()

    def current(self) -> dict[str, Any] | None:
        conn = self._conn()
        try:
            row = conn.execute(
                "select holder, host, pid, acquired_at, expires_at from leases where name = ?",
                (self.name,),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            return None
        return {"holder": row[0], "host": row[1], "pid": row[2], "acquired_at": row[3],
                "expires_at": row[4], "expired": row[4] < self.clock()}


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
    if leases_db(root).exists():
        with contextlib.suppress(Exception):
            data["db_lease"] = DbLease(leases_db(root)).current()
    return data


# --------------------------------------------------------------------------- #
# The loop
# --------------------------------------------------------------------------- #


def choose_apps(
    root: Path, explicit: list[str] | None = None, env: str | None = None,
    *, log: Callable[[str], None] = lambda msg: None,
) -> list[str]:
    """Which apps serve ticks: ``--app`` values, else ``$FACTORY_SERVE_APPS``
    (comma list), else every registered app whose config sets
    ``serve_tick: true``. Never "every registered app": a registered but idle
    app (a stale local config) must not start ticking because serve came up.
    """
    chosen = [a for a in (explicit or []) if a]
    if not chosen and env:
        chosen = [a.strip() for a in env.split(",") if a.strip()]
    if chosen:
        return chosen
    from factory.app_config import load_app_config
    from factory.jobs.common import registered_apps

    out: list[str] = []
    for app in registered_apps(root):
        try:
            if load_app_config(app, root).serve_tick:
                out.append(app)
        except Exception as exc:  # noqa: BLE001 - a broken config is not ticked
            log(f"app {app}: config does not load ({exc!r}); not ticked")
    return out


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
    #: Consecutive wake-started ticks of one app before wakes are ignored until
    #: the next interval tick (a story moving step to step re-wakes its app).
    max_wake_burst: int = 30


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
    burst: dict[str, int] = field(default_factory=dict)
    #: The triage lane (E5.4): ``triage(app)`` runs PM triage in-process, in its
    #: own thread, as soon as an app is woken, so a new job's first step starts
    #: in about a second and never waits behind another job's long tick.
    triage: Callable[[str], None] | None = None
    triaging: dict[str, Any] = field(default_factory=dict)
    _triage_lock: Any = field(default_factory=lambda: __import__("threading").Lock())

    def start_triage(self, app: str) -> None:
        """Start the app's triage lane unless it is already running.

        Called from the loop (a wake) and from API threads (a submit), hence
        the lock. The lock inside pm-sync is the cross-process backstop."""
        if self.triage is None:
            return
        import threading

        with self._triage_lock:
            t = self.triaging.get(app)
            if t is not None and t.is_alive():
                return
            fn = self.triage

            def run() -> None:
                try:
                    fn(app)
                except Exception as exc:  # noqa: BLE001 - the lane never kills serve
                    self.log(f"triage {app} failed: {exc!r}")

            t = threading.Thread(target=run, name=f"triage-{app}", daemon=True)
            self.triaging[app] = t
            t.start()

    _start_triage = start_triage

    def log(self, msg: str) -> None:
        self.out(f"{_now_iso()} serve: {msg}")

    # -- ticks ---------------------------------------------------------------- #

    def _start_tick(self, app: str, reason: str) -> None:
        log_dir = state_dir(Path(self.cfg.root)) / "logs" / "serve"
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
        self.burst[app] = self.burst.get(app, 0) + 1 if reason == "wake" else 0
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
                self._start_triage(app)
                if self.burst.get(app, 0) >= self.cfg.max_wake_burst:
                    continue  # runaway re-waking: the interval tick takes over
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


#: Child exit codes ``supervise`` treats specially.
EXIT_UPDATED = 75  # the checkout moved: restart now on the new code
EXIT_LEASE_HELD = 3  # another serve runs: retry slowly


def supervise(
    root: Path,
    child_args: list[str],
    *,
    spawn: Callable[[list[str]], Any] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    max_restarts: int | None = None,
    out: Callable[[str], None] = lambda line: print(line, flush=True),
) -> int:
    """Keep a ``factory serve`` child running; restart it whenever it exits.

    Windows' Task Scheduler does not restart a task whose program merely exits
    non-zero (measured), so the ``factory-serve`` task runs this loop. The
    child gets ``--parent-pid`` and stops itself when this process dies (the
    task was stopped), so it is never left running unsupervised. systemd has
    ``Restart=always`` instead and runs serve directly.
    """
    import signal as _signal

    stop = {"flag": False}

    def _stop(*_a: object) -> None:
        stop["flag"] = True

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(_signal, name, None)
        if sig is not None:
            with contextlib.suppress(ValueError, OSError):
                _signal.signal(sig, _stop)

    argv = [sys.executable, "-X", "utf8", "-m", "factory", *child_args, "--parent-pid", str(os.getpid())]

    def _default_spawn(a: list[str]) -> Any:
        return subprocess.Popen(a, cwd=str(root))  # noqa: S603 - our own interpreter and module

    run = spawn or _default_spawn
    restarts = 0
    while not stop["flag"]:
        child = run(argv)
        rc = child.wait()
        if stop["flag"]:
            break
        restarts += 1
        if max_restarts is not None and restarts > max_restarts:
            return int(rc or 0)
        delay = 0.0 if rc == EXIT_UPDATED else 30.0 if rc == EXIT_LEASE_HELD else 5.0
        out(f"{_now_iso()} serve supervisor: child exited {rc}; restarting in {delay:.0f}s")
        sleep(delay)
    return 0


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
    periodic: list[tuple[float, Callable[[], bool | None]]] | None = None,
) -> str | None:
    """Run until ``stop()``. ``periodic`` is ``[(every_s, fn), …]``; a ``fn``
    that returns ``True`` ends the loop (e.g. "the checkout moved: restart").
    Returns why it stopped early (``"periodic"``) or ``None``."""
    root = Path(sched.cfg.root)
    last_status = -1e18
    jobs = [(float(every), fn, [-1e18]) for every, fn in (periodic or [])]
    why: str | None = None
    try:
        while not stop():
            sched.step(consume_wakes(root))
            now = sched.clock()
            if now - last_status >= status_every_s:
                _write_status(root, sched.snapshot())
                last_status = now
            for every, fn, last in jobs:
                if now - last[0] >= every:
                    last[0] = now
                    try:
                        if fn():
                            why = "periodic"
                    except Exception as exc:  # noqa: BLE001 - a side job never kills serve
                        sched.log(f"periodic {getattr(fn, '__name__', fn)} failed: {exc!r}")
            if why:
                break
            sleep(sched.cfg.poll_s)
    finally:
        if why:
            # Restarting for new code: leave running ticks alone. They are
            # detached and hold tick-<app>.lock, so the next serve skips them.
            sched.log(f"stopping ({why}); running ticks keep running")
        else:
            sched.log("stopping: no new ticks; draining running ones")
            sched.drain(drain_timeout_s, sleep=sleep)
        snap = sched.snapshot()
        snap["stopped_at"] = _now_iso()
        _write_status(root, snap)
    return why


__all__ = [
    "ALL_APPS",
    "DEFAULT_INTERVAL_S",
    "DbLease",
    "Lease",
    "leases_db",
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
