"""Tests for the Phase-6 cron scheduler.

Covers:

  * ``due_schedules`` returns first-run entries when no rows exist.
  * After a run is recorded with last_run = now, ``due_schedules`` does
    NOT re-fire until the next cron boundary.
  * Rate-limit cap (``ux_auditor_runs_per_day``) flips entries to
    ``rate_limit_hit=True`` once the cap is hit.
  * ``load_schedules`` falls back to defaults when factory_settings.yaml
    lacks a ``schedules:`` block.

The fixture personas here were rewritten 2026-08-07 (019 AC5): ``ralph`` and
``bug_hunter`` (and their schedules) were deleted, so this file now drives
its cron-mechanics coverage through the two SURVIVING scheduled personas,
``ux_auditor`` (in place of ralph — the rate-limited, hourly schedule) and
``security`` (in place of bug_hunt — the un-rate-limited daily schedule).
None of the is_due / rate-limit logic under test changed; only the fixture
names did.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import yaml

from factory.chain.scheduled_tasks import ScheduledRunRecord
from factory.scheduler.cron import (
    Schedule,
    due_schedules,
    load_schedules,
    next_fire,
    upsert_schedule_row,
)
from factory.settings.loader import reload_settings


def _write_root(tmp_path: Path, with_schedules: bool = True) -> Path:
    """Set up a tmp factory root with optional schedules block."""
    apps = tmp_path / "apps" / "sacrifice"
    apps.mkdir(parents=True)
    (apps / "config.yaml").write_text("name: sacrifice\nrepo: o/r\n", encoding="utf-8")
    settings: dict[str, object] = {
        "rate_limits": {
            "ux_auditor_runs_per_day": 24,
        },
        "modes": {"default": "normal", "available": ["normal"]},
    }
    if with_schedules:
        settings["schedules"] = [
            {
                "name": "ux_audit",
                "cron": "0 * * * *",
                "persona": "ux_auditor",
                "rate_limit_key": "ux_auditor_runs_per_day",
            },
            {"name": "security_weekly", "cron": "0 6 * * *", "persona": "security"},
        ]
    (tmp_path / "factory_settings.yaml").write_text(yaml.safe_dump(settings), encoding="utf-8")
    (tmp_path / "state").mkdir()
    reload_settings(tmp_path)
    return tmp_path


def test_first_tick_returns_all_schedules(tmp_path: Path) -> None:
    root = _write_root(tmp_path)
    due = due_schedules(root, now=datetime(2026, 6, 1, 10, 5, tzinfo=UTC))
    names = sorted(d.schedule.name for d in due)
    assert names == ["security_weekly", "ux_audit"]
    assert all(d.reason == "first_run" for d in due)
    assert all(not d.rate_limit_hit for d in due)


def test_run_recorded_blocks_re_firing(tmp_path: Path) -> None:
    root = _write_root(tmp_path)
    db = root / "state" / "factory.db"
    # Record a run at 10:00. The previous cron fire for "0 * * * *" at
    # 10:05 is also 10:00 → already covered.
    upsert_schedule_row(
        name="ux_audit",
        cron_expr="0 * * * *",
        last_run="2026-06-01T10:00:00+00:00",
        last_status="ok",
        db_path=db,
    )
    due = due_schedules(root, now=datetime(2026, 6, 1, 10, 5, tzinfo=UTC), db_path=db)
    names = [d.schedule.name for d in due]
    # security_weekly fires at 06:00; never run → still due.
    assert "ux_audit" not in names
    assert "security_weekly" in names


def test_rate_limit_flags_due_schedule(tmp_path: Path) -> None:
    """When the cap is reached, the schedule still surfaces but rate_limit_hit=True."""
    from sqlmodel import Session

    from factory.scheduler.cron import _engine

    root = _write_root(tmp_path)
    db = root / "state" / "factory.db"
    # Insert 24 successful scheduled runs of ``ux_auditor`` in the last 24h.
    eng = _engine(db)
    now = datetime(2026, 6, 1, 10, 5, tzinfo=UTC)
    with Session(eng) as session:
        for i in range(24):
            session.add(
                ScheduledRunRecord(
                    ts=(now - timedelta(hours=i)).isoformat(),
                    persona="ux_auditor",
                    app="sacrifice",
                    status="ok",
                )
            )
        session.commit()
    due = due_schedules(root, now=now, db_path=db)
    ux_audit = [d for d in due if d.schedule.name == "ux_audit"]
    assert len(ux_audit) == 1
    assert ux_audit[0].rate_limit_hit is True


def test_fallback_defaults_when_no_schedules_block(tmp_path: Path) -> None:
    """Missing ``schedules:`` block in YAML → defaults still load."""
    root = _write_root(tmp_path, with_schedules=False)
    schedules = load_schedules(root)
    names = sorted(s.name for s in schedules)
    assert names == ["security_weekly", "ux_audit"]


def test_next_fire_returns_future_time() -> None:
    s = Schedule(name="t", cron_expr="0 * * * *", persona="ux_auditor")
    now = datetime(2026, 6, 1, 10, 5, tzinfo=UTC)
    nxt = next_fire(s, now=now)
    assert nxt == datetime(2026, 6, 1, 11, 0, tzinfo=UTC)


def test_rate_limited_audit_rows_do_not_count_toward_cap(tmp_path: Path) -> None:
    """Regression: refusal audit rows must not feed the cap they audit.

    Observed 2026-06-14 → 2026-07-06 on the now-deleted ``ralph`` schedule:
    every refused fire wrote a ``rate_limited`` row, ``runs_in_window``
    counted it, so the count could only grow — ralph locked itself out
    permanently after one day at the cap (6,328 rate_limited rows vs 91 real
    runs). With only refusal rows in the window and zero executions, the
    schedule must fire. Re-vehicled onto ``ux_auditor`` (019 AC5); the logic
    under test is unchanged.
    """
    from sqlmodel import Session

    from factory.scheduler.cron import _engine

    root = _write_root(tmp_path)
    db = root / "state" / "factory.db"
    eng = _engine(db)
    now = datetime(2026, 6, 1, 10, 5, tzinfo=UTC)
    with Session(eng) as session:
        # A wall of refusal audit rows (the self-reinforcing lockout state)
        # plus a handful of mode-rejected rows — none of these executed.
        for i in range(300):
            session.add(
                ScheduledRunRecord(
                    ts=(now - timedelta(minutes=5 * i)).isoformat(),
                    persona="ux_auditor",
                    app="sacrifice",
                    status="rate_limited",
                )
            )
        for i in range(3):
            session.add(
                ScheduledRunRecord(
                    ts=(now - timedelta(hours=i)).isoformat(),
                    persona="ux_auditor",
                    app="sacrifice",
                    status="rejected",
                )
            )
        session.commit()
    due = due_schedules(root, now=now, db_path=db)
    ux_audit = [d for d in due if d.schedule.name == "ux_audit"]
    assert len(ux_audit) == 1
    assert ux_audit[0].rate_limit_hit is False, (
        "refusal audit rows counted toward the cap — self-reinforcing lockout"
    )


def test_executed_runs_still_count_toward_cap(tmp_path: Path) -> None:
    """The cap still binds on REAL executions (ok/errored/dry_run all count)."""
    from sqlmodel import Session

    from factory.scheduler.cron import _engine

    root = _write_root(tmp_path)
    db = root / "state" / "factory.db"
    eng = _engine(db)
    now = datetime(2026, 6, 1, 10, 5, tzinfo=UTC)
    with Session(eng) as session:
        for i, status in enumerate(["ok"] * 22 + ["errored", "dry_run"]):
            session.add(
                ScheduledRunRecord(
                    ts=(now - timedelta(hours=i % 23)).isoformat(),
                    persona="ux_auditor",
                    app="sacrifice",
                    status=status,
                )
            )
        session.commit()
    due = due_schedules(root, now=now, db_path=db)
    ux_audit = [d for d in due if d.schedule.name == "ux_audit"]
    assert len(ux_audit) == 1
    assert ux_audit[0].rate_limit_hit is True
