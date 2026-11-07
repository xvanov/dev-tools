"""``factory job status | list | cancel`` — a job's state, from the real artifacts.

Read paths are READ-ONLY: the sqlite DB is opened ``mode=ro`` (a status call
must never create or migrate the live DB), and PR state / merged come from
GitHub via :mod:`factory.jobs.github`. When ``gh`` fails the job is reported
from the local view and ``why`` says so.

State mapping (docs/JOBS-API.md), first match wins:

* ``cancelled`` — ``factory job cancel`` ran AND no story is still live.
* no stories yet: direction ``created`` → ``queued`` (or ``needs_human`` when
  the approval gate parks it); ``pm-validated`` → ``triaging``;
  ``needs-direction`` → ``needs_human``; ``closed`` → ``failed``.
* every story finished successfully → ``done`` — but only when GitHub
  CONFIRMED it; a delivery only the local view claims stays ``in_progress``
  with a ``why``. "Finished" is read from the story ITSELF (the chain stamps
  ``StoryRecord.delivery_level`` at spawn and ends each story in its level's
  end state), never recomputed from today's app config:

  - ``delivered_pr`` → its PR is open or merged on GitHub;
  - ``delivered_branch`` → its branch exists on GitHub;
  - ``delivered_local`` → nothing to confirm remotely (level ``none``);
  - ``deploy_pending`` / ``deployed`` → merged: the PR is MERGED on GitHub,
    or, for ``push_to_main`` (no PR), the default branch on GitHub contains
    the fast-forwarded commit. A local flag alone is never ``done``.
* any story waiting on a human (the orchestrator's pending-human sinks, or a
  dependency-cap park) → ``needs_human``.
* any story still live → ``in_progress``, or ``blocked`` when the factory is
  halted / paused or every live story is waiting on a dependency.
* otherwise (everything terminal, something undelivered) → ``failed``.

Dual-draft losers (``superseded_by_sibling``) are ignored: only one of the two
interpretations is meant to ship.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from factory.app_config import AppConfig, load_app_config
from factory.chain.orchestrator import _PENDING_HUMAN_STATES
from factory.chain.state_machine import (
    DELIVERED_UNMERGED_STATES,
    StoryState,
    is_dependency_cap_parked,
    is_terminal,
)
from factory.delivery import DeliveryLevel, effective_level, parse_level
from factory.directions.approval import (
    approval_blocked_reason,
    awaiting_operator_approval,
)
from factory.jobs.common import (
    JobError,
    JobRef,
    find_job,
    iter_jobs,
    read_state_yaml,
    state_db_path,
)
from factory.jobs.github import GitHubCache, GitHubView, PRInfo
from factory.jobs.submit import effective_pipeline

JOB_STATES: tuple[str, ...] = (
    "queued",
    "triaging",
    "in_progress",
    "blocked",
    "needs_human",
    "done",
    "failed",
    "cancelled",
)
TERMINAL_JOB_STATES: frozenset[str] = frozenset({"done", "failed", "cancelled"})

# How long a delivered job stays ``in_progress`` waiting for its PR's CI.
CI_WAIT_S = 2 * 60 * 60

#: ``state.yaml`` key ``factory job cancel`` writes.
CANCEL_KEY = "job_cancelled"

_S = StoryState
#: Stories waiting on a human = the orchestrator's pending-human sinks MINUS
#: the delivery end states. Derived, not hand-copied (finding 1, 2026-11-02:
#: the hand-copied list went stale the moment ``delivered_*`` joined the
#: orchestrator's set). For the CHAIN a delivered story awaits a human merge;
#: for the JOB it is SUCCESS — the job asked for exactly that end state.
HUMAN_STATES: frozenset[str] = frozenset(_PENDING_HUMAN_STATES - DELIVERED_UNMERGED_STATES)
#: Terminal sinks that mean "this story will not deliver".
FAILED_STATES: frozenset[str] = frozenset(
    {
        _S.BLOCKED_CI_UNRESOLVED.value,
        _S.BLOCKED_DEPENDENCY_UNMET.value,  # deadlock park; cap park is human
        _S.QUARANTINED_INVALID_STATE.value,
        _S.CLOSED_BY_OPERATOR.value,
    }
)
IGNORED_STATES: frozenset[str] = frozenset({_S.SUPERSEDED_BY_SIBLING.value})
#: Local evidence that a merge happened. Never sufficient for ``done`` alone.
LOCAL_MERGED_STATES: frozenset[str] = frozenset({_S.DEPLOY_PENDING.value, _S.DEPLOYED.value})
#: Finished work that ``factory job cancel`` must leave alone (finding 6).
CANCEL_PROTECTED_STATES: frozenset[str] = LOCAL_MERGED_STATES | DELIVERED_UNMERGED_STATES
#: Local evidence that a PR exists.
LOCAL_PR_STATES: frozenset[str] = frozenset(
    {
        _S.PR_OPEN.value,
        _S.CI_PENDING.value,
        _S.CI_GREEN.value,
        _S.READY_FOR_MERGE.value,
    }
    | LOCAL_MERGED_STATES
)


#: Where a ``draft_pr`` / ``pr`` story waits while its PR's CI is watched.
_WATCHED_PR_STATES: frozenset[str] = frozenset(
    {_S.PR_OPEN.value, _S.CI_GREEN.value, _S.READY_FOR_MERGE.value}
)


#: States with no ``_TRANSITIONS`` edge that are nevertheless IN FLIGHT:
#: ``ci_pending`` is driven by the auto-merge poller by direct assignment, so
#: ``is_terminal`` wrongly calls it terminal (review 2026-11-02, MUST 2).
_LIVE_BY_OMISSION: frozenset[str] = frozenset({_S.CI_PENDING.value})


def _is_live(state: str) -> bool:
    if state in _LIVE_BY_OMISSION:
        return True
    try:
        return not is_terminal(StoryState(state))
    except ValueError:
        # Unknown state: not provably finished, so not terminal (and the
        # job is reported in_progress with the raw state visible).
        return True


# --------------------------------------------------------------------------- #
# Read-only DB access
# --------------------------------------------------------------------------- #


def _ro_connect(db: Path) -> sqlite3.Connection | None:
    if not db.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return None
    conn.row_factory = sqlite3.Row
    return conn


def _query(conn: sqlite3.Connection | None, sql: str, args: tuple[Any, ...]) -> list[sqlite3.Row]:
    if conn is None:
        return []
    try:
        return list(conn.execute(sql, args).fetchall())
    except sqlite3.Error:
        return []


@dataclass
class _Ctx:
    root: Path
    conn: sqlite3.Connection | None
    github: GitHubCache
    factory_block: str | None


def _factory_block_reason(root: Path, conn: sqlite3.Connection | None) -> str | None:
    """Why the factory as a whole is not dispatching, or ``None``."""
    try:
        from factory.manager.halt import is_halted

        if is_halted(root=root):
            return "factory is halted (operator must run 'factory resume')"
    except Exception:  # noqa: BLE001
        pass
    rows = _query(conn, "SELECT mode FROM factory_state WHERE id = 1", ())
    if rows and str(rows[0]["mode"]) == "paused":
        return "factory mode is 'paused'"
    return None


def _direction_status(ctx: _Ctx, ref: JobRef, state_yaml: dict[str, Any]) -> str:
    rows = _query(
        ctx.conn,
        "SELECT status FROM directions WHERE app = ? AND direction_id = ?",
        (ref.app, ref.direction_id),
    )
    if rows and rows[0]["status"]:
        return str(rows[0]["status"])
    status = state_yaml.get("status")
    return str(status) if isinstance(status, str) and status else "created"


def _stories(ctx: _Ctx, ref: JobRef) -> list[dict[str, Any]]:
    rows = _query(
        ctx.conn,
        "SELECT * FROM stories WHERE app = ? AND direction_id = ? ORDER BY id",
        (ref.app, ref.direction_id),
    )
    return [dict(r) for r in rows]


def _cost(ctx: _Ctx, ref: JobRef, story_ids: list[int]) -> float:
    clauses = ["(app = ? AND direction_id = ?)"]
    args: list[Any] = [ref.app, ref.direction_id]
    if story_ids:
        clauses.append(f"story_id IN ({','.join('?' * len(story_ids))})")
        args += story_ids
    rows = _query(
        ctx.conn,
        f"SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE {' OR '.join(clauses)}",
        tuple(args),
    )
    if not rows and story_ids:
        # Older DB without runs.app/direction_id columns: story-attributed only.
        rows = _query(
            ctx.conn,
            "SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs "
            f"WHERE story_id IN ({','.join('?' * len(story_ids))})",
            tuple(story_ids),
        )
    return round(float(rows[0]["c"]), 4) if rows else 0.0


# --------------------------------------------------------------------------- #
# Story classification
# --------------------------------------------------------------------------- #


@dataclass
class _StoryView:
    row: dict[str, Any]
    pr: PRInfo | None
    pr_number: int | None
    pr_url: str | None
    pr_state: str | None
    delivered: bool
    merged: bool
    kind: str  # delivered | unverified | human | failed | live | ignored
    level: str = ""
    note: str | None = None


def _story_level(row: dict[str, Any], job_level: DeliveryLevel) -> DeliveryLevel:
    """The level the chain stamped on this story; the job's level only for a
    row that predates stamping. An unreadable stamp is ``none`` (fail safe —
    the same rule ``delivery_gate.story_level`` applies)."""
    try:
        return parse_level(row.get("delivery_level")) or job_level
    except ValueError:
        return DeliveryLevel.NONE


def _delivery_note(ctx: _Ctx, row: dict[str, Any]) -> str | None:
    """Why this story is delivered differently from what the job asked for.

    Today: a ``push_to_main`` story whose default branch requires checks or a
    PR falls back to a ready PR at ``auto_merge`` (``auto_merge.
    _fall_back_push_to_main_to_pr``); its event carries the reason
    ``push_to_main_fell_back_to_pr:<why>``. And a ``draft_pr`` / ``pr`` PR
    delivered with red or unreported CI (the ``delivered`` event's
    ``ci_note``). Read from the story's event log
    (a file read; the DB stays read-only). ``None`` when nothing to say."""
    sid = row.get("id")
    if sid is None:
        return None
    try:
        from factory.chain.event_log import read_story_events

        events = read_story_events(
            int(sid), software_factory_root=ctx.root, slug_hint=str(row.get("slug") or "")
        )
    except Exception:  # noqa: BLE001 - a note is best-effort, never a status failure
        return None
    notes: list[str] = []
    for e in reversed(events):
        if e.get("event") == "push_to_main_fell_back_to_pr" and e.get("reason"):
            notes.append(str(e["reason"]))
            break
    # draft_pr / pr: a PR delivered WITHOUT green CI (red after the CI-fix cap,
    # or no verdict in time) carries a ``ci_note`` on its LATEST ``delivered``
    # event (``auto_merge._watch_ci_then_deliver``). Only the latest counts: a
    # resumed story that later delivered green must not keep an old red note.
    for e in reversed(events):
        if e.get("event") == "delivered":
            if e.get("ci_note"):
                notes.append(str(e["ci_note"]))
            break
    return "; ".join(notes) or None


def _merged_sha(ctx: _Ctx, row: dict[str, Any]) -> str | None:
    """``push_to_main``: the commit the fast-forward published, recorded by the
    auto-merge worker under the ``-(story.id)`` placeholder PR number."""
    sid = row.get("id")
    if sid is None:
        return None
    rows = _query(
        ctx.conn,
        "SELECT head_sha FROM merge_actions WHERE app = ? AND pr_number = ? AND merged = 1 "
        "ORDER BY id DESC LIMIT 1",
        (row.get("app"), -int(sid)),
    )
    return str(rows[0]["head_sha"]) if rows and rows[0]["head_sha"] else None


def _classify(
    ctx: _Ctx,
    row: dict[str, Any],
    job_level: DeliveryLevel,
    cfg: AppConfig,
    gh: GitHubView | None,
) -> _StoryView:
    repo = cfg.repo
    state = str(row.get("state") or "")
    level = _story_level(row, job_level)
    pr_number = row.get("github_pr_number")
    pr_number = int(pr_number) if pr_number and int(pr_number) > 0 else None
    pr = gh.pr(pr_number) if (gh is not None and pr_number) else None
    gh_known = pr is not None

    if pr is not None:
        pr_state: str | None = pr.state
        pr_url: str | None = pr.url or f"https://github.com/{repo}/pull/{pr_number}"
    elif pr_number:
        # Local view only — say nothing about merge state we did not observe.
        pr_state = None
        pr_url = f"https://github.com/{repo}/pull/{pr_number}"
    else:
        pr_state, pr_url = None, None

    live = _is_live(state)
    delivered = False
    merged = False
    verified = True
    note: str | None = None
    if gh_known and pr_state == "merged" and state not in IGNORED_STATES:
        # Merge reality is GitHub: a merged PR is delivered whatever the local
        # row says (reconcile may simply not have caught up yet).
        delivered = merged = True
    elif state in DELIVERED_UNMERGED_STATES:
        # The chain's own success end state for a level below auto_merge.
        if state == _S.DELIVERED_PR.value:
            delivered = True if not gh_known else pr_state in ("open", "merged")
            merged = gh_known and pr_state == "merged"
            verified = gh_known
            if gh_known and pr_state == "closed":
                note = f"PR #{pr_number} was closed without merging"
        elif state == _S.DELIVERED_BRANCH.value:
            branch = row.get("github_branch")
            exists = gh.branch_exists(branch) if (gh is not None and branch) else None
            delivered = exists is not False
            verified = exists is True
            if exists is False:
                note = f"branch {branch} is not on GitHub"
        else:  # delivered_local: level none, nothing to confirm remotely
            delivered = True
    elif state in LOCAL_MERGED_STATES:
        delivered = True
        if pr_number:
            merged = pr_state == "merged" if gh_known else True
            verified = gh_known and pr_state == "merged"
            if gh_known and pr_state != "merged":
                delivered = False
                note = f"local state {state} but PR #{pr_number} is {pr_state} on GitHub"
        else:
            # push_to_main: no PR. Proof = the default branch contains the
            # fast-forwarded commit (finding 5) — never the local row alone.
            sha = _merged_sha(ctx, row)
            base = cfg.default_branch or "main"
            contains = gh.branch_contains(base, sha) if (gh is not None and sha) else None
            merged = contains is not False
            verified = contains is True
            if sha is None:
                note = "no recorded fast-forward commit to confirm on GitHub"
            elif contains is False:
                delivered = False
                note = f"{base} on GitHub does not contain {sha[:12]}"

    if state in IGNORED_STATES:
        kind = "ignored"
    elif delivered:
        kind = "delivered" if verified else "unverified"
    elif state in HUMAN_STATES or is_dependency_cap_parked(state, row.get("last_rejection_reason")):
        kind = "human"
    elif live and note is None:
        kind = "live"
    else:
        kind = "failed"
    return _StoryView(
        row, pr, pr_number, pr_url, pr_state, delivered, merged, kind, level.value, note
    )


def _story_reason(row: dict[str, Any]) -> str:
    reason = row.get("last_rejection_reason") or row.get("error") or ""
    reason = " ".join(str(reason).split())
    return f": {reason[:160]}" if reason else ""


def _latest_ts(values: list[Any]) -> str:
    best: datetime | None = None
    for v in values:
        if not v:
            continue
        try:
            dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        if best is None or dt > best:
            best = dt
    return (best or datetime.now(UTC)).astimezone(UTC).isoformat()


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


def _job_level(cfg: AppConfig, meta: dict[str, Any], rows: list[dict[str, Any]]) -> DeliveryLevel:
    """The job's delivery level (nice 11, review 2026-11-02).

    An explicit ``delivery:`` request IS the level. A job that omitted it ran
    at the app default AS OF SPAWN — which the chain stamped on its stories —
    so read the stamp (lowest-id story) rather than today's config, which may
    have changed since. No stories yet → the current app default."""
    if meta.get("delivery"):
        return effective_level(cfg.delivery, meta.get("delivery"))
    for row in rows:
        if row.get("state") in IGNORED_STATES:
            continue
        try:
            stamped = parse_level(row.get("delivery_level"))
        except ValueError:
            return DeliveryLevel.NONE
        if stamped is not None:
            return stamped
    return effective_level(cfg.delivery, None)


def _status_for(ctx: _Ctx, ref: JobRef) -> dict[str, Any]:
    cfg: AppConfig = load_app_config(ref.app, ctx.root)
    meta = ref.meta
    state_yaml = read_state_yaml(ref.dir_path)
    dir_status = _direction_status(ctx, ref, state_yaml)
    rows = _stories(ctx, ref)
    level = _job_level(cfg, meta, rows)
    gh = ctx.github.view(cfg.repo)
    views = [_classify(ctx, r, level, cfg, gh) for r in rows]
    counted = [v for v in views if v.kind != "ignored"]
    cancel = state_yaml.get(CANCEL_KEY) if isinstance(state_yaml.get(CANCEL_KEY), dict) else None

    why: str | None = None
    live = [v for v in counted if v.kind == "live"]
    human = [v for v in counted if v.kind == "human"]
    failed = [v for v in counted if v.kind == "failed"]

    all_confirmed = bool(counted) and all(v.kind == "delivered" for v in counted)
    if cancel is not None and all_confirmed:
        # MUST 3 (review 2026-11-02): a job that FINISHED is done, whatever a
        # later cancel says — a cancel cannot un-deliver work.
        state = "done"
        why = (
            f"cancel requested at {cancel.get('at', '?')} after every story was already "
            "delivered; nothing was cancelled"
        )
    # Merged/delivered work classifies as delivered, never live, so a cancel
    # that left it alone (finding 6) still reads as cancelled here.
    elif cancel is not None and not live:
        state = "cancelled"
        why = f"cancelled at {cancel.get('at', '?')} by {cancel.get('by', '?')}"
    elif not counted:
        if views:
            state, why = "failed", "every story was superseded by a sibling"
        elif dir_status == "created":
            from factory.directions.parser import parse_direction_dir

            direction = parse_direction_dir(ref.app, ref.dir_path)
            direction.status = dir_status
            if awaiting_operator_approval(direction):
                state = "needs_human"
                why = f"awaiting operator approval: {approval_blocked_reason(direction)}"
            else:
                state = "queued"
                why = "waiting for pm-sync on the next factory tick"
        elif dir_status == "pm-validated":
            state, why = "triaging", "PM validated the direction; stories are being created"
        elif dir_status == "needs-direction":
            missing = state_yaml.get("missing") or []
            state = "needs_human"
            why = "PM marked the job needs-direction" + (
                f" (missing: {', '.join(map(str, missing))})" if missing else ""
            )
        else:
            state, why = "failed", f"direction is '{dir_status}' with no stories"
    elif all(v.kind in ("delivered", "unverified") for v in counted):
        unverified = [v for v in counted if v.kind == "unverified"]
        if unverified:
            u = unverified[0]
            state = "in_progress"
            why = (
                f"story {u.row.get('id')} looks delivered locally "
                f"({u.row.get('state')}) but GitHub could not confirm it"
                + (f" ({u.note})" if u.note else "")
            )
        else:
            state = "done"
    elif human:
        v = human[0]
        state = "needs_human"
        why = f"story {v.row.get('id')} is {v.row.get('state')}{_story_reason(v.row)}"
    elif live:
        state = "in_progress"
        # ``dependency_defer_count`` is not reset when the blocker clears, so
        # only a story that has never left ``story_created`` counts as waiting.
        deferred = [
            v
            for v in live
            if v.row.get("state") == StoryState.STORY_CREATED.value
            and int(v.row.get("dependency_defer_count") or 0) > 0
        ]
        if ctx.factory_block:
            state, why = "blocked", ctx.factory_block
        elif deferred and len(deferred) == len(live):
            state = "blocked"
            why = f"story {deferred[0].row.get('id')} is waiting on a dependency"
        else:
            v = live[0]
            why = f"story {v.row.get('id')} is {v.row.get('state')}"
            if (
                v.pr_number
                and v.row.get("state") in _WATCHED_PR_STATES
                and v.level in (DeliveryLevel.DRAFT_PR.value, DeliveryLevel.PR.value)
            ):
                # draft_pr / pr: the chain watches the PR's CI (and sends a red
                # run back to dev) before it reports the story delivered.
                why += f" (watching CI on PR #{v.pr_number} before delivery)"
        if cancel is not None:
            why = (
                f"cancel requested at {cancel.get('at', '?')} but story "
                f"{live[0].row.get('id')} is still {live[0].row.get('state')} "
                "(an in-flight handler wrote it back); re-run 'factory job cancel'"
            )
    else:
        state = "failed"
        v = failed[0] if failed else counted[0]
        why = f"story {v.row.get('id')} ended {v.row.get('state')}" + (
            f": {v.note}" if v.note else _story_reason(v.row)
        )

    # CI of every still-open PR: "delivered" means the PR exists, not that its
    # checks pass — say so, so the caller never reports a red PR as done-and-good.
    ci_by_story: dict[Any, dict[str, Any] | None] = {}
    for v in views:
        if gh is not None and v.pr_number and v.pr_state == "open":
            ci_by_story[v.row.get("id")] = gh.ci(v.pr_number)
    red = [
        (v.pr_number, ci_by_story[v.row.get("id")])
        for v in views
        if (ci_by_story.get(v.row.get("id")) or {}).get("state") == "failing"
    ]
    # A just-opened PR's CI has not finished yet: "done" now would end the
    # caller's watch (and its notification) before the verdict exists. Wait,
    # but at most CI_WAIT_S after the story's last update — a check that never
    # reports must not keep a job open forever.
    if state == "done":
        now = datetime.now(UTC)
        waiting = []
        for v in views:
            ci = ci_by_story.get(v.row.get("id")) or {}
            if ci.get("state") != "pending" or not v.row.get("updated_at"):
                continue
            last = datetime.fromisoformat(_latest_ts([v.row.get("updated_at")]))
            if (now - last).total_seconds() < CI_WAIT_S:
                waiting.append((v.pr_number, ci))
        if waiting:
            n, ci = waiting[0]
            state = "in_progress"
            why = f"PR #{n} is open; waiting for its CI ({', '.join(ci.get('pending', [])[:5])})"
    if red:
        ci_note = "; ".join(
            f"PR #{n} CI failing: {', '.join(c['failing'][:5])}" for n, c in red if c
        )
        why = f"{why}; {ci_note}" if why else ci_note

    if gh is not None and gh.errors:
        note = "GitHub unavailable, local view: " + gh.errors[0]
        why = f"{why}; {note}" if why else note

    stories = [
        {
            "id": v.row.get("id"),
            "state": v.row.get("state"),
            "pr_url": v.pr_url,
            "pr_state": v.pr_state,
            "branch": v.row.get("github_branch"),
            "delivery_level": v.level,
            "delivery_note": _delivery_note(ctx, v.row),
            "ci": ci_by_story.get(v.row.get("id")),
        }
        for v in views
    ]
    raw_audit = state_yaml.get("audit")
    audit: list[Any] = raw_audit if isinstance(raw_audit, list) else []
    return {
        "job_id": ref.job_id,
        "app": ref.app,
        "title": str(meta.get("title") or ref.dir_path.name),
        "source": meta.get("source"),
        "external_id": meta.get("external_id"),
        "state": state,
        "terminal": state in TERMINAL_JOB_STATES,
        "pipeline": effective_pipeline(cfg, meta.get("pipeline")),
        "delivery": level.value,
        "stories": stories,
        "pr_urls": [v.pr_url for v in views if v.pr_url],
        "merged": bool(counted) and all(v.merged for v in counted),
        "cost_usd": _cost(ctx, ref, [int(r["id"]) for r in rows if r.get("id") is not None]),
        "updated_at": _latest_ts(
            [r.get("updated_at") for r in rows]
            + [a.get("ts") for a in audit if isinstance(a, dict)]
            + [state_yaml.get("created_at"), (cancel or {}).get("at")]
        ),
        "why": why,
    }


def _ctx(root: Path, github: bool) -> _Ctx:
    conn = _ro_connect(state_db_path(root))
    return _Ctx(Path(root), conn, GitHubCache(enabled=github), _factory_block_reason(root, conn))


def job_status(root: Path, job_id: str, *, github: bool = True) -> dict[str, Any]:
    ref = find_job(root, job_id)
    ctx = _ctx(root, github)
    try:
        return _status_for(ctx, ref)
    finally:
        if ctx.conn is not None:
            ctx.conn.close()


def list_jobs(
    root: Path,
    *,
    source: str | None = None,
    active: bool = False,
    app: str | None = None,
    github: bool = True,
) -> dict[str, Any]:
    ctx = _ctx(root, github)
    jobs: list[dict[str, Any]] = []
    try:
        for ref in iter_jobs(root, app=app):
            if source and str(ref.meta.get("source") or "") != source:
                continue
            status = _status_for(ctx, ref)
            if active and status["terminal"]:
                continue
            jobs.append(status)
    finally:
        if ctx.conn is not None:
            ctx.conn.close()
    return {"jobs": jobs}


#: Never parked by cancel — the human (or quarantine) already ruled.
_CANCEL_LEAVE_STATES: frozenset[str] = frozenset(
    {_S.CLOSED_BY_OPERATOR.value, _S.QUARANTINED_INVALID_STATE.value}
)


def cancel_job(
    root: Path, job_id: str, *, by: str = "factory job cancel", github: bool = True
) -> dict[str, Any]:
    """Stop the job: disarm its PRs, park its unfinished stories, close the direction.

    Never deletes evidence: worktrees, branches, PRs, logs and spend stay.

    * A job that is already ``done`` is left exactly as it is (MUST 3, review
      2026-11-02): cancel is a no-op returning the real state — a cancel cannot
      un-deliver work, and it must not flip a finished job to ``cancelled``.
    * FINISHED work is never touched: ``deploy_pending`` / ``deployed``
      (merged), ``delivered_*``, a story whose PR GitHub reports MERGED, and
      the superseded dual-draft loser.
    * EVERY other story of the job with an OPEN PR has GitHub auto-merge
      DISARMED (``gh pr merge --disable-auto``) — whatever its state, including
      the terminal / human-pending sinks (``blocked_ci_unresolved``,
      ``blocked_deploy_failed``, ``blocked_review_nonconvergent``, …) that can
      still carry an armed auto-merge (MUST 2). Then it is parked in
      ``closed_by_operator``.
    * Race-safe (MUST 1): each story is handled under the same per-story lock
      the auto-merge pass takes around its merge, re-read inside the lock, and
      parked with a compare-and-set from the state just read.
    * Fail safe: lock busy, GitHub unable to say whether the PR merged, or a
      failed disarm → the story is NOT parked and is listed in
      ``stories_left`` with the reason; re-run cancel.

    Idempotent: re-running re-parks anything an in-flight handler wrote back.
    """
    from factory.chain import delivery_gate
    from factory.chain.handlers import get_story
    from factory.directions.parser import parse_direction_dir
    from factory.directions.watcher import mark_direction_status, merge_state

    ref = find_job(root, job_id)
    before = job_status(root, job_id, github=github)
    if before["state"] == "done":
        return {
            "job_id": ref.job_id,
            "state": "done",
            "stories_parked": [],
            "stories_left": [],
            "why": "job already done — nothing to cancel",
        }

    db = state_db_path(root)
    now = datetime.now(UTC).isoformat()
    direction = parse_direction_dir(ref.app, ref.dir_path)
    cfg = load_app_config(ref.app, root)
    gh = GitHubCache(enabled=github).view(cfg.repo)

    state_yaml = read_state_yaml(ref.dir_path)
    if not isinstance(state_yaml.get(CANCEL_KEY), dict):
        merge_state(direction, {CANCEL_KEY: {"at": now, "by": by}})
    # N2: the DURABLE marker, written BEFORE any story is parked. A handler's
    # stale write-back can undo a story row, never this: the merge pass (inside
    # its lock) and the orchestrator (before dispatch) both check it.
    delivery_gate.mark_job_cancelled(db, ref.app, ref.direction_id, by=by)

    parked: list[int] = []
    left: list[dict[str, Any]] = []
    ctx = _ctx(root, github=False)
    try:
        rows = _stories(ctx, ref)
    finally:
        if ctx.conn is not None:
            ctx.conn.close()
    untouchable = CANCEL_PROTECTED_STATES | IGNORED_STATES | _CANCEL_LEAVE_STATES

    def _leave(sid: int, state: str, reason: str) -> None:
        left.append({"id": sid, "state": state, "reason": reason})

    for row in rows:
        sid = int(row["id"])
        row_state = str(row.get("state") or "")
        if row_state in untouchable:
            if row_state in CANCEL_PROTECTED_STATES and _is_live(row_state):
                _leave(sid, row_state, "finished work (merged, deploying)")
            continue
        with delivery_gate.story_lock(root, sid, timeout=30) as held:
            if not held:
                _leave(sid, str(row.get("state")), "story lock busy (a merge in progress?); re-run")
                continue
            story = get_story(sid, db)
            if story is None or story.state in untouchable:
                if story is not None and story.state in CANCEL_PROTECTED_STATES:
                    _leave(sid, story.state, "finished work (became merged/delivered)")
                continue
            pr_no = story.github_pr_number if (story.github_pr_number or 0) > 0 else None
            if pr_no is not None:
                info = gh.pr(pr_no) if gh is not None else None
                if info is None:
                    _leave(
                        sid,
                        story.state,
                        f"cannot confirm PR #{pr_no} is unmerged (GitHub unavailable); re-run",
                    )
                    continue
                if info.state == "merged":
                    _leave(sid, story.state, f"PR #{pr_no} is merged")
                    continue
                if info.state == "open":
                    err = delivery_gate.disable_auto_merge(cfg, pr_no)
                    if err is not None:
                        _leave(
                            sid, story.state, f"could not disarm auto-merge on PR #{pr_no}: {err}"
                        )
                        continue
            from_state = story.state
            if delivery_gate.cas_story_state(
                db,
                sid,
                {from_state},
                StoryState.CLOSED_BY_OPERATOR.value,
                error=(
                    f"cancelled via 'factory job cancel' ({job_id}) at {now} while in {from_state}"
                ),
            ):
                parked.append(sid)
            else:
                _leave(sid, from_state, "state changed during cancel; re-run")

    try:
        if direction.status != "closed":
            mark_direction_status(direction, "closed", by=by, details={"job_cancelled": now})
    except Exception as exc:  # noqa: BLE001
        raise JobError("cancel_failed", f"could not close direction: {exc}") from exc
    return {
        "job_id": ref.job_id,
        "state": "cancelled",
        "stories_parked": parked,
        "stories_left": left,
    }


__all__ = [
    "CANCEL_KEY",
    "JOB_STATES",
    "JobError",
    "cancel_job",
    "job_status",
    "list_jobs",
]
