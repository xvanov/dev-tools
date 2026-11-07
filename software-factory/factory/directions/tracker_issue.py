"""Direction Tracker GitHub issue — open/update + needs-direction comments.

The tracker is the *one issue per direction* the factory keeps current with
links to child stories, current status, and any blockers. Idempotent: the issue
number is recorded on the direction's ``directions`` ROW once the issue exists,
and subsequent calls update that issue in place.

The row — not the file — because ``apps/*/directions/*/state.yaml`` is gitignored
(D018). Every resolution here goes through :func:`resolve_tracker_issue`, which
is row-first and falls back to the ``state.yaml`` projection only for a direction
that has no row yet (hand-written between clones). Reading the file first was a
silent-no-op bug: on a fresh clone the number came back ``None``, so "close this
direction's issues" closed nothing and reported no error (trackers #156 / #159),
and "open or update the tracker" would have opened a DUPLICATE.

The ``github_client`` parameter is the ``pygithub.Github`` object (or a
duck-type mock for tests). We don't construct it here — the caller wires
authentication so the same client can be reused across calls.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from factory.app_config import AppConfig
from factory.directions.parser import Direction, MissingDirection, resolve_direction_chain
from factory.directions.schema import RESOLVED_DIRECTION_STATUSES
from factory.directions.watcher import _root_from_direction, merge_state

_TRACKER_LABEL = "direction-tracker"
_NEEDS_DIRECTION_LABEL = "needs-direction"


def _format_tracker_body(
    direction: Direction,
    *,
    pm_summary: str | None,
    child_issue_numbers: list[int],
    extra_sections: list[str] | None = None,
    direction_chain: list[Direction | MissingDirection] | None = None,
) -> str:
    parts: list[str] = []

    if direction_chain and len(direction_chain) > 1:
        chain_parts: list[str] = []
        for item in direction_chain:
            if isinstance(item, MissingDirection):
                chain_parts.append(f"`{item.id_slug}`")
            elif item.id_slug == direction.id_slug:
                chain_parts.append("**THIS**")
            else:
                tracker_num = item.state.get("tracker_issue") if item.state else None
                if isinstance(tracker_num, int) and tracker_num > 0:
                    chain_parts.append(f"`{item.id_slug}` #{tracker_num}")
                else:
                    chain_parts.append(f"`{item.id_slug}`")
        parts.append(f"**Chain:** {' ← '.join(chain_parts)}")
        parts.append("")

    parts.append(f"**Direction:** `{direction.id}-{direction.slug}`")
    parts.append(f"**App:** `{direction.app}`")
    if direction.type_tag:
        parts.append(f"**Type:** `{direction.type_tag}`")
    parts.append(f"**Status:** `{direction.status}`")
    parts.append("")
    if pm_summary:
        parts.append("## Summary")
        parts.append(pm_summary.strip())
        parts.append("")
    parts.append("## Child stories")
    if child_issue_numbers:
        for n in child_issue_numbers:
            parts.append(f"- #{n}")
    else:
        parts.append("_(no child stories yet)_")
    parts.append("")
    if extra_sections:
        for section in extra_sections:
            parts.append(section.rstrip())
            parts.append("")
    parts.append("---")
    parts.append("_This issue is maintained by the factory. Edits will be overwritten._")
    return "\n".join(parts)


def _build_labels(direction: Direction, pm_labels: list[str]) -> list[str]:
    labels = {_TRACKER_LABEL}
    if direction.type_tag:
        labels.add(direction.type_tag)
    for lbl in pm_labels:
        if lbl:
            labels.add(lbl)
    return sorted(labels)


def open_or_update_tracker_issue(
    direction: Direction,
    app_config: AppConfig,
    github_client: Any,
    *,
    pm_result: dict[str, Any] | None = None,
    child_issue_numbers: list[int] | None = None,
    software_factory_root: Path | None = None,
    extra_sections: list[str] | None = None,
) -> int:
    """Idempotently open or update the Direction Tracker issue.

    Returns the issue number. On first creation the number is persisted BOTH to
    the authoritative ``directions`` row and to the ``state.yaml`` projection;
    subsequent calls re-use it.

    Idempotency is the whole point of this function, and it used to rest solely
    on ``state.yaml`` — which D018 then gitignored. On a tree without the
    projection every call looked like a first call, so this would have opened a
    DUPLICATE tracker issue per direction per clone. Resolution is now
    row-first (:func:`resolve_tracker_issue`).
    """
    repo = github_client.get_repo(app_config.repo)
    pm_result = pm_result or {}
    child_issue_numbers = child_issue_numbers or []

    title = pm_result.get("tracker_title") or f"[DIRECTION] {direction.title}"
    if not title.startswith("[DIRECTION]"):
        title = f"[DIRECTION] {title}"
    if len(title) > 256:
        title = title[:253] + "..."

    pm_body = pm_result.get("tracker_body")
    pm_labels: list[str] = list(pm_result.get("labels") or [])
    priority = pm_result.get("priority")
    if priority and not any(lbl.startswith("priority/") for lbl in pm_labels):
        pm_labels.append(f"priority/{priority}")

    chain: list[Direction | MissingDirection] | None = None
    if software_factory_root is not None and direction.parent_direction:
        chain = resolve_direction_chain(direction, software_factory_root)

    body = _format_tracker_body(
        direction,
        pm_summary=pm_body,
        child_issue_numbers=child_issue_numbers,
        direction_chain=chain,
        extra_sections=extra_sections,
    )
    labels = _build_labels(direction, pm_labels)

    existing_number = resolve_tracker_issue(direction, _db_for_direction(direction))
    if existing_number:
        issue = repo.get_issue(existing_number)
        issue.edit(title=title, body=body, labels=labels)
        return existing_number

    issue = repo.create_issue(title=title, body=body, labels=labels)
    number = int(issue.number)
    _persist_tracker_issue(direction, number)
    # Best-effort, same as ``_persist_tracker_issue`` immediately above: the
    # GitHub issue already exists, so a state.yaml write failure (disk full,
    # permission error, a stale/removed dir_path) must never raise back into
    # the caller. An uncaught exception here used to abort the REST of this
    # direction's pm-sync iteration too — including the ``mark_direction_status``
    # call that is the ONLY other place a brand-new direction's row (and thus
    # its tracker_issue) gets written — leaving the real issue number recorded
    # NOWHERE in factory state. The next pm-sync pass would then resolve
    # ``existing_number`` as None and create a DUPLICATE issue. Swallowing here
    # keeps the number resolvable from ``state.yaml`` even when the DB row
    # doesn't exist yet, and — a level up — ``reconcile_completed_issues``/
    # ``directions-backfill-tracker-issue`` recover from a case where BOTH
    # writes were lost.
    try:
        merge_state(direction, {"tracker_issue": number})
    except Exception:  # noqa: BLE001 - bookkeeping must never fail issue creation
        pass
    return number


def _db_for_direction(direction: Direction) -> Path | None:
    """``state/factory.db`` for the repo owning *direction*, or ``None``.

    Derived from ``dir_path`` (``<root>/apps/<app>/directions/<id>-<slug>/``).
    Returns ``None`` rather than raising when the path is not that shape — every
    caller treats ``None`` as "no DB, use the projection".
    """
    try:
        return _root_from_direction(direction) / "state" / "factory.db"
    except Exception:  # noqa: BLE001 - an unusual dir_path must not raise
        return None


def _persist_tracker_issue(direction: Direction, number: int) -> None:
    """Record the tracker number on the AUTHORITATIVE ``directions`` row.

    Best-effort: this is bookkeeping, and the caller has already created the
    GitHub issue. Only ever fills in ``tracker_issue`` on an EXISTING row — it
    never inserts one and never touches ``status``, because ``direction.status``
    here comes from the projection and must not be allowed to overwrite the
    row's authoritative value.

    Needed because ``state.yaml`` is gitignored (D018): a number written only to
    the file is lost at the next clone, and then nothing can find — or avoid
    re-creating — the tracker issue.
    """
    db = _db_for_direction(direction)
    if db is None or not direction.id or not db.exists():
        # No DB ⇒ no row to update. Never CREATE one from here: ``dir_path`` is
        # caller-supplied and a relative/odd path would resolve to a wrong root,
        # scattering empty ``state/factory.db`` files around the filesystem.
        return
    try:
        from sqlmodel import Session

        from factory.directions.schema import get_direction
        from factory.directions.watcher import _engine

        with Session(_engine(db)) as session:
            row = get_direction(session, direction.app, direction.id)
            if row is None or row.tracker_issue == number:
                return
            row.tracker_issue = number
            session.add(row)
            session.commit()
    except Exception:  # noqa: BLE001 - bookkeeping must never fail issue creation
        pass


def record_needs_direction(
    direction: Direction,
    missing: list[str],
    app_config: AppConfig,
    github_client: Any,
    *,
    pm_result: dict[str, Any] | None = None,
    detail_lines: list[str] | None = None,
) -> int:
    """Open/update the tracker issue with the ``needs-direction`` label + comment.

    Direction status stays ``created`` / ``needs-direction`` so the watcher
    picks it up again after the user updates the on-disk direction.

    ``detail_lines`` (typically ``ValidationResult.issues``) is appended
    verbatim below the generic "Missing: ..." line. This is how the vacuity
    gate (019 AC1) gets the actual vacuous criteria text and a rewritten
    example onto the tracker comment, not just the bare ``vacuous_criteria``
    token in ``missing``.
    """
    pm_result = pm_result or {}
    extra_labels = list(pm_result.get("labels") or [])
    if _NEEDS_DIRECTION_LABEL not in extra_labels:
        extra_labels.append(_NEEDS_DIRECTION_LABEL)
    merged_pm = dict(pm_result)
    merged_pm["labels"] = extra_labels

    issue_number = open_or_update_tracker_issue(
        direction,
        app_config,
        github_client,
        pm_result=merged_pm,
        child_issue_numbers=[],
    )

    repo = github_client.get_repo(app_config.repo)
    issue = repo.get_issue(issue_number)
    missing_text = ", ".join(missing) if missing else "(unspecified)"
    comment_body = (
        f"**Needs direction.** Missing: {missing_text}.\n\n"
        "Add the missing artifact(s) (flow.md / api_spec.md / acceptance "
        "criteria) to the direction directory and the factory will re-validate "
        "on the next pm-sync."
    )
    if detail_lines:
        comment_body += "\n\n" + "\n".join(detail_lines)
    # Idempotent: re-validating an unchanged direction must not append the
    # same comment again — repeated pm-sync passes were spamming one
    # identical comment per pass onto every needs-direction tracker issue.
    if _last_comment_body(issue) != comment_body:
        issue.create_comment(comment_body)
    return issue_number


def _last_comment_body(issue: Any) -> str | None:
    """Best-effort body of the issue's most recent comment (None on failure)."""
    try:
        comments = issue.get_comments()
        total = getattr(comments, "totalCount", None)
        if total is None:
            seq = list(comments)
            return getattr(seq[-1], "body", None) if seq else None
        if total == 0:
            return None
        return getattr(comments[total - 1], "body", None)
    except Exception:  # noqa: BLE001 - never block the comment on a read error
        return None


