"""Per-app direction queue management.

Status resolution precedence:
1. ``directions`` table row (when one exists for the app + direction_id).
2. On-disk ``state.yaml`` ``status`` field.
3. ``created`` (default for a hand-created direction with no DB row).

The ``DirectionCursor`` SQLModel table is a *cursor optimization* — it
remembers the highest direction id we've seen for an app so the watcher can
skip already-processed entries without a full disk scan in steady state.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from sqlmodel import Field, Session, SQLModel, create_engine, select

from factory.directions.parser import Direction, list_direction_dirs, parse_direction_dir
from factory.directions.schema import RESOLVED_DIRECTION_STATUSES, get_direction


class DirectionCursor(SQLModel, table=True):
    """Per-app cursor over directions/. Optional optimization, see module docstring."""

    __tablename__ = "direction_cursors"

    id: int | None = Field(default=None, primary_key=True)
    app: str = Field(unique=True, index=True)
    last_seen_direction_id: str = ""
    updated_at: str = ""


def _engine(db_path: Path) -> Any:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    # ``create_all`` creates MISSING TABLES but never ALTERs an existing one, so
    # a live DB whose ``directions`` table predates a new column (e.g. ``source``)
    # would still be missing it and every SQLModel read would fail with
    # "no such column". ``migrate`` owns the ADD COLUMN path; it is idempotent.
    from factory.observability.schema import migrate

    migrate(db_path)
    engine = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(engine)
    return engine


def _resolve_status(
    app: str,
    direction_id: str,
    state_yaml_status: str,
    engine: Any,
) -> str:
    """Resolve direction status with DB-first precedence.

    1. DB row → row.status
    2. state.yaml → *state_yaml_status*
    3. ``created``
    """
    with Session(engine) as session:
        row = get_direction(session, app, direction_id)
        if row is not None:
            return row.status
    # state_yaml_status is already the parsed state.yaml value, or "created"
    # if state.yaml was missing/corrupt — see parse_direction_dir.
    return state_yaml_status


def hydrate_direction_source(
    direction: Direction,
    state_db_path: Path,
    *,
    engine: Any | None = None,
) -> Direction:
    """Resolve ``direction.state['source']`` from the authoritative row.

    Same DB-first precedence as :func:`_resolve_status` (see the module
    docstring), applied to the other fact a reader needs about a direction: WHO
    filed it. The operator-approval gate keys on it, and reading only
    ``state.yaml`` made that gate hostage to a file D018 gitignored — no file, no
    source, so the gate's "unknown ⇒ park" fail-safe parked everything.

    Row FIRST, projection as fallback — one precedence rule for the whole
    subsystem. Divergence between the two is not an expected state: the row's
    ``source`` is populated FROM the projection (by ``directions-backfill`` and by
    ``mark_direction_status``) and never set independently, so the row is either
    equal to the file or the only copy left. Preferring it means the gate behaves
    the same on a fresh clone whether or not
    ``factory directions-regenerate-state`` has been run yet, and a hand-edited
    projection cannot talk the gate into building machine-filed work.

    Never raises, and never CREATES a database: a missing/unreadable DB leaves the
    record exactly as parsed, which the gate treats as unknown and parks — the
    fail-safe direction.

    Pass ``engine`` when hydrating in a loop. ``_engine`` runs ``migrate`` (a raw
    sqlite connect plus a ``PRAGMA table_info`` per table) and ``create_all`` on
    every call, so building one per direction turns a listing into O(directions)
    redundant migrations on the tick / CLI path.
    """
    if not direction.id:
        return direction
    if engine is None and not Path(state_db_path).exists():
        return direction
    state = direction.state if isinstance(direction.state, dict) else {}
    try:
        with Session(engine if engine is not None else _engine(state_db_path)) as session:
            row = get_direction(session, direction.app, direction.id)
        if row is not None and row.source and str(row.source).strip():
            state = dict(state)
            state["source"] = str(row.source).strip()
            direction.state = state
    except Exception:  # noqa: BLE001 - fail SAFE: leave it unknown, the gate parks
        pass
    return direction


def pending_directions(
    app: str, software_factory_root: Path, state_db_path: Path
) -> list[Direction]:
    """Return parsed ``Direction`` records whose status indicates the chain has
    not yet validated them.

    Status resolution: ``directions`` table row → ``state.yaml`` → ``created``.
    ``source`` is resolved the same way (see :func:`hydrate_direction_source`),
    so the operator-approval gate downstream sees the authoritative value.
    Pending statuses: ``created``, ``needs-direction``.
    """
    engine = _engine(state_db_path)  # ensure tables exist for callers downstream
    out: list[Direction] = []
    for dir_path in list_direction_dirs(app, software_factory_root):
        d = parse_direction_dir(app, dir_path, software_factory_root=software_factory_root)
        # Resolve status from DB first, falling back to state.yaml / created.
        d.status = _resolve_status(app, d.id, d.status, engine)
        if d.status in {"created", "needs-direction"}:
            # Reuse the engine built above — one migrate, not one per direction.
            out.append(hydrate_direction_source(d, state_db_path, engine=engine))
    return out


def mark_direction_status(
    direction: Direction,
    new_status: str,
    *,
    by: str,
    details: dict[str, Any] | None = None,
    app_config: Any | None = None,
    github_client: Any | None = None,
) -> None:
    """Authoritative database write + best-effort ``state.yaml`` projection.

    The ``directions`` table row is the source of truth.  ``state.yaml`` is
    still written for human inspection but its failure does NOT fail the
    transition.

    When *new_status* resolves the direction (see
    ``schema.RESOLVED_DIRECTION_STATUSES``) and BOTH *app_config* and
    *github_client* are supplied, the direction's GitHub tracker issue and every
    child story issue are closed too — see the comment on that block. Callers
    without a GitHub client (e.g. an operator calling this from a REPL) still
    transition correctly; ``factory reconcile-issues`` closes the issues for any
    direction already in a resolved status, so the remediation self-heals.
    """
    # ---- authoritative database write -----------------------------------
    root = _root_from_direction(direction)
    db_path = root / "state" / "factory.db"
    engine = _engine(db_path)

    # ``UNSET`` (not ``None``) when the projection cannot tell us: ``state.yaml``
    # is gitignored (D018), so a fresh clone has none — and passing ``None`` here
    # would WIPE a perfectly good ``tracker_issue`` / ``source`` off the
    # authoritative row on every status transition. Only overwrite what we can
    # actually read.
    from factory.directions.schema import UNSET, upsert_direction

    tracker_issue: int | None | Any = UNSET
    raw = (direction.state or {}).get("tracker_issue")
    if isinstance(raw, int) and raw > 0:
        tracker_issue = raw

    source: str | None | Any = UNSET
    raw_source = (direction.state or {}).get("source")
    if raw_source not in (None, "") and str(raw_source).strip():
        source = str(raw_source).strip()

    with Session(engine) as session:
        upsert_direction(
            session,
            app=direction.app,
            direction_id=direction.id,
            slug=direction.slug,
            status=new_status,
            tracker_issue=tracker_issue,
            updated_by=by,
            source=source,
        )

    # ---- best-effort state.yaml projection ------------------------------
    state_path = Path(direction.dir_path) / "state.yaml"
    state = _read_state_yaml(state_path)

    state["status"] = new_status
    audit = state.get("audit") or []
    if not isinstance(audit, list):
        audit = []
    audit.append(
        {
            "ts": datetime.now(UTC).isoformat(),
            "by": by,
            "event": f"status -> {new_status}",
            "details": details or {},
        }
    )
    state["audit"] = audit

    try:
        state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    except OSError:
        # File projection is best-effort; the DB row is already committed.
        pass

    # Keep the in-memory record in sync with the authoritative write.
    direction.status = new_status
    direction.state = state

    # ---- best-effort GitHub issue close ---------------------------------
    # Closing a direction means "no more work will happen here", but nothing
    # used to close the direction's GitHub tracker issue or its child story
    # issues, so they leaked open forever (observed 2026-07-28 on the
    # operator-closed D015/D016/D017: 6 orphaned issues). That is the
    # detect-without-remediate class — the state transition happened and
    # nothing closed the loop.
    #
    # BEST-EFFORT BY DESIGN, exactly like the ``state.yaml`` projection above
    # and the GC precedent in ``factory.directions.gc``: the authoritative
    # ``directions`` row is ALREADY committed at this point, so a GitHub
    # outage / missing token / 404 must never fail — or raise out of — the
    # status transition. ``close_direction_issues`` swallows its own errors;
    # the belt-and-braces try/except here also covers an import or
    # path-derivation failure. Anything missed is re-swept by
    # ``factory reconcile-issues``, which closes issues for directions already
    # in a resolved status.
    if new_status in RESOLVED_DIRECTION_STATUSES and app_config is not None:
        try:
            from factory.directions.tracker_issue import close_direction_issues

            close_direction_issues(
                direction,
                app_config,
                github_client,
                by=by,
                reason=str((details or {}).get("reason") or "") or None,
            )
        except Exception:  # noqa: BLE001 - bookkeeping must never fail the transition
            pass


def _read_state_yaml(state_path: Path) -> dict[str, Any]:
    """Read and return the existing ``state.yaml`` dict, or an empty dict.

    Robust against missing file, permission errors, and corrupt YAML.
    """
    try:
        if state_path.exists() and state_path.is_file():
            state = yaml.safe_load(state_path.read_text(encoding="utf-8")) or {}
            if not isinstance(state, dict):
                state = {}
            return state
    except (yaml.YAMLError, OSError):
        pass
    return {}


def _root_from_direction(direction: Direction) -> Path:
    """Derive the software-factory root from the direction's directory path.

    Direction dir_path layout: ``<root>/apps/<app>/directions/<id>-<slug>/``
    so the root is 3 levels up from *dir_path*.
    """
    return direction.dir_path.resolve().parents[3]


def merge_state(direction: Direction, patch: dict[str, Any]) -> None:
    """Merge ``patch`` into ``state.yaml`` at the top level (shallow merge)."""
    state_path = Path(direction.dir_path) / "state.yaml"
    if state_path.exists():
        try:
            state = yaml.safe_load(state_path.read_text(encoding="utf-8")) or {}
            if not isinstance(state, dict):
                state = {}
        except yaml.YAMLError:
            state = {}
    else:
        state = {}
    state.update(patch)
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    direction.state = state


def bump_cursor(app: str, last_id: str, state_db_path: Path) -> None:
    """Persist the highest direction id we've processed for ``app``."""
    engine = _engine(state_db_path)
    now = datetime.now(UTC).isoformat()
    with Session(engine) as session:
        existing = session.exec(select(DirectionCursor).where(DirectionCursor.app == app)).first()
        if existing is None:
            session.add(DirectionCursor(app=app, last_seen_direction_id=last_id, updated_at=now))
        else:
            existing.last_seen_direction_id = last_id
            existing.updated_at = now
            session.add(existing)
        session.commit()


def get_cursor(app: str, state_db_path: Path) -> str | None:
    """Return the last-seen direction id for ``app``, or None."""
    engine = _engine(state_db_path)
    with Session(engine) as session:
        existing = session.exec(select(DirectionCursor).where(DirectionCursor.app == app)).first()
        if existing is None:
            return None
        return existing.last_seen_direction_id
