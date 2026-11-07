"""Detector: placeholder_prompts — surface persona prompts that shipped with
literal placeholder strings in place of real fetched data.

Background
----------
For months, ``handle_review`` (and ``handle_tech_writer``) assembled their
LLM prompts with three literal placeholder sections — ``(see <path>)`` for
story content, stale ``test_implementer_result_json`` for test output, and
``(fetched from GitHub by the chain — placeholder for real-run)`` for the
PR diff. The reviewer kept asking for clarifications about information that
was already on disk; stories 5, 15, 16, 18, 19, 22 each cycled
dev<->reviewer 5+ times entirely because the LLM never saw the data.

The fix removed the placeholders, added a sanity guard inside the handlers,
and made ``factory.runner.text_run`` log every prompt's metadata (length,
section headers, placeholder markers found, sha256 prefix) to
``state/events/prompts.ndjson``. This detector reads that stream and
returns any record where ``placeholder_markers_found`` is non-empty so the
L1 watcher escalates a regression within one tick instead of letting it
burn another month of cycles.

The detector returns raw rows from the stream. The calling agent decides
severity / urgency based on persona, recency, and how many distinct stories
are affected.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


def placeholder_prompts(*, root: Path, since: datetime) -> list[dict]:
    """Return prompt-log records with non-empty ``placeholder_markers_found``.

    Parameters
    ----------
    root:
        Factory root directory. The stream is read from
        ``<root>/state/events/prompts.ndjson``.
    since:
        Lower bound (inclusive) on the event's ``ts`` field. Records with
        ``ts >= since`` whose ``placeholder_markers_found`` list is
        non-empty are returned, with a ``severity`` field added
        (currently fixed to ``"high"`` — any leaked placeholder is a
        plumbing bug in the dispatch handler, not a transient blip).

    Returns
    -------
    list[dict]
        Each element is the original JSON record from the stream with one
        added key (``severity``). Empty list when the file is missing,
        empty, or no leaked-placeholder rows fall inside the window.
    """
    stream = root / "state" / "events" / "prompts.ndjson"
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
            markers = rec.get("placeholder_markers_found") or []
            if not markers:
                continue
            # Skip the FMS's own personas. Manager prompts (manager_watcher,
            # _summarizer, _diagnostician — all three deleted 2026-08-07 with
            # the rest of the L1-L4 LLM tiers) used to ECHO the rows this very
            # detector returns — including their literal marker strings — back
            # into the next prompt as analysis input. Without this guard a
            # single flagged chain record got re-echoed into the watcher
            # prompt, which then tripped the marker scan on ITSELF, and the
            # detector re-surfaced that watcher prompt next tick: a
            # self-sustaining false-positive loop that burned 10 L2/L3
            # escalations in one window. The marker scan's semantics ("a
            # literal placeholder == a leak") only hold for chain personas
            # that fetch real data. The prefix check stays as defence-in-depth
            # for any future ``manager_*`` persona, even though none exists
            # right now.
            persona = rec.get("persona") or ""
            if persona.startswith("manager_"):
                continue
            ts = rec.get("ts", "")
            if ts < since_iso:
                continue
            enriched = dict(rec)
            enriched["severity"] = "high"
            results.append(enriched)
    return results
