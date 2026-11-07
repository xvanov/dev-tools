"""Cron scheduler for Phase-6 scheduled personas.

Responsibilities:

* Read schedules from ``factory_settings.yaml`` (top-level ``schedules:``).
* Persist last-run metadata per schedule in ``state/factory.db.cron_schedules``.
* Tell ``factory tick`` which schedules are due *now* (croniter-based).
* Enforce per-schedule rate limits (e.g. ``security_runs_per_day``).

This module is intentionally NOT a daemon. It is invoked once per tick;
the host's cron (or ``factory tick`` itself) provides the wall clock.

Schedule shape (factory_settings.yaml):

```yaml
schedules:
  - name: ux_audit
    cron: "0 12 * * *"
    persona: ux_auditor
    rate_limit_key: ux_auditor_runs_per_day  # optional; references rate_limits
  - name: security_weekly
    cron: "0 9 * * 1"
    persona: security
```

(The ``ralph`` and ``bug_hunt`` schedules/personas were deleted 2026-08-07 —
019 AC5 — along with ``factory/chain/idle.py``'s rotation through them.)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from croniter import croniter
from sqlmodel import Field, Session, SQLModel, create_engine, select

# --------------------------------------------------------------------------- #
# DB
# --------------------------------------------------------------------------- #


class CronSchedule(SQLModel, table=True):
    """Per-schedule persistence: last-run timestamp + last-run status.

    Rows are upserted by ``name`` (which is unique). The presence of a row
    only reflects history; the *truth* of which schedules exist comes from
    ``factory_settings.yaml``. A row whose ``name`` is not in the YAML is
    inert (kept for audit).
    """

    __tablename__ = "cron_schedules"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    cron_expr: str
    last_run: str | None = None  # ISO8601 UTC
    last_status: str | None = None  # 'ok' | 'errored' | 'rate_limited' | 'skipped_mode'


def _engine(db_path: Path) -> Any:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    return eng


# --------------------------------------------------------------------------- #
# Schedule loader
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Schedule:
    """A schedule as declared in ``factory_settings.yaml``."""

    name: str
    cron_expr: str
    persona: str
    rate_limit_key: str | None = None


# Default schedules embedded so a fresh checkout has sane defaults even if
# the operator hasn't added ``schedules:`` to factory_settings.yaml.
_DEFAULT_SCHEDULES: list[Schedule] = [
    Schedule("ux_audit", "0 12 * * *", "ux_auditor"),
    Schedule("security_weekly", "0 9 * * 1", "security"),
]


def load_schedules(software_factory_root: Path) -> list[Schedule]:
    """Read ``schedules:`` from ``factory_settings.yaml``; fall back to defaults.

    The YAML block is optional; missing top-level key returns
    ``_DEFAULT_SCHEDULES``. The validator is lenient — entries with a
    missing ``cron`` or ``persona`` are dropped with no error (the factory
    is supposed to keep ticking even with a partially-broken config).
    """
    yaml_path = Path(software_factory_root) / "factory_settings.yaml"
    if not yaml_path.exists():
        return list(_DEFAULT_SCHEDULES)
    raw: Any = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
    rows = raw.get("schedules") if isinstance(raw, dict) else None
    if not isinstance(rows, list) or not rows:
        return list(_DEFAULT_SCHEDULES)
    out: list[Schedule] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = row.get("name")
        cron_expr = row.get("cron")
        persona = row.get("persona")
        if not (isinstance(name, str) and isinstance(cron_expr, str) and isinstance(persona, str)):
            continue
        if not croniter.is_valid(cron_expr):
            continue
        rate_key = row.get("rate_limit_key")
        out.append(
            Schedule(
                name=name,
                cron_expr=cron_expr,
                persona=persona,
                rate_limit_key=rate_key if isinstance(rate_key, str) else None,
            )
        )
    return out or list(_DEFAULT_SCHEDULES)


# --------------------------------------------------------------------------- #
# Persistence helpers
# --------------------------------------------------------------------------- #


def get_schedule_row(name: str, db_path: Path) -> CronSchedule | None:
    eng = _engine(db_path)
    with Session(eng) as session:
        return session.exec(select(CronSchedule).where(CronSchedule.name == name)).first()


def upsert_schedule_row(
    *,
    name: str,
    cron_expr: str,
    last_run: str | None,
    last_status: str | None,
    db_path: Path,
) -> CronSchedule:
    """Insert-or-update the row for ``name``. Idempotent.

    Returns the persisted row.
    """
    eng = _engine(db_path)
    with Session(eng) as session:
        row = session.exec(select(CronSchedule).where(CronSchedule.name == name)).first()
        if row is None:
            row = CronSchedule(
                name=name,
                cron_expr=cron_expr,
                last_run=last_run,
                last_status=last_status,
            )
        else:
            row.cron_expr = cron_expr
            if last_run is not None:
                row.last_run = last_run
            if last_status is not None:
                row.last_status = last_status
        session.add(row)
        session.commit()
        session.refresh(row)
        return row


# --------------------------------------------------------------------------- #
# Due-schedule selection
# --------------------------------------------------------------------------- #


def _previous_fire(cron_expr: str, now: datetime) -> datetime:
    """Return the most-recent fire time on/before ``now`` for ``cron_expr``."""
    it = croniter(cron_expr, now)
    return it.get_prev(datetime)  # type: ignore[no-any-return]


def is_due(schedule: Schedule, *, now: datetime, db_path: Path) -> bool:
    """True iff ``schedule`` should fire at ``now``.

    A schedule is due when:

      * No row exists yet (never run), OR
      * The previous fire-time is strictly after the last successful run.

    A failed run is recorded with a non-``ok`` status and DOES count as a
    "ran" event; the schedule will not re-fire within the same cron slot.
    Otherwise a failing persona would re-fire every tick.
    """
    row = get_schedule_row(schedule.name, db_path)
    prev = _previous_fire(schedule.cron_expr, now)
    if row is None or not row.last_run:
        return True
    last_run = datetime.fromisoformat(row.last_run)
    if last_run.tzinfo is None:
        last_run = last_run.replace(tzinfo=UTC)
    return prev > last_run


def runs_in_window(
    *,
    persona: str,
    window_start: datetime,
    db_path: Path,
) -> int:
    """Count executed scheduled runs of ``persona`` since ``window_start``.

    Reads ``state/factory.db.scheduled_runs`` (defined in
    ``factory.chain.scheduled_tasks``). Imported lazily to avoid the
    scheduler package depending on chain at import time.

    Refusal audit rows (``rate_limited``, ``rejected``) are excluded: they
    record a fire that was REFUSED, not a run that consumed budget. Counting
    them made the cap self-reinforcing — every refused fire wrote a
    rate_limited row, which pushed the count further over the cap, which
    refused the next fire. ralph (hourly, so due on every 5-min tick while
    never advancing ``last_run``) locked itself out permanently within a day
    (observed 2026-06-14 → 2026-07-06: 6,328 rate_limited rows vs 91 real
    runs). Unknown future statuses still count, keeping the cap fail-safe
    for spend.
    """
    from factory.chain.scheduled_tasks import ScheduledRunRecord

    eng = _engine(db_path)
    cutoff = window_start.isoformat()
    _refusal_statuses = ("rate_limited", "rejected")
    with Session(eng) as session:
        rows = session.exec(
            select(ScheduledRunRecord).where(
                ScheduledRunRecord.persona == persona,
                ScheduledRunRecord.ts >= cutoff,
                ScheduledRunRecord.status.not_in(_refusal_statuses),  # type: ignore[attr-defined]
            )
        ).all()
    return len(rows)


@dataclass
class DueSchedule:
    """A schedule that's due to fire (decision-stage; not yet executed)."""

    schedule: Schedule
    reason: str  # e.g. "first_run", "previous_fire_passed"
    rate_limit_hit: bool = False


