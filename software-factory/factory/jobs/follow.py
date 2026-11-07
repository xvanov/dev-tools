"""``factory job follow`` — a plain-text live stream of one job.

Runs inside a TermHub web terminal, so: plain lines, flushed, no full-screen
TUI, no colour codes. Sources, polled:

* the job status (:func:`factory.jobs.status.job_status`) — job state
  changes, story state transitions, new PR links, cost;
* each story's per-story JSONL log (``state/logs/<id>-<slug>.log``, the same
  stream ``factory trace`` reads) — handler starts/ends, gate results, retries.

Exits 0 once the job is terminal (done / failed / cancelled).
"""

from __future__ import annotations

import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from factory.chain.event_log import read_story_events
from factory.jobs.status import job_status

#: Keys shown inline for a log event, in this order, when present.
_DETAIL_KEYS: tuple[str, ...] = (
    "handler",
    "from_state",
    "to_state",
    "verdict",
    "gate",
    "passed",
    "pr_number",
    "pr_url",
    "attempt",
    "cost_usd",
    "total_spend_usd",
    "reason",
    "error",
)


def _clock(ts: str | None) -> str:
    return ts[11:19] if ts and len(ts) >= 19 else time.strftime("%H:%M:%S", time.gmtime())


def format_event(story_id: Any, ev: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in _DETAIL_KEYS:
        value = ev.get(key)
        if value in (None, "", [], {}):
            continue
        text = " ".join(str(value).split())
        parts.append(f"{key}={text[:120]}")
    detail = (" " + " ".join(parts)) if parts else ""
    return f"{_clock(ev.get('ts'))} story {story_id} {ev.get('event', '?')}{detail}"


def follow_job(
    root: Path,
    job_id: str,
    *,
    interval: float = 3.0,
    status_every: float = 15.0,
    emit: Callable[[str], None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    max_polls: int | None = None,
    github: bool = True,
) -> dict[str, Any]:
    """Stream until the job is terminal; return the final status object."""

    def out(line: str) -> None:
        if emit is not None:
            emit(line)
        else:
            print(line, flush=True)

    status = job_status(root, job_id, github=github)
    out(
        f"following {status['job_id']} — {status['title']} "
        f"(app={status['app']} pipeline={status['pipeline']} delivery={status['delivery']})"
    )
    out(f"{_clock(None)} job {status['state']}" + (f" — {status['why']}" if status["why"] else ""))

    seen_events: dict[Any, int] = {}
    story_states: dict[Any, str] = {}
    pr_seen: set[str] = set()
    last_state = status["state"]
    last_cost = status["cost_usd"]
    last_status_at = time.monotonic()
    polls = 0

    def drain(st: dict[str, Any]) -> None:
        for story in st["stories"]:
            sid = story["id"]
            if story_states.get(sid) != story["state"]:
                prev = story_states.get(sid)
                arrow = f"{prev} -> " if prev else ""
                out(f"{_clock(None)} story {sid} state {arrow}{story['state']}")
                story_states[sid] = story["state"]
            url = story.get("pr_url")
            if url and url not in pr_seen:
                pr_seen.add(url)
                out(f"{_clock(None)} story {sid} PR {url} ({story.get('pr_state') or 'state ?'})")
            slug = _slug_for(root, sid)
            events = read_story_events(int(sid), software_factory_root=root, slug_hint=slug)
            start = seen_events.get(sid, 0)
            for ev in events[start:]:
                out(format_event(sid, ev))
            seen_events[sid] = len(events)

    drain(status)
    while not status["terminal"]:
        if max_polls is not None and polls >= max_polls:
            break
        polls += 1
        sleep(interval)
        refresh_gh = github and (time.monotonic() - last_status_at >= status_every)
        status = job_status(root, job_id, github=refresh_gh)
        if refresh_gh:
            last_status_at = time.monotonic()
        drain(status)
        if status["cost_usd"] != last_cost:
            out(f"{_clock(None)} cost ${status['cost_usd']:.2f}")
            last_cost = status["cost_usd"]
        if status["state"] != last_state:
            # A terminal verdict must come from GitHub, not the local view.
            if status["terminal"] and github and not refresh_gh:
                status = job_status(root, job_id, github=True)
                last_status_at = time.monotonic()
            if status["state"] != last_state:
                out(
                    f"{_clock(None)} job {last_state} -> {status['state']}"
                    + (f" — {status['why']}" if status["why"] else "")
                )
                last_state = status["state"]

    if status["terminal"]:
        prs = ", ".join(status["pr_urls"]) or "none"
        out(
            f"{_clock(None)} job finished: {status['state']} "
            f"(merged={str(status['merged']).lower()} cost=${status['cost_usd']:.2f} PRs: {prs})"
        )
    sys.stdout.flush()
    return status


_SLUGS: dict[tuple[str, Any], str] = {}


def _slug_for(root: Path, story_id: Any) -> str:
    """The story slug (the log filename embeds it). Read-only DB lookup, cached."""
    key = (str(root), story_id)
    if key in _SLUGS:
        return _SLUGS[key]
    import sqlite3

    from factory.jobs.common import state_db_path

    slug = ""
    db = state_db_path(root)
    if db.exists():
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
            try:
                row = conn.execute("SELECT slug FROM stories WHERE id = ?", (story_id,)).fetchone()
            finally:
                conn.close()
            slug = str(row[0]) if row and row[0] else ""
        except sqlite3.Error:
            slug = ""
    _SLUGS[key] = slug
    return slug
