"""Detector: review_churn — surface stories cycling through review without converging.

This module exposes ``review_churn``, which groups *successful* run
events by ``story_id`` and reports, per story, how many times it has been
sent through the ``reviewer`` (and ``dev``) personas plus the accumulated
cost of that churn.

Why this exists
---------------
``retry_storm`` deliberately ignores successful runs — it only counts
*failures*. But the dominant non-convergence failure mode in the chain is
a dev<->reviewer ping-pong where **every individual run succeeds**: the
reviewer returns ``request_changes`` (a successful run, not a failure),
dev makes a change (a successful run), the reviewer runs again, and so on.
Such loops are invisible to every failure-based detector. They are also
invisible to a single 60-second watcher window, because each window sees
only *one* dev+reviewer cycle and looks perfectly routine — the cumulative
churn only becomes visible when you count across windows.

This detector closes that blind spot by reading the cumulative cycle count
straight from the run stream (it does not depend on the watcher's lookback
window), so a story that has quietly bounced through review a dozen times
shows up even when the current window contains a single cycle.

The detector describes; it does not decide. A few review rounds are
healthy. The calling agent judges whether a given cycle count is anomalous
in context (see the watcher persona's calibration guidance).
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

# Personas whose run cadence reflects a review-convergence loop.
_REVIEWER = "reviewer"
_DEV = "dev"
# Default floor below which churn is unremarkable; the agent still decides
# significance. Returned rows always have reviewer_cycles >= this value.
_DEFAULT_MIN_CYCLES = 3


def _blank() -> dict:
    return {"count": 0, "cost": 0.0, "last_ts": "", "max_attempt": 0}


def review_churn(
    *,
    root: Path,
    since: datetime,
    min_cycles: int = _DEFAULT_MIN_CYCLES,
) -> list[dict]:
    """Surface stories repeatedly cycling through review without converging.

    Reads ``state/events/runs.ndjson`` and, per ``story_id``, counts the
    number of **successful** ``reviewer`` runs (the review-cycle count) and
    ``dev`` runs, summing their cost. Unlike :func:`retry_storm`, this
    counts *successful* runs — a dev<->reviewer ping-pong where each run
    succeeds but the reviewer keeps returning ``request_changes`` produces
    no failures yet silently burns money and never advances the story.

    The scan is **cumulative** — it intentionally ignores *since* for the
    cycle counts, because the whole point is to surface churn that a
    single short watcher window cannot see. *since* is used only to label
    which churning stories are still active *right now* (``active_in_window``).

    Parameters
    ----------
    root:
        Factory root directory.
    since:
        Lower bound used solely to compute ``active_in_window`` — a story
        whose most recent reviewer run is at or after *since* is flagged as
        currently active. Does not affect the cumulative cycle counts.
    min_cycles:
        Only stories with ``reviewer_cycles >= min_cycles`` are returned.
        Default 3. This is an observation floor, not a decision threshold —
        the calling agent judges whether a returned count is anomalous.

    Returns
    -------
    list[dict]
        One dict per qualifying story, sorted by ``reviewer_cycles``
        descending. Each dict contains:

        * ``story_id`` — int
        * ``reviewer_cycles`` — number of successful reviewer runs for the
          story (max of record count and highest ``attempt_n`` seen)
        * ``dev_cycles`` — same measure for the dev persona
        * ``total_cost_usd`` — summed ``cost_usd`` of the reviewer + dev
          runs for this story (rounded to 4 dp)
        * ``last_reviewer_ts`` — ISO-8601 ts of the most recent reviewer run
        * ``active_in_window`` — True when ``last_reviewer_ts >= since``

        Empty list when no story reaches *min_cycles* or the file is missing.
    """
    stream = root / "state" / "events" / "runs.ndjson"
    if not stream.exists():
        return []

    since_iso = since.isoformat()
    # story_id -> {"reviewer": {...}, "dev": {...}}
    stories: dict[int, dict] = {}

    with stream.open(encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            # Only successful runs — failures are retry_storm's job.
            if not (rec.get("success") is True or rec.get("success") == 1):
                continue
            persona = rec.get("persona", "")
            if persona not in (_REVIEWER, _DEV):
                continue
            sid = rec.get("story_id")
            if sid is None:
                continue

            slot = stories.setdefault(
                sid, {_REVIEWER: _blank(), _DEV: _blank()}
            )[persona]
            slot["count"] += 1
            slot["cost"] += rec.get("cost_usd") or 0.0
            ts = rec.get("ts", "")
            if ts > slot["last_ts"]:
                slot["last_ts"] = ts
            attempt = rec.get("attempt_n")
            if isinstance(attempt, int) and attempt > slot["max_attempt"]:
                slot["max_attempt"] = attempt

    results: list[dict] = []
    for sid, slots in stories.items():
        rv = slots[_REVIEWER]
        dv = slots[_DEV]
        reviewer_cycles = max(rv["count"], rv["max_attempt"])
        if reviewer_cycles < min_cycles:
            continue
        last_ts = rv["last_ts"]
        results.append(
            {
                "story_id": sid,
                "reviewer_cycles": reviewer_cycles,
                "dev_cycles": max(dv["count"], dv["max_attempt"]),
                "total_cost_usd": round(rv["cost"] + dv["cost"], 4),
                "last_reviewer_ts": last_ts,
                "active_in_window": bool(last_ts) and last_ts >= since_iso,
            }
        )

    results.sort(key=lambda r: r["reviewer_cycles"], reverse=True)
    return results
