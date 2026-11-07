"""Detector: runs_failed_since — surface failed persona-call events.

This module exposes ``runs_failed_since``, which reads
``state/events/runs.ndjson`` and returns every event that recorded a
failure (``success=False``) on or after the requested timestamp.

Design note: this detector returns raw rows from the stream.  The
calling agent decides whether the count, error content, or recency is
anomalous in context.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


def runs_failed_since(*, root: Path, since: datetime) -> list[dict]:
    """Return all failed run events from ``state/events/runs.ndjson`` since *since*.

    Parameters
    ----------
    root:
        Factory root directory.  The stream is read from
        ``<root>/state/events/runs.ndjson``.
    since:
        Lower bound (inclusive) on the event's ``ts`` field.  Events
        with ``ts >= since`` and ``success=False`` are returned.

    Returns
    -------
    list[dict]
        Each element is the original JSON object from the stream, with
        all fields intact (no transformation).  Empty list when the
        file is missing, empty, or no failure rows match the time
        window.
    """
    stream = root / "state" / "events" / "runs.ndjson"
    if not stream.exists():
        return []

    since_iso = since.isoformat()
    results: list[dict] = []
    with stream.open(encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if rec.get("success") is True or rec.get("success") == 1:
                continue
            ts = rec.get("ts", "")
            if ts >= since_iso:
                results.append(rec)
    return results
