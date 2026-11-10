"""``runs`` rows for Claude Code runs.

A row is opened when the run starts (``error`` = the runner's provisional marker,
so ``factory job status`` reports it ``running`` and a killed process leaves a
visible row), the termhub session is written onto it as soon as it exists, and
it is finalised when the run ends.

Billing: ``cost_usd`` stays 0.0 — a subscription run is not metered, and every
spend cap sums ``runs.cost_usd``. What the run would have cost at API prices
(Claude Code's ``total_cost_usd``) goes to ``subscription_equiv_usd``.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from factory.jobs.kinds import BILLING_SUBSCRIPTION, RUNTIME_CLAUDE


def model_label(model: str | None) -> str:
    return f"claude_session/{model or 'default'}"


def open_run(
    db_path: Path,
    *,
    persona: str,
    model: str | None,
    story_id: int | None,
    app: str | None,
    direction_id: str | None,
    repo_path: str | None,
    story_path: str | None = None,
    run_dir: str | None = None,
) -> int | None:
    """Open the run's provisional row. ``run_dir`` (plan 8.8) is where its
    ``stream-<n>.jsonl`` rounds land, so Build's run viewer can read them."""
    from sqlmodel import Session

    from factory.runner import _PROVISIONAL_RUN_ERROR, Run, _engine

    now = datetime.now(UTC).isoformat()
    with Session(_engine(db_path)) as session:
        row = Run(
            ts=now,
            started_at=now,
            persona=persona,
            model=model_label(model),
            mode=RUNTIME_CLAUDE,
            success=False,
            story_path=story_path,
            repo_path=repo_path,
            error=_PROVISIONAL_RUN_ERROR,
            story_id=story_id,
            app=app,
            direction_id=direction_id,
            runtime=RUNTIME_CLAUDE,
            billing=BILLING_SUBSCRIPTION,
            cost_usd=0.0,
            subscription_equiv_usd=0.0,
            premodel_infra=False,
            stream_path=run_dir,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row.id


def set_session(db_path: Path, row_id: int | None, session_info: dict[str, Any] | None) -> None:
    if row_id is None or not session_info:
        return
    from sqlmodel import Session

    from factory.runner import Run, _engine

    with Session(_engine(db_path)) as session:
        row = session.get(Run, row_id)
        if row is None:
            return
        row.session_json = json.dumps(session_info, sort_keys=True)
        session.add(row)
        session.commit()


def close_run(
    db_path: Path,
    row_id: int | None,
    *,
    success: bool,
    error: str | None,
    tokens_in: int,
    tokens_out: int,
    cached_input_tokens: int,
    subscription_equiv_usd: float,
    duration_s: float,
    usage_reliable: bool,
    model: str | None = None,
) -> None:
    if row_id is None:
        return
    from sqlmodel import Session

    from factory.runner import Run, _engine, redact_secrets, truncate_error

    with Session(_engine(db_path)) as session:
        row = session.get(Run, row_id)
        if row is None:
            return
        row.ts = datetime.now(UTC).isoformat()
        row.success = bool(success)
        row.error = truncate_error(redact_secrets(error)) if error else None
        row.tokens_in = int(tokens_in)
        row.tokens_out = int(tokens_out)
        row.cached_input_tokens = int(cached_input_tokens)
        row.cost_usd = 0.0
        row.subscription_equiv_usd = round(float(subscription_equiv_usd), 6)
        row.duration_s = float(duration_s)
        row.usage_reliable = bool(usage_reliable)
        if model:
            row.model = model_label(model)
        session.add(row)
        session.commit()


__all__ = ["close_run", "model_label", "open_run", "set_session"]