def close_story_issue(
    story: Any,
    app_config: AppConfig,
    github_client: Any,
) -> bool:
    """Close a story's GitHub issue after it deploys. Idempotent, best-effort.

    The chain sets a deployed story's DB state but historically never closed
    its issue, so per-story ``story`` issues accumulated open forever (audit
    2026-07-18: 53 of them). Returns True if a close was attempted. Any GH
    error is swallowed — a bookkeeping close must never break the deploy path.
    """
    num = getattr(story, "github_issue_number", None)
    if not num:
        return False
    try:
        repo = github_client.get_repo(app_config.repo)
        issue = repo.get_issue(int(num))
        if str(getattr(issue, "state", "")).lower() == "closed":
            return False
        issue.create_comment(
            "✅ Deployed — closing automatically (story reached DEPLOYED in the chain)."
        )
        issue.edit(state="closed")
        return True
    except Exception:  # noqa: BLE001 - never break deploy on a bookkeeping close
        return False


def _close_issue_if_open(
    repo: Any,
    number: int,
    comment: str,
    *,
    state_reason: str | None = None,
) -> bool:
    """Close issue *number* if it is currently open. Returns True on close.

    Raises whatever the GitHub client raises — every caller decides how to
    record the failure. An already-closed issue is never re-edited (idempotent).
    """
    issue = repo.get_issue(int(number))
    if str(getattr(issue, "state", "")).lower() == "closed":
        return False
    issue.create_comment(comment)
    if state_reason is None:
        issue.edit(state="closed")
    else:
        issue.edit(state="closed", state_reason=state_reason)
    return True


