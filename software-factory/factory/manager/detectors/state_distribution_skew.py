"""Detector: state_distribution_skew — surface uneven story-state distributions.

This module exposes ``state_distribution_skew``, which reads the most
recent ``queue_snapshot`` event per app from ``state/events/queue.ndjson``
and returns per-app state-distribution observations including fractions
and a threshold flag.  The calling agent decides whether an observed
skew warrants action.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


def state_distribution_skew(
    *,
    root: Path,
    since: datetime,
    threshold_fraction: float = 0.5,
) -> dict:
    """Return state-distribution observations per app from recent queue snapshots.

    Reads ``state/events/queue.ndjson`` and finds the *most recent*
    ``queue_snapshot`` event per app that occurred on or after *since*.
    For each app, computes the fraction of stories in each state and
    flags when any single state accounts for more than
    *threshold_fraction* of the total.

    Parameters
    ----------
    root:
        Factory root directory.
    since:
        Lower bound (inclusive) on the snapshot's ``ts`` field.
        Snapshots older than *since* are ignored.
    threshold_fraction:
        Fraction above which ``exceeds_threshold`` is set to ``True``.
        Default 0.5 (50 %).  This is an *observation* label, not a
        decision — the calling agent interprets its significance.

    Returns
    -------
    dict
        ``{"app_snapshots": {<app>: {...}, ...}}``

        Each app value contains:

        * ``ts`` — ISO-8601 timestamp of the snapshot
        * ``counts_by_state`` — raw state→count mapping
        * ``total`` — sum of all counts
        * ``max_state`` — state with the highest count (empty string
          when total is 0)
        * ``max_fraction`` — fraction of total occupied by max_state
          (0.0 when total is 0)
        * ``exceeds_threshold`` — True when max_fraction >
          threshold_fraction
        * ``exceeds_state`` — the name of the state that exceeds the
          threshold, or None

        Returns ``{"app_snapshots": {}}`` when no qualifying snapshots
        exist.
    """
    stream = root / "state" / "events" / "queue.ndjson"
    if not stream.exists():
        return {"app_snapshots": {}}

    since_iso = since.isoformat()
    # Keep only the most recent snapshot per app
    latest: dict[str, dict] = {}

    with stream.open(encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if rec.get("event") != "queue_snapshot":
                continue
            ts = rec.get("ts", "")
            if ts < since_iso:
                continue
            app = rec.get("app", "")
            if not app:
                continue
            if app not in latest or ts > latest[app].get("ts", ""):
                latest[app] = rec

    app_snapshots: dict[str, dict] = {}
    for app, rec in latest.items():
        counts: dict[str, int] = rec.get("counts_by_state") or {}
        total = sum(counts.values())
        if total > 0:
            max_state = max(counts, key=lambda s: counts[s])
            max_fraction = counts[max_state] / total
        else:
            max_state = ""
            max_fraction = 0.0
        exceeds = max_fraction > threshold_fraction
        app_snapshots[app] = {
            "ts": rec.get("ts", ""),
            "counts_by_state": counts,
            "total": total,
            "max_state": max_state,
            "max_fraction": max_fraction,
            "exceeds_threshold": exceeds,
            "exceeds_state": max_state if exceeds else None,
        }

    return {"app_snapshots": app_snapshots}
