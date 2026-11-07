"""Garbage-collect stale scheduled-persona directions nobody is acting on.

Directions filed by the scheduled personas (security/ux_auditor —
``source`` starting with ``scheduled-``) sometimes fail the
backpressure gate and sit at ``status: needs-direction`` forever: nobody is
watching for an operator to flesh them out, so the normal
``needs-direction`` re-check (which is operator-triggered, see
``factory.chain.pm_sync.pm_sync``'s ``pending_statuses`` docstring) never
arrives. The tracker issue GitHub opened for the direction also never
closes, so these accumulate as an ever-growing pile of stale open issues
(audit 2026-07-18, leak 2 of 4).

This module adds a conservative GC pass: a direction is only auto-closed
when it was filed by a *scheduler* persona (never ``github_issue``,
``operator``, ``user``, or a direction with no recorded source) AND it has
sat unactioned for a long time (either many consecutive
``needs-direction`` audit entries, or a long wall-clock age). Everything
else is left alone — this is a safety net for abandoned scheduler noise,
not a general-purpose direction sweeper.

Since 2026-07-30 the same net also covers the other place scheduler noise
can rot: a direction parked at ``status: created`` by the operator-approval
gate (``factory.directions.approval``) that nobody ever approved or
rejected. Same conservative threshold (14 days), same scheduler-source-only
rule.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from factory.directions.approval import awaiting_operator_approval
from factory.directions.parser import Direction, list_direction_dirs, parse_direction_dir
from factory.directions.watcher import mark_direction_status

# Only directions filed by a scheduled persona are GC-eligible. Anything
# filed by a human (operator/user) or ingested from a real GitHub issue
# must NEVER be auto-closed here.
_SCHEDULED_SOURCE_PREFIX = "scheduled-"

# Threshold policy (either condition is sufficient):
#   * >= this many CONSECUTIVE "status -> needs-direction" audit entries
#     with no other status transition in between, or
#   * older than this many days since ``created_at``.
MIN_CONSECUTIVE_NEEDS_DIRECTION_ENTRIES = 5
MAX_AGE_DAYS = 14

GC_BY = "factory.directions.gc"
GC_REASON = "stale-scheduled-unactioned"


def _consecutive_needs_direction_count(direction: Direction) -> int:
    """Count trailing ``status -> needs-direction`` audit entries.

    Walks the audit trail backwards from the most recent entry, counting
    while the event is ``status -> needs-direction``; stops at the first
    entry that transitioned to a different status (or at the start of the
    list). A direction that has bounced back to ``needs-direction``
    multiple times in a row without ever being re-validated is exactly the
    "nobody is looking at this" signal the GC threshold targets.
    """
    audit = (direction.state or {}).get("audit") or []
    if not isinstance(audit, list):
        return 0
    count = 0
    for entry in reversed(audit):
        if not isinstance(entry, dict):
            continue
        event = str(entry.get("event", ""))
        if event == "status -> needs-direction":
            count += 1
        else:
            break
    return count


def _direction_age_days(direction: Direction, now: datetime) -> float | None:
    """Age in days from ``state.yaml``'s ``created_at``, or ``None`` if absent/unparseable."""
    created_at = (direction.state or {}).get("created_at")
    if not created_at:
        return None
    try:
        created = datetime.fromisoformat(str(created_at))
    except ValueError:
        return None
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    return (now - created).total_seconds() / 86400.0