def _tracker_from_state(direction: Direction) -> int | None:
    """Tracker-issue number as recorded in the ``state.yaml`` PROJECTION."""
    raw = (direction.state or {}).get("tracker_issue")
    if isinstance(raw, int) and raw > 0:
        return raw
    return None


def resolve_tracker_issue(direction: Direction, db_path: Path | None) -> int | None:
    """Tracker-issue number for *direction*, resolved DB-row-first.

    Precedence mirrors ``watcher._resolve_status`` — the ``directions`` row is
    authoritative, the on-disk ``state.yaml`` is a projection:

    1. ``directions.tracker_issue`` for this ``(app, direction_id)``
    2. ``state.yaml::tracker_issue`` (a direction hand-written between clones has
       no row yet, and must still work)
    3. ``None``

    Reading only the file was the second half of the D018 compose-bug: D018
    gitignored ``state.yaml``, so on a fresh clone there is no file, the number
    came back ``None``, and every "close this direction's issues" path became a
    silent no-op — no error, nothing in the report, the tracker just stayed open
    (observed live on trackers #156 and #159).

    Never raises, and never CREATES a database: a missing/locked/corrupt DB simply
    falls through to the file.
    """
    if db_path is not None and direction.id and Path(db_path).exists():
        try:
            from sqlmodel import Session

            from factory.directions.schema import get_direction
            from factory.directions.watcher import _engine

            with Session(_engine(Path(db_path))) as session:
                row = get_direction(session, direction.app, direction.id)
            if row is not None and row.tracker_issue and int(row.tracker_issue) > 0:
                return int(row.tracker_issue)
        except Exception:  # noqa: BLE001 - a bad DB must fall back, never raise
            pass
    return _tracker_from_state(direction)


