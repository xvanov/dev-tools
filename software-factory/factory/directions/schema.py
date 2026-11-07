"""``directions`` table schema and persistence primitives.

Storage contract for direction rows — the foundation that later stories
(read-path, write-path, backfill CLI, ancestor-story context) consume.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Index, UniqueConstraint
from sqlmodel import Field, Session, SQLModel
from sqlmodel import select as _select

DIRECTION_STATUSES: tuple[str, ...] = (
    "created",
    "pm-validated",
    "needs-direction",
    "closed",
)

# Direction statuses that RESOLVE a direction: no further work will happen on
# it, so its GitHub tracker issue and every child story issue should be closed.
#
# Deliberately an explicit ALLOWLIST (never "everything that is not pending" or
# an ``is_terminal``-style predicate). The story-side equivalent
# (``tracker_issue._RESOLVED_STORY_STATES``) learned this the hard way: states
# that are "terminal by omission" get silently classified as resolved and the
# remediation over-fires. Adding a status here is a deliberate decision; an
# unknown/unparseable status resolves to "not resolved", which keeps the issues
# OPEN — the fail-safe direction.
RESOLVED_DIRECTION_STATUSES: frozenset[str] = frozenset({"closed"})


class _Unset:
    """Sentinel for "caller did not supply this field" in :func:`upsert_direction`.

    ``upsert_direction`` OVERWRITES every field it is given, and the one
    production caller (``watcher.mark_direction_status``) only knows about
    ``status``. If "not supplied" meant ``None``, every status transition would
    silently NULL out ``source`` (and ``tracker_issue``) — re-creating the
    outage this column exists to prevent, one transition at a time. With the
    sentinel, an omitted field keeps whatever the row already holds; passing an
    explicit ``None`` still clears it.
    """

    def __repr__(self) -> str:  # pragma: no cover - debug aid only
        return "<unset>"


UNSET = _Unset()


def _validated_status(status: str) -> str:
    if status not in DIRECTION_STATUSES:
        allowed = ", ".join(DIRECTION_STATUSES)
        raise ValueError(f"unsupported direction status '{status}'; expected one of: {allowed}")
    return status


class DirectionRecord(SQLModel, table=True):
    """One row per direction, keyed by app + direction_id.

    Surrogate ``id`` primary key; unique on ``(app, direction_id)``.
    Hot-read index on ``(app, status)`` for "pending directions for this app".
    """

    __tablename__ = "directions"

    id: int | None = Field(default=None, primary_key=True)
    app: str = Field(nullable=False)
    direction_id: str = Field(nullable=False)
    slug: str = Field(nullable=False)
    status: str = Field(nullable=False)
    tracker_issue: int | None = Field(default=None, nullable=True)
    #: WHO filed this direction (``operator``, ``cli-tell``, ``github_issue``,
    #: ``scheduled-ux_auditor``, …). Read by
    #: :func:`factory.directions.approval.requires_operator_approval` to decide
    #: auto-build vs. park-for-approval.
    #:
    #: This column exists because the gate's only source of truth used to be
    #: ``state.yaml`` — which direction 018 then gitignored. The documented
    #: recovery path (``factory directions-regenerate-state``) could not write a
    #: field the table did not have, so every regenerated direction came back
    #: with no source, the gate's fail-safe fired, and the whole build pipeline
    #: parked (reproduced: 18 of 18 factory directions).
    #:
    #: NULLable on purpose: ``NULL`` means "this row predates the column", which
    #: a reader must be able to tell apart from a recorded value. ``NULL`` is
    #: treated as unknown by the gate, i.e. it parks — so heal it from disk with
    #: ``factory directions-backfill --real-run`` while the projections still
    #: exist, or approve with ``factory approve-direction``.
    source: str | None = Field(default=None, nullable=True)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        nullable=False,
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        nullable=False,
    )
    updated_by: str | None = Field(default=None, nullable=True)

    __table_args__ = (
        UniqueConstraint("app", "direction_id", name="uq_directions_app_direction_id"),
        Index("ix_directions_app_status", "app", "status"),
        CheckConstraint(
            "status IN ('created', 'pm-validated', 'needs-direction', 'closed')",
            name="ck_directions_status",
        ),
    )


# ---------------------------------------------------------------------------
# Persistence skeleton — primitives consumed by later stories
# ---------------------------------------------------------------------------


def get_direction(session: Session, app: str, direction_id: str) -> DirectionRecord | None:
    """Return the direction row for *app* + *direction_id*, or *None*."""
    return session.exec(
        _select(DirectionRecord).where(
            DirectionRecord.app == app,
            DirectionRecord.direction_id == direction_id,
        )
    ).first()


def upsert_direction(
    session: Session,
    app: str,
    direction_id: str,
    slug: str,
    status: str,
    tracker_issue: int | None | _Unset = UNSET,
    updated_by: str | None = None,
    source: str | None | _Unset = UNSET,
) -> DirectionRecord:
    """Insert-or-update a direction row, returning the row.

    If a row for *(app, direction_id)* already exists its fields are
    overwritten; otherwise a new row is created.

    ``tracker_issue`` and ``source`` are sentinel-defaulted (:data:`UNSET`):
    OMITTING one preserves whatever the existing row holds, while passing an
    explicit ``None`` clears it. See :class:`_Unset` — a status transition that
    does not know the source must not erase it.
    """
    status = _validated_status(status)
    existing = get_direction(session, app, direction_id)
    now = datetime.now(UTC)

    if existing is not None:
        existing.slug = slug
        existing.status = status
        if not isinstance(tracker_issue, _Unset):
            existing.tracker_issue = tracker_issue
        if not isinstance(source, _Unset):
            existing.source = source
        existing.updated_at = now
        existing.updated_by = updated_by
        session.add(existing)
        session.commit()
        session.refresh(existing)
        return existing

    row = DirectionRecord(
        app=app,
        direction_id=direction_id,
        slug=slug,
        status=status,
        tracker_issue=None if isinstance(tracker_issue, _Unset) else tracker_issue,
        source=None if isinstance(source, _Unset) else source,
        created_at=now,
        updated_at=now,
        updated_by=updated_by,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def list_directions(
    session: Session,
    app: str,
    status: str | None = None,
) -> list[DirectionRecord]:
    """Return direction rows for *app*, optionally filtered by *status*."""
    stmt = _select(DirectionRecord).where(DirectionRecord.app == app)
    if status is not None:
        stmt = stmt.where(DirectionRecord.status == _validated_status(status))
    return list(session.exec(stmt).all())
