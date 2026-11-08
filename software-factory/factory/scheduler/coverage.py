"""Which apps something actually ticks (JOBS-API v1.6, ``ticked``).

A code job only moves when its app is ticked: pm-sync, the chain's steps and
the CI watch all run inside ``factory tick --app <app>``. ``factory serve``
ticks only the apps it was started with (``serve_tick: true``, ``--app`` or
``$FACTORY_SERVE_APPS``) and writes that list to ``state/scheduler/serve.json``;
Linux hosts that have not moved to serve tick from ``factory-tick@<app>.timer``.
A job for an app neither covers is accepted and then sits ``queued`` forever,
so submit, status and ``app list`` report it from here.

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
    ) -> None:
        self.serve_apps = serve_apps  # None: no serve status at all
        self.serve_running = serve_running
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
        hint = (
            f"set `serve_tick: true` in apps/{app}/config.yaml and restart factory serve, "
            f"or run `factory tick --app {app}`"
        )
        if self.serve_running:
            ticks = ", ".join(self.serve_apps or []) or "no app"
            return f"app {app} is not ticked: factory serve ticks {ticks}; {hint}"
        return f"app {app} is not ticked: factory serve is not running and no timer ticks it; {hint}"


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
    return TickCoverage(serve_apps, running, timers or serve.systemd_timers_active)


__all__ = ["FRESH_S", "TickCoverage", "read_coverage"]
