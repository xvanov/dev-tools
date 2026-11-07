"""Detector: retry_storm — surface repeated failures per (story, persona) pair.

This module exposes ``retry_storm``, which groups failed run events by
``(story_id, persona)`` and returns per-group failure counts plus a
sample of error excerpts.  The calling agent decides whether a given
failure count warrants action.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


def retry_storm(
    *,
    root: Path,
    persona: str | None = None,
    story_id: int | None = None,
    since: datetime,
) -> list[dict]:
    """Group failed run events by (story_id, persona) and return per-group counts.

    Reads ``state/events/runs.ndjson`` and aggregates failure events since
    *since*, optionally filtered by *persona* and/or *story_id*.

    Parameters
    ----------
    root:
        Factory root directory.
    persona:
        If provided, restrict to events with this persona value.
    story_id:
        If provided, restrict to events with this story_id value.
    since:
        Lower bound (inclusive) on the event ``ts`` field.

    Returns
    -------
    list[dict]
        One dict per ``(story_id, persona)`` group, sorted by
        ``failure_count`` descending.  Each dict contains:

        * ``story_id`` — int or None
        * ``persona`` — str
        * ``failure_count`` — int
        * ``first_ts`` — ISO-8601 string of earliest failure in group
        * ``last_ts`` — ISO-8601 string of latest failure in group
        * ``error_excerpts`` — list of up to 5 truncated error strings
          (≤200 chars each)

        Empty list when no matching failures exist or the file is missing.
    """
    stream = root / "state" / "events" / "runs.ndjson"
    if not stream.exists():
        return []

    since_iso = since.isoformat()
    # groups: (story_id, persona) -> {"ts_list", "errors"}
    groups: dict[tuple, dict] = {}

    with stream.open(encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            # Only failures
            if rec.get("success") is True or rec.get("success") == 1:
                continue
            ts = rec.get("ts", "")
            if ts < since_iso:
                continue
            rec_persona = rec.get("persona", "")
            rec_story_id = rec.get("story_id")
            # Apply optional filters
            if persona is not None and rec_persona != persona:
                continue
            if story_id is not None and rec_story_id != story_id:
                continue

            key = (rec_story_id, rec_persona)
            if key not in groups:
                groups[key] = {"ts_list": [], "errors": []}
            groups[key]["ts_list"].append(ts)
            err = rec.get("error") or ""
            if err:
                groups[key]["errors"].append(str(err)[:200])

    results: list[dict] = []
    for (sid, pname), data in groups.items():
        ts_list = sorted(data["ts_list"])
        excerpts = data["errors"][:5]
        results.append(
            {
                "story_id": sid,
                "persona": pname,
                "failure_count": len(ts_list),
                "first_ts": ts_list[0] if ts_list else "",
                "last_ts": ts_list[-1] if ts_list else "",
                "error_excerpts": excerpts,
            }
        )

    results.sort(key=lambda r: r["failure_count"], reverse=True)
    return results
