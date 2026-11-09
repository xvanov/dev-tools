"""Per-job caps on either runtime: budget, wall clock, rounds (JOBS-API v1.9).

The caps themselves are resolved and stamped by ``factory/job_policy.py``.
This module measures a job against them and parks it when one is reached:

* **usage** comes from the ``runs`` ledger of the job (its app+direction or
  any of its stories), counted from the job's cap window: spend is
  ``cost_usd`` (metered API) plus ``subscription_equiv_usd`` (a Claude Code
  run's ``total_cost_usd``), rounds are runs of ``ROUND_PERSONAS``, and the
  wall clock runs from the window's first run.
* the window opens at the job's first run and again at every ``factory job
  resume`` (state.yaml ``caps_window_started_at``), so Continue grants the
  caps again instead of re-tripping at once.
* the orchestrator checks before every agent step (:func:`breach_for_story`);
  inside a step the dev conversation gets the remaining budget and wall clock.
* reaching a cap parks the story in ``blocked_budget_exceeded`` (a
  pending-human sink: the job reads ``needs_human``) with its work saved
  (:func:`preserve_work`), never ``failed``.
"""

from __future__ import annotations

import sqlite3
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from factory.job_policy import ROUND_PERSONAS, story_caps

CAP_REASON_PREFIX = "job_cap"
WINDOW_KEY = "caps_window_started_at"


def _parse(ts: Any) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(ts))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def job_dir(root: Path, app: str, direction_id: str) -> Path | None:
    d = Path(root) / "apps" / app / "directions"
    try:
        for p in d.iterdir():
            if p.is_dir() and p.name.startswith(f"{direction_id}-"):
                return p
    except OSError:
        return None
    return None