def is_gc_eligible(direction: Direction, *, now: datetime) -> bool:
    """Pure decision function — no I/O, no ``datetime.now()`` call.

    ``now`` is required (not defaulted) so tests can drive the age
    threshold deterministically. Returns True in either of two cases, both
    requiring a ``scheduled-`` source:

      * ``status == "needs-direction"`` and it has been stuck long enough:
        >= 5 consecutive needs-direction audit entries, OR age > 14 days.
      * ``status == "created"``, it is parked at the operator-approval gate
        (see ``factory.directions.approval``) and unapproved, AND age > 14
        days. Without this, every scheduled-persona direction an operator
        never got round to approving or rejecting would sit in
        ``factory inbox`` forever — detect-without-remediate, just with a
        cheaper failure mode than the treadmill it replaced. A re-filed
        finding still recurs (the persona's own dedup only skips
        non-terminal directions), which is the desired behaviour: a real
        problem comes back, an ignored nag does not accumulate.
    """
    source = str((direction.state or {}).get("source") or "")
    if not source.startswith(_SCHEDULED_SOURCE_PREFIX):
        return False

    age_days = _direction_age_days(direction, now)

    if direction.status == "created":
        if not awaiting_operator_approval(direction):
            return False
        return age_days is not None and age_days > MAX_AGE_DAYS

    if direction.status != "needs-direction":
        return False
    if _consecutive_needs_direction_count(direction) >= MIN_CONSECUTIVE_NEEDS_DIRECTION_ENTRIES:
        return True
    if age_days is not None and age_days > MAX_AGE_DAYS:
        return True
    return False


def gc_stale_scheduled_directions(
    app: str,
    software_factory_root: Path,
    app_config: Any,
    github_client: Any,
    *,
    dry_run: bool = False,
    now: datetime | None = None,
) -> list[str]:
    """Close stale scheduled-persona directions nobody is acting on.

    Scans ``apps/<app>/directions/`` for directions passing
    ``is_gc_eligible``: sets ``status: closed`` on disk (with an audit
    entry from ``GC_BY`` / reason ``GC_REASON``) and, when not
    ``dry_run`` and a ``github_client`` is available, closes the
    direction's tracker issue on GitHub with reason "not planned" plus an
    explanatory comment. Best-effort: a GitHub failure never blocks the
    on-disk close. Returns the list of closed direction ids.
    """
    root = Path(software_factory_root)
    resolved_now = now or datetime.now(UTC)
    closed: list[str] = []

    for dir_path in list_direction_dirs(app, root):
        try:
            direction = parse_direction_dir(app, dir_path, software_factory_root=root)
        except Exception:  # noqa: BLE001 - a malformed sibling must never block the pass
            continue
        if not is_gc_eligible(direction, now=resolved_now):
            continue

        # Captured BEFORE the close, so the GitHub comment below names the
        # status the direction rotted at rather than "closed".
        prior_status = direction.status

        # Dry-run is a pure preview: report which directions WOULD be closed
        # (via the returned list) without mutating any state.yaml on disk.
        if not dry_run:
            mark_direction_status(
                direction,
                "closed",
                by=GC_BY,
                details={"reason": GC_REASON},
            )

        if not dry_run and github_client is not None and app_config is not None:
            # Shared remediation for every "direction is finished/abandoned"
            # path: closes the tracker issue AND any child story issue. It never
            # raises (the on-disk close above is already committed), which is the
            # long-standing contract here — bookkeeping must not break the pass.
            #
            # ``prior_status`` (not a hardcoded state) because this pass now reaps
            # two shapes: a scheduled direction stuck at ``needs-direction`` AND one
            # parked at ``created`` awaiting operator approval. Naming the wrong one
            # in the closing comment would mislead whoever reads the issue later.
            try:
                from factory.directions.tracker_issue import close_direction_issues

                close_direction_issues(
                    direction,
                    app_config,
                    github_client,
                    software_factory_root=root,
                    by=GC_BY,
                    reason=GC_REASON,
                    tracker_comment=(
                        "Closing automatically — this direction was filed by a "
                        f"scheduled persona and sat at `{prior_status}` with no "
                        "operator follow-up past the garbage-collection "
                        f"threshold ({GC_REASON})."
                    ),
                )
            except Exception:  # noqa: BLE001 - bookkeeping must never break the GC pass
                pass

        closed.append(direction.id or direction.slug)

    return closed
