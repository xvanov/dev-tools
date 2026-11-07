"""Per-app "Factory Status" pinned GitHub issue — Phase 7 B.

One issue per app, labeled ``factory-status``. The factory rewrites the
body every ``status-sync`` tick with current mode, queue depth, today's
spend, last 5 deploys, active blockers, and active Direction Trackers.
Idempotent: ``FactoryStatusRecord`` carries the issue number per app, so
re-runs update in place rather than open new issues.

Pure-Python, single-purpose, no transitive imports of heavy chain
modules. Dry-run callers (``factory status-sync --app <a> --dry-run``)
get the composed body string back without touching GitHub.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Field, Session, SQLModel, create_engine, select

_STATUS_LABEL = "factory-status"


class FactoryStatusRecord(SQLModel, table=True):
    """One row per (app) → pinned status issue number.

    The factory owns this issue. On first ``update_status_issue`` call
    for an app, the issue is created and its number persisted here.
    Subsequent calls fetch the row and edit the existing issue.
    """

    __tablename__ = "factory_status_issues"

    id: int | None = Field(default=None, primary_key=True)
    app: str = Field(index=True, unique=True)
    gh_issue_number: int
    last_updated: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())


def _engine(db_path: Path) -> Any:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    return eng


# In-flight state set — anything not in a terminal/pre-spawn state.
# Mirrors the queue_cmd convention in cli.py.
_TERMINAL_STATES = {
    "pr_open",
    "ci_pending",
    "ci_green",
    "ready_for_merge",
    "deployed",
    "blocked_tests_need_clarification",
    "blocked_deploy_failed",
    "blocked_review_nonconvergent",
    # Dev-declared underspecification — terminal, awaiting a human.
    "blocked_underspecified",
    # Dual-draft loser sink — terminal (abandoned), never in-flight.
    "superseded_by_sibling",
    # Operator-closed sink — terminal, never in-flight.
    "closed_by_operator",
    # Delivery-level end states — terminal, never in-flight.
    "delivered_local",
    "delivered_branch",
    "delivered_pr",
}

_BLOCKED_STATES = {
    "blocked_tests_need_clarification",
    "blocked_deploy_failed",
    "blocked_review_nonconvergent",
    "blocked_underspecified",
    "reviewer_requested_changes",
}


def _queue_depth_and_blockers(db_path: Path, app: str) -> tuple[int, list[Any]]:
    """Return ``(in_flight_count, blocked_records)`` for ``app``."""
    from factory.chain.state_machine import StoryRecord  # local; avoid cycles

    eng = _engine(db_path)
    in_flight = 0
    blocked: list[Any] = []
    with Session(eng) as session:
        rows = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()
        for r in rows:
            if r.state in _BLOCKED_STATES:
                blocked.append(r)
            elif r.state not in _TERMINAL_STATES:
                in_flight += 1
    return in_flight, blocked


def _last_n_deploys(db_path: Path, app: str, n: int = 5) -> list[Any]:
    """Return the last ``n`` ``DeployActionRecord`` rows for ``app`` (newest first)."""
    from factory.deploy.models import DeployActionRecord
    from factory.deploy.orchestrator import _engine as _deploy_engine

    eng = _deploy_engine(db_path)
    with Session(eng) as session:
        rows = list(
            session.exec(
                select(DeployActionRecord)
                .where(DeployActionRecord.app == app)
                .order_by(DeployActionRecord.id.desc())  # type: ignore[union-attr]
            ).all()
        )
    return rows[:n]


def _active_direction_trackers(app: str, software_factory_root: Path) -> list[dict[str, Any]]:
    """Return ``[{id, slug, title, status, tracker_issue}]`` for trackers still alive.

    "Active" = not in {created, needs-direction, complete}.
    """
    from factory.directions.parser import list_direction_dirs, parse_direction_dir

    out: list[dict[str, Any]] = []
    for ddir in list_direction_dirs(app, software_factory_root):
        try:
            d = parse_direction_dir(app, ddir)
        except Exception:
            continue
        if d.status in {"created", "needs-direction", "complete"}:
            continue
        out.append(
            {
                "id": d.id,
                "slug": d.slug,
                "title": d.title,
                "status": d.status,
                "tracker_issue": d.state.get("tracker_issue"),
            }
        )
    return out


def compose_status_body(app: str, software_factory_root: Path) -> str:
    """Build the markdown body for the pinned ``factory-status`` issue.

    Sections (in order):

    1. Current mode (from ``settings.modes.get_mode``)
    2. Queue depth (in-flight stories)
    3. Today's spend / daily cap (with utilisation percent)
    4. Last 5 deploys (status + sha[:12] + ts)
    5. Active blockers (BLOCKED_* and ``reviewer_requested_changes``)
    6. Active Direction Trackers

    A trailing horizontal rule + "maintained by the factory" footer
    mirrors the tracker-issue convention so users don't hand-edit.
    """
    from factory.settings.loader import load_settings
    from factory.settings.modes import get_mode
    from factory.settings.spend import today_spend_usd

    software_factory_root = Path(software_factory_root)
    db = software_factory_root / "state" / "factory.db"

    settings = load_settings(software_factory_root)
    mode = get_mode(software_factory_root, db_path=db)
    queue, blockers = _queue_depth_and_blockers(db, app)
    spend = today_spend_usd(software_factory_root, db_path=db)
    cap = settings.caps.daily_spend_usd
    deploys = _last_n_deploys(db, app, n=5)
    trackers = _active_direction_trackers(app, software_factory_root)

    pct = (spend / cap * 100.0) if cap > 0 else 0.0

    parts: list[str] = []
    parts.append(f"## Factory live status for `{app}`")
    parts.append("")
    parts.append(f"**Last updated:** `{datetime.now(UTC).isoformat()}`")
    parts.append("")

    parts.append("### Current mode")
    parts.append(f"`{mode}`")
    parts.append("")

    parts.append("### Queue depth")
    parts.append(f"{queue} story / stories in flight")
    parts.append("")

    parts.append("### Today's spend")
    parts.append(f"${spend:.4f} / ${cap:.2f} daily cap ({pct:.1f}%)")
    parts.append("")

    parts.append("### Last 5 deploys")
    if deploys:
        for d in deploys:
            parts.append(
                f"- `{d.sha[:12]}` — **{d.status}** at `{d.ts[:19]}`"
                + (f" — err: {d.error[:60]}" if d.error else "")
            )
    else:
        parts.append("_(no deploys recorded yet)_")
    parts.append("")

    parts.append("### Active blockers")
    if blockers:
        for b in blockers:
            parts.append(f"- story #{b.id} `{b.slug}` — state=`{b.state}`")
    else:
        parts.append("_(none)_")
    parts.append("")

    parts.append("### Active Direction Trackers")
    if trackers:
        for t in trackers:
            iss = f" → tracker #{t['tracker_issue']}" if t.get("tracker_issue") else ""
            parts.append(f"- `{t['id']}-{t['slug']}` — status=`{t['status']}` — {t['title']}{iss}")
    else:
        parts.append("_(none)_")
    parts.append("")

    parts.append("---")
    parts.append("_This issue is maintained by the factory. Edits will be overwritten._")
    return "\n".join(parts)


def _find_existing_issue(app: str, db_path: Path) -> int | None:
    """Look up the persisted ``gh_issue_number`` for ``app`` (or None)."""
    eng = _engine(db_path)
    with Session(eng) as session:
        row = session.exec(
            select(FactoryStatusRecord).where(FactoryStatusRecord.app == app)
        ).first()
        if row is None:
            return None
        return row.gh_issue_number


def _persist_issue_number(app: str, issue_number: int, db_path: Path) -> None:
    """Idempotently upsert the FactoryStatusRecord row for ``app``."""
    eng = _engine(db_path)
    with Session(eng) as session:
        row = session.exec(
            select(FactoryStatusRecord).where(FactoryStatusRecord.app == app)
        ).first()
        now = datetime.now(UTC).isoformat()
        if row is None:
            row = FactoryStatusRecord(app=app, gh_issue_number=issue_number, last_updated=now)
        else:
            row.gh_issue_number = issue_number
            row.last_updated = now
        session.add(row)
        session.commit()


def update_status_issue(
    app: str,
    software_factory_root: Path,
    github_client: Any,
    *,
    app_config: Any = None,
    db_path: Path | None = None,
) -> int:
    """Open or update the pinned ``factory-status`` issue for ``app``.

    * If a ``FactoryStatusRecord`` row exists for ``app`` and the GH issue
      is still open, edit the body in place.
    * Otherwise, create a fresh issue titled ``[FACTORY] <app> live status``,
      labeled ``factory-status``, and persist its number.

    Returns the issue number. Always idempotent; never opens a duplicate.
    """
    if github_client is None:
        raise ValueError("github_client is required for real-run update_status_issue")

    software_factory_root = Path(software_factory_root)
    db = db_path or (software_factory_root / "state" / "factory.db")

    if app_config is None:
        from factory.app_config import load_app_config

        app_config = load_app_config(app, software_factory_root)

    body = compose_status_body(app, software_factory_root)
    title = f"[FACTORY] {app} live status"
    labels = [_STATUS_LABEL]

    repo = github_client.get_repo(app_config.repo)
    existing = _find_existing_issue(app, db)
    if existing is not None:
        try:
            issue = repo.get_issue(existing)
            issue.edit(title=title, body=body, labels=labels)
            _persist_issue_number(app, existing, db)
            return existing
        except Exception:
            # Stale row (issue deleted manually). Fall through and create.
            pass

    issue = repo.create_issue(title=title, body=body, labels=labels)
    number = int(issue.number)
    _persist_issue_number(app, number, db)
    return number
