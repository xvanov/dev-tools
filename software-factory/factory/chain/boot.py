"""Boot a real instance of the app on an ephemeral port (019 AC3).

The out-of-process oracle drives a BOOTED app over HTTP instead of importing
its code, so the interpreter that computes the verdict never runs a single
line the diff wrote. This module owns the one place that is allowed to start
and stop that process: port allocation, health polling, environment
construction, and — the part that must never be gotten wrong — teardown.

Teardown is by PROCESS GROUP, never ``pkill -f``: a boot command like
``uv run uvicorn app.main:app`` commonly forks or execs a grandchild (uv execs
uvicorn; uvicorn with a reloader forks a worker), and killing only the direct
child leaves the grandchild running and the port held. ``start_new_session``
makes the child its own process-group leader, so ``os.killpg`` reaches the
whole tree with one signal — SIGTERM first, a grace period, then SIGKILL. A
module-level registry plus an ``atexit`` reaper is the belt-and-braces: if the
gate process itself is killed before a ``finally`` runs, nothing here can
clean up, but the registry at least documents what was live so the next
process to touch this app knows to look.

Substitution of ``{port}`` / ``{base_url}`` / ``{run_id}`` / ``{run_dir}`` in
the boot command and env values is a LITERAL replace, never ``str.format``: a
real boot command can contain other braces (a compose env-var expansion, a jq
filter) and ``str.format`` raising ``KeyError`` on one would abort the whole
merge evaluation rather than failing this one gate.

Two things here exist specifically to stop a booted-but-not-really-serving
instance from being mistaken for a healthy one (KNOWN OPEN #1 in
``gates.acceptance_verified``, closed 2026-08-07/08): :func:`_poll_health`
requires several CONSECUTIVE healthy polls, not just the first one, and
:func:`probe_paths` lets a caller issue its OWN direct HTTP requests against
an already-booted app to get independent evidence it serves real routes, not
only its health endpoint. Neither is a sandbox or a correctness proof; both
are cheap, out-of-band evidence the acceptance-oracle gate uses before
trusting a merge-base run's all-failing result as a genuine ``red``.
"""

from __future__ import annotations

import atexit
import logging
import os
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from factory.app_config import AcceptanceBootConfig

_log = logging.getLogger(__name__)

# pgid -> the Popen of the process group's leader. Used so teardown can
# ``.wait()`` on the real child (avoiding a zombie) after ``killpg``, and so
# the atexit reaper can find anything a crashed gate process left running.
_LIVE_PGIDS: dict[int, subprocess.Popen[bytes]] = {}
_LOCK = threading.Lock()


def _atexit_reap() -> None:
    with _LOCK:
        items = list(_LIVE_PGIDS.items())
    for pgid, _proc in items:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except OSError:
            pass


atexit.register(_atexit_reap)


@dataclass
class BootedApp:
    """A live, healthy instance. Nothing here is trusted once ``boot_app``'s
    ``with`` block exits — teardown runs in that context manager's ``finally``."""

    base_url: str
    port: int
    pid: int
    pgid: int
    log_path: Path
    run_dir: Path


