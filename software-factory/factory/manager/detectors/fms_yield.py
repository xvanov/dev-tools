"""Detector: fms_yield — does the self-improvement loop actually ship anything?

This module exposes ``fms_yield``, which reads the L4 apply history and the
manager's own spend and reports what the FMS produced versus what it cost. It
returns raw observations only; the calling agent decides whether the numbers are
concerning.

Why this exists
---------------
Added 2026-07-24 after an audit found the FMS had run for 59 days with a
**measured lifetime yield of zero**: 163 apply attempts, 0 of which ever set a
``pr_number``, at a cost of $1,028 (53% of all factory LLM spend). Two one-line
wiring bugs caused it, but the reason it went unnoticed for two months is that
**nothing in the system measured FMS output.** Every existing detector watches
the production chain; none watches the watcher. ``cost_spike`` reads the same
spend stream that contained ``manager_watcher: $971.86`` and never fired.

A self-improvement loop that cannot observe its own yield cannot notice that it
has stopped working. This detector closes that hole, and is deliberately the one
detector pointed at the manager rather than at the app pipeline.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path

# Statuses that mean "this proposal reached a reviewable artifact". Anything else
# is a proposal that died somewhere between L3 emitting it and a human seeing it.
_SHIPPED_STATUSES = frozenset({"opened_pr", "applied", "queued_for_review"})


def _parse_ts(raw: object) -> datetime | None:
    """Parse an apply-history timestamp, or None if unparseable.

    L4 history writes a COMPACT stamp (``20260527T135919``) while the event
    streams use ISO-8601 (``2026-05-27T13:59:19+00:00``). Both appear in real
    data, and a naive string comparison between them is silently always-true
    (``"20260527…" > "2026-07-17…"`` lexicographically, because ``'0' > '-'``),
    which turns any window filter into a no-op. Parse both explicitly.
    """
    if not isinstance(raw, str) or not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        try:
            dt = datetime.strptime(raw, "%Y%m%dT%H%M%S")
        except ValueError:
            return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt


def _history_path(root: Path) -> Path:
    return root / "state" / ".manager_apply_history.json"


def _load_history(root: Path) -> list[dict]:
    try:
        raw = _history_path(root).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []


def _manager_spend_since(root: Path, after: datetime) -> float:
    """Sum ``cost_usd`` for manager_* personas in the runs stream since ``after``."""
    stream = root / "state" / "events" / "runs.ndjson"
    if not stream.exists():
        return 0.0
    after_iso = after.isoformat()
    total = 0.0
    try:
        with stream.open(encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if (rec.get("ts") or "") < after_iso:
                    continue
                if not str(rec.get("persona") or "").startswith("manager"):
                    continue
                total += float(rec.get("cost_usd", 0.0) or 0.0)
    except OSError:
        return total
    return total


def fms_yield(
    *,
    root: Path,
    window: timedelta = timedelta(days=7),
    now: datetime | None = None,
) -> dict:
    """Report FMS proposal→PR conversion and manager spend over ``window``.

    Reads ``state/.manager_apply_history.json`` (written by L4
    ``apply_manager_proposals``) and ``state/events/runs.ndjson``.

    Returns a dict with:

    ``window_hours``
        Size of the observation window.
    ``attempts``
        L4 apply attempts recorded in the window.
    ``shipped``
        Attempts that reached a PR / applied state (``opened_pr``, ``applied``,
        ``queued_for_review``).
    ``shipped_all_time``
        Same count across the entire history — a zero here with a large
        ``attempts_all_time`` means the loop has *never* shipped, which is a
        different and more serious condition than a quiet week.
    ``attempts_all_time``
        Total recorded apply attempts ever.
    ``by_status``
        Status histogram for the window (e.g. ``{"abandoned": 12}``).
    ``top_errors``
        Up to 5 most common ``error`` strings in the window with counts. A single
        error dominating this list is the signature of a systematic wiring bug
        rather than unrelated one-off failures.
    ``manager_spend_usd``
        Manager-persona LLM spend in the window.
    ``spend_per_shipped_usd``
        ``manager_spend_usd / shipped``, or ``None`` when ``shipped`` is 0. When
        this is ``None`` and spend is non-trivial, the loop is burning money at
        zero yield.

    The detector makes no judgement about what an acceptable yield is; it reports
    the ratio and lets the agent reason about it in context.
    """
    now = now or datetime.now(UTC)
    after = now - window

    history = _load_history(root)
    in_window = [e for e in history if (_dt := _parse_ts(e.get("ts"))) is not None and _dt >= after]

    shipped = sum(1 for e in in_window if e.get("status") in _SHIPPED_STATUSES)
    shipped_all_time = sum(1 for e in history if e.get("status") in _SHIPPED_STATUSES)

    errors = Counter(
        str(e.get("error") or "").strip() for e in in_window if str(e.get("error") or "").strip()
    )
    spend = _manager_spend_since(root, after)

    return {
        "window_hours": round(window.total_seconds() / 3600.0, 2),
        "attempts": len(in_window),
        "shipped": shipped,
        "attempts_all_time": len(history),
        "shipped_all_time": shipped_all_time,
        "by_status": dict(Counter(str(e.get("status") or "unknown") for e in in_window)),
        "top_errors": [{"error": err[:200], "count": n} for err, n in errors.most_common(5)],
        "manager_spend_usd": round(spend, 4),
        "spend_per_shipped_usd": round(spend / shipped, 4) if shipped else None,
    }