def _child_story_issues(app: str, direction_id: str, db_path: Path) -> list[tuple[str, int]]:
    """Return ``(story key, github issue number)`` for every child story of a direction."""
    from sqlmodel import Session, select

    from factory.chain.state_machine import StoryRecord
    from factory.runner import _engine

    with Session(_engine(db_path)) as session:
        rows = list(
            session.exec(
                select(StoryRecord).where(
                    StoryRecord.app == app,
                    StoryRecord.direction_id == direction_id,
                )
            ).all()
        )
    out: list[tuple[str, int]] = []
    for r in rows:
        num = getattr(r, "github_issue_number", None)
        if num:
            out.append((r.slug or str(r.id), int(num)))
    return out


def _direction_closed_comments(direction_id: str, by: str | None, reason: str | None) -> str:
    """Shared explanatory suffix for a "direction was closed" issue comment."""
    who = f" by `{by}`" if by else ""
    why = f" (reason: `{reason}`)" if reason else ""
    return f"direction `{direction_id}` was closed{who}{why}"


def close_direction_issues(
    direction: Direction,
    app_config: AppConfig,
    github_client: Any,
    *,
    db_path: Path | None = None,
    software_factory_root: Path | None = None,
    by: str | None = None,
    reason: str | None = None,
    tracker_comment: str | None = None,
    story_comment: str | None = None,
    state_reason: str | None = "not_planned",
) -> dict[str, Any]:
    """Close a closed direction's tracker issue AND every child story issue.

    The single remediation used by every "this direction is finished/abandoned"
    path: :func:`factory.directions.watcher.mark_direction_status`, the
    scheduled-direction GC, and the ``reconcile-issues`` backfill.

    **Best-effort by contract — never raises.** Callers reach here *after* the
    authoritative status write has been committed, so a GitHub outage, a missing
    token, a 404 or a rate-limit must not undo (or abort) the transition. Every
    failure is recorded in the returned report instead:
    ``{"tracker_closed", "stories_closed", "errors"}``. Anything missed here is
    swept up by :func:`reconcile_completed_issues`, which closes issues for any
    direction already in a resolved status.
    """
    report: dict[str, Any] = {"tracker_closed": None, "stories_closed": [], "errors": []}
    if github_client is None or app_config is None:
        return report

    try:
        repo = github_client.get_repo(app_config.repo)
    except Exception as exc:  # noqa: BLE001 - a bad client must never raise at callers
        report["errors"].append(("repo", getattr(app_config, "repo", "?"), str(exc)))
        return report

    context = _direction_closed_comments(direction.id, by, reason)
    tracker_body = tracker_comment or (
        f"🚪 Closing the direction tracker automatically — {context}. "
        "Any still-open child story issues are being closed too."
    )
    story_body = story_comment or (
        f"🚪 Closing this story issue automatically — its parent {context}. "
        "Re-file the direction to resume the work."
    )

    # Resolve the DB path FIRST: it is what makes the tracker number resolvable
    # from the authoritative row rather than only from the gitignored projection.
    db: Path | None
    try:
        if db_path is not None:
            db = Path(db_path)
        else:
            root = (
                Path(software_factory_root)
                if software_factory_root is not None
                else _root_from_direction(direction)
            )
            db = root / "state" / "factory.db"
    except Exception as exc:  # noqa: BLE001 - an underivable root must not raise
        report["errors"].append(("db", str(db_path or ""), str(exc)))
        db = None

    tracker = resolve_tracker_issue(direction, db)
    if tracker:
        try:
            if _close_issue_if_open(repo, tracker, tracker_body, state_reason=state_reason):
                report["tracker_closed"] = int(tracker)
        except Exception as exc:  # noqa: BLE001 - one bad issue must not abort the rest
            report["errors"].append(("tracker", tracker, str(exc)))

    if not direction.id or db is None:
        return report

    try:
        children = _child_story_issues(direction.app, direction.id, db)
    except Exception as exc:  # noqa: BLE001 - a bad DB must not raise, tracker is already closed
        report["errors"].append(("db", str(db_path or ""), str(exc)))
        return report

    for key, num in children:
        try:
            if _close_issue_if_open(repo, num, story_body, state_reason=state_reason):
                report["stories_closed"].append((key, num))
        except Exception as exc:  # noqa: BLE001 - one bad issue must not abort the sweep
            report["errors"].append(("story", num, str(exc)))

    return report


