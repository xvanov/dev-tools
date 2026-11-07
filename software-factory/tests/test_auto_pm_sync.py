"""``maybe_auto_pm_sync`` — tick-driven triage of pending directions.

Directions filed by scheduled personas (or ``factory tell``) used to rot in
``status: created`` until an operator manually ran ``factory pm-sync``. The
auto-sync hook drains them on every tick, gated by the settings flag and
bounded by the real ``pm_invocations_per_hour`` budget.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import yaml
from sqlmodel import SQLModel, create_engine

from factory.chain.pm_sync import maybe_auto_pm_sync
from factory.directions.creator import create_direction
from factory.directions.gc import GC_BY, MAX_AGE_DAYS
from factory.settings.loader import reload_settings


def _seed_app(tmp_path: Path) -> Path:
    apps_dir = tmp_path / "apps" / "sacrifice"
    apps_dir.mkdir(parents=True)
    (apps_dir / "config.yaml").write_text(
        "name: sacrifice\nrepo: xvanov/sacrifice\ndefault_branch: main\n"
        "context_dir: context\ndeploy:\n  enabled: false\nmodels: {}\n",
        encoding="utf-8",
    )
    db = tmp_path / "state" / "factory.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    SQLModel.metadata.create_all(create_engine(f"sqlite:///{db}", echo=False))
    return db


def _seed_pending_direction(tmp_path: Path) -> None:
    create_direction(
        app="sacrifice",
        title="Add healthz endpoint",
        type_tag="feature",
        why="Smoke test wants a stable endpoint.",
        has_ui=False,
        flow_steps=None,
        has_api=True,
        api_spec_lines=['- `POST /healthz` -> 200 {"status":"ok"}'],
        acceptance=["Returns 200", "JSON body has status"],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
    )


def _write_settings(tmp_path: Path, *, enabled: bool, pm_per_hour: int = 4) -> None:
    (tmp_path / "factory_settings.yaml").write_text(
        f"auto_pm_sync:\n  enabled: {str(enabled).lower()}\n"
        f"rate_limits:\n  pm_invocations_per_hour: {pm_per_hour}\n",
        encoding="utf-8",
    )
    reload_settings(tmp_path)


def test_disabled_does_nothing(tmp_path: Path) -> None:
    db = _seed_app(tmp_path)
    _seed_pending_direction(tmp_path)
    _write_settings(tmp_path, enabled=False)

    summary, reason = maybe_auto_pm_sync(
        "sacrifice", tmp_path, dry_run=True, state_db_path=db
    )
    assert summary is None and reason == "disabled"


def test_no_pending_directions_is_a_noop(tmp_path: Path) -> None:
    db = _seed_app(tmp_path)
    _write_settings(tmp_path, enabled=True)

    summary, reason = maybe_auto_pm_sync(
        "sacrifice", tmp_path, dry_run=True, state_db_path=db
    )
    assert summary is None and reason == "no_pending"


def test_pending_direction_is_triaged(tmp_path: Path) -> None:
    db = _seed_app(tmp_path)
    _seed_pending_direction(tmp_path)
    _write_settings(tmp_path, enabled=True)

    summary, reason = maybe_auto_pm_sync(
        "sacrifice", tmp_path, dry_run=True, state_db_path=db
    )
    assert reason == "synced"
    assert summary is not None and summary.processed == 1

    # Dry-run is a pure preview: it does NOT consume the direction, so a second
    # pass previews the very same pending direction (identical result). A real
    # (non-dry) run is what actually advances the direction out of "created".
    summary2, reason2 = maybe_auto_pm_sync(
        "sacrifice", tmp_path, dry_run=True, state_db_path=db
    )
    assert reason2 == "synced"
    assert summary2 is not None and summary2.processed == 1

    # The direction on disk is untouched by the preview.
    directions_dir = tmp_path / "apps" / "sacrifice" / "directions"
    for entry in directions_dir.iterdir():
        if entry.is_dir():
            state = yaml.safe_load((entry / "state.yaml").read_text(encoding="utf-8"))
            assert state["status"] == "created"


def test_hourly_pm_budget_blocks_sync(tmp_path: Path) -> None:
    from sqlmodel import Session

    from factory.runner import Run

    db = _seed_app(tmp_path)
    _seed_pending_direction(tmp_path)
    _write_settings(tmp_path, enabled=True, pm_per_hour=2)

    recent = datetime.now(UTC).isoformat()
    old = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    with Session(create_engine(f"sqlite:///{db}")) as ses:
        for ts in (recent, recent, old):
            ses.add(Run(ts=ts, persona="pm", model="m", mode="text"))
        ses.commit()

    summary, reason = maybe_auto_pm_sync(
        "sacrifice", tmp_path, dry_run=True, state_db_path=db
    )
    assert summary is None and reason == "rate_limited"


def test_needs_direction_entries_are_not_auto_retriaged(tmp_path: Path) -> None:
    """Auto-sync must skip needs-direction entries: re-validating them
    unchanged every tick re-posts the same tracker-issue comment. They are
    re-checked only by an operator-invoked pm-sync."""
    import yaml

    db = _seed_app(tmp_path)
    _seed_pending_direction(tmp_path)
    _write_settings(tmp_path, enabled=True)

    # Flip the seeded direction to needs-direction (failed backpressure).
    state_files = list((tmp_path / "apps" / "sacrifice" / "directions").glob("*/state.yaml"))
    assert state_files
    for sf in state_files:
        state = yaml.safe_load(sf.read_text())
        state["status"] = "needs-direction"
        sf.write_text(yaml.safe_dump(state), encoding="utf-8")

    summary, reason = maybe_auto_pm_sync(
        "sacrifice", tmp_path, dry_run=True, state_db_path=db
    )
    assert summary is None and reason == "no_pending"


def test_gc_runs_on_tick_with_only_stale_needs_direction_pending(tmp_path: Path) -> None:
    """Regression (audit 2026-07-18): a backlog of stale ``needs-direction``
    directions with no fresh ``created`` direction alongside used to never
    reach GC, because ``maybe_auto_pm_sync``'s ``created``-only gate returned
    ``no_pending`` before ``pm_sync()`` — and its internal GC pass — ever
    ran. GC must fire on the automatic tick independently of that gate."""
    db = _seed_app(tmp_path)
    _write_settings(tmp_path, enabled=True)

    created = create_direction(
        app="sacrifice",
        title="rate-limit pledge endpoint",
        type_tag="security",
        why="pledge flooding",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["429 after 5/min"],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
        source="scheduled-security",
    )
    state_path = created.dir_path / "state.yaml"
    state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    old = (datetime.now(UTC) - timedelta(days=MAX_AGE_DAYS + 1)).isoformat()
    state["created_at"] = old
    state["status"] = "needs-direction"
    state["audit"] = [{"event": "status -> needs-direction"}]
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")

    # No ``created`` direction pending anywhere — the previously-broken case.
    # Runs REAL (dry_run=False) with no GitHub client: the GC pass mutates
    # state.yaml locally (its GitHub issue-close is skipped when no client is
    # available). A dry-run here would only PREVIEW the close, so it could not
    # observe the on-disk mutation this regression is about.
    summary, reason = maybe_auto_pm_sync(
        "sacrifice", tmp_path, dry_run=False, state_db_path=db
    )
    assert summary is None and reason == "no_pending"

    final_state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    assert final_state["status"] == "closed"
    assert final_state["audit"][-1]["by"] == GC_BY


def test_github_client_factory_not_called_when_nothing_pending(tmp_path: Path) -> None:
    """Ticks on hosts without GitHub creds must not fail on an idle queue."""
    db = _seed_app(tmp_path)
    _write_settings(tmp_path, enabled=True)

    def _boom() -> None:
        raise AssertionError("factory must not be called with no pending work")

    summary, reason = maybe_auto_pm_sync(
        "sacrifice", tmp_path, dry_run=False, github_client_factory=_boom, state_db_path=db
    )
    assert summary is None and reason == "no_pending"
