"""End-to-end pm_sync test in dry-run mode.

Exercises the real ``pm_sync`` function (no monkeypatching the entry point).
The only thing mocked is the LLM call (skipped via ``dry_run=True``) and the
GitHub client (None; pm_sync does not call it in dry-run).
"""

from __future__ import annotations

from pathlib import Path

import yaml

from factory.chain.pm_sync import pm_sync
from factory.directions.creator import create_direction


def _seed_app_config(tmp_path: Path) -> None:
    apps_dir = tmp_path / "apps" / "sacrifice"
    apps_dir.mkdir(parents=True)
    (apps_dir / "config.yaml").write_text(
        "name: sacrifice\nrepo: xvanov/sacrifice\ndefault_branch: main\n"
        "context_dir: context\ndeploy:\n  enabled: false\nmodels: {}\n",
        encoding="utf-8",
    )


def test_pm_sync_dry_run_two_complete_one_vague(tmp_path: Path) -> None:
    _seed_app_config(tmp_path)

    # 001 — complete with API spec.
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

    # 002 — complete with a UI flow.
    create_direction(
        app="sacrifice",
        title="Celebration screen",
        type_tag="feature",
        why="Users want a moment of joy after pledging.",
        has_ui=True,
        flow_steps=[
            "User completes pledge",
            "App displays celebration screen with confetti",
            "User dismisses; returns to dashboard",
        ],
        has_api=False,
        api_spec_lines=None,
        acceptance=["Confetti renders", "Screen dismisses on click"],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
    )

    # 003 — vague. No flow, no api_spec, no explore tag.
    create_direction(
        app="sacrifice",
        title="Vague thought",
        type_tag=None,
        why="I have a feeling.",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=[],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
    )

    state_db = tmp_path / "state" / "factory.db"
    summary = pm_sync(
        app="sacrifice",
        software_factory_root=tmp_path,
        dry_run=True,
        state_db_path=state_db,
    )

    assert summary.processed == 3
    assert summary.validated == 2
    assert summary.needs_direction == 1
    assert summary.errors == []

    # Dry-run is a PURE PREVIEW: the summary reflects exactly what the real
    # run would decide (2 validated, 1 needs-direction) but NOTHING on disk is
    # mutated. Every direction must remain exactly as created — no status flip,
    # no pm_result blob, no status-transition audit entry. Regression guard for
    # the 2026-07-20 self-tick incident, where a dry-run that mutated state let
    # a "safe" preview spawn live dispatchable rebuild-stories.
    directions_dir = tmp_path / "apps" / "sacrifice" / "directions"
    for entry in sorted(directions_dir.iterdir()):
        if not entry.is_dir():
            continue
        state = yaml.safe_load((entry / "state.yaml").read_text(encoding="utf-8"))
        assert state["status"] == "created", f"{entry.name} status mutated by dry-run"
        assert "pm_result" not in state, f"{entry.name} got a pm_result in dry-run"
        assert not any(
            e.get("event", "").startswith("status -> ") for e in state.get("audit", [])
        ), f"{entry.name} recorded a status transition in dry-run"

    # And no StoryRecord rows leaked into the DB from the preview.
    import sqlite3

    conn = sqlite3.connect(str(state_db))
    try:
        n = conn.execute("SELECT COUNT(*) FROM stories").fetchone()[0]
    finally:
        conn.close()
    assert n == 0, f"dry-run persisted {n} dispatchable stories — must be a pure preview"


