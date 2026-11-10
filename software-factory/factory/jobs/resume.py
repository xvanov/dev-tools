"""``factory job resume`` — pick a job back up where it stopped (JOBS-API v1.3).

A job is resumable when it is ``failed``, ``cancelled``, ``needs_human`` with
parked stories, or STALLED (``status.is_stalled``). It is refused while it is
alive (``job_running``), once it is ``done`` (``job_done``), and when nothing
about it can be resumed (``not_resumable`` / ``resume_refused``).

What a resume does, in this order (plan first, write after, so a refused
resume changes nothing):

1. **Plan** every unfinished story with the operator story-resume
   (``factory.chain.resume.plan_resume``, point ``auto``). That keeps
   everything the story already paid for — its branch, PR, issue, story file,
   dev and review history, spend — and re-enters it at the cheapest step that
   still re-runs what could be broken: a story with a PR goes back to the merge
   gates / CI watch, one whose dev ran goes back to dev (in its existing branch
   and worktree), one whose SM ran skips the SM, and only a story that never
   started is rebuilt from ``story_created``. Finished stories (merged,
   ``delivered_*``) and dual-draft losers are kept as they are.
2. **Un-cancel** a cancelled job: the durable ``job_cancellations`` row and
   the ``job_cancelled`` state.yaml marker are removed (otherwise the
   orchestrator re-parks every resumed story on its next tick), and a
   ``job_resumed`` audit entry is written.
3. **Apply** each story plan (``apply_resume``; it writes the
   ``story_resumed`` event that resets the gate-block and CI-fix windows).
4. **Re-open the direction**: ``closed`` → ``pm-validated`` when it has
   stories (never re-triaged: that would spawn duplicates) or ``created``
   when it has none (PM triages it again on the next tick).
5. Best-effort: re-open each resumed story's GitHub issue if it was closed,
   so the issue hygiene does not settle the story to ``closed_by_operator``
   again when it next waits on a human.

A picked-up story (``--branch`` / ``--pr``) is never resumed onto a PR a human
CLOSED: that is refused for that story (``pr closed by a human``), because a
resume would otherwise re-open the human's PR.

Research / report jobs re-queue: ``failed`` / ``cancelled`` → ``queued`` (the
agent runs again from a fresh workspace; there is no partial report to keep).
"""

from __future__ import annotations

import sqlite3
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from factory.jobs.common import JobError, find_job, read_state_yaml, state_db_path
from factory.tracker import uses_github_issues as _uses_issues

RESUMED_BY = "factory job resume"