def free_port() -> int:
    """An ephemeral TCP port, free at the instant of the call.

    Bind-0-and-read: ask the OS for port 0 (any free port), read back what it
    picked, close immediately. Not a guarantee against a race with a second
    process picking the same port before the boot command binds it — nothing
    short of holding the socket open across the exec can guarantee that — so
    :func:`boot_app` retries with a fresh port up to 3 times when the boot
    command dies immediately after starting (the observable symptom of losing
    that race). No ``lsof``: it is not installed in every sandbox, and asking
    the OS is both simpler and race-free.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def check_prerequisite(
    cfg: AcceptanceBootConfig, *, cwd: Path | None = None, timeout: int = 30
) -> tuple[bool, str]:
    """Run ``cfg.prerequisite_command`` as a CHECK (never a start).

    ``(True, why)`` when unconfigured (nothing to check) or the command exits
    0. ``(False, why)`` otherwise, ``why`` including ``cfg.prerequisite_hint``
    when set — the operator action, e.g. ``make up-db``.
    """
    if not cfg.prerequisite_command or not cfg.prerequisite_command.strip():
        return True, "no prerequisite configured"
    try:
        proc = subprocess.run(  # noqa: S602 - operator-owned config command
            cfg.prerequisite_command,
            shell=True,
            cwd=str(cwd) if cwd is not None else None,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"prerequisite check could not run ({exc})"
    if proc.returncode == 0:
        return True, f"prerequisite satisfied: {cfg.prerequisite_command!r}"
    hint = f" — {cfg.prerequisite_hint}" if cfg.prerequisite_hint else ""
    tail = (proc.stdout + proc.stderr).strip()[-500:]
    return False, (
        f"prerequisite {cfg.prerequisite_command!r} exited {proc.returncode}{hint}: {tail}"
    )


def _substitute(template: str, *, port: int, base_url: str, run_id: str, run_dir: str) -> str:
    """Literal (never ``str.format``) replacement of the four boot tokens."""
    return (
        template.replace("{port}", str(port))
        .replace("{base_url}", base_url)
        .replace("{run_id}", run_id)
        .replace("{run_dir}", run_dir)
    )


def _ensure_run_dir_subdirs(env: dict[str, str], run_dir: str) -> None:
    """Create any directory an env value points at UNDER ``run_dir`` (found
    2026-08-07): ``mkdtemp`` makes only ``run_dir`` itself, so an app config
    naming ``SACRIFICE_MEDIA_DIR: "{run_dir}/media"`` boots into a directory
    that does not exist yet — and not every app creates its own media/upload
    dir at startup. Best-effort; a failure here is not fatal (the app's own
    boot failure, if any, still surfaces through the health poll).
    """
    for value in env.values():
        if value != run_dir and not value.startswith(run_dir.rstrip("/") + "/"):
            continue
        try:
            Path(value).mkdir(parents=True, exist_ok=True)
        except OSError:
            continue


def _build_env(
    cfg: AcceptanceBootConfig, *, port: int, base_url: str, run_id: str, run_dir: str
) -> dict[str, str]:
    env: dict[str, str] = {}
    for name in cfg.env_passthrough:
        val = os.environ.get(name)
        if val is not None:
            env[name] = val
    for key, value in (cfg.env or {}).items():
        env[key] = _substitute(str(value), port=port, base_url=base_url, run_id=run_id, run_dir=run_dir)
    env.setdefault("PATH", os.environ.get("PATH", ""))
    _ensure_run_dir_subdirs(env, run_dir)
    # ``sys.stderr`` is line-buffered in CPython regardless of destination, but
    # ``sys.stdout`` is BLOCK-buffered once redirected to a file/pipe (as it
    # always is here) — a booted app that ``print()``s to stdout can lose that
    # output entirely when the process is SIGTERM'd/SIGKILL'd before its buffer
    # flushes, silently emptying the log tail this module exists to capture
    # (used for ablation-attribution debugging, ``oracle_probe.py``). Forcing
    # unbuffered I/O costs nothing for a short-lived boot and makes the log
    # reliable for the common case of a Python boot command.
    env.setdefault("PYTHONUNBUFFERED", "1")
    return env


def tail_log(path: Path, n: int) -> str:
    """The last ``n`` bytes of a boot log, decoded best-effort. Never raises."""
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    return data[-n:].decode("utf-8", errors="replace")


#: KNOWN OPEN #1 (closed 2026-08-07/08): the FIRST sub-400 health response used
#: to be trusted outright. A health endpoint that answers before its own
#: dependency (a DB pool still connecting) is ready can flap — 200 once, 5xx
#: on the next real request — and a single lucky poll declared the app
#: "booted" regardless. Requiring several CONSECUTIVE healthy polls, reset to
#: zero on any non-2xx/3xx response in between, does not by itself prove the
#: app's REAL routes work (that is what the base-run probe in
#: ``gates.acceptance_verified`` establishes) — it closes the narrower,
#: independently-worth-fixing case where the health check itself is flaky
#: during startup (a worker still forking, a reload in progress).
_HEALTH_CONSECUTIVE_REQUIRED = 2
_HEALTH_POLL_INTERVAL_S = 0.5


def _poll_health(
    proc: subprocess.Popen[bytes],
    base_url: str,
    cfg: AcceptanceBootConfig,
    *,
    consecutive_required: int = _HEALTH_CONSECUTIVE_REQUIRED,
    interval: float = _HEALTH_POLL_INTERVAL_S,
) -> tuple[bool, str]:
    """Healthy only after ``consecutive_required`` (>=1) BACK-TO-BACK polls all
    answer ``< 400`` — a single stray success no longer ends the poll. Any
    response ``>= 400`` (5xx explicitly included: a broken dependency
    typically surfaces as 500, never silently as "healthy") resets the streak
    to zero, so a flapping health check (200, 503, 200, 200) must produce TWO
    healthy responses in a row after its last blip, not just two total.
    """
    import httpx

    deadline = time.monotonic() + cfg.boot_timeout_seconds
    path = cfg.health_path or "/"
    url = f"{base_url}{path}"
    consecutive = 0
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False, f"boot process exited (code={proc.returncode}) before becoming healthy"
        healthy_this_poll = False
        try:
            resp = httpx.get(url, timeout=2.0)
            healthy_this_poll = resp.status_code < 400
        except httpx.HTTPError:
            pass
        if healthy_this_poll:
            consecutive += 1
            if consecutive >= max(consecutive_required, 1):
                return True, ""
        else:
            consecutive = 0
        time.sleep(interval)
    return False, (
        f"did not become healthy within {cfg.boot_timeout_seconds}s ({url}, "
        f"needs {consecutive_required} consecutive healthy polls)"
    )


def _teardown(pgid: int, proc: subprocess.Popen[bytes] | None, grace: float) -> None:
    """SIGTERM the whole process group, wait ``grace``, then SIGKILL. Never raises."""
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, OSError):
        pass
    exited = False
    if proc is not None:
        try:
            proc.wait(timeout=max(grace, 0.1))
            exited = True
        except subprocess.TimeoutExpired:
            exited = False
        except Exception:  # noqa: BLE001 - teardown must never raise
            exited = True
    if not exited:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, OSError):
            pass
        if proc is not None:
            try:
                proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass
    with _LOCK:
        _LIVE_PGIDS.pop(pgid, None)


def _verify_port_free(port: int, *, tries: int = 5, delay: float = 0.2) -> bool:
    """Best-effort check that ``port`` is free after teardown; never raises.

    A double-fork (or any descendant ``killpg`` could not reach, e.g. one
    that called ``setsid`` itself) leaks a listening socket that a LATER
    boot on the same port would then fail to bind — the leak surfaces as a
    confusing "boot never healthy" on a completely unrelated later story.
    Retried briefly because the OS can take a moment to release the socket
    after the process exits (``TIME_WAIT`` on some platforms/handlers).
    """
    for _ in range(tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.3)
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return True  # nothing answered -> free
        time.sleep(delay)
    return False


def is_alive(app: BootedApp) -> bool:
    """Is the booted process group still running?"""
    with _LOCK:
        proc = _LIVE_PGIDS.get(app.pgid)
    if proc is not None:
        return proc.poll() is None
    try:
        os.killpg(app.pgid, 0)
        return True
    except OSError:
        return False


def probe_health(app: BootedApp, cfg: AcceptanceBootConfig, *, timeout: float = 3.0, retries: int = 3) -> bool:
    """Re-probe health AFTER a run — used to tell "the oracle is broken" from
    "we broke the app" when the HEAD run comes back errors-only red.

    Retried up to ``retries`` times with a short backoff (found 2026-08-07,
    an unreproduced intermittent failure): concluding "the app died" from a
    SINGLE transient failure (a health check that lands during a GC pause, a
    connection-pool hiccup right after a load burst from the oracle's own
    requests) DOWNGRADES an authoritative violation to the waivable
    ``app_crashed_during_run`` — an operator would be OFFERED A WAIVER for a
    genuinely broken implementation. A pass on ANY attempt is a pass; only
    exhausting every attempt concludes "not healthy".
    """
    import httpx

    for attempt in range(retries):
        try:
            resp = httpx.get(f"{app.base_url}{cfg.health_path or '/'}", timeout=timeout)
            if resp.status_code < 400:
                return True
        except httpx.HTTPError:
            pass
        if attempt < retries - 1:
            time.sleep(0.3)
    return False


@dataclass
class ProbeResult:
    """One direct, factory-issued HTTP request against a booted app —
    evidence gathered OUTSIDE the oracle's own process. See ``probe_paths``."""

    method: str
    path: str
    status: int | None
    error: str | None = None