# Story states that RESOLVE a child story for the purpose of closing a
# direction tracker. Deliberately an explicit allowlist (not ``is_terminal``):
#   DEPLOYED             = shipped;
#   SUPERSEDED_BY_SIBLING = the dual-draft loser (never ships, by design);
#   "closed"             = a regime-invalidated / abandoned story row.
# Everything else keeps the tracker OPEN — including ``BLOCKED_*`` (needs a
# human) AND states like ``CI_PENDING`` that are "terminal-by-omission" in the
# state machine (the auto-merge poller drives ``ci_pending -> ci_green`` by
# direct assignment, not a ``_TRANSITIONS`` edge, so ``is_terminal(ci_pending)``
# is wrongly True). Using an allowlist means a story mid-CI can never be
# mistaken for resolved — the fail-safe direction.
# ``blocked_ci_unresolved`` is the one BLOCKED_* state that IS resolved for
# issue-closing: the auto-merge worker only parks a story there AFTER closing its
# PR (CI-recovery exhausted, app-blocked). The work is terminally done for this
# attempt — the tracker issue should close, not linger. Every OTHER BLOCKED_*
# state stays absent (it may still be fixed and merged), preserving the fail-safe.
_RESOLVED_STORY_STATES = frozenset(
    {
        "deployed",
        "superseded_by_sibling",
        "closed",
        # An operator-closed story is resolved BY DEFINITION — its tracker issue
        # is what the operator closed to put it here.
        "closed_by_operator",
        "blocked_ci_unresolved",
        # A dependency-deadlocked story is terminally abandoned (its foundation
        # will never deploy), so its tracker issue should close rather than
        # linger — same resolved-terminal rationale as blocked_ci_unresolved.
        "blocked_dependency_unmet",
        # A poisoned row quarantined by the operational reconciler (its ``state``
        # was an invalid enum) is terminally parked and will never deploy — same
        # resolved-terminal rationale as the two above, so its tracker closes.
        "quarantined_invalid_state",
    }
)


def _story_is_resolved(row: Any) -> bool:
    """Is this story row settled, for issue/tracker-closing purposes?

    ``state in _RESOLVED_STORY_STATES`` with ONE carve-out: a story parked by the
    dependency-deferral CAP. It lands in ``blocked_dependency_unmet``, but unlike
    the DEADLOCK park that sink was built for, its blockers are only HUMAN-blocked
    and may still be revived — the dependent is awaiting an operator DECISION, and
    is listed as such in ``factory inbox``. Treating it as resolved would (a) close
    its story issue with "🛑 Terminally abandoned", (b) let ``_direction_is_complete``
    declare the direction finished over never-built work, and (c) put the inbox and
    GitHub into permanent disagreement — the exact invariant the inbox's
    resolved-states reuse exists to preserve.
    """
    from factory.chain.state_machine import is_dependency_cap_parked

    if is_dependency_cap_parked(
        getattr(row, "state", None), getattr(row, "last_rejection_reason", None)
    ):
        return False
    return (getattr(row, "state", "") or "") in _RESOLVED_STORY_STATES


# Delivery-level end states (``StoryState.DELIVERED_*``). NOT resolved for a
# STORY issue — the change is not on the default branch, so the story issue
# stays open as the human's handle on it — but a direction whose every child is
# resolved OR delivered has nothing left for the factory to do: the job ran to
# the level it asked for. Kept separate from ``_RESOLVED_STORY_STATES`` so no
# issue-closing / inbox / dependency consumer of that set changes meaning.
_DELIVERED_STORY_STATES = frozenset({"delivered_local", "delivered_branch", "delivered_pr"})


