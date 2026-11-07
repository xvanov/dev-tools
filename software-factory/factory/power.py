"""factory.power — the process-level ON/OFF switch for the whole factory.

``factory off`` stops everything; ``factory on`` starts everything. Both are
idempotent and work from ANY starting state — active, inactive, disabled, failed,
or half-up — because "is it running?" had previously to be answered by reading
five systemd units by hand, and a partially-up factory (timers live, manager
down; or manager live, timers down) is indistinguishable from a healthy one at a
glance.

This is deliberately DISTINCT from the two existing switches:

* ``factory pause`` / ``factory resume`` set the in-DB *mode*. The processes keep
  running and keep ticking; they just decline to dispatch. Spend does not go to
  zero (the L1 watcher still fires on its own timer).
* ``factory halt`` (FMS) is an emergency in-DB brake the daemon checks per
  iteration.
* ``factory off`` (here) stops the OS units. Nothing runs, nothing is billed.

Clean shutdown, in order, because the order is the whole point:

  1. Stop + disable every TIMER first, so no NEW work can start.
  2. WAIT for any in-flight oneshot tick service to finish on its own — a tick
     interrupted mid-handler leaves a story in an ``*_in_progress`` state that
     the next run has to recover via the stale-threshold path. Letting it drain
     is the difference between "stopped" and "stopped cleanly".
  3. Stop the long-running services, if any (``_SERVICE_UNITS`` is empty since
     the FMS L1 manager daemon was deleted 2026-08-07 — see ``factory.manager``).
  4. ``reset-failed`` everything, so a unit that had died leaves a clean
     ``inactive`` rather than a sticky ``failed`` that makes the next status read
     look alarming.

``--now`` skips step 2 for when you need it down immediately.
"""

from __future__ import annotations

import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

Runner = Callable[[list[str]], subprocess.CompletedProcess[str]]

# How long ``factory off`` waits for an in-flight tick to drain before giving up
# and stopping it anyway. A full tick (dev convergence loop + gates) can legally
# run ~45 min; this is a shutdown command an operator is watching, so cap the
# patience well below that and report honestly when it expires.
DEFAULT_DRAIN_TIMEOUT_S = 300
_DRAIN_POLL_S = 2.0

# Long-running daemons — stopped LAST (after timers, after the drain).
#
# Empty since 2026-08-07: the FMS L1 watcher daemon (factory-manager.service)
# was deleted along with the other three LLM tiers (operator decision — see
# STATUS.md and the Exteroception v1 direction, P0). The tuple stays so a
# future long-running service has a slot to register in without touching the
# power_on/power_off iteration logic below.
_SERVICE_UNITS: tuple[str, ...] = ()

# Timer units that are not per-app.
_GLOBAL_TIMER_UNITS: tuple[str, ...] = ("factory-self-deploy.timer",)


@dataclass(frozen=True)
class Unit:
    """One systemd user unit under factory control."""

    name: str
    kind: str  # "timer" | "service"
    role: str  # human-readable: what stopping it turns off


@dataclass(frozen=True)
class UnitState:
    name: str
    active: str  # systemctl is-active: active/inactive/failed/unknown
    enabled: str  # systemctl is-enabled: enabled/disabled/static/not-found

    @property
    def installed(self) -> bool:
        return self.enabled != "not-found"

    @property
    def running(self) -> bool:
        return self.active == "active"


def _run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60)


def _sc(runner: Runner, *args: str) -> subprocess.CompletedProcess[str]:
    return runner(["systemctl", "--user", *args])


def _installed_unit_names(runner: Runner) -> set[str]:
    """Every user unit systemd knows about, so we never act on a missing unit."""
    proc = _sc(runner, "list-unit-files", "--no-legend", "--no-pager")
    if proc.returncode != 0:
        return set()
    names: set[str] = set()
    for line in (proc.stdout or "").splitlines():
        parts = line.split()
        if parts:
            names.add(parts[0])
    return names


def discover_units(
    *,
    root: Path,
    runner: Runner | None = None,
    apps: list[str] | None = None,
) -> list[Unit]:
    """Every factory unit that is actually installed on this machine.

    Per-app units are derived from ``apps/*/config.yaml`` rather than hardcoded,
    then filtered against the installed set — so wiring a new app brings its
    units under ``on``/``off`` automatically, and an app without units installed
    is silently skipped instead of erroring.
    """
    runner = runner or _run
    if apps is None:
        apps_dir = root / "apps"
        apps = (
            sorted(p.name for p in apps_dir.iterdir() if (p / "config.yaml").exists())
            if apps_dir.exists()
            else []
        )

    installed = _installed_unit_names(runner)

    def _known(name: str) -> bool:
        # Templated instances (foo@bar.service) are installed as "foo@.service".
        if name in installed:
            return True
        if "@" in name:
            base, _, suffix = name.partition("@")
            ext = suffix.rsplit(".", 1)[-1]
            return f"{base}@.{ext}" in installed
        return False

    candidates: list[Unit] = []
    for a in apps:
        candidates.append(Unit(f"factory-tick@{a}.timer", "timer", f"{a} pipeline heartbeat"))
        candidates.append(Unit(f"{a}-redeploy-main.timer", "timer", f"{a} auto-redeploy"))
    for t in _GLOBAL_TIMER_UNITS:
        candidates.append(Unit(t, "timer", "factory self-deploy"))
    for s in _SERVICE_UNITS:
        candidates.append(Unit(s, "service", "FMS L1 manager daemon"))

    return [u for u in candidates if _known(u.name)]


