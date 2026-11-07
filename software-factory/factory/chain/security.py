"""Security chain — deeper-scan security audit.

Thin spec-aligned wrapper around ``run_scheduled_persona`` so the
security persona has its own module per the Phase 6 layout. The actual
LLM dispatch, direction filing, rate-limit gating, and DB persistence
all live in ``factory.chain.scheduled_tasks``.

Triggered by (security)-tagged directions or the weekly cron.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from factory.chain.scheduled_tasks import (
    ScheduledRunOutput,
    run_scheduled_persona,
)


def security_tick(
    app: str,
    software_factory_root: Path,
    *,
    dry_run: bool = False,
    fixture_output: dict[str, Any] | None = None,
    db_path: Path | None = None,
) -> ScheduledRunOutput:
    """Single security-audit pass for ``app``.

    Strong-model persona; rate-limited to ``security_runs_per_day``.
    Returns the structured ``ScheduledRunOutput`` so the CLI / cron
    scheduler can render a summary.
    """
    return run_scheduled_persona(
        "security",
        app,
        Path(software_factory_root),
        dry_run=dry_run,
        fixture_output=fixture_output,
        db_path=db_path,
    )


__all__ = ["security_tick"]