def _issue_reopen(repo: str, number: int) -> None:
    """Seam (tests replace it): re-open a story issue if it is closed."""
    try:
        subprocess.run(
            ["gh", "issue", "reopen", str(number), "--repo", repo],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def _uncancel(root: Path, ref: Any, now: str) -> bool:
    """Remove both cancel markers. Returns whether the job had been cancelled."""
    from factory.chain.delivery_gate import _CANCEL_TABLE
    from factory.jobs.status import CANCEL_KEY

    was = False
    db = state_db_path(root)
    if db.exists():
        con = sqlite3.connect(db, timeout=30)
        try:
            cur = con.execute(
                f"DELETE FROM {_CANCEL_TABLE} WHERE app = ? AND direction_id = ?",
                (ref.app, str(ref.direction_id)),
            )
            was = cur.rowcount > 0
            con.commit()
        except sqlite3.OperationalError as exc:
            if "no such table" not in str(exc):
                raise
        finally:
            con.close()
    state_path = Path(ref.dir_path) / "state.yaml"
    state = read_state_yaml(ref.dir_path)
    if CANCEL_KEY in state:
        was = True
        state["previous_cancel"] = state.pop(CANCEL_KEY)
    audit = state.get("audit")
    if not isinstance(audit, list):
        audit = []
    audit.append({"ts": now, "by": RESUMED_BY, "event": "job_resumed", "details": {}})
    state["audit"] = audit
    state_path.write_text(yaml.safe_dump(state, sort_keys=False), encoding="utf-8")
    return was


def resume_job(root: Path, job_id: str, *, github: bool = True) -> dict[str, Any]:
    from factory.jobs.tasks import is_task_job_id

    root = Path(root)
    if is_task_job_id(job_id):
        return _resume_task(root, job_id)

    from factory.app_config import load_app_config, resolve_app_repo_path
    from factory.chain import resume as story_resume
    from factory.chain.pickup import is_pickup
    from factory.directions.parser import parse_direction_dir
    from factory.directions.watcher import mark_direction_status
    from factory.jobs.status import (
        CANCEL_PROTECTED_STATES,
        IGNORED_STATES,
        _ctx,
        _stories,
        job_status,
    )

    ref = find_job(root, job_id)
    before = job_status(root, job_id, github=github)
    state = before["state"]
    if state == "done":
        raise JobError("job_done", f"job {job_id} is done; there is nothing to resume")
    if state in ("queued", "triaging") or (
        state in ("in_progress", "blocked") and not before.get("stalled")
    ):
        raise JobError(
            "job_running",
            f"job {job_id} is {state} and not stalled ({before.get('why') or 'working'}); "
            "nothing to resume",
        )

    db = state_db_path(root)
    cfg = load_app_config(ref.app, root)
    try:
        app_repo: Path | None = resolve_app_repo_path(cfg, root)
    except Exception:  # noqa: BLE001 - only needed for PR state; plan_resume fails safe
        app_repo = None

    ctx = _ctx(root, github=False)
    try:
        rows = _stories(ctx, ref)
    finally:
        if ctx.conn is not None:
            ctx.conn.close()

    direction = parse_direction_dir(ref.app, ref.dir_path)
    dir_status = str(direction.status or "created")
    if not rows and dir_status != "closed":
        raise JobError(
            "not_resumable",
            f"job {job_id} has no stories and its direction is {dir_status!r} "
            f"({before.get('why') or 'no reason recorded'}); resubmit it with what is missing",
        )

    kept: list[dict[str, Any]] = []
    left: list[dict[str, Any]] = []
    plans: list[tuple[Any, Any]] = []
    for row in rows:
        sid = int(row["id"])
        st = str(row.get("state") or "")
        if st in CANCEL_PROTECTED_STATES or st in IGNORED_STATES:
            kept.append({"id": sid, "state": st})
            continue
        story = story_resume.load_story(db, sid)
        if story is None:
            continue
        plan = story_resume.plan_resume(
            story=story,
            db=db,
            root=root,
            point="auto",
            reason=f"{RESUMED_BY} {job_id}",
            app_repo=app_repo,
        )
        if plan.pr_needs_reopen and is_pickup(story):
            plan.refusals.append(
                f"PR #{story.github_pr_number} on the picked-up branch was closed by a human; "
                "not re-opening it"
            )
        if not plan.ok:
            left.append({"id": sid, "state": st, "reason": "; ".join(plan.refusals)[:500]})
            continue
        plans.append((plan, story))

    requeue = dir_status == "closed"
    if not plans and not (requeue and not rows):
        reasons = "; ".join(f"story {x['id']}: {x['reason']}" for x in left) or (
            "no unfinished story to resume"
        )
        raise JobError("resume_refused", f"job {job_id} cannot be resumed: {reasons}")

    now = datetime.now(UTC).isoformat()
    was_cancelled = _uncancel(root, ref, now)
    # JOBS-API v1.9: Continue grants the job caps again (a new window), so a
    # job parked at its budget / wall clock / rounds does not re-park at once.
    from factory.job_caps import open_window

    open_window(Path(ref.dir_path), now)

    resumed: list[dict[str, Any]] = []
    for plan, story in plans:
        try:
            story_resume.apply_resume(
                plan=plan, story=story, db=db, root=root, app_repo=app_repo, actor=RESUMED_BY
            )
        except Exception as exc:  # noqa: BLE001 - one story's failure is reported, not fatal
            left.append({"id": plan.story_id, "state": plan.from_state, "reason": str(exc)[:500]})
            continue
        resumed.append(
            {
                "id": plan.story_id,
                "from_state": plan.from_state,
                "to_state": plan.to_state,
                "point": plan.point,
            }
        )
        if was_cancelled and story.github_issue_number and github and _uses_issues(cfg):
            _issue_reopen(cfg.repo, int(story.github_issue_number))

    if requeue:
        new_status = "pm-validated" if rows else "created"
        mark_direction_status(direction, new_status, by=RESUMED_BY, details={"job_resumed": now})

    from factory.scheduler.serve import request_wake

    request_wake(root, ref.app, reason=f"resume {ref.job_id}")
    after = job_status(root, job_id, github=False)
    return {
        "job_id": ref.job_id,
        "state": after["state"],
        "resumed": resumed,
        "kept": kept,
        "stories_left": left,
        "requeued": bool(requeue and not rows),
        "was": state,
        "why": after.get("why"),
    }


def _resume_task(root: Path, job_id: str) -> dict[str, Any]:
    from factory.jobs.tasks import CANCELLED, DONE, FAILED, QUEUED, find_task, update_meta

    ref = find_task(root, job_id)
    raw = str(ref.meta.get("state") or QUEUED)
    if raw == DONE:
        raise JobError("job_done", f"job {job_id} is done; there is nothing to resume")
    if raw not in (FAILED, CANCELLED):
        raise JobError("job_running", f"job {job_id} is {raw}; nothing to resume")
    history = ref.meta.get("resumed")
    history = list(history) if isinstance(history, list) else []
    now = datetime.now(UTC).isoformat()
    history.append({"at": now, "from": raw, "why": ref.meta.get("why")})
    update_meta(
        ref.dir_path,
        state=QUEUED,
        cancel=None,
        worker_pid=None,
        ended_at=None,
        why=f"resumed at {now}; waiting for the next factory tick",
        resumed=history,
    )
    from factory.scheduler.serve import request_wake

    request_wake(root, ref.app, reason=f"resume {ref.job_id}")
    return {
        "job_id": ref.job_id,
        "state": "queued",
        "resumed": [],
        "kept": [],
        "stories_left": [],
        "requeued": True,
        "was": "cancelled" if raw == CANCELLED else "failed",
        "why": "re-queued; the agent runs again from a fresh workspace",
    }


__all__ = ["RESUMED_BY", "resume_job"]
