"""Detector: tick_duration_outliers — surface abnormally long tick durations.

This module exposes ``tick_duration_outliers``, which pairs tick_start /
tick_end events from ``state/events/ticks.ndjson``, computes durations,
and returns completed ticks, p95 duration, outliers, and still-running
ticks.  The calling agent decides whether a given outlier or stuck tick
requires intervention.
"""

from __future__ import annotations

import json
import statistics
from datetime import UTC, datetime
from pathlib import Path


def _parse_ts(ts: str) -> datetime | None:
    """Parse an ISO-8601 timestamp string, returning None on failure."""
    try:
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except (ValueError, TypeError):
        return None


def tick_duration_outliers(
    *,
    root: Path,
    since: datetime,
    multiplier: float = 2.0,
) -> dict:
    """Pair tick_start/tick_end events and return duration observations.

    Reads ``state/events/ticks.ndjson``, matches ``tick_start`` events
    with their corresponding ``tick_end`` by ``tick_id``, and computes
    durations for all completed ticks with a ``tick_start`` ``ts`` >=
    *since*.

    Parameters
    ----------
    root:
        Factory root directory.
    since:
        Lower bound (inclusive) on the ``tick_start`` event's ``ts``.
        Ticks that started before *since* are ignored.
    multiplier:
        Outlier threshold as a multiple of p95.  A completed tick is
        an outlier if its ``duration_s > multiplier * p95``.

    Returns
    -------
    dict
        * ``completed_ticks`` — list of dicts for all matched
          (start, end) pairs, each with ``tick_id``, ``app``,
          ``start_ts``, ``end_ts``, ``duration_s``, and all
          fields from the ``tick_end`` event.
        * ``p95_duration_s`` — 95th-percentile duration over
          completed ticks (0.0 when fewer than 2 completed ticks).
        * ``outliers`` — subset of ``completed_ticks`` where
          ``duration_s > multiplier * p95_duration_s``.
        * ``still_running`` — ``tick_start`` events in scope that
          have no matching ``tick_end`` (age computed from now).
        * ``still_running_max_age_s`` — age in seconds of the oldest
          unmatched ``tick_start``, or 0.0 when none.
    """
    stream = root / "state" / "events" / "ticks.ndjson"
    if not stream.exists():
        return {
            "completed_ticks": [],
            "p95_duration_s": 0.0,
            "outliers": [],
            "still_running": [],
            "still_running_max_age_s": 0.0,
        }

    since_iso = since.isoformat()
    starts: dict[str, dict] = {}  # tick_id -> tick_start record
    ends: dict[str, dict] = {}    # tick_id -> tick_end record

    with stream.open(encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            event = rec.get("event", "")
            tick_id = rec.get("tick_id")
            if not tick_id:
                continue
            if event == "tick_start":
                starts[tick_id] = rec
            elif event == "tick_end":
                ends[tick_id] = rec

    now = datetime.now(UTC)
    completed: list[dict] = []
    still_running: list[dict] = []

    for tick_id, start_rec in starts.items():
        start_ts_str = start_rec.get("ts", "")
        if start_ts_str < since_iso:
            continue
        if tick_id in ends:
            end_rec = ends[tick_id]
            start_dt = _parse_ts(start_ts_str)
            end_ts_str = end_rec.get("ts", "")
            end_dt = _parse_ts(end_ts_str)
            if start_dt is not None and end_dt is not None:
                dur = (end_dt - start_dt).total_seconds()
            else:
                dur = end_rec.get("duration_s") or 0.0
            row = {
                "tick_id": tick_id,
                "app": start_rec.get("app"),
                "start_ts": start_ts_str,
                "end_ts": end_ts_str,
                "duration_s": dur,
            }
            # Merge remaining tick_end fields
            for k, v in end_rec.items():
                if k not in row:
                    row[k] = v
            completed.append(row)
        else:
            # Unmatched start — still running
            start_dt = _parse_ts(start_ts_str)
            age_s = (now - start_dt).total_seconds() if start_dt else 0.0
            still_running.append({**start_rec, "age_s": age_s})

    # Compute p95
    if len(completed) >= 2:
        durations = [r["duration_s"] for r in completed]
        p95 = statistics.quantiles(durations, n=20)[18]
    elif len(completed) == 1:
        p95 = completed[0]["duration_s"]
    else:
        p95 = 0.0

    threshold = multiplier * p95
    outliers = [r for r in completed if r["duration_s"] > threshold] if p95 > 0 else []

    max_age_s = max((r["age_s"] for r in still_running), default=0.0)

    return {
        "completed_ticks": completed,
        "p95_duration_s": p95,
        "outliers": outliers,
        "still_running": still_running,
        "still_running_max_age_s": max_age_s,
    }
