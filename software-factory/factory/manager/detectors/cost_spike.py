"""Detector: cost_spike — compare recent spend to a trailing baseline.

This module exposes ``cost_spike``, which reads the spend signal stream
(or falls back to the runs stream) and returns a dict of raw spend
observations.  The calling agent decides whether the ratio is
concerning in context.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _sum_cost_usd_in_window(stream: Path, after: datetime, before: datetime) -> float:
    """Sum cost_usd from an NDJSON stream for events within [after, before)."""
    after_iso = after.isoformat()
    before_iso = before.isoformat()
    total = 0.0
    with stream.open(encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            ts = rec.get("ts", "")
            if ts < after_iso or ts >= before_iso:
                continue
            total += float(rec.get("cost_usd", 0.0) or 0.0)
    return total


def cost_spike(
    *,
    root: Path,
    window: timedelta = timedelta(hours=1),
    baseline_window: timedelta = timedelta(hours=6),
) -> dict:
    """Compare recent spend to a trailing per-window baseline.

    Reads ``state/events/spend.ndjson`` for spend snapshots, falling
    back to summing ``cost_usd`` fields from ``state/events/runs.ndjson``
    when the spend stream is absent or empty.

    The *window* covers the most recent period; the *baseline_window*
    covers the period immediately preceding the *window*.  Both are
    normalized to per-hour rates before computing the ratio so that
    different window sizes remain comparable.

    Parameters
    ----------
    root:
        Factory root directory.
    window:
        Duration of the "recent" spend period ending now.
    baseline_window:
        Duration of the baseline period ending at the start of *window*.

    Returns
    -------
    dict
        * ``recent_usd`` — total spend in the recent window
        * ``baseline_avg_usd`` — average spend per window-sized slice
          within the baseline period (normalized to the same duration
          as *window*)
        * ``ratio`` — ``recent_usd / baseline_avg_usd``; ``float("inf")``
          when baseline is 0 and recent > 0; ``1.0`` when both are 0
        * ``recent_window_hours`` — *window* expressed in hours
        * ``baseline_window_hours`` — *baseline_window* expressed in hours
    """
    now = _now_utc()
    recent_start = now - window
    baseline_start = recent_start - baseline_window

    spend_stream = root / "state" / "events" / "spend.ndjson"
    runs_stream = root / "state" / "events" / "runs.ndjson"

    # Prefer spend.ndjson; fall back to runs.ndjson
    use_stream: Path | None = None
    if spend_stream.exists() and spend_stream.stat().st_size > 0:
        use_stream = spend_stream
    elif runs_stream.exists() and runs_stream.stat().st_size > 0:
        use_stream = runs_stream

    if use_stream is None:
        return {
            "recent_usd": 0.0,
            "baseline_avg_usd": 0.0,
            "ratio": 1.0,
            "recent_window_hours": window.total_seconds() / 3600,
            "baseline_window_hours": baseline_window.total_seconds() / 3600,
        }

    recent_usd = _sum_cost_usd_in_window(use_stream, recent_start, now)
    baseline_total_usd = _sum_cost_usd_in_window(use_stream, baseline_start, recent_start)

    # Normalize baseline to the same window size as recent
    window_secs = window.total_seconds()
    baseline_secs = baseline_window.total_seconds()
    # baseline_avg_usd = baseline_total per equivalent window
    if baseline_secs > 0:
        baseline_avg_usd = baseline_total_usd * (window_secs / baseline_secs)
    else:
        baseline_avg_usd = 0.0

    if baseline_avg_usd == 0.0 and recent_usd > 0.0:
        ratio = float("inf")
    elif baseline_avg_usd == 0.0 and recent_usd == 0.0:
        ratio = 1.0
    else:
        ratio = recent_usd / baseline_avg_usd

    return {
        "recent_usd": recent_usd,
        "baseline_avg_usd": baseline_avg_usd,
        "ratio": ratio,
        "recent_window_hours": window.total_seconds() / 3600,
        "baseline_window_hours": baseline_window.total_seconds() / 3600,
    }
