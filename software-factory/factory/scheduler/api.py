"""``factory serve``'s localhost HTTP API (plan 2.1) and job-state push (E3).

**The API.** Every JOBS-API call used to be a fresh ``uv run factory job …``
process: 5–10 s of Python start-up per call on Windows, ~5 s on Linux. Serve
already holds a warm interpreter, so it answers the same verbs in-process:

    POST /api/cli        {"argv": ["job", "status", "app:001", "--json"]}
                      -> {"code": 0, "stdout": "<the CLI's stdout>", "stderr": "..."}
    GET  /api/health  -> {"ok": true, "pid": …, "head": "<git sha>", "apps": […]}

``/api/cli`` runs the very same typer command the CLI runs, with stdout and
stderr captured, so the JSON contract (docs/JOBS-API.md) is byte-identical to
the spawned CLI and the reply has exactly the shape the personal assistant's
command runner already returns (``{code, stdout, stderr}``). Only ``job …``
(except the streaming ``follow``) and ``app …`` verbs are allowed. Calls run
one at a time (the CLI redirects the process-wide stdout). Warm, a ``job
status`` takes ~50 ms and a ``job list`` ~200 ms.

Guards: bound to 127.0.0.1 only; every request needs the header ``X-Factory:
1`` (a browser cannot send a custom header cross-origin without a preflight
this server never answers), like termhub's ``X-Termhub``.

**Stale code.** Ticks are fresh processes, so they always run the checkout's
current code; these in-process verbs do not. Serve therefore checks the
checkout's git HEAD every 30 s and exits with :data:`EXIT_CODE_UPDATED` when it
moved, so its supervisor (the ``factory-serve`` task, systemd) starts the new
code. While it is down, callers fall back to spawning the CLI.

**Push (E3).** :class:`JobStatePusher` keeps the last-seen ``state`` and
``why`` of every job (``list_jobs(github=False)``, local) and POSTs the ones
that changed to the personal assistant's ``/api/factory/events`` (best effort,
2 s timeout). :class:`JobStateWatch` runs it in its own thread within ~0.1 s of
a commit to ``factory.db`` (where the ticks record every story transition), so
a job's stage reaches Build in well under a second, and never in a tick's way.
A job's end is pushed as ``done`` at its last delivery, then corrected if
GitHub says otherwise: the local view reads a PR, branch or merge delivery as
``in_progress`` until GitHub confirms it (8.4.44).
"""

from __future__ import annotations

import contextlib
import json
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

DEFAULT_PORT = 7330
DEFAULT_PA_EVENTS_URL = "http://127.0.0.1:7300/api/factory/events"
EXIT_CODE_UPDATED = 75
GUARD_HEADER = "X-Factory"
MAX_BODY = 1_000_000

#: Verbs the API runs. ``job follow`` streams forever and stays CLI-only.
_ALLOWED: dict[str, set[str] | None] = {
    "job": {"submit", "status", "list", "cancel", "resume", "report", "dispatch"},
    "app": None,  # every app verb (add, set, list)
}

_CLI_LOCK = threading.Lock()
#: Verbs that change nothing: run concurrently (each with its own capture).
_READ_ONLY = (["job", "status"], ["job", "list"], ["job", "report"], ["app", "list"])


def allowed(argv: list[str]) -> bool:
    if not argv or not all(isinstance(a, str) for a in argv):
        return False
    group = argv[0]
    if group not in _ALLOWED:
        return False
    subs = _ALLOWED[group]
    return subs is None or (len(argv) > 1 and argv[1] in subs)


def run_cli(argv: list[str]) -> dict[str, Any]:
    """Run one ``factory`` CLI command in-process: ``{code, stdout, stderr}``."""
    import typer.main

    from factory.capture import capture
    from factory.cli import app

    code = 0
    # Each call captures its own stdout/stderr (factory.capture), so read-only
    # verbs run concurrently; state-changing ones still go one at a time.
    lock = _CLI_LOCK if argv[:2] not in _READ_ONLY else contextlib.nullcontext()
    with lock, capture() as (out, err):
        try:
            rc = typer.main.get_command(app).main(
                args=list(argv), prog_name="factory", standalone_mode=False
            )
            code = int(rc or 0)
        except SystemExit as exc:  # typer.Exit under standalone_mode=False is returned, but be safe
            code = int(exc.code or 0) if not isinstance(exc.code, str) else 1
        except Exception as exc:  # noqa: BLE001 - a usage error or a crash is a reply, not a dead server
            import click

            if isinstance(exc, click.ClickException):
                code = exc.exit_code
                err.write(exc.format_message() + "\n")
            else:
                code = 2
                err.write(f"{type(exc).__name__}: {exc}\n")
    return {"code": code, "stdout": out.getvalue(), "stderr": err.getvalue()}