def _direction_is_complete(rows: list[Any]) -> bool:
    """True when EVERY child story is in a resolved state — nothing is left to do
    on this direction, whether it SHIPPED or was fully ABANDONED.

    Closes on two shapes:
      * **shipped** — a winner ``DEPLOYED`` (+ any dual-draft loser
        ``SUPERSEDED_BY_SIBLING``); the historical case.
      * **abandoned** — no child deployed, but every child reached a definitively
        terminal sink (``blocked_ci_unresolved`` / ``blocked_dependency_unmet`` /
        ``superseded_by_sibling`` / ``closed``). The direction produced nothing
        and never will, so its tracker should close rather than leak open forever
        (the stories are surfaced to the FMS via ``_terminally_blocked_stories``
        for a bounded recency window and remain in the DB/event log after; closing
        the tracker is reversible — reopen if a total failure warrants a look).

    The predicate is ``all children ∈ _RESOLVED_STORY_STATES``. It deliberately
    does NOT require a ``DEPLOYED`` child anymore — that requirement kept
    all-abandoned directions' trackers open indefinitely (observed 2026-07-23:
    the app-blocked D093/D096/D097/D099 cluster). Mid-flight protection is intact:
    ``_RESOLVED_STORY_STATES`` excludes every in-flight state (``pr_open`` /
    ``ci_pending`` / ``ready_for_merge`` / …) AND the recoverable-pending-human
    blocks (``blocked_deploy_failed`` / ``blocked_tests_need_clarification`` /
    ``blocked_budget_exceeded``), so any of those keeps the tracker open — a
    direction still doing (or revivable) work is never closed.

    **delivered** (2026-11-02, finding 10) — a child in a ``delivered_*`` end
    state (delivery level below ``auto_merge``) counts as complete for the
    DIRECTION: the factory took it as far as the job asked. Without this a
    direction below ``auto_merge`` could never complete, so its job never
    reached a terminal state. The story issues themselves stay open.
    """
    if not rows:
        return False
    return all(
        _story_is_resolved(r) or (getattr(r, "state", "") or "") in _DELIVERED_STORY_STATES
        for r in rows
    )


def maybe_close_tracker_issue(
    direction_id: str,
    app_config: AppConfig,
    github_client: Any,
    *,
    software_factory_root: Path,
    db_path: Path | None = None,
) -> bool:
    """Close a direction's tracker issue once the direction is complete.

    Resolves the tracker number row-first via :func:`resolve_tracker_issue`
    (``state.yaml`` is only the fallback) and checks the ``stories`` table via
    :func:`_direction_is_complete`: the tracker closes
    when at least one child story DEPLOYED and every child is resolved
    (deployed / superseded / invalidated), never while active or ``BLOCKED_*``
    work remains. Best-effort; returns True on close.
    """
    try:
        from sqlmodel import Session, select

        from factory.chain.state_machine import StoryRecord, StoryState
        from factory.directions.parser import parse_direction_dir
        from factory.runner import _engine

        root = Path(software_factory_root)
        # Locate the direction dir + its tracker issue number.
        dirs = list((root / "apps" / app_config.name / "directions").glob(f"{direction_id}-*"))
        if not dirs:
            return False
        direction = parse_direction_dir(app_config.name, dirs[0], software_factory_root=root)
        db = db_path or (root / "state" / "factory.db")
        # DB row first, gitignored ``state.yaml`` projection second — see
        # ``resolve_tracker_issue``.
        tracker = resolve_tracker_issue(direction, db)
        if not tracker:
            return False
        with Session(_engine(db)) as session:
            rows = session.exec(
                select(StoryRecord).where(
                    StoryRecord.direction_id == direction_id,
                    StoryRecord.app == app_config.name,
                )
            ).all()
        if not _direction_is_complete(rows):
            return False  # still active (or blocked) work for this direction

        deployed = sum(1 for r in rows if r.state == StoryState.DEPLOYED.value)
        delivered = sum(1 for r in rows if r.state in _DELIVERED_STORY_STATES)
        repo = github_client.get_repo(app_config.repo)
        issue = repo.get_issue(int(tracker))
        if str(getattr(issue, "state", "")).lower() == "closed":
            return False
        issue.create_comment(
            f"✅ Direction complete — {deployed} of {len(rows)} child stories deployed"
            + (
                f", {delivered} delivered at their job's level (not merged — see each story issue)"
                if delivered
                else ""
            )
            + " (remaining resolved/superseded). Closing the direction tracker."
        )
        issue.edit(state="closed")
        return True
    except Exception:  # noqa: BLE001
        return False


