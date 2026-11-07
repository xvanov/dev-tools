"""UX-Auditor chain — daily Playwright-driven flow audit.

Thin spec-aligned wrapper around ``run_scheduled_persona`` so the
ux_auditor persona has its own module per the Phase 6 layout. The
actual sandbox dispatch (browser tool), direction filing, rate-limit
gating, and DB persistence all live in
``factory.chain.scheduled_tasks``.

In v1 this delegates to ``text_run`` with a fixture for dry-run; future
work wires the OpenHands SDK browser tool via ``sandbox_run`` once the
app has a live deploy URL the auditor can visit.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from factory.chain.scheduled_tasks import (
    ScheduledRunOutput,
    run_scheduled_persona,
)


def ux_auditor_tick(
    app: str,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    fixture_output: dict[str, Any] | None = None,
    db_path: Path | None = None,
) -> ScheduledRunOutput:
    """Single UX-audit pass for ``app``.

    Strong-model persona; rate-limited to ``ux_auditor_runs_per_day``.
    Returns the structured ``ScheduledRunOutput`` so the CLI / cron
    scheduler can render a summary.
    """
    return run_scheduled_persona(
        "ux_auditor",
        app,
        Path(software_factory_root),
        dry_run=dry_run,
        fixture_output=fixture_output,
        db_path=db_path,
    )


__all__ = ["ux_auditor_tick"]