def git_head(root: Path) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(root), capture_output=True, text=True,
            timeout=15, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip() or None


class _Handler(BaseHTTPRequestHandler):
    server: _Server

    def log_message(self, fmt: str, *args: Any) -> None:  # quiet: serve has its own log
        return

    def _reply(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _guarded(self) -> bool:
        if self.headers.get(GUARD_HEADER) != "1":
            self._reply(403, {"error": "forbidden", "message": f"missing {GUARD_HEADER}: 1"})
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        if not self._guarded():
            return
        if self.path.split("?")[0] == "/api/health":
            self._reply(200, self.server.health())
            return
        self._reply(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        # Read the body before any reply: closing a socket with unread request
        # data makes Windows reset the connection, and the client loses the reply.
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        raw = self.rfile.read(n) if 0 < n <= MAX_BODY else b""
        if not self._guarded():
            return
        if self.path.split("?")[0] != "/api/cli":
            self._reply(404, {"error": "not_found"})
            return
        try:
            if n < 0 or n > MAX_BODY:
                raise ValueError("bad or oversized body")
            body = json.loads(raw or b"{}")
            argv = body.get("argv")
        except (ValueError, AttributeError):
            self._reply(400, {"error": "bad_request", "message": "want JSON {argv: [...]}"})
            return
        if not isinstance(argv, list) or not allowed(argv):
            self._reply(400, {"error": "not_allowed", "message": f"argv not allowed: {argv!r}"[:300]})
            return
        t0 = time.perf_counter()
        res = run_cli(argv)
        res["ms"] = round((time.perf_counter() - t0) * 1000)
        self._reply(200, res)
        self.server.after_call(argv, res)


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port: int, health: Callable[[], dict[str, Any]],
                 after_call: Callable[[list[str], dict[str, Any]], None]) -> None:
        super().__init__(("127.0.0.1", port), _Handler)
        self.health = health
        self.after_call = after_call


def start_api(
    port: int,
    *,
    health: Callable[[], dict[str, Any]],
    after_call: Callable[[list[str], dict[str, Any]], None] = lambda argv, res: None,
) -> _Server:
    """Bind and serve in a daemon thread. Raises ``OSError`` if the port is taken."""
    srv = _Server(port, health, after_call)
    threading.Thread(target=srv.serve_forever, name="factory-api", daemon=True).start()
    return srv


# --------------------------------------------------------------------------- #
# Job-state push to the personal assistant (E3)
# --------------------------------------------------------------------------- #


def _post_json(url: str, body: dict[str, Any], timeout: float) -> int:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json", "X-PA": "1"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - loopback URL from config
        return int(resp.status)


_TERMINAL = frozenset({"done", "failed", "cancelled"})


def _delivered_locally(job: dict[str, Any]) -> bool:
    """Every story is in a delivered end state the chain recorded, and only
    GitHub's confirmation keeps the local view at ``in_progress``."""
    from factory.chain.state_machine import DELIVERED_UNMERGED_STATES
    from factory.jobs.status import IGNORED_STATES, LOCAL_MERGED_STATES

    if job.get("state") != "in_progress":
        return False
    stories = [s for s in job.get("stories") or [] if s.get("state") not in IGNORED_STATES]
    ends = DELIVERED_UNMERGED_STATES | LOCAL_MERGED_STATES
    return bool(stories) and all(s.get("state") in ends for s in stories)


class JobStatePusher:
    """Diff job states and POST the changes. Thread-safe; never raises.

    A change is a new ``state`` or a new ``why``: Build shows both, and a job
    moving from one story step to the next stays ``in_progress`` while its
    ``why`` names the new step.

    **A job's end (8.4.44).** The local view cannot see GitHub, so a job whose
    last story the chain just delivered reads ``in_progress`` there ("looks
    delivered locally but GitHub could not confirm it") and never ``done``. At
    that change the pusher sends ``done`` (the chain's own record), then reads
    that job once with GitHub (``confirm_fn``, a few seconds) and sends what
    GitHub says if it differs. The answer stands while the local view is
    unchanged; a non-terminal answer (CI still running) is read again every
    ``recheck_s`` on a full check.
    """

    def __init__(
        self,
        root: Path,
        url: str,
        *,
        list_fn: Callable[[Path, frozenset[str]], list[dict[str, Any]]] | None = None,
        confirm_fn: Callable[[Path, str], dict[str, Any]] | None = None,
        post: Callable[[str, dict[str, Any], float], int] = _post_json,
        timeout: float = 2.0,
        recheck_s: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
        log: Callable[[str], None] = lambda msg: None,
    ) -> None:
        self.root = Path(root)
        self.url = url
        self._list = list_fn or _list_jobs_local
        self._confirm = confirm_fn or _job_status_github
        self._post = post
        self.timeout = timeout
        self.recheck_s = recheck_s
        self.clock = clock
        self.log = log
        self._seen: dict[str, tuple[str, str]] | None = None
        # job id -> (its local reading, what is pushed for it, when GitHub was last asked)
        self._ends: dict[str, tuple[tuple[str, str], tuple[str, str], float | None]] = {}
        self._lock = threading.Lock()
        self.pushed = 0

    def check(self, *, full: bool = True) -> list[dict[str, Any]]:
        """Read states, push what changed since the last check. Returns the pushed rows.

        The first check only records the baseline (the PA's own ``job list``
        already has it), so a restart does not re-announce every job.
        ``full=False`` leaves out jobs last seen terminal (most of them, and
        each costs ~15 ms to read); a full check still reads them, so a job
        resumed outside serve's API is caught by the next one.
        """
        if not self.url:
            return []
        with self._lock:
            skip = frozenset() if full or self._seen is None else frozenset(
                jid for jid, (state, _why) in self._seen.items() if state in _TERMINAL
            )
            try:
                jobs = self._list(self.root, skip)
            except Exception as exc:  # noqa: BLE001
                self.log(f"push: job list failed: {exc!r}")
                return []
            by_id = {str(j["job_id"]): j for j in jobs if j.get("job_id")}
            listed = {jid: (str(j.get("state")), str(j.get("why") or "")) for jid, j in by_id.items()}
            now = self.clock()
            shown: dict[str, tuple[str, str]] = {}
            confirm: list[str] = []
            for jid, local in listed.items():
                end = self._ends.get(jid)
                if end is not None and end[0] == local:
                    shown[jid] = end[1]
                    asked = end[2]
                    if end[1][0] not in _TERMINAL and full and (asked is None or now - asked >= self.recheck_s):
                        confirm.append(jid)
                elif _delivered_locally(by_id[jid]):
                    shown[jid] = ("done", "")
                    self._ends[jid] = (local, shown[jid], None)
                    confirm.append(jid)
                else:
                    self._ends.pop(jid, None)
                    shown[jid] = local
            if self._seen is None:
                # Jobs that ended before serve started are taken as ended,
                # unannounced and unconfirmed: the PA's own list has them.
                self._seen = shown
                return []
            changed = [self._row(by_id[jid], shown[jid]) for jid in by_id if self._seen.get(jid) != shown[jid]]
            self._seen = {**{k: v for k, v in self._seen.items() if k in skip}, **shown}
        self._send(changed)
        # GitHub's word on the ends just pushed (seconds each), outside the lock.
        corrected: list[dict[str, Any]] = []
        for jid in confirm:
            try:
                st = self._confirm(self.root, jid)
                said = (str(st["state"]), str(st.get("why") or ""))
            except Exception as exc:  # noqa: BLE001 - the PA's poll still reads GitHub
                self.log(f"push: {jid} not confirmed on GitHub ({exc!r}); pushed as the chain recorded it")
                continue
            with self._lock:
                end = self._ends.get(jid)
                if end is None or self._seen is None:
                    continue
                self._ends[jid] = (end[0], said, self.clock())
                if self._seen.get(jid) != said:
                    self._seen[jid] = said
                    corrected.append(self._row({**by_id[jid], **st}, said))
        self._send(corrected)
        return changed + corrected

    @staticmethod
    def _row(job: dict[str, Any], shown: tuple[str, str]) -> dict[str, Any]:
        return {
            "job_id": job["job_id"],
            "state": shown[0],
            "why": shown[1],
            "updated_at": job.get("updated_at") or datetime.now(UTC).isoformat(timespec="seconds"),
        }

    def _send(self, rows: list[dict[str, Any]]) -> None:
        for i in range(0, len(rows), 50):
            batch = rows[i : i + 50]
            try:
                self._post(self.url, {"jobs": batch}, self.timeout)
                self.pushed += len(batch)
            except (urllib.error.URLError, OSError, ValueError) as exc:
                self.log(f"push: {len(batch)} change(s) not delivered ({exc!r}); the PA's poll will catch up")
        if rows:
            self.log("push: " + ", ".join(f"{c['job_id']}={c['state']}" for c in rows)[:300])


def _list_jobs_local(root: Path, skip: frozenset[str] = frozenset()) -> list[dict[str, Any]]:
    from factory.capture import capture
    from factory.jobs.status import list_jobs

    with capture():  # anything it prints stays out of other threads' output
        res = list_jobs(root, github=False, skip=skip)
    jobs = res.get("jobs") if isinstance(res, dict) else None
    return list(jobs or [])


def _job_status_github(root: Path, job_id: str) -> dict[str, Any]:
    from factory.capture import capture
    from factory.jobs.status import job_status

    with capture():
        return job_status(root, job_id, github=True)


def _signature(paths: list[Path]) -> tuple[tuple[int, int] | None, ...]:
    out: list[tuple[int, int] | None] = []
    for p in paths:
        try:
            st = p.stat()
            out.append((st.st_mtime_ns, st.st_size))
        except OSError:
            out.append(None)
    return tuple(out)


class JobStateWatch:
    """Run :class:`JobStatePusher` as job states change, in its own thread (E3).

    Job states move in tick subprocesses, which commit to ``factory.db``; this
    thread stats the DB every ``poll_s`` and, once a write has been quiet for
    ``settle_s`` (a transition is a few commits in a row), checks the jobs
    that can still move (``full=False``) and pushes what changed. A full
    check runs every ``full_every_s`` and after :meth:`poke` with ``full``
    (submit, cancel, resume through the API). Nothing here runs in a tick or
    in serve's loop, so a slow or absent PA never delays a transition.
    """

    def __init__(
        self,
        pusher: JobStatePusher,
        paths: list[Path],
        *,
        poll_s: float = 0.1,
        settle_s: float = 0.1,
        full_every_s: float = 5.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.pusher = pusher
        self.paths = [Path(p) for p in paths]
        self.poll_s = poll_s
        self.settle_s = settle_s
        self.full_every_s = full_every_s
        self.clock = clock
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._want_full = False
        self._thread: threading.Thread | None = None

    def start(self) -> JobStateWatch:
        self._thread = threading.Thread(target=self._run, name="factory-push", daemon=True)
        self._thread.start()
        return self

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout)

    def poke(self, *, full: bool = False) -> None:
        """Check now (from any thread; never blocks)."""
        if full:
            self._want_full = True
        self._wake.set()

    def _run(self) -> None:
        self.pusher.check()  # baseline, so the first real change is announced
        sig = _signature(self.paths)
        last_full = self.clock()
        while not self._stop.is_set():
            poked = self._wake.wait(self.poll_s)
            self._wake.clear()
            if self._stop.is_set():
                return
            written = False
            now_sig = _signature(self.paths)
            if now_sig != sig:
                written = True
                # Let the transition's commits land, then read once.
                while not self._stop.wait(self.settle_s):
                    settled = _signature(self.paths)
                    if settled == now_sig:
                        break
                    now_sig = settled
                sig = now_sig
            full = self._want_full or self.clock() - last_full >= self.full_every_s
            if not (written or poked or full):
                continue
            self._want_full = False
            if full:
                last_full = self.clock()
            try:
                self.pusher.check(full=full)
            except Exception as exc:  # noqa: BLE001 - check() never raises; belt and braces
                self.pusher.log(f"push: check failed: {exc!r}")


__all__ = [
    "DEFAULT_PA_EVENTS_URL",
    "DEFAULT_PORT",
    "EXIT_CODE_UPDATED",
    "GUARD_HEADER",
    "JobStatePusher",
    "JobStateWatch",
    "allowed",
    "git_head",
    "run_cli",
    "start_api",
]