def window_start(dir_path: Path | None) -> str | None:
    if dir_path is None:
        return None
    try:
        import yaml

        data = yaml.safe_load((Path(dir_path) / "state.yaml").read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return None
    v = data.get(WINDOW_KEY) if isinstance(data, dict) else None
    return str(v) if v else None


def open_window(dir_path: Path, now: str | None = None) -> str:
    """Start a fresh cap window (``factory job resume``)."""
    import yaml

    now = now or datetime.now(UTC).isoformat()
    path = Path(dir_path) / "state.yaml"
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        data = {}
    data[WINDOW_KEY] = now
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return now


def job_usage(
    db_path: Path | None, app: str, direction_id: str, *, since: str | None = None,
    now: datetime | None = None, conn: sqlite3.Connection | None = None,
) -> dict[str, Any] | None:
    """Spend / rounds / wall clock of a job since ``since``. None = unreadable.

    ``conn`` (a caller's open connection) is used as is and not closed."""
    now = now or datetime.now(UTC)
    con = conn
    if con is None:
        try:
            con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
        except sqlite3.Error:
            return None
    try:
        cur = con.execute(
            "SELECT persona, cost_usd, subscription_equiv_usd, started_at, ts FROM runs "
            "WHERE (app = ? AND direction_id = ?) OR story_id IN "
            "(SELECT id FROM stories WHERE app = ? AND direction_id = ?)",
            (app, str(direction_id), app, str(direction_id)),
        )
        names = [c[0] for c in cur.description]
        rows = [dict(zip(names, r, strict=False)) for r in cur.fetchall()]
    except sqlite3.Error:
        return None
    finally:
        if conn is None:
            con.close()
    floor = _parse(since) if since else None
    spend = 0.0
    rounds = 0
    first: datetime | None = None
    for d in rows:
        started = _parse(d.get("started_at") or d.get("ts"))
        if floor is not None and (started is None or started < floor):
            continue
        spend += float(d.get("cost_usd") or 0.0) + float(d.get("subscription_equiv_usd") or 0.0)
        if str(d.get("persona") or "") in ROUND_PERSONAS:
            rounds += 1
        if started is not None and (first is None or started < first):
            first = started
    return {
        "spend_usd": round(spend, 4),
        "rounds": rounds,
        "wall_s": max(0.0, (now - first).total_seconds()) if first else 0.0,
        "since": since,
    }


def breach(caps: dict[str, Any] | None, usage: dict[str, Any] | None) -> str | None:
    """The first cap reached, as a reason line, or None. 0 = no cap."""
    if not caps or not usage:
        return None
    budget = float(caps.get("budget_usd") or 0)
    if budget > 0 and usage["spend_usd"] >= budget:
        return f"{CAP_REASON_PREFIX}: spend ${usage['spend_usd']:.2f} reached the job budget ${budget:.2f}"
    wall_h = float(caps.get("wall_clock_h") or 0)
    if wall_h > 0 and usage["wall_s"] >= wall_h * 3600:
        return (
            f"{CAP_REASON_PREFIX}: {usage['wall_s'] / 3600:.1f} h of wall clock reached the "
            f"job cap {wall_h:g} h"
        )
    rounds = int(caps.get("max_rounds") or 0)
    if rounds > 0 and usage["rounds"] >= rounds:
        return f"{CAP_REASON_PREFIX}: {usage['rounds']} agent rounds reached the job cap {rounds}"
    return None


def remaining(caps: dict[str, Any] | None, usage: dict[str, Any] | None) -> dict[str, float | None]:
    """What one step may still use: ``{"budget_usd", "wall_s"}`` (None = no cap)."""
    out: dict[str, float | None] = {"budget_usd": None, "wall_s": None}
    if not caps or not usage:
        return out
    budget = float(caps.get("budget_usd") or 0)
    if budget > 0:
        out["budget_usd"] = max(0.0, budget - usage["spend_usd"])
    wall_h = float(caps.get("wall_clock_h") or 0)
    if wall_h > 0:
        out["wall_s"] = max(0.0, wall_h * 3600 - usage["wall_s"])
    return out


def usage_for_story(root: Path, db_path: Path, story: Any) -> dict[str, Any] | None:
    since = window_start(job_dir(root, story.app, str(story.direction_id)))
    return job_usage(db_path, story.app, str(story.direction_id), since=since)


def breach_for_story(root: Path, db_path: Path, story: Any) -> tuple[str | None, dict[str, Any]]:
    """``(reason or None, basis)`` for a stamped story; a legacy story has no caps."""
    caps = story_caps(story)
    if not caps:
        return None, {}
    usage = usage_for_story(root, db_path, story)
    if usage is None:
        # Unreadable ledger: the per-story breaker and the attempts cap still
        # bound the story; a cap we cannot read does not park healthy work.
        return None, {"caps": caps, "usage": None}
    return breach(caps, usage), {"caps": caps, "usage": usage}


def _git(cwd: Path, *args: str, timeout: int = 120) -> tuple[int, str]:
    try:
        p = subprocess.run(
            ["git", *args], cwd=str(cwd), capture_output=True, text=True, errors="replace",
            timeout=timeout, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return -1, str(exc)
    return p.returncode, (p.stdout + p.stderr)


def preserve_work(story: Any, app_config: Any, root: Path, *, push: Any = None) -> dict[str, Any]:
    """Save a parked story's work: commit a dirty worktree on the story branch,
    and push that branch when the factory owns it and the job's level pushes.

    Never forces, never pushes a picked-up (human's) branch: there the commit
    stays local and the resume continues from it. Best effort, reported."""
    from factory.chain.pickup import is_pickup, story_branch
    from factory.chain.worktree import worktree_path
    from factory.delivery import DeliveryLevel, parse_level

    wt = worktree_path(Path(root), story.app, story.id, story.slug)
    out: dict[str, Any] = {"worktree": str(wt), "committed": False, "pushed": False}
    if not wt.is_dir():
        out["note"] = "no worktree (nothing in flight to save)"
        return out
    rc, st = _git(wt, "status", "--porcelain")
    if rc == 0 and st.strip():
        _git(wt, "add", "-A")
        rc, msg = _git(
            wt, "commit", "--no-verify", "-m",
            f"wip(factory): story {story.id} paused at a job cap\n\n"
            "Saved by the factory so `factory job resume` continues from here.",
        )
        out["committed"] = rc == 0
        if rc != 0:
            out["note"] = msg[-300:]
    try:
        level = parse_level(getattr(story, "delivery_level", None))
    except ValueError:
        level = None
    if level is not None and level.rank >= DeliveryLevel.BRANCH.rank and not is_pickup(story):
        branch = story_branch(story)
        rc, msg = (push or _git)(wt, "push", "origin", f"HEAD:refs/heads/{branch}")
        out["pushed"] = rc == 0
        out["branch"] = branch
        if rc != 0:
            out["push_note"] = str(msg)[-300:]
    return out


__all__ = [
    "CAP_REASON_PREFIX",
    "WINDOW_KEY",
    "breach",
    "breach_for_story",
    "job_dir",
    "job_usage",
    "open_window",
    "preserve_work",
    "remaining",
    "usage_for_story",
    "window_start",
]