def test_pm_sync_dry_run_all_vacuous_routes_to_needs_direction(tmp_path: Path) -> None:
    """The vacuity gate (019 AC1 / Flow A) must route an all-vacuous direction
    to needs-direction WITHOUT ever calling the PM persona — dry-run stays a
    pure, deterministic preview, no LLM call involved in the classification."""
    _seed_app_config(tmp_path)

    # Has a real flow.md (otherwise it would be blocked for THAT reason) but
    # every acceptance criterion is satisfiable by a fixed-response no-op —
    # the password-reset incident's own trio.
    create_direction(
        app="sacrifice",
        title="Password reset",
        type_tag="feature",
        why="Users who forget their password need a way back in.",
        has_ui=True,
        flow_steps=[
            "User requests a password reset",
            "User receives a reset email",
            "User submits a new password",
        ],
        has_api=False,
        api_spec_lines=None,
        acceptance=[
            "returns 202",
            "the token is not in the response body",
            "no error is raised",
        ],
        explore=False,
        attach_files=None,
        software_factory_root=tmp_path,
    )

    state_db = tmp_path / "state" / "factory.db"
    summary = pm_sync(
        app="sacrifice",
        software_factory_root=tmp_path,
        dry_run=True,
        state_db_path=state_db,
    )

    assert summary.processed == 1
    assert summary.validated == 0
    assert summary.needs_direction == 1
    assert summary.errors == []

    # No StoryRecord rows spawned — the PM persona (and therefore any
    # story-spawn path) was never reached.
    import sqlite3

    conn = sqlite3.connect(str(state_db))
    try:
        n = conn.execute("SELECT COUNT(*) FROM stories").fetchone()[0]
    finally:
        conn.close()
    assert n == 0, "all-vacuous direction must never reach story spawn"


def test_pm_sync_gc_pass_closes_stale_scheduled_direction(tmp_path: Path) -> None:
    """pm_sync's end-of-pass GC (factory.directions.gc) closes a scheduler-filed
    direction that's been stuck at needs-direction well past the threshold —
    the fix for audit 2026-07-18 leak 2 of 4 (directions filed by scheduler
    personas that never got operator follow-up rotted at needs-direction
    forever)."""
    from datetime import UTC, datetime, timedelta

    from factory.directions.gc import GC_BY, MAX_AGE_DAYS

    _seed_app_config(tmp_path)
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

    summary = pm_sync(
        app="sacrifice",
        software_factory_root=tmp_path,
        dry_run=True,
        state_db_path=tmp_path / "state" / "factory.db",
        # Narrow to "created" so this stale needs-direction entry is not
        # re-validated by the normal pm loop — only the GC pass should
        # touch it, mirroring the automated (maybe_auto_pm_sync) caller.
        pending_statuses=frozenset({"created"}),
    )

    # Dry-run PREVIEWS which directions would be GC-closed (via the returned
    # gc_closed list) but must not mutate state.yaml on disk.
    assert summary.gc_closed == [created.direction.id]
    final_state = yaml.safe_load(state_path.read_text(encoding="utf-8"))
    assert final_state["status"] == "needs-direction", "dry-run must not close on disk"
    assert not any(e.get("by") == GC_BY for e in final_state.get("audit", []))


def test_pm_sync_gc_pass_leaves_fresh_directions_alone(tmp_path: Path) -> None:
    """A freshly-filed scheduled direction (or one from the main test fixture)
    must not be touched by the GC pass."""
    _seed_app_config(tmp_path)
    create_direction(
        app="sacrifice",
        title="fresh scheduled finding",
        type_tag="security",
        why="just filed",
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=["fixed"],
        explore=True,
        attach_files=None,
        software_factory_root=tmp_path,
        source="scheduled-bug_hunter",
    )
    summary = pm_sync(
        app="sacrifice",
        software_factory_root=tmp_path,
        dry_run=True,
        state_db_path=tmp_path / "state" / "factory.db",
    )
    assert summary.gc_closed == []


def test_pm_sync_dry_run_is_idempotent(tmp_path: Path) -> None:
    """Two consecutive dry-runs return the IDENTICAL summary, because a pure
    preview never consumes the direction it previews. Before the 2026-07-20
    fix the first dry-run flipped the direction to ``pm-validated`` and spawned
    dispatchable stories, so the second dry-run reported ``validated=0`` — a
    dry-run!=real-run divergence that made a "safe" preview into a live action.
    """
    _seed_app_config(tmp_path)
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
    state_db = tmp_path / "state" / "factory.db"
    first = pm_sync(
        app="sacrifice", software_factory_root=tmp_path, dry_run=True, state_db_path=state_db
    )
    second = pm_sync(
        app="sacrifice", software_factory_root=tmp_path, dry_run=True, state_db_path=state_db
    )
    assert first.validated == second.validated == 1
    assert first.processed == second.processed == 1