def probe_paths(app: BootedApp, requests: Sequence[str], *, timeout: float = 3.0) -> list[ProbeResult]:
    """KNOWN OPEN #1 (closed 2026-08-07/08): issue ``requests`` (each ``"METHOD
    /path"``, the exact shape ``stub_server.StubApp.requests`` logs) directly
    against ``app``, over HTTP, from THIS process — never from the oracle's.

    Why this exists: a health endpoint that lies (answers 200 before its own
    dependency is ready) makes ``_poll_health`` declare the app booted while
    every REAL route still 500s. The oracle's own per-criterion outcome
    (PASS/FAIL/ERROR) cannot tell "the app genuinely disagreed" from "the app
    is broken and 500s to everything" — both look like a FAIL/ERROR from
    inside pytest. This function gets INDEPENDENT evidence the caller (the
    ``red at merge base`` crediting logic in ``gates.acceptance_verified``)
    can use to require a real signal before trusting an all-FAIL base as
    ``red``: see :func:`served_a_real_route`.

    Deliberately a BLIND replay — no request body, no auth headers copied
    from the oracle. That is a real limitation (a body-validating route may
    4xx instead of exercising its real logic) but a stated, fail-safe one: a
    4xx (or any non-5xx) still proves the route ran far enough to answer with
    a real HTTP response instead of the broken-dependency catch-all, and this
    function does not claim to prove more than that. Never raises — a request
    that cannot even connect is recorded as ``status=None`` with the error,
    not treated as an infrastructure failure of the CALLER.
    """
    import httpx

    out: list[ProbeResult] = []
    for raw in requests:
        method, _, path = raw.partition(" ")
        if not method or not path:
            continue
        if not path.startswith("/"):
            path = "/" + path
        url = f"{app.base_url}{path}"
        try:
            resp = httpx.request(method, url, timeout=timeout)
            out.append(ProbeResult(method=method, path=path, status=resp.status_code))
        except httpx.HTTPError as exc:
            out.append(ProbeResult(method=method, path=path, status=None, error=str(exc)[:200]))
    return out