def unit_state(name: str, *, runner: Runner | None = None) -> UnitState:
    """Read one unit's state. Never raises — an unknown unit reports not-found."""
    runner = runner or _run
    active = (_sc(runner, "is-active", name).stdout or "").strip() or "unknown"
    enabled = (_sc(runner, "is-enabled", name).stdout or "").strip() or "not-found"
    return UnitState(name=name, active=active, enabled=enabled)


def power_status(*, root: Path, runner: Runner | None = None) -> list[UnitState]:
    runner = runner or _run
    return [unit_state(u.name, runner=runner) for u in discover_units(root=root, runner=runner)]


def _running_tick_services(runner: Runner) -> list[str]:
    """Instances of the oneshot tick service currently executing."""
    proc = _sc(
        runner, "list-units", "factory-tick@*.service", "--state=active", "--no-legend", "--no-pager"
    )
    if proc.returncode != 0:
        return []
    out: list[str] = []
    for line in (proc.stdout or "").splitlines():
        parts = line.split()
        for p in parts:
            if p.startswith("factory-tick@") and p.endswith(".service"):
                out.append(p)
                break
    return out


def power_off(
    *,
    root: Path,
    runner: Runner | None = None,
    wait: bool = True,
    drain_timeout_s: int = DEFAULT_DRAIN_TIMEOUT_S,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, object]:
    """Stop the entire factory. Idempotent, and safe from any starting state.

    Returns a report dict: ``{"stopped": [...], "drained": [...], "drain_timed_out":
    bool, "already_off": bool, "units": [UnitState, ...]}``.
    """
    runner = runner or _run
    units = discover_units(root=root, runner=runner)
    before = [unit_state(u.name, runner=runner) for u in units]
    already_off = not any(s.running for s in before) and all(
        s.enabled != "enabled" for s in before if s.installed
    )

    stopped: list[str] = []

    # 1. Timers first — no new work may start while we drain.
    for u in units:
        if u.kind != "timer":
            continue
        _sc(runner, "stop", u.name)
        _sc(runner, "disable", u.name)
        stopped.append(u.name)

    # 2. Let in-flight ticks finish so no story is abandoned mid-handler.
    drained: list[str] = []
    drain_timed_out = False
    if wait:
        waited = 0.0
        while waited < drain_timeout_s:
            running = _running_tick_services(runner)
            if not running:
                break
            drained = running
            sleep(_DRAIN_POLL_S)
            waited += _DRAIN_POLL_S
        else:
            drain_timed_out = bool(_running_tick_services(runner))

    # Whether we waited or not, ensure no tick service is left running.
    for svc in _running_tick_services(runner):
        _sc(runner, "stop", svc)
        stopped.append(svc)

    # 3. Long-running daemons last.
    for u in units:
        if u.kind != "service":
            continue
        _sc(runner, "stop", u.name)
        _sc(runner, "disable", u.name)
        stopped.append(u.name)

    # 4. Clear sticky failure state so the next status read is honest.
    for u in units:
        _sc(runner, "reset-failed", u.name)

    return {
        "stopped": stopped,
        "drained": drained,
        "drain_timed_out": drain_timed_out,
        "already_off": already_off,
        "units": [unit_state(u.name, runner=runner) for u in units],
    }


def power_on(*, root: Path, runner: Runner | None = None) -> dict[str, object]:
    """Start the entire factory. Idempotent, and safe from any starting state.

    Clears sticky ``failed`` state FIRST — a unit left failed by an earlier crash
    can refuse to start cleanly, which is exactly the "it won't come back up"
    case this command exists to make impossible.
    """
    runner = runner or _run
    units = discover_units(root=root, runner=runner)
    before = [unit_state(u.name, runner=runner) for u in units]
    already_on = bool(before) and all(s.running for s in before if s.installed)

    started: list[str] = []
    failed: list[tuple[str, str]] = []

    for u in units:
        _sc(runner, "reset-failed", u.name)

    # Services first, then timers: the manager daemon should be up before the
    # ticks that generate the telemetry it watches.
    for kind in ("service", "timer"):
        for u in units:
            if u.kind != kind:
                continue
            _sc(runner, "enable", u.name)
            proc = _sc(runner, "start", u.name)
            if proc.returncode != 0:
                failed.append((u.name, (proc.stderr or proc.stdout or "").strip()[:200]))
            else:
                started.append(u.name)

    return {
        "started": started,
        "failed": failed,
        "already_on": already_on,
        "units": [unit_state(u.name, runner=runner) for u in units],
    }


__all__ = [
    "DEFAULT_DRAIN_TIMEOUT_S",
    "Unit",
    "UnitState",
    "discover_units",
    "power_off",
    "power_on",
    "power_status",
    "unit_state",
]