def due_schedules(
    software_factory_root: Path,
    *,
    now: datetime | None = None,
    db_path: Path | None = None,
    audit_app: str | None = None,
) -> list[DueSchedule]:
    """Return every schedule whose previous fire-time post-dates its last run.

    Pure selection — does NOT advance any state. Rate-limit checks are
    embedded; rate-limited schedules are returned with
    ``rate_limit_hit=True`` so the caller can record them as
    ``rate_limited`` instead of silently dropping.

    For every rate-limited schedule we also write a
    ``ScheduledRunRecord`` row with ``status="rate_limited"`` so the audit
    trail captures the skip — otherwise an operator inspecting
    ``factory schedules`` would see nothing for a slot that "fired but
    was refused", making rate-limit-driven gaps invisible.
    ``audit_app`` (default ``"unknown"``) tags the audit row so the
    inbox can group rate-limited events per-app.
    """
    from factory.settings.loader import load_settings

    root = Path(software_factory_root)
    db = db_path or (root / "state" / "factory.db")
    moment = now or datetime.now(UTC)
    out: list[DueSchedule] = []
    schedules = load_schedules(root)
    settings = load_settings(root)
    for schedule in schedules:
        if not is_due(schedule, now=moment, db_path=db):
            continue
        rate_limited = False
        if schedule.rate_limit_key:
            cap = getattr(settings.rate_limits, schedule.rate_limit_key, None)
            if isinstance(cap, int) and cap > 0:
                # Window is a rolling 24h period for "_per_day" caps; for
                # "_per_hour" caps we'd use 1h. We keep the family naming
                # convention in settings and pick the window accordingly.
                from datetime import timedelta

                window_start = moment - (
                    timedelta(hours=1)
                    if schedule.rate_limit_key.endswith("_per_hour")
                    else timedelta(hours=24)
                )
                count = runs_in_window(
                    persona=schedule.persona,
                    window_start=window_start,
                    db_path=db,
                )
                if count >= cap:
                    rate_limited = True
        reason = "first_run" if get_schedule_row(schedule.name, db) is None else "due"
        if rate_limited:
            # P7.0 #4: emit an audit row so operators can see rate-limit
            # skips in ``factory inbox`` and the per-persona audit trail.
            _record_rate_limited_audit_row(
                persona=schedule.persona,
                app=audit_app or "unknown",
                db_path=db,
            )
        out.append(DueSchedule(schedule=schedule, reason=reason, rate_limit_hit=rate_limited))
    return out


def _record_rate_limited_audit_row(*, persona: str, app: str, db_path: Path) -> None:
    """Write a ScheduledRunRecord row marking a rate-limited skip.

    Best-effort — failure here is logged silently because the cron path
    must not block on an audit-write hiccup. Imported lazily to keep
    the scheduler package free of chain imports at module-import time.
    """
    try:
        from factory.chain.scheduled_tasks import ScheduledRunRecord

        eng = _engine(db_path)
        rec = ScheduledRunRecord(
            persona=persona,
            app=app,
            duration_s=0.0,
            findings_count=0,
            directions_filed_json="[]",
            status="rate_limited",
            error=f"{persona}_rate_limit_exceeded",
            dry_run=False,
        )
        with Session(eng) as session:
            session.add(rec)
            session.commit()
    except Exception:  # noqa: BLE001 - audit is best-effort
        return


def next_fire(schedule: Schedule, *, now: datetime | None = None) -> datetime:
    """Return the next time ``schedule`` would fire after ``now``."""
    moment = now or datetime.now(UTC)
    it = croniter(schedule.cron_expr, moment)
    return it.get_next(datetime)  # type: ignore[no-any-return]