def reconcile_completed_issues(
    app_config: AppConfig,
    github_client: Any,
    *,
    software_factory_root: Path,
    db_path: Path | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Backfill the GitHub-issue lifecycle: close issues left open for completed work.

    Idempotent + fail-safe (never raises). This is the "detect-and-remediate"
    safety net for issue-lifecycle drift — the event-driven close on deploy can
    no-op (e.g. a merge that lands via the async ``--auto`` path with no token
    in scope), leaving completed directions/stories with open trackers/issues.
    Running this reconciles that state and is safe to run repeatedly / on a
    schedule.

    Two passes, both scoped to ``app_config.name``:
      1. Direction trackers — close the tracker of every direction that is
         either
           * **resolved by status** — its status is in
             ``RESOLVED_DIRECTION_STATUSES`` (an operator/GC ``closed``
             direction). Its child story issues are closed too, whatever state
             those stories are in: the direction is closed, so no child will
             ever ship. This is the operator-close leak (D015/D016/D017,
             2026-07-28) — closing the direction never closed its issues, and
             ``_direction_is_complete`` can never fire for it because its
             children are parked mid-flight (or it has no children at all).
           * or **complete by children** per :func:`_direction_is_complete`
             (winner deployed, no active/blocked child work).
      2. Story issues — close the issue of every story in a resolved-shipped
         state (``DEPLOYED`` or ``SUPERSEDED_BY_SIBLING``) whose issue is still
         open.

    An already-closed issue is never touched (state is checked first). Returns a
    report: ``{"trackers_closed", "stories_closed", "would_close", "errors"}``.
    """
    from collections import defaultdict

    report: dict[str, Any] = {
        "trackers_closed": [],
        "stories_closed": [],
        "would_close": [],
        "errors": [],
    }

    # Load story rows for this app. The DB read (missing / locked / corrupt
    # ``factory.db``) must NOT raise — this function's contract is fail-safe so
    # it can be run on a schedule / on the tick path without breaking it.
    try:
        from sqlmodel import Session, select

        from factory.chain.state_machine import StoryRecord, StoryState
        from factory.directions.parser import parse_direction_dir
        from factory.directions.schema import list_directions
        from factory.runner import _engine

        root = Path(software_factory_root)
        db = db_path or (root / "state" / "factory.db")
        with Session(_engine(db)) as session:
            story_rows = list(
                session.exec(select(StoryRecord).where(StoryRecord.app == app_config.name)).all()
            )
            # Authoritative direction rows: the ``directions`` table wins over the
            # ``state.yaml`` projection for BOTH facts this sweep needs — the
            # status AND the tracker-issue number. Reading the tracker number from
            # the file was the live bug: D018 gitignored ``state.yaml``, so on a
            # normal (fresh-clone) tree there is no file, the number resolved to
            # ``None``, and a genuinely ``closed`` direction's tracker was never
            # closed — silently, with an empty ``errors`` list.
            direction_rows = list_directions(session, app_config.name)
            direction_status: dict[str, str] = {r.direction_id: r.status for r in direction_rows}
            direction_tracker: dict[str, int] = {
                r.direction_id: int(r.tracker_issue)
                for r in direction_rows
                if r.tracker_issue and int(r.tracker_issue) > 0
            }
    except Exception as exc:  # noqa: BLE001 - a bad DB must not break the sweep
        # FAIL SAFE: without the DB we cannot tell resolved work from in-flight
        # work, so we close NOTHING rather than guess from state.yaml alone.
        report["errors"].append(("db", str(db_path or "state/factory.db"), str(exc)))
        return report

    by_direction: dict[str, list[Any]] = defaultdict(list)
    for r in story_rows:
        by_direction[r.direction_id].append(r)

    try:
        repo = github_client.get_repo(app_config.repo)
    except Exception as exc:  # noqa: BLE001 - a bad client must not raise
        report["errors"].append(("repo", app_config.repo, str(exc)))
        return report

    def _close_if_open(
        kind: str,
        number: Any,
        comment: str,
        key: str,
        *,
        state_reason: str | None = None,
    ) -> bool:
        """Close one issue if currently open. Records the action in ``report``."""
        try:
            if dry_run:
                issue = repo.get_issue(int(number))
                if str(getattr(issue, "state", "")).lower() == "closed":
                    return False
                report["would_close"].append((kind, int(number), key))
                return True
            return _close_issue_if_open(repo, int(number), comment, state_reason=state_reason)
        except Exception as exc:  # noqa: BLE001 - one bad issue must not abort the sweep
            report["errors"].append((kind, number, str(exc)))
            return False

    # Pass 1 — direction trackers.
    directions_root = root / "apps" / app_config.name / "directions"
    for d in sorted(p for p in directions_root.glob("*") if p.is_dir()):
        direction_id = d.name.split("-", 1)[0]
        try:
            direction = parse_direction_dir(app_config.name, d, software_factory_root=root)
        except Exception:  # noqa: BLE001 - skip unparseable direction dirs
            continue
        tracker = direction_tracker.get(direction_id) or _tracker_from_state(direction)
        rows = by_direction.get(direction_id, [])

        # Two independent reasons a tracker may close. The DB row wins over the
        # ``state.yaml`` projection (watcher._resolve_status precedence); an
        # unknown/unparseable status is NOT in the allowlist, which leaves every
        # issue open — the fail-safe direction.
        status = direction_status.get(direction_id) or (direction.status or "")
        closed_by_status = status in RESOLVED_DIRECTION_STATUSES
        complete_by_children = _direction_is_complete(rows)
        if not (closed_by_status or complete_by_children):
            continue

        if complete_by_children:
            deployed = sum(1 for r in rows if r.state == StoryState.DEPLOYED.value)
            delivered = sum(1 for r in rows if r.state in _DELIVERED_STORY_STATES)
            tracker_comment = (
                f"✅ Direction complete — {deployed} of {len(rows)} child stories deployed"
                + (
                    f", {delivered} delivered at their job's level (not merged — see each "
                    "story issue)"
                    if delivered
                    else ""
                )
                + " (remaining resolved/superseded). Closing the direction tracker (reconcile)."
            )
            tracker_reason = None
        else:
            tracker_comment = (
                f"🚪 Direction closed (status `{status}`) — closing the direction tracker "
                "and any open child story issues (reconcile)."
            )
            tracker_reason = "not_planned"

        if tracker and (
            _close_if_open(
                "tracker", tracker, tracker_comment, direction_id, state_reason=tracker_reason
            )
            and not dry_run
        ):
            report["trackers_closed"].append((direction_id, int(tracker)))

        if not closed_by_status:
            continue

        # The direction itself is closed, so its child stories will never ship —
        # close their issues too, INCLUDING stories parked in a state that is
        # deliberately absent from ``_RESOLVED_STORY_STATES`` (D015/D016 sat in
        # ``blocked_deploy_failed``, a recoverable-pending-human block, which is
        # exactly why pass 2 could never reach them). Stories that ARE resolved
        # are left to pass 2, which words their close precisely
        # (deployed / superseded / abandoned) — the two sets are disjoint, so no
        # issue is handled or reported twice.
        for r in rows:
            num = getattr(r, "github_issue_number", None)
            if not num or _story_is_resolved(r):
                continue
            comment = (
                f"🚪 Parent direction closed (status `{status}`) — closing this story issue "
                "(reconcile). Re-file the direction to resume the work."
            )
            if (
                _close_if_open(
                    "story", num, comment, r.slug or str(r.id), state_reason="not_planned"
                )
                and not dry_run
            ):
                report["stories_closed"].append((r.id, int(num)))

    # Pass 2 — story issues for RESOLVED stories: shipped (deployed / superseded)
    # OR terminally abandoned (blocked_ci_unresolved / blocked_dependency_unmet).
    # Uses the same _RESOLVED_STORY_STATES allowlist as _direction_is_complete, so
    # an abandoned story's own tracker closes rather than lingering after its
    # PR/direction is already gone (the 8 orphaned per-story sub-issues observed
    # 2026-07-23). A story in ANY non-resolved state — in-flight or a
    # recoverable-pending-human block — keeps its issue open.
    _abandoned = {
        StoryState.BLOCKED_CI_UNRESOLVED.value,
        StoryState.BLOCKED_DEPENDENCY_UNMET.value,
    }
    for r in story_rows:
        num = getattr(r, "github_issue_number", None)
        if not num or not _story_is_resolved(r):
            continue
        if r.state == StoryState.DEPLOYED.value:
            comment = "✅ Deployed — closing automatically (reconcile: story reached DEPLOYED)."
        elif r.state == StoryState.SUPERSEDED_BY_SIBLING.value:
            comment = "🔁 Superseded by a sibling draft — closing automatically (reconcile)."
        elif r.state in _abandoned:
            comment = (
                "🛑 Terminally abandoned (CI-recovery exhausted / dependency-deadlocked) "
                "— closing the story issue (reconcile). Re-file the direction to retry."
            )
        else:  # "closed" / invalidated
            comment = "Closing resolved story issue (reconcile)."
        if _close_if_open("story", num, comment, r.slug or str(r.id)) and not dry_run:
            report["stories_closed"].append((r.id, int(num)))

    return report
