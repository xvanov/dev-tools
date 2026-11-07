"""Backfill a direction's ``tracker_issue`` number from GitHub when it's missing.

``factory.directions.tracker_issue.resolve_tracker_issue`` has exactly two
sources for a direction's tracker-issue number: the ``directions`` row and the
``state.yaml`` projection. Both are populated by
``open_or_update_tracker_issue`` the first time it creates the issue — but a
direction whose tracker issue and child stories were produced OUTSIDE that
code path (observed on direction 018: its ``state.yaml`` never gained a
``pm_result`` or ``tracker_issue`` key and its DB row's ``tracker_issue`` was
NULL, even though a real, correctly-formatted tracker issue existed on
GitHub — #171) has no source to resolve from, ever. ``reconcile_completed_issues``
then has no issue number to close, so a direction whose every child story
resolved (``closed_by_operator``) sits with an open tracker forever — a human
has to find and close it by hand.

This module closes that gap by searching GitHub directly. Every tracker issue
body is rendered by ``_format_tracker_body`` and always embeds the exact line
``**Direction:** `<id>-<slug>` `` — that marker is more reliable than a title
match (the direction's ``title`` in ``direction.md`` can be edited after the
issue was created, and a hand-authored issue may not use the auto-generated
title template at all), so it is the sole matching signal here.

Matching is deliberately conservative: zero or more-than-one issue containing
the marker is reported and skipped, never guessed. A wrong tracker number
would misdirect ``reconcile_completed_issues`` into closing (or never
closing) the wrong issue.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from factory.app_config import AppConfig
from factory.directions.parser import list_direction_dirs, parse_direction_dir
from factory.directions.tracker_issue import resolve_tracker_issue


def _direction_marker(direction_id: str, slug: str) -> str:
    """The exact body line ``_format_tracker_body`` renders for every tracker issue."""
    return f"**Direction:** `{direction_id}-{slug}`"


@dataclass
class TrackerBackfillResult:
    """Outcome of a tracker-issue backfill pass, scoped to one app.

    found: ``(direction_id, issue_number)`` for a direction that had no
        resolvable tracker and now has exactly one matching GitHub issue —
        persisted to the ``directions`` row unless ``dry_run``.
    already_set: directions that already resolved a tracker (DB row or
        ``state.yaml``) — left untouched.
    not_found: direction ids with no resolvable tracker AND no matching
        GitHub issue. Nothing to persist; the direction may simply never
        have had a tracker issue.
    ambiguous: ``(direction_id, [issue_numbers])`` for a direction whose
        marker matched MORE than one issue — never guessed, reported instead.
    errors: ``(direction_id_or_context, message)`` for a lookup/write failure
        that did not abort the rest of the sweep.
    """

    found: list[tuple[str, int]] = field(default_factory=list)
    already_set: int = 0
    not_found: list[str] = field(default_factory=list)
    ambiguous: list[tuple[str, list[int]]] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)


def backfill_tracker_issues(
    app_config: AppConfig,
    github_client: Any,
    *,
    software_factory_root: Path,
    db_path: Path | None = None,
    dry_run: bool = True,
) -> TrackerBackfillResult:
    """Find + persist a missing ``tracker_issue`` for every direction of *app_config*.

    Fail-safe: a GitHub or DB error for one direction is recorded in
    ``errors`` and does not abort the rest of the sweep. Fetches every issue
    (open + closed) in the app's repo ONCE and matches by body marker, rather
    than one GitHub call per direction.

    ``dry_run`` (default True, matching ``directions-backfill``'s convention)
    reports what would be persisted without writing to the DB.
    """
    result = TrackerBackfillResult()
    root = Path(software_factory_root)
    db = Path(db_path) if db_path is not None else root / "state" / "factory.db"

    try:
        repo = github_client.get_repo(app_config.repo)
        issues = list(repo.get_issues(state="all"))
    except Exception as exc:  # noqa: BLE001 - a bad client/repo must not raise
        result.errors.append(("repo", str(exc)))
        return result

    # Index every issue's body once, so each direction's lookup is a cheap
    # substring scan instead of a fresh GitHub call.
    bodies: list[tuple[int, str]] = [
        (int(issue.number), getattr(issue, "body", None) or "") for issue in issues
    ]

    for dir_path in sorted(list_direction_dirs(app_config.name, root)):
        try:
            direction = parse_direction_dir(
                app_config.name, dir_path, software_factory_root=root
            )
        except Exception:  # noqa: BLE001 - skip unparseable direction dirs
            continue
        if not direction.id:
            continue

        existing = resolve_tracker_issue(direction, db)
        if existing:
            result.already_set += 1
            continue

        marker = _direction_marker(direction.id, direction.slug)
        matches = [num for num, body in bodies if marker in body]

        if not matches:
            result.not_found.append(direction.id)
            continue
        if len(matches) > 1:
            result.ambiguous.append((direction.id, sorted(matches)))
            continue

        number = matches[0]
        result.found.append((direction.id, number))
        if not dry_run:
            try:
                _persist(app_config.name, direction, number, db)
            except Exception as exc:  # noqa: BLE001 - one bad write must not abort the sweep
                result.errors.append((direction.id, str(exc)))

    return result


def _persist(app: str, direction: Any, number: int, db_path: Path) -> None:
    """Write *number* to the ``directions`` row for *direction*, creating the row
    if it doesn't exist yet — mirroring ``factory.directions.backfill.directions_backfill``'s
    disk → DB import so a direction with no row (never through ``mark_direction_status``)
    is not silently skipped.
    """
    from sqlmodel import Session, SQLModel, create_engine

    from factory.directions.backfill import (
        _resolve_created_at,
        _resolve_source,
        _resolve_updated_at,
        _resolve_updated_by,
    )
    from factory.directions.schema import DirectionRecord, get_direction
    from factory.observability.schema import migrate

    db_path.parent.mkdir(parents=True, exist_ok=True)
    migrate(db_path)
    engine = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        row = get_direction(session, app, direction.id)
        if row is not None:
            row.tracker_issue = number
            session.add(row)
            session.commit()
            return

        created_at = _resolve_created_at(direction.state)
        new_row = DirectionRecord(
            app=app,
            direction_id=direction.id,
            slug=direction.slug,
            status=direction.status,
            tracker_issue=number,
            source=_resolve_source(direction.state),
            created_at=created_at,
            updated_at=_resolve_updated_at(direction.state, fallback=created_at),
            updated_by=_resolve_updated_by(direction.state),
        )
        session.add(new_row)
        session.commit()
