"""Which apps something actually ticks (JOBS-API v1.6, ``ticked``).

A code job only moves when its app is ticked: pm-sync, the chain's steps and
the CI watch all run inside ``factory tick --app <app>``. ``factory serve``
ticks the opted-in apps (``serve_tick: true``, ``--app`` or
``$FACTORY_SERVE_APPS``) plus every app with an active job, and writes its
current list to ``state/scheduler/serve.json`` with ``ticks_active_jobs:
true``; such a running serve ticks ANY app a job is submitted to. A serve from
before that flag ticks only its list. Linux hosts that have not moved to serve
tick from ``factory-tick@<app>.timer``. A job for an app nothing covers is
accepted and then sits ``queued`` forever, so submit, status and ``app list``
report it from here.

``ticked`` is ``True`` / ``False`` when this host can tell, and ``None`` when
it cannot: no serve has ever run here and no timer is active (a test root, a
machine where ticks are started by hand). Unknown is never reported as "not
ticked".
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

#: A serve whose status file is this fresh still counts as running: it is
#: rewritten every 10 s, and a supervised restart (exit 75) writes ``stopped_at``
#: a second or two before the next serve writes its own.
FRESH_S = 60.0


class TickCoverage:
    """What ticks which app on this factory root, read once.

    ``timers`` is asked at most once, and only for an app serve does not cover
    (``systemctl`` is a process; serve's push reads status every few seconds).
    """

    def __init__(
        self,
        serve_apps: list[str] | None,
        serve_running: bool,
        timers: Callable[[], list[str]] = lambda: [],
        *,
        serve_ticks_jobs: bool = False,
    ) -> None:
        self.serve_apps = serve_apps  # None: no serve status at all
        self.serve_running = serve_running
        #: The running serve adds any app with an active job (a job here makes one).
        self.serve_ticks_jobs = serve_ticks_jobs
        self._timers = timers
        self._timer_apps: list[str] | None = None

    def timer_apps(self) -> list[str]:
        if self._timer_apps is None:
            try:
                units = self._timers()
            except Exception:  # noqa: BLE001 - no systemd = no timers
                units = []
            self._timer_apps = [
                u.removesuffix(".timer")[len("factory-tick@") :]
                for u in units
                if u.startswith("factory-tick@")
            ]
        return self._timer_apps

    def ticked(self, app: str) -> bool | None:
        """Whether a job for ``app`` gets ticked here (not whether ``app`` is ticked
        while idle: a serve that ticks active jobs ticks it once one exists)."""
        if self.serve_running and self.serve_ticks_jobs and self.serve_apps is not None:
            return True
        if self.serve_running and self.serve_apps is not None and app in self.serve_apps:
            return True
        if app in self.timer_apps():
            return True
        if self.serve_apps is None and not self.timer_apps():
            return None
        return False

    def why_not(self, app: str) -> str | None:
        """One line for ``why`` / ``warnings`` when ``app`` is not ticked, else None."""
        if self.ticked(app) is not False:
            return None
        if self.serve_running:
            # Only a serve from before ticks_active_jobs gets here.
            ticks = ", ".join(self.serve_apps or []) or "no app"
            return (
                f"app {app} is not ticked: factory serve ticks {ticks} and is too old to tick "
                f"apps with active jobs; update and restart factory serve, set `serve_tick: true` "
                f"in apps/{app}/config.yaml (`factory app set {app} --serve-tick on`), "
                f"or run `factory tick --app {app}`"
            )
        return (
            f"app {app} is not ticked: factory serve is not running and no timer ticks it; "
            f"start factory serve (it ticks every app with an active job; docs/WINDOWS.md) "
            f"or run `factory tick --app {app}`"
        )


def _fresh(updated_at: Any, now: float) -> bool:
    try:
        stamp = datetime.fromisoformat(str(updated_at)).timestamp()
    except (TypeError, ValueError):
        return False
    return now - stamp <= FRESH_S


def read_coverage(
    root: Path,
    *,
    timers: Callable[[], list[str]] | None = None,
    clock: Callable[[], float] = time.time,
) -> TickCoverage:
    """The coverage of ``root`` now. Never raises."""
    from factory.scheduler import serve

    try:
        st = serve.read_status(Path(root))
    except Exception:  # noqa: BLE001 - an unreadable status is "no serve seen"
        st = {}
    apps = st.get("apps")
    serve_apps = [str(a) for a in apps] if isinstance(apps, list) else None
    running = bool(st.get("running")) or _fresh(st.get("updated_at"), clock())
    return TickCoverage(
        serve_apps, running, timers or serve.systemd_timers_active,
        serve_ticks_jobs=bool(st.get("ticks_active_jobs")),
    )


__all__ = ["FRESH_S", "TickCoverage", "read_coverage"]