def served_a_real_route(results: Sequence[ProbeResult]) -> bool:
    """``True`` iff at least one probe got back anything OTHER than a 5xx (or
    a connection failure) — positive evidence the instance is actually
    serving, not merely that its health endpoint answers. A 4xx counts: it
    proves the route ran past whatever wraps a broken dependency in a blanket
    500. ``False`` (including the empty-``results`` case) is the fail-safe
    default — no evidence collected is not evidence of health."""
    return any(r.status is not None and r.status < 500 for r in results)


@contextmanager
def boot_app(
    tree: Path, cfg: AcceptanceBootConfig, run_id: str, label: str = "boot"
) -> Iterator[tuple[BootedApp | None, str]]:
    """Boot ``cfg.command`` inside ``tree``; yields ``(app, "")`` or ``(None, why)``.

    Never raises for an ordinary boot failure — a booted app that never
    becomes healthy is *cannot verify*, not an infrastructure exception. A
    genuinely malformed config (``{port}`` missing from the command) DOES
    raise ``ValueError``: that is an operator config fault, and the caller's
    ``evaluate()`` wrapper turns any exception into an authoritative block —
    which is the ONE case here that should name itself loudly rather than
    read as "the app never came up".
    """
    if not cfg.command or "{port}" not in cfg.command:
        raise ValueError(
            "gates.acceptance_boot.command must contain '{port}' "
            f"(got {cfg.command!r}) — a boot command that never binds the chosen "
            "port cannot be observed over HTTP"
        )

    # The directory/log NAMES deliberately do NOT encode ``label`` (found
    # 2026-08-07): a same-user attacker booted as the diff's own production
    # code can list /tmp for "factory-oracle-head-*" vs "factory-oracle-base-*"
    # and learn WHICH of the three grading runs is currently live — letting it
    # behave correctly at base and tamper only at head. An opaque token
    # removes that signal; ``label`` still appears in ``BootedApp``-adjacent
    # log messages/details for HUMAN debugging, never in a path the booted
    # process can read. This narrows discoverability; it does not remove it
    # (a same-user process can always glob for ANY new ``factory-*`` dir) —
    # see the module docstring and ``oracle_run._tamper_check`` for the
    # mechanism that actually closes the attack.
    _opaque = secrets.token_hex(8)
    run_dir = Path(tempfile.mkdtemp(prefix=f"factory-run-{_opaque}-"))
    run_cwd = tree if not cfg.cwd else (Path(tree) / cfg.cwd)
    if not run_cwd.is_dir():
        shutil.rmtree(run_dir, ignore_errors=True)
        yield None, f"acceptance_boot.cwd={cfg.cwd!r} does not exist in the tree ({run_cwd})"
        return

    booted: BootedApp | None = None
    active_proc: subprocess.Popen[bytes] | None = None
    active_pgid: int | None = None
    last_why = "boot failed for an unknown reason"
    try:
        for _attempt in range(3):
            port = free_port()
            base_url = f"http://127.0.0.1:{port}"
            cmd = _substitute(cfg.command, port=port, base_url=base_url, run_id=run_id, run_dir=str(run_dir))
            env = _build_env(cfg, port=port, base_url=base_url, run_id=run_id, run_dir=str(run_dir))
            log_path = run_dir / "server.log"
            try:
                log_f = log_path.open("ab")
            except OSError as exc:
                last_why = f"could not open boot log {log_path}: {exc}"
                continue
            try:
                proc = subprocess.Popen(  # noqa: S602 - operator-owned boot command
                    cmd, shell=True, cwd=str(run_cwd), env=env,
                    stdout=log_f, stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as exc:
                log_f.close()
                last_why = f"could not start boot command ({exc})"
                continue
            finally:
                log_f.close()
            pgid = proc.pid
            try:
                pgid = os.getpgid(proc.pid)
            except OSError:
                pass
            with _LOCK:
                _LIVE_PGIDS[pgid] = proc
            active_proc, active_pgid = proc, pgid
            healthy, why = _poll_health(proc, base_url, cfg)
            if healthy:
                booted = BootedApp(
                    base_url=base_url, port=port, pid=proc.pid, pgid=pgid,
                    log_path=log_path, run_dir=run_dir,
                )
                break
            tail = tail_log(log_path, 4000)
            last_why = f"{why}\n--- boot log tail ---\n{tail}" if tail else why
            _teardown(pgid, proc, cfg.shutdown_grace_seconds)
            active_proc, active_pgid = None, None

        if booted is None:
            yield None, last_why
            return
        yield booted, ""
    finally:
        torn_down_port = None
        if booted is not None:
            _teardown(booted.pgid, active_proc, cfg.shutdown_grace_seconds)
            torn_down_port = booted.port
        elif active_pgid is not None:
            _teardown(active_pgid, active_proc, cfg.shutdown_grace_seconds)
        shutil.rmtree(run_dir, ignore_errors=True)
        if torn_down_port is not None and not _verify_port_free(torn_down_port):
            _log.warning(
                "boot_app: port %d still answers after teardown (pgid=%s) — a "
                "double-fork or a descendant that escaped the process group may "
                "have leaked a listening socket",
                torn_down_port, booted.pgid if booted is not None else "?",
            )


__all__ = [
    "BootedApp",
    "ProbeResult",
    "boot_app",
    "check_prerequisite",
    "free_port",
    "is_alive",
    "probe_health",
    "probe_paths",
    "served_a_real_route",
    "tail_log",
]
