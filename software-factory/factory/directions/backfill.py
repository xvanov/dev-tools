"""Reconciliation between on-disk direction directories and the ``directions`` table.

Two commands, one per data direction:

* ``factory directions-backfill --app <app> [--dry-run]`` — disk → DB. Imports an
  on-disk direction that has no row yet, so a direction hand-written between
  clones is not lost. Dry-run is the DEFAULT: it writes the authoritative table.
* ``factory directions-regenerate-state --app <app> [--dry-run]`` — DB → disk.
  Rewrites a MISSING ``state.yaml`` projection from its row. ``state.yaml`` is
  gitignored (direction 018), so a fresh clone has none; this rebuilds them.
  Writing is the DEFAULT here: the output is a gitignored, never-overwritten
  projection, so there is nothing to lose.

Both are idempotent — safe to run twice.

``source`` and the round trip
-----------------------------
These two commands are inverses, so anything the gate depends on has to survive
a full disk → DB → disk lap. It did not: the ``directions`` table shipped
without a ``source`` column, so ``regenerate-state`` could not write one, and
the operator-approval gate (PR #182) reads ``state.yaml::source`` with a
"unknown ⇒ park" fail-safe. Following the documented recovery procedure
therefore parked EVERY direction (reproduced: 18 of 18). ``source`` is now a
column, backfill populates it (and heals a NULL one from disk), and regenerate
projects it back out — so the round trip preserves the auto-build/park verdict.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from sqlmodel import Session

from factory.directions.parser import list_direction_dirs, parse_direction_dir
from factory.directions.schema import DirectionRecord


@dataclass
class BackfillResult:
    """Outcome of a disk → DB backfill pass.

    imported: direction dirs that had no row and now do.
    skipped: direction dirs whose row already existed.
    source_healed: EXISTING rows whose ``source`` was NULL and which disk could
        fill in. This is the migration path for rows written before the
        ``source`` column existed: without it every pre-existing direction would
        park at the operator-approval gate forever, because ``--real-run``
        skips rows that already exist and would never touch their ``source``.
        Only ever fills a NULL — a recorded source is never overwritten from a
        projection, since the row is the authority.
    """

    imported: int
    skipped: int
    source_healed: int = 0


@dataclass
class RegenerateResult:
    """Outcome of a ``state.yaml`` regeneration pass.

    written: projections written (or, in dry-run, that would be written).
    present: direction dirs that already have a ``state.yaml`` — left untouched.
    no_row: direction dirs with no ``directions`` row to project from. Run
        ``factory directions-backfill --real-run`` to import those first.
    """

    written: int
    present: int
    no_row: int
    no_source: int = 0


def _resolve_tracker_issue(state: dict[str, Any]) -> int | None:
    raw = state.get("tracker_issue")
    if isinstance(raw, int) and raw > 0:
        return raw
    return None


def _resolve_source(state: dict[str, Any]) -> str | None:
    """Return the ``source`` recorded in a ``state.yaml`` dict, or ``None``.

    Mirrors ``approval.direction_source`` (same normalisation) so a round trip
    through the DB cannot change the gate's verdict.
    """
    raw = state.get("source")
    if raw in (None, ""):
        return None
    text = str(raw).strip()
    return text or None


def _resolve_updated_by(state: dict[str, Any]) -> str | None:
    audit = state.get("audit")
    if isinstance(audit, list) and audit:
        for entry in reversed(audit):
            if not isinstance(entry, dict):
                continue
            by = entry.get("by")
            if isinstance(by, str) and by.strip():
                return by.strip()
            break
    return None


def _parse_timestamp(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    text = raw.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _resolve_created_at(state: dict[str, Any]) -> datetime:
    created = _parse_timestamp(state.get("created_at"))
    if created is not None:
        return created
    return datetime.now(UTC)


def _resolve_updated_at(state: dict[str, Any], *, fallback: datetime) -> datetime:
    audit = state.get("audit")
    if isinstance(audit, list) and audit:
        for entry in reversed(audit):
            if not isinstance(entry, dict):
                continue
            ts = _parse_timestamp(entry.get("ts"))
            if ts is not None:
                return ts
            break
    return fallback


def _existing_rows_by_id(session: Session, app: str) -> dict[str, DirectionRecord]:
    from sqlmodel import select

    rows = session.exec(select(DirectionRecord).where(DirectionRecord.app == app)).all()
    return {str(row.direction_id): row for row in rows if row.direction_id is not None}


def _existing_direction_sources_read_only(db_path: Path, app: str) -> dict[str, str | None]:
    """``{direction_id: source}`` for *app*, read WITHOUT writing to the DB.

    Dry-run must not migrate or create anything, so this reads sqlite directly
    and tolerates a DB whose ``directions`` table predates the ``source`` column
    (reported as all-NULL, i.e. "would be healed").
    """
    if not db_path.exists():
        return {}

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='directions'"
        ).fetchone()
        if table is None:
            return {}
        columns = {row[1] for row in conn.execute("PRAGMA table_info(directions)").fetchall()}
        if "source" in columns:
            rows = conn.execute(
                "SELECT direction_id, source FROM directions WHERE app = ?", (app,)
            ).fetchall()
        else:
            rows = [
                (row[0], None)
                for row in conn.execute(
                    "SELECT direction_id FROM directions WHERE app = ?", (app,)
                ).fetchall()
            ]
        return {
            str(row[0]): (str(row[1]) if row[1] not in (None, "") else None)
            for row in rows
            if row and row[0] is not None
        }
    finally:
        conn.close()


def directions_backfill(
    app: str,
    software_factory_root: Path,
    state_db_path: Path,
    *,
    dry_run: bool = True,
) -> BackfillResult:
    """Import on-disk directions that have no row yet into the ``directions`` table.

    Args:
        app: App name (e.g. ``"factory"``).
        software_factory_root: Repository root.
        state_db_path: Path to the SQLite database file.
        dry_run: If True, report what would happen without writing.

    Returns:
        ``BackfillResult`` with counts of imported and skipped rows.
    """
    from sqlmodel import SQLModel, create_engine

    db_path = Path(state_db_path)
    directions = [
        parse_direction_dir(app, dir_path, software_factory_root=software_factory_root)
        for dir_path in list_direction_dirs(app, software_factory_root)
    ]

    if dry_run:
        existing_sources = _existing_direction_sources_read_only(db_path, app)
        imported = sum(1 for d in directions if d.id not in existing_sources)
        skipped = len(directions) - imported
        healed = sum(
            1
            for d in directions
            if d.id in existing_sources
            and existing_sources[d.id] is None
            and _resolve_source(d.state) is not None
        )
        return BackfillResult(imported=imported, skipped=skipped, source_healed=healed)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    # ``migrate`` owns ADD COLUMN; ``create_all`` alone would leave a pre-existing
    # ``directions`` table without the ``source`` column and every read below
    # would fail with "no such column".
    from factory.observability.schema import migrate

    migrate(db_path)
    engine = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(engine)

    imported = 0
    skipped = 0
    source_healed = 0
    with Session(engine) as session:
        existing = _existing_rows_by_id(session, app)

        for direction in directions:
            disk_source = _resolve_source(direction.state)
            row = existing.get(direction.id)
            if row is not None:
                skipped += 1
                # HEAL, do not overwrite: rows written before the ``source``
                # column exists carry NULL, and nothing else will ever fill them
                # (the row already exists, so the import below is skipped). Left
                # NULL, the approval gate parks the direction forever. A row that
                # already HAS a source is authoritative and untouched.
                if row.source is None and disk_source is not None:
                    row.source = disk_source
                    session.add(row)
                    source_healed += 1
                continue

            tracker_issue = _resolve_tracker_issue(direction.state)
            updated_by = _resolve_updated_by(direction.state)
            created_at = _resolve_created_at(direction.state)
            updated_at = _resolve_updated_at(direction.state, fallback=created_at)

            new_row = DirectionRecord(
                app=app,
                direction_id=direction.id,
                slug=direction.slug,
                status=direction.status,
                tracker_issue=tracker_issue,
                source=disk_source,
                created_at=created_at,
                updated_at=updated_at,
                updated_by=updated_by,
            )
            session.add(new_row)
            imported += 1
            existing[direction.id] = new_row

        session.commit()

    return BackfillResult(imported=imported, skipped=skipped, source_healed=source_healed)


def _projection_from_row(row: DirectionRecord) -> dict[str, Any]:
    """Render the ``state.yaml`` projection of a ``directions`` row.

    Only what the row actually holds. The richer keys a live transition
    accumulates (``pm_result``, the full ``audit`` history) are not in the table
    and are NOT invented here — ``regenerated_from: database`` tells the operator
    reading the file that this is the reduced projection.

    ``source`` IS projected, and that is load-bearing rather than cosmetic: the
    operator-approval gate
    (:func:`factory.directions.approval.requires_operator_approval`) reads
    ``state.yaml::source`` to decide auto-build vs. park. Omitting it made this
    command a pipeline-wide kill switch — regenerate, and every direction looked
    machine-filed, so the gate's fail-safe parked all of them.

    A row with ``source is None`` still projects NO ``source`` key. That is
    deliberate: inventing one (``"operator"``, say) would forge human intent, and
    the gate must not be talked into building something no human asked for.
    Such rows park — see the ``no_source`` counter on :class:`RegenerateResult`,
    which the CLI surfaces with the two ways out (heal from disk via
    ``directions-backfill``, or ``factory approve-direction``).
    """
    state: dict[str, Any] = {
        "status": row.status,
        "created_at": row.created_at.isoformat(),
        "regenerated_from": "database",
        "audit": [
            {
                "ts": row.updated_at.isoformat(),
                "by": row.updated_by or "factory.directions.backfill",
                "event": f"status -> {row.status}",
                "details": {"regenerated": True},
            }
        ],
    }
    if row.tracker_issue is not None:
        state["tracker_issue"] = row.tracker_issue
    if row.source:
        state["source"] = row.source
    return state


def regenerate_state_files(
    app: str,
    software_factory_root: Path,
    state_db_path: Path,
    *,
    dry_run: bool = False,
) -> RegenerateResult:
    """Write a ``state.yaml`` projection for every direction that is missing one.

    ``state.yaml`` is a gitignored projection of the authoritative ``directions``
    row (direction 018), so a fresh clone has direction.md but no state.yaml.
    This rebuilds them.

    An EXISTING ``state.yaml`` is never overwritten. That is deliberate on two
    counts: the on-disk file carries strictly more than the row (``pm_result``,
    the real audit trail), and it makes the command a no-op on a tree that
    already has its projections — so running it produces no diff.

    Args:
        app: App name (e.g. ``"factory"``).
        software_factory_root: Repository root.
        state_db_path: Path to the SQLite database file.
        dry_run: If True, report what would be written without touching disk.

    Returns:
        ``RegenerateResult`` with per-direction outcome counts.
    """
    from sqlmodel import SQLModel, create_engine

    from factory.directions.schema import get_direction

    db_path = Path(state_db_path)
    dir_paths = list_direction_dirs(app, software_factory_root)

    written = 0
    present = 0
    no_row = 0
    no_source = 0

    if not db_path.exists():
        # No database at all: nothing to project from. Every direction dir that
        # lacks a state.yaml is reported as ``no_row`` rather than silently
        # counted as done.
        for dir_path in dir_paths:
            if (dir_path / "state.yaml").exists():
                present += 1
            else:
                no_row += 1
        return RegenerateResult(written=written, present=present, no_row=no_row)

    # ``migrate`` before reading: a live DB whose ``directions`` table predates
    # the ``source`` column must gain it, or the SELECT below raises.
    from factory.observability.schema import migrate

    migrate(db_path)
    engine = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        for dir_path in dir_paths:
            state_path = dir_path / "state.yaml"
            if state_path.exists():
                present += 1
                continue

            direction = parse_direction_dir(
                app, dir_path, software_factory_root=software_factory_root
            )
            row = get_direction(session, app, direction.id)
            if row is None:
                no_row += 1
                continue

            written += 1
            if not row.source:
                # Regenerated with no recorded source ⇒ the operator-approval
                # gate will PARK it. Counted (and shouted about by the CLI) so
                # this is a visible, actionable state instead of the silent
                # factory-wide stall it used to be.
                no_source += 1
            if dry_run:
                continue
            state_path.write_text(
                yaml.safe_dump(_projection_from_row(row), sort_keys=False),
                encoding="utf-8",
            )

    return RegenerateResult(
        written=written, present=present, no_row=no_row, no_source=no_source
    )
