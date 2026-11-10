"""``factory serve``: the in-process tick scheduler (replaces systemd timers).

On Linux the factory ticks from systemd user timers (``factory-tick@<app>.timer``,
every 5 minutes; a oneshot service, so ticks of one app never overlap). Windows
has no systemd, so ``factory serve`` does the same job in one long-lived
process. Linux keeps its timers; serve refuses to run beside them.

What it does, every ``poll_s`` (1 s):

* **Which apps.** The opted-in apps (``serve_tick: true``, ``--app`` or
  ``$FACTORY_SERVE_APPS``) plus every app with an active code job
  (:func:`choose_apps`), re-read every ``refresh_s`` and at once when a wake
  names an app outside the set. A submitted job is the intent to spend; an idle
  app without ``serve_tick`` is never ticked.
* **Ticks.** Each app is ticked as a FRESH subprocess (``python -m factory tick
  --app <app>``), like the systemd unit, so a ``git pull`` of chain code is
  picked up on the next tick and a crash in one tick cannot take the scheduler
  down. One app's ticks never overlap; different apps tick in parallel. An app
  is due every ``interval_s`` (default 300 s) after its last tick STARTED.
* **Wake.** ``factory job submit`` / ``resume`` drop a file in
  ``state/scheduler/wake.d/`` (:func:`request_wake`). Serve sees it within one
  poll and starts queued research/report jobs at once (``dispatch_tasks``, no
  LLM, milliseconds). A **submit** starts PM triage in this process and does
  not also start a tick: that tick used to run the maintenance passes while
  triage held the first step, then hold the app so the next step waited for it
  to exit (8.4.15). Triage wakes again when it finishes, and that wake starts
  the tick. A resume, a finished step (``progress``) or that follow-up starts
  a tick at once; the tick is told ``FACTORY_TICK_REASON=wake`` so it dispatches
  before the GitHub maintenance the interval tick still does. A wake for an app
  that is mid-tick re-ticks it as soon as that tick ends.
* **Dispatch.** ``dispatch_tasks`` also runs every interval in-process, so
  research/report jobs start and dead workers are reaped even when a tick cannot
  run (a machine with no LLM provider key: ``factory tick`` exits 2 before its
  own dispatch).
* **Lease.** Only one serve runs per factory root: it holds an exclusive lock on
  ``state/locks/serve.lock`` for its lifetime (released by the OS if it dies, so
  there is never a stale lease). Each tick it starts also takes
  ``state/locks/tick-<app>.lock`` (``FACTORY_TICK_LOCK=1``), so a tick orphaned
  by a killed serve is never doubled by the next serve.
* **Timeout.** A tick running longer than ``tick_timeout_s`` (default 3 h) is
  killed (whole tree), and the provisional ``runs`` rows its dead processes
  owned are closed as failed. Each tick is told the same number as its budget
  (``FACTORY_TICK_BUDGET_S``), so the orchestrator never starts an agent step
  that cannot finish before the kill (a solo dev step needs 5400 s + 1500 s).

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
from collections.abc import Callable, Iterable, Mapping
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
#: Must not be below the orchestrator's ``_DEFAULT_TICK_BUDGET_S`` (the old
#: systemd ``TimeoutStartSec=3h``): at 3600 s serve killed a solo dev step the
#: orchestrator had budgeted 6900 s for, 58 min into a live run (2026-11-08).
DEFAULT_TICK_TIMEOUT_S = 3 * 3600.0
#: Env var that makes ``factory tick`` take the per-app tick lock.
TICK_LOCK_ENV = "FACTORY_TICK_LOCK"
#: Env var the orchestrator reads as its tick budget; serve sets it to its own
#: tick timeout so the two can never disagree.
TICK_BUDGET_ENV = "FACTORY_TICK_BUDGET_S"
#: Set on a wake-started tick so it dispatches before the interval's maintenance.
TICK_REASON_ENV = "FACTORY_TICK_REASON"
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


def _prefer_wake_reason(old: str | None, new: str) -> str:
    """A submit must not hide a wake that has to start a tick (resume, progress)."""
    if old and not old.startswith("submit"):
        return old
    if not new.startswith("submit"):
        return new
    return old or new


def consume_wake_details(root: Path) -> dict[str, str]:
    """Read and delete pending wake files. ``{app: reason}``; ``*`` = all apps.

    Several files for one app collapse to one reason. A non-submit reason wins,
    so a progress wake dropped while a submit's file is still there still ticks.
    """
    d = wake_dir(root)
    reasons: dict[str, str] = {}
    try:
        entries = sorted(d.glob("*.wake"))
    except OSError:
        return reasons
    for p in entries:
        try:
            data = json.loads(p.read_text(encoding="utf-8") or "{}")
            app = str(data.get("app") or ALL_APPS)
            reason = str(data.get("reason") or "wake")
        except (OSError, ValueError):
            app, reason = ALL_APPS, "wake"
        reasons[app] = _prefer_wake_reason(reasons.get(app), reason)
        try:
            p.unlink()
        except OSError:
            pass
    return reasons


def consume_wakes(root: Path) -> set[str]:
    """Read and delete pending wake files; return the app names (``*`` = all)."""
    return set(consume_wake_details(root))


def _wake_reasons(wakes: Iterable[str] | Mapping[str, str]) -> dict[str, str]:
    """App names become reason ``wake`` (a tick). A mapping keeps its reasons."""
    if isinstance(wakes, Mapping):
        return {str(k): str(v or "wake") for k, v in wakes.items()}
    return {str(a): "wake" for a in wakes}


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


def _active_job_apps(root: Path) -> list[str]:
    from factory.jobs.status import apps_with_active_jobs

    return apps_with_active_jobs(root)


def choose_apps(
    root: Path, explicit: list[str] | None = None, env: str | None = None,
    *, log: Callable[[str], None] = lambda msg: None,
    active: Callable[[Path], list[str]] | None = _active_job_apps,
) -> list[str]:
    """Which apps serve ticks: the opted-in apps plus every app with an active job.

    Opted in: ``--app`` values, else ``$FACTORY_SERVE_APPS`` (comma list), else
    every registered app whose config sets ``serve_tick: true``. Then any
    registered app with a code job a tick can move (queued, triaging, in
    progress, blocked, paused: :func:`factory.jobs.status.apps_with_active_jobs`)
    is added: a submitted job is explicit intent to spend, and an app nothing
    ticks leaves it queued forever (raven, 2026-11-09). Never "every registered
    app": an idle app without ``serve_tick`` (a stale local config) must not
    start ticking because serve came up. Serve calls this every
    ``refresh_s``, so neither a config change nor a new job needs a restart.
    """
    base = _opted_in_apps(root, explicit, env, log=log)
    if active is None:
        return base
    try:
        extra = [a for a in active(Path(root)) if a not in base]
    except Exception as exc:  # noqa: BLE001 - the opted-in set still ticks
        log(f"reading the apps with active jobs failed ({exc!r}); ticking the opted-in apps only")
        extra = []
    return base + extra


def _opted_in_apps(
    root: Path, explicit: list[str] | None, env: str | None,
    *, log: Callable[[str], None],
) -> list[str]:
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
    #: Re-reads the app set (:func:`choose_apps`) every ``refresh_s``, and at
    #: once when a wake names an app not in it (a submit). ``None``: ``apps``
    #: is fixed (tests, ``--app`` on an old serve).
    app_source: Callable[[], list[str]] | None = None
    refresh_s: float = 10.0


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


def _default_close_orphans(root: Path, reason: str) -> list[int]:
    from factory.runner import close_orphaned_provisional_runs

    return close_orphaned_provisional_runs(state_dir(Path(root)) / "factory.db", reason=reason)


@dataclass
class Scheduler:
    cfg: ServeConfig
    spawn: Spawn = _default_spawn
    dispatch: Callable[[Path], dict[str, Any]] = _default_dispatch
    close_orphans: Callable[[Path, str], list[int]] = _default_close_orphans
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
    next_refresh: float = 0.0
    _apps_lock: Any = field(default_factory=lambda: __import__("threading").Lock())

    # -- the app set ---------------------------------------------------------- #

    def refresh_apps(self, *, force: bool = False) -> list[str]:
        """Re-read the app set when due (or ``force``); return the apps it added.

        Called from the loop and from API threads (a submit), hence the lock.
        An app that leaves the set keeps a running tick; it just starts no new
        one. A failed read keeps the current set.
        """
        source = self.cfg.app_source
        if source is None:
            return []
        with self._apps_lock:
            now = self.clock()
            if not force and now < self.next_refresh:
                return []
            self.next_refresh = now + self.cfg.refresh_s
            try:
                fresh = [str(a) for a in source() if a]
            except Exception as exc:  # noqa: BLE001 - keep ticking what we tick
                self.log(f"re-reading the app set failed ({exc!r}); keeping {self.cfg.apps}")
                return []
            old = list(self.cfg.apps)
            if fresh == old:
                return []
            added = [a for a in fresh if a not in old]
            dropped = [a for a in old if a not in fresh]
            self.cfg.apps = fresh  # a new list: a loop iterating the old one is unaffected
            self.log(
                f"apps now {fresh}"
                + (f" (+{', '.join(added)})" if added else "")
                + (f" (-{', '.join(dropped)})" if dropped else "")
            )
            return added

    def admit(self, app: str, *, submit: bool = False, added: set[str] | None = None) -> bool:
        """Make sure ``app`` is ticked now that a job was submitted or resumed.

        Re-reads the app set when ``app`` is not in it (its new job puts it
        there). A submitted app that was just added waits for triage to wake
        it instead of starting an interval tick beside triage (8.4.15).
        True when serve ticks ``app``.
        """
        added = set() if added is None else added
        if app not in self.cfg.apps:
            added.update(self.refresh_apps(force=True))
        if app not in self.cfg.apps:
            return False
        if submit and app in added and self.triage is not None:
            self.next_due.setdefault(app, self.clock() + self.cfg.interval_s)
        return True

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
        env[TICK_BUDGET_ENV] = str(int(self.cfg.tick_timeout_s))
        env.setdefault("PYTHONUNBUFFERED", "1")
        # Interval ticks keep the maintenance passes. A wake tick dispatches
        # first (8.4.15); drop a leaked value so an interval tick stays one.
        if reason != "interval":
            env[TICK_REASON_ENV] = "wake"
        else:
            env.pop(TICK_REASON_ENV, None)
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
                self._close_orphans(f"tick {app} killed after {self.cfg.tick_timeout_s:.0f}s")
            if rc is None:
                continue
            run.log.close()
            del self.running[app]
            self.log(f"tick {app} exited {rc} after {now - run.started:.1f}s")

    def _close_orphans(self, reason: str) -> None:
        try:
            closed = self.close_orphans(Path(self.cfg.root), reason)
        except Exception as exc:  # noqa: BLE001 - housekeeping never kills serve
            self.log(f"closing orphaned runs failed: {exc!r}")
            return
        if closed:
            self.log(f"closed orphaned run rows {closed} ({reason})")

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

    def step(self, wakes: Iterable[str] | Mapping[str, str] = ()) -> None:
        """One poll: reap, apply wakes, dispatch if due, start due ticks.

        ``wakes`` is app names (reason ``wake``, which starts a tick) or
        ``{app: reason}`` from :func:`consume_wake_details`. A ``submit …``
        reason starts triage and the research dispatch but not a tick.
        """
        self._reap()
        now = self.clock()
        reasons = _wake_reasons(wakes)
        added = set(self.refresh_apps())
        if self.triage is not None:
            # An app the refresh just added has a job triage is about to pick
            # up; do not start an interval tick beside it (8.4.15), whether or
            # not its submit wake lands in this same step.
            for app in added:
                self.next_due.setdefault(app, now + self.cfg.interval_s)
        for app, why in reasons.items():
            if app != ALL_APPS:
                self.admit(app, submit=why.startswith("submit"), added=added)
        if reasons:
            self._dispatch("wake")
            self.next_dispatch = now + self.cfg.interval_s
            targets = (
                self.cfg.apps
                if ALL_APPS in reasons
                else [a for a in reasons if a in self.cfg.apps]
            )
            star = reasons.get(ALL_APPS, "")
            for app in targets:
                reason = reasons.get(app) or star or "wake"
                self._start_triage(app)
                # A submit's first step is the in-process triage lane. A tick
                # started here races that lane for the pm lock, then holds the
                # app through the GitHub maintenance, so the next step waits
                # for the tick to exit (8.4.15). Triage wakes again when done.
                if reason.startswith("submit") and self.triage is not None:
                    continue
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
        killed = False
        for app, run in list(self.running.items()):
            self.log(f"tick {app} still running at shutdown; killing it")
            kill_tree(run.proc.pid, force=True)
            with contextlib.suppress(subprocess.TimeoutExpired):
                run.proc.wait(timeout=10)
            run.log.close()
            del self.running[app]
            killed = True
        if killed:
            self._close_orphans("tick killed at serve shutdown")

    def snapshot(self) -> dict[str, Any]:
        return {
            "pid": os.getpid(),
            "updated_at": _now_iso(),
            "apps": list(self.cfg.apps),
            # Serve adds any app with an active job (choose_apps), so a job
            # for an app not listed here is still ticked (coverage.py).
            "ticks_active_jobs": self.cfg.app_source is not None,
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
            sched.step(consume_wake_details(root))
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
