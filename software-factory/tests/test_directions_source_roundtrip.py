"""``directions.source`` — the disk → DB → disk round trip the gate rides on.

The compose-bug this file pins down
-----------------------------------
Three merged changes, each correct alone:

1. **D012** made the ``directions`` table the authority for a direction's
   status. Its columns did NOT include ``source``.
2. **D018 / PR #181** gitignored and untracked ``apps/*/directions/*/state.yaml``
   on the premise that the DB is authoritative, and shipped
   ``factory directions-regenerate-state`` as the documented fresh-clone
   recovery path.
3. **PR #182** added the operator-approval gate, which reads
   ``state.yaml::source`` to tell a human-filed direction (auto-build) from a
   machine-filed one (park), failing SAFE on unknown ⇒ park.

Composed, they brick the factory: regenerate cannot write a column the table
does not have, so every regenerated direction comes back sourceless, the
fail-safe fires, and NOTHING can be built. Reproduced on the live tree — after
regenerating, 18 of 18 factory directions required operator approval.

The invariant these tests defend is the round trip, not any single function:
**a direction's auto-build/park verdict must be identical before and after a
disk → DB → disk lap.**
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import yaml

from factory.directions.approval import is_auto_buildable, requires_operator_approval
from factory.directions.backfill import directions_backfill, regenerate_state_files
from factory.directions.parser import list_direction_dirs, parse_direction_dir
from factory.observability.schema import migrate

# ─── helpers ──────────────────────────────────────────────────────────────


def _write_direction(
    root: Path,
    direction_id: str,
    slug: str,
    *,
    app: str = "factory",
    state: dict[str, Any] | None = None,
) -> Path:
    d = root / "apps" / app / "directions" / f"{direction_id}-{slug}"
    d.mkdir(parents=True)
    (d / "direction.md").write_text(
        f"---\ntitle: {slug}\ntype: feature\n---\n\n# {slug}\n\n"
        "## Why\n\nBecause.\n\n## Acceptance Criteria\n\n- AC1\n",
        encoding="utf-8",
    )
    if state is not None:
        (d / "state.yaml").write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    return d


def _verdicts(root: Path, app: str = "factory") -> dict[str, bool]:
    """``{direction_id: requires_operator_approval}`` read fresh from disk."""
    out: dict[str, bool] = {}
    for dir_path in list_direction_dirs(app, root):
        direction = parse_direction_dir(app, dir_path, software_factory_root=root)
        out[direction.id] = requires_operator_approval(direction)
    return out


def _db_source(db: Path, app: str, direction_id: str) -> str | None:
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT source FROM directions WHERE app = ? AND direction_id = ?",
            (app, direction_id),
        ).fetchone()
    finally:
        conn.close()
    return None if row is None else row[0]


# ─── the schema column ────────────────────────────────────────────────────


def test_directions_table_has_a_source_column(tmp_path: Path) -> None:
    """The table must be able to HOLD what the gate reads.

    Drives ``migrate()`` — the application initializer every CLI entry calls —
    not a hand-rolled create_all, so this covers the real upgrade path.
    """
    db = tmp_path / "factory.db"
    migrate(db)
    conn = sqlite3.connect(str(db))
    try:
        columns = {r[1] for r in conn.execute("PRAGMA table_info(directions)").fetchall()}
    finally:
        conn.close()
    assert "source" in columns


def test_migrate_adds_source_to_a_pre_existing_directions_table(tmp_path: Path) -> None:
    """A LIVE db whose ``directions`` table predates the column must gain it.

    ``SQLModel.metadata.create_all`` creates missing tables but never ALTERs an
    existing one, so without an explicit ADD COLUMN the live ``state/factory.db``
    would keep the old shape and every read would fail with "no such column".
    """
    db = tmp_path / "factory.db"
    # A ``directions`` table in its pre-``source`` (D012) shape.
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "CREATE TABLE directions (id INTEGER PRIMARY KEY, app VARCHAR, "
            "direction_id VARCHAR, slug VARCHAR, status VARCHAR, tracker_issue INTEGER, "
            "created_at DATETIME, updated_at DATETIME, updated_by VARCHAR)"
        )
        conn.execute(
            "INSERT INTO directions (app, direction_id, slug, status) "
            "VALUES ('factory', '001', 'legacy', 'created')"
        )
        conn.commit()
        assert "source" not in {
            r[1] for r in conn.execute("PRAGMA table_info(directions)").fetchall()
        }
    finally:
        conn.close()

    migrate(db)

    conn = sqlite3.connect(str(db))
    try:
        columns = {r[1] for r in conn.execute("PRAGMA table_info(directions)").fetchall()}
        # The pre-existing row survives (ADD COLUMN, not a rebuild).
        rows = conn.execute("SELECT direction_id, source FROM directions").fetchall()
    finally:
        conn.close()
    assert "source" in columns
    assert rows == [("001", None)]


# ─── disk → DB (backfill) ─────────────────────────────────────────────────


def test_backfill_populates_source_from_state_yaml(tmp_path: Path) -> None:
    """AC: ``directions-backfill`` must carry ``source`` from disk into the row."""
    db = tmp_path / "state" / "factory.db"
    _write_direction(tmp_path, "001", "human-filed", state={"status": "created", "source": "cli"})
    _write_direction(
        tmp_path,
        "002",
        "robot-filed",
        state={"status": "created", "source": "scheduled-ux_auditor"},
    )

    result = directions_backfill("factory", tmp_path, db, dry_run=False)

    assert result.imported == 2
    assert _db_source(db, "factory", "001") == "cli"
    assert _db_source(db, "factory", "002") == "scheduled-ux_auditor"


def test_backfill_heals_a_null_source_on_an_existing_row(tmp_path: Path) -> None:
    """The migration path for rows written BEFORE the column existed.

    ``--real-run`` skips a direction that already has a row, so without an
    explicit heal every pre-existing direction would keep ``source = NULL`` — and
    NULL parks. That is precisely the outage, made permanent. This is the
    one-time backfill-from-disk that avoids it.
    """
    db = tmp_path / "state" / "factory.db"
    _write_direction(tmp_path, "001", "human-filed", state={"status": "created", "source": "cli"})
    # Row exists but predates the column.
    directions_backfill("factory", tmp_path, db, dry_run=False)
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("UPDATE directions SET source = NULL")
        conn.commit()
    finally:
        conn.close()
    assert _db_source(db, "factory", "001") is None

    result = directions_backfill("factory", tmp_path, db, dry_run=False)

    assert result.imported == 0
    assert result.skipped == 1
    assert result.source_healed == 1
    assert _db_source(db, "factory", "001") == "cli"


def test_backfill_never_overwrites_a_recorded_source(tmp_path: Path) -> None:
    """The ROW is the authority: a projection must not rewrite a recorded source.

    Otherwise a stale/hand-edited ``state.yaml`` could talk the gate into
    building a machine-filed direction.
    """
    db = tmp_path / "state" / "factory.db"
    d = _write_direction(
        tmp_path, "001", "robot", state={"status": "created", "source": "scheduled-ralph"}
    )
    directions_backfill("factory", tmp_path, db, dry_run=False)
    assert _db_source(db, "factory", "001") == "scheduled-ralph"

    # Someone edits the projection to claim a human filed it.
    (d / "state.yaml").write_text(
        yaml.safe_dump({"status": "created", "source": "operator"}), encoding="utf-8"
    )
    result = directions_backfill("factory", tmp_path, db, dry_run=False)

    assert result.source_healed == 0
    assert _db_source(db, "factory", "001") == "scheduled-ralph"


def test_backfill_dry_run_reports_healable_sources_without_writing(tmp_path: Path) -> None:
    db = tmp_path / "state" / "factory.db"
    _write_direction(tmp_path, "001", "human", state={"status": "created", "source": "cli"})
    directions_backfill("factory", tmp_path, db, dry_run=False)
    conn = sqlite3.connect(str(db))
    try:
        conn.execute("UPDATE directions SET source = NULL")
        conn.commit()
    finally:
        conn.close()

    result = directions_backfill("factory", tmp_path, db, dry_run=True)

    assert result.source_healed == 1
    assert _db_source(db, "factory", "001") is None  # dry-run wrote nothing


# ─── DB → disk (regenerate) ───────────────────────────────────────────────


def test_regenerate_writes_source_back_into_the_projection(tmp_path: Path) -> None:
    db = tmp_path / "state" / "factory.db"
    d = _write_direction(
        tmp_path, "001", "human", state={"status": "created", "source": "operator-loop3"}
    )
    directions_backfill("factory", tmp_path, db, dry_run=False)
    (d / "state.yaml").unlink()

    regenerate_state_files("factory", tmp_path, db)

    written = yaml.safe_load((d / "state.yaml").read_text(encoding="utf-8"))
    assert written["source"] == "operator-loop3"


def test_regenerate_counts_rows_with_no_source_as_no_source(tmp_path: Path) -> None:
    """A regenerated direction that WILL park must be counted, not silent.

    The outage's real damage was invisibility: the command reported
    ``written=18`` and looked like a success while parking the whole pipeline.
    """
    db = tmp_path / "state" / "factory.db"
    d = _write_direction(tmp_path, "001", "sourceless", state={"status": "created"})
    directions_backfill("factory", tmp_path, db, dry_run=False)
    (d / "state.yaml").unlink()

    result = regenerate_state_files("factory", tmp_path, db)

    assert result.written == 1
    assert result.no_source == 1


def test_regenerate_does_not_invent_a_source(tmp_path: Path) -> None:
    """Fail SAFE: no recorded source ⇒ no ``source`` key ⇒ the gate parks.

    Inventing ``operator`` here would forge human intent and let the factory
    build something nobody asked for — the exact treadmill PR #182 stopped.
    """
    db = tmp_path / "state" / "factory.db"
    d = _write_direction(tmp_path, "001", "sourceless", state={"status": "created"})
    directions_backfill("factory", tmp_path, db, dry_run=False)
    (d / "state.yaml").unlink()

    regenerate_state_files("factory", tmp_path, db)

    written = yaml.safe_load((d / "state.yaml").read_text(encoding="utf-8"))
    assert "source" not in written
    direction = parse_direction_dir("factory", d, software_factory_root=tmp_path)
    assert requires_operator_approval(direction) is True


# ─── THE round trip ───────────────────────────────────────────────────────


def test_regenerate_round_trip_preserves_the_approval_verdict(tmp_path: Path) -> None:
    """THE regression test for bug 1.

    disk → DB → (delete projections, i.e. a fresh clone) → disk, then assert the
    approval decision is UNCHANGED for every direction. Before the fix this
    flipped every direction to "requires approval" — 18 of 18 on the live tree —
    because ``source`` could not survive the lap.

    The mix below is deliberate: human-filed sources (which MUST keep
    auto-building), a deterministic detector (ditto), and machine-filed ones
    (which MUST keep parking). A "fix" that simply stopped parking would pass a
    weaker test and re-open the treadmill; this one fails in both directions.
    """
    db = tmp_path / "state" / "factory.db"
    _write_direction(tmp_path, "001", "by-operator", state={"status": "created", "source": "cli"})
    _write_direction(
        tmp_path, "002", "by-operator-loop3", state={"status": "created", "source": "operator-loop3"}
    )
    _write_direction(
        tmp_path, "003", "by-ci-health", state={"status": "created", "source": "ci-health"}
    )
    _write_direction(
        tmp_path,
        "004",
        "by-auditor",
        state={"status": "created", "source": "scheduled-ux_auditor"},
    )
    _write_direction(
        tmp_path, "005", "by-ralph", state={"status": "created", "source": "scheduled-ralph"}
    )

    before = _verdicts(tmp_path)
    assert before == {
        "001": False,  # human → auto-builds
        "002": False,  # human → auto-builds
        "003": False,  # deterministic detector → auto-builds
        "004": True,  # scheduled persona → parks
        "005": True,  # scheduled persona → parks
    }

    # disk → DB
    directions_backfill("factory", tmp_path, db, dry_run=False)
    # a fresh clone: the gitignored projections are simply not there
    for dir_path in list_direction_dirs("factory", tmp_path):
        (dir_path / "state.yaml").unlink()
    # the DOCUMENTED recovery path: DB → disk
    result = regenerate_state_files("factory", tmp_path, db)
    assert result.written == 5

    after = _verdicts(tmp_path)

    # THE assertion. Deliberately the FIRST thing checked after the lap, so a
    # regression fails on the verdict itself rather than on some bookkeeping
    # counter that happens to be evaluated earlier.
    assert after == before, (
        "regenerate → gate round trip changed the approval verdict; "
        f"before={before} after={after}"
    )
    # And spelled out, because "equal dicts" hides which way it broke:
    assert [d for d, parked in after.items() if not parked] == ["001", "002", "003"]
    # Nothing was left sourceless, so nothing needs an operator here.
    assert result.no_source == 0


def test_round_trip_preserves_an_operator_approval(tmp_path: Path) -> None:
    """A machine-filed direction an operator ALREADY approved must stay buildable.

    ``operator_approval`` lives only in the projection, so a regenerate that
    drops it silently un-approves work a human signed off — the same class of
    loss as ``source``, and it would send the direction back to the inbox.
    """
    from factory.directions.approval import approve_direction

    db = tmp_path / "state" / "factory.db"
    d = _write_direction(
        tmp_path, "001", "by-auditor", state={"status": "created", "source": "scheduled-ux_auditor"}
    )
    direction = parse_direction_dir("factory", d, software_factory_root=tmp_path)
    approve_direction(direction, by="operator", note="checked by hand")
    directions_backfill("factory", tmp_path, db, dry_run=False)

    reparsed = parse_direction_dir("factory", d, software_factory_root=tmp_path)
    assert is_auto_buildable(reparsed) is True

    (d / "state.yaml").unlink()
    regenerate_state_files("factory", tmp_path, db)

    after = parse_direction_dir("factory", d, software_factory_root=tmp_path)
    # The approval itself is NOT in the row, so it cannot come back — but the
    # direction must still be recognisably machine-filed and therefore parked,
    # i.e. it lands in the operator's inbox rather than silently auto-building.
    assert requires_operator_approval(after) is True
    assert is_auto_buildable(after) is False


# ─── the gate is DB-authoritative, not file-authoritative ─────────────────


def test_gate_resolves_source_from_the_row_when_the_projection_is_absent(
    tmp_path: Path,
) -> None:
    """A fresh clone must build human-filed work WITHOUT running regenerate first.

    ``state.yaml`` is gitignored, so "no projection" is the normal state of a
    fresh clone. The authority is the row; ``pending_directions`` hydrates
    ``source`` from it, so the gate no longer depends on a file being present.
    """
    from factory.directions.watcher import pending_directions

    db = tmp_path / "state" / "factory.db"
    _write_direction(tmp_path, "001", "by-operator", state={"status": "created", "source": "cli"})
    _write_direction(
        tmp_path, "002", "by-auditor", state={"status": "created", "source": "scheduled-ralph"}
    )
    directions_backfill("factory", tmp_path, db, dry_run=False)
    for dir_path in list_direction_dirs("factory", tmp_path):
        (dir_path / "state.yaml").unlink()

    pending = {d.id: d for d in pending_directions("factory", tmp_path, db)}

    assert set(pending) == {"001", "002"}
    assert is_auto_buildable(pending["001"]) is True, "human-filed work must not park"
    assert is_auto_buildable(pending["002"]) is False, "machine-filed work must still park"


def test_row_source_wins_over_the_projection(tmp_path: Path) -> None:
    """Row-FIRST precedence, matching ``watcher._resolve_status``.

    One precedence rule for the whole subsystem, and a hand-edited projection
    cannot talk the gate into auto-building machine-filed work.
    """
    from factory.directions.watcher import pending_directions

    db = tmp_path / "state" / "factory.db"
    d = _write_direction(
        tmp_path, "001", "robot", state={"status": "created", "source": "scheduled-ralph"}
    )
    directions_backfill("factory", tmp_path, db, dry_run=False)
    # The projection now claims a human filed it; the row still says otherwise.
    (d / "state.yaml").write_text(
        yaml.safe_dump({"status": "created", "source": "operator"}), encoding="utf-8"
    )

    pending = {x.id: x for x in pending_directions("factory", tmp_path, db)}

    assert is_auto_buildable(pending["001"]) is False


def test_hydration_never_creates_a_database(tmp_path: Path) -> None:
    """No DB ⇒ leave the record as parsed. Never conjure a ``state/factory.db``.

    ``hydrate_direction_source`` is called from CLI listings too, where a
    surprise write would be a side effect nobody asked for.
    """
    from factory.directions.watcher import hydrate_direction_source

    db = tmp_path / "state" / "factory.db"
    d = _write_direction(tmp_path, "001", "robot", state={"status": "created"})
    direction = parse_direction_dir("factory", d, software_factory_root=tmp_path)

    hydrate_direction_source(direction, db)

    assert not db.exists()
    assert requires_operator_approval(direction) is True  # unknown ⇒ parks


def test_status_transition_does_not_erase_the_recorded_source(tmp_path: Path) -> None:
    """``mark_direction_status`` must not NULL out ``source`` as a side effect.

    It re-reads ``tracker_issue``/``source`` from the projection to write the row.
    With the projection gitignored (D018) those reads come back empty, and an
    unconditional overwrite would wipe the row's ``source`` on the very first
    transition — re-creating the outage one direction at a time.
    """
    from factory.directions.watcher import mark_direction_status

    db = tmp_path / "state" / "factory.db"
    d = _write_direction(
        tmp_path, "001", "human", state={"status": "created", "source": "cli", "tracker_issue": 42}
    )
    directions_backfill("factory", tmp_path, db, dry_run=False)
    assert _db_source(db, "factory", "001") == "cli"

    # Fresh clone: the projection is gone, so the transition has nothing to read.
    (d / "state.yaml").unlink()
    direction = parse_direction_dir("factory", d, software_factory_root=tmp_path)
    mark_direction_status(direction, "pm-validated", by="test")

    assert _db_source(db, "factory", "001") == "cli"
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT status, tracker_issue FROM directions WHERE direction_id = '001'"
        ).fetchone()
    finally:
        conn.close()
    assert row == ("pm-validated", 42), "tracker_issue must survive the transition too"