def test_pm_sync_dry_run_no_directions_empty_summary(tmp_path: Path) -> None:
    _seed_app_config(tmp_path)
    # Need at least the directions directory to exist.
    (tmp_path / "apps" / "sacrifice" / "directions").mkdir(exist_ok=True)
    summary = pm_sync(
        app="sacrifice",
        software_factory_root=tmp_path,
        dry_run=True,
        state_db_path=tmp_path / "state" / "factory.db",
    )
    assert summary.processed == 0
    assert summary.validated == 0
    assert summary.needs_direction == 0


# ---------------------------------------------------------------------------
# D012 regression: deleted state.yaml does not cause re-triage
# ---------------------------------------------------------------------------


def test_deleted_state_yaml_survives_pm_sync_without_retriage(tmp_path: Path) -> None:
    """AC1.1 + AC1.2 + AC2.1 + AC2.2 — Integration regression test.

    Proves that a direction whose ``state.yaml`` is deleted keeps its status
    across a fresh read-path (factory restart simulation), ``pm_sync`` does
    NOT re-triage it, and ``state.yaml`` is regenerated from the database
    without status drift.
    """
    import sqlite3

    from factory.directions.parser import parse_direction_dir
    from factory.directions.watcher import mark_direction_status, pending_directions

    def _db_status(db_path: Path, *, app: str, direction_id: str) -> str | None:
        conn = sqlite3.connect(str(db_path))
        try:
            row = conn.execute(
                "SELECT status FROM directions WHERE app=? AND direction_id=?",
                (app, direction_id),
            ).fetchone()
        finally:
            conn.close()
        return None if row is None else str(row[0])

    _seed_app_config(tmp_path)

    # -- create direction on disk and set an authoritative non-pending status
    created = create_direction(
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
    dir_id = created.direction.id
    state_yaml = created.dir_path / "state.yaml"
    state_db = tmp_path / "state" / "factory.db"
    assert state_yaml.exists()

    mark_direction_status(created.direction, "pm-validated", by="regression-test-seed")
    assert _db_status(state_db, app="sacrifice", direction_id=dir_id) == "pm-validated"

    # -- delete state.yaml (simulate operator action from flow step 5)
    state_yaml.unlink()
    assert not state_yaml.exists()

    # -- simulate restart/fresh read path: pending_directions re-resolves from DB
    after_restart = pending_directions("sacrifice", tmp_path, state_db)
    assert dir_id not in {d.id for d in after_restart}
    assert _db_status(state_db, app="sacrifice", direction_id=dir_id) == "pm-validated", (
        "AC1.1: status must survive state.yaml deletion across fresh read-path"
    )

    # -- run pm-sync twice to prove no re-triage and repeat stability
    first = pm_sync(
        app="sacrifice",
        software_factory_root=tmp_path,
        dry_run=True,
        state_db_path=state_db,
    )
    second = pm_sync(
        app="sacrifice",
        software_factory_root=tmp_path,
        dry_run=True,
        state_db_path=state_db,
    )

    # AC1.2: pm-sync must not see this direction as pending after deletion
    assert first.processed == 0 and second.processed == 0, (
        "AC1.2: pm-sync re-triaged a direction whose DB status is pm-validated"
    )
    assert _db_status(state_db, app="sacrifice", direction_id=dir_id) == "pm-validated"

    # -- regenerate state.yaml from DB (AC2.1 + AC2.2)
    status_from_db = _db_status(state_db, app="sacrifice", direction_id=dir_id)
    assert status_from_db is not None
    fresh_direction = parse_direction_dir(
        "sacrifice",
        created.dir_path,
        software_factory_root=tmp_path,
    )
    mark_direction_status(fresh_direction, status_from_db, by="regression-test-regenerate")

    # AC2.1: state.yaml is rewritten for human inspection
    assert state_yaml.exists(), "AC2.1: state.yaml must be regenerated for human inspection"

    # AC2.2: regenerated state.yaml carries the same status as the DB row
    regenerated = yaml.safe_load(state_yaml.read_text(encoding="utf-8"))
    assert regenerated["status"] == status_from_db
    assert _db_status(state_db, app="sacrifice", direction_id=dir_id) == status_from_db
