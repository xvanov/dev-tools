"""Spend ledger queries against the ``runs`` table.

The ``Run`` rows are written by ``factory.runner._record_run`` for every
LLM call (sandbox or text). This module exposes aggregate queries the
settings enforcer and the ``factory budget`` CLI need.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlmodel import Session, select

from factory.runner import Run, _engine, _record_run


def today_spend_usd(software_factory_root: Path, *, db_path: Path | None = None) -> float:
    """Sum of ``runs.cost_usd`` for runs whose ts is in today's UTC date."""
    db = db_path or (Path(software_factory_root) / "state" / "factory.db")
    eng = _engine(db)
    today = datetime.now(UTC).date().isoformat()
    total = 0.0
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
        for r in rows:
            if (r.ts or "").startswith(today):
                total += float(r.cost_usd or 0.0)
    return round(total, 6)


def persona_runs_today(
    persona: str,
    software_factory_root: Path,
    *,
    db_path: Path | None = None,
) -> int:
    """Count scheduled-persona runs today across ``runs`` and ``scheduled_runs``.

    Phase 6 personas (security, ux_auditor) use this
    to feed ``can_dispatch`` so the per-persona daily-run cap trips.
    Both real-run (writes ``runs`` via ``_record_run``) and dry-run
    (writes ``scheduled_runs`` via ``ScheduledRunRecord``) contribute —
    dry-run is for development and shouldn't be counted toward the cap,
    so this counter only counts ``scheduled_runs`` rows where
    ``dry_run=False`` plus all ``runs`` rows.
    """
    db = db_path or (Path(software_factory_root) / "state" / "factory.db")
    eng = _engine(db)
    today = datetime.now(UTC).date().isoformat()
    count = 0
    with Session(eng) as session:
        rows = session.exec(select(Run).where(Run.persona == persona)).all()
        for r in rows:
            if (r.ts or "").startswith(today):
                count += 1
        # Also count rejected/dry-run scheduled invocations? No: the cap
        # is enforced PRE-dispatch, so a previously rejected run is not a
        # consumed quota slot. Real-run rows above already cover the
        # consumed-quota case. ScheduledRunRecord with status="ok" or
        # status="errored" (post-LLM) means a real LLM call happened, so
        # those also count via the ``runs`` table. No double-count.
    return count


def unpriced_model_runs_today(
    software_factory_root: Path, *, db_path: Path | None = None
) -> list[Run]:
    """Runs today that burned tokens but landed ``cost_usd == 0.0`` with
    ``usage_reliable is False`` — the silent-$0 signature of a model with no
    LiteLLM price registration (see ``factory.providers.azure_foundry`` and
    the guard in ``factory.runner._record_run``).

    ``factory budget`` surfaces the count so an operator sees the blind spot
    a $0.00 total can otherwise hide: these runs are real spend the ledger
    could not read, not free calls.
    """
    db = db_path or (Path(software_factory_root) / "state" / "factory.db")
    eng = _engine(db)
    today = datetime.now(UTC).date().isoformat()
    out: list[Run] = []
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
        for r in rows:
            if not (r.ts or "").startswith(today):
                continue
            if (
                getattr(r, "usage_reliable", None) is False
                and float(r.cost_usd or 0.0) == 0.0
                and ((r.tokens_in or 0) > 0 or (r.tokens_out or 0) > 0)
            ):
                out.append(r)
    return out


def hour_spend_usd(software_factory_root: Path, *, db_path: Path | None = None) -> float:
    """Sum of ``runs.cost_usd`` for runs in the past 60 minutes (UTC)."""
    db = db_path or (Path(software_factory_root) / "state" / "factory.db")
    eng = _engine(db)
    cutoff = datetime.now(UTC) - timedelta(hours=1)
    total = 0.0
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
        for r in rows:
            try:
                ts = datetime.fromisoformat(r.ts)
            except (TypeError, ValueError):
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=UTC)
            if ts >= cutoff:
                total += float(r.cost_usd or 0.0)
    return round(total, 6)


def projected_end_of_day(software_factory_root: Path, *, db_path: Path | None = None) -> float:
    """Linear-extrapolation of today's spend to the end of the UTC day."""
    today = today_spend_usd(software_factory_root, db_path=db_path)
    now = datetime.now(UTC)
    seconds_elapsed = (now - now.replace(hour=0, minute=0, second=0, microsecond=0)).total_seconds()
    if seconds_elapsed <= 0:
        return today
    factor = 86400.0 / seconds_elapsed
    return round(today * factor, 6)


def recent_runs(
    software_factory_root: Path,
    *,
    db_path: Path | None = None,
    limit: int = 5,
) -> list[Run]:
    """Return the last ``limit`` Run rows sorted by ts descending."""
    db = db_path or (Path(software_factory_root) / "state" / "factory.db")
    eng = _engine(db)
    with Session(eng) as session:
        rows = list(session.exec(select(Run)).all())
    rows.sort(key=lambda r: r.ts or "", reverse=True)
    return rows[:limit]


def spend_by_day(
    software_factory_root: Path,
    *,
    db_path: Path | None = None,
    days: int = 7,
) -> list[tuple[str, float]]:
    """Return a list of ``(YYYY-MM-DD, total_usd)`` for the past ``days`` days."""
    db = db_path or (Path(software_factory_root) / "state" / "factory.db")
    eng = _engine(db)
    out: dict[str, float] = {}
    with Session(eng) as session:
        rows = session.exec(select(Run)).all()
        for r in rows:
            d = (r.ts or "")[:10]
            if not d:
                continue
            out[d] = out.get(d, 0.0) + float(r.cost_usd or 0.0)
    # Restrict to last ``days`` days inclusive of today.
    today = datetime.now(UTC).date()
    keys = [(today - timedelta(days=i)).isoformat() for i in range(days)]
    return [(k, round(out.get(k, 0.0), 6)) for k in keys]


def record_cost(
    persona: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    cost_usd: float,
    *,
    mode: str = "text",
    story_path: str | None = None,
    repo_path: str | None = None,
    error: str | None = None,
    software_factory_root: Path | None = None,
    db_path: Path | None = None,
) -> None:
    """Append a ``Run`` row. Thin pass-through to ``runner._record_run``."""
    db: Path | None
    if db_path is not None:
        db = db_path
    elif software_factory_root is not None:
        db = Path(software_factory_root) / "state" / "factory.db"
    else:
        db = None
    _record_run(
        persona=persona,
        model=model,
        mode=mode,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=cost_usd,
        success=error is None,
        story_path=story_path,
        repo_path=repo_path,
        error=error,
        db_path=db,
    )


# Re-export for callers that want the raw Run shape.
__all__ = [
    "Run",
    "hour_spend_usd",
    "projected_end_of_day",
    "recent_runs",
    "record_cost",
    "spend_by_day",
    "today_spend_usd",
    "unpriced_model_runs_today",
]


_ = Any  # silence "imported but unused" if the module is consumed via __all__
