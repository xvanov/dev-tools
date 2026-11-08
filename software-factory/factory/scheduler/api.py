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

**Push (E3).** :class:`JobStatePusher` keeps the last-seen ``state`` of every
job (``list_jobs(github=False)``, local and cheap) and POSTs the ones that
changed to the personal assistant's ``/api/factory/events`` (best effort,
2 s timeout, never blocking a tick), so Build updates in about a second instead
of after the PA's next ``job list``.
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


class JobStatePusher:
    """Diff job states and POST the changes. Thread-safe; never raises."""

    def __init__(
        self,
        root: Path,
        url: str,
        *,
        list_fn: Callable[[Path], list[dict[str, Any]]] | None = None,
        post: Callable[[str, dict[str, Any], float], int] = _post_json,
        timeout: float = 2.0,
        log: Callable[[str], None] = lambda msg: None,
    ) -> None:
        self.root = Path(root)
        self.url = url
        self._list = list_fn or _list_jobs_local
        self._post = post
        self.timeout = timeout
        self.log = log
        self._seen: dict[str, str] | None = None
        self._lock = threading.Lock()
        self.pushed = 0

    def check(self) -> list[dict[str, Any]]:
        """Read states, push what changed since the last check. Returns the pushed rows.

        The first check only records the baseline (the PA's own ``job list``
        already has it), so a restart does not re-announce every job.
        """
        if not self.url:
            return []
        with self._lock:
            try:
                jobs = self._list(self.root)
            except Exception as exc:  # noqa: BLE001
                self.log(f"push: job list failed: {exc!r}")
                return []
            now = {str(j.get("job_id")): str(j.get("state")) for j in jobs if j.get("job_id")}
            if self._seen is None:
                self._seen = now
                return []
            changed = [
                {
                    "job_id": j["job_id"],
                    "state": j["state"],
                    "why": j.get("why") or "",
                    "updated_at": j.get("updated_at")
                    or datetime.now(UTC).isoformat(timespec="seconds"),
                }
                for j in jobs
                if j.get("job_id") and self._seen.get(str(j["job_id"])) != str(j.get("state"))
            ]
            self._seen = now
        for i in range(0, len(changed), 50):
            batch = changed[i : i + 50]
            try:
                self._post(self.url, {"jobs": batch}, self.timeout)
                self.pushed += len(batch)
            except (urllib.error.URLError, OSError, ValueError) as exc:
                self.log(f"push: {len(batch)} change(s) not delivered ({exc!r}); the PA's poll will catch up")
        if changed:
            self.log("push: " + ", ".join(f"{c['job_id']}={c['state']}" for c in changed)[:300])
        return changed


def _list_jobs_local(root: Path) -> list[dict[str, Any]]:
    from factory.capture import capture
    from factory.jobs.status import list_jobs

    with capture():  # anything it prints stays out of other threads' output
        res = list_jobs(root, github=False)
    jobs = res.get("jobs") if isinstance(res, dict) else None
    return list(jobs or [])


__all__ = [
    "DEFAULT_PA_EVENTS_URL",
    "DEFAULT_PORT",
    "EXIT_CODE_UPDATED",
    "GUARD_HEADER",
    "JobStatePusher",
    "allowed",
    "git_head",
    "run_cli",
    "start_api",
]
