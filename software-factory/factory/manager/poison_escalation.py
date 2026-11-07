"""factory.manager.poison_escalation — surface persistent poisoned rows (#96).

The silent-poison problem
-------------------------
The tick-exit fix made a quarantined invalid-enum ("poisoned") story row
NON-FATAL: ``factory tick`` skips it (records it in ``summary.skipped`` + a
per-story ``invalid_state_skipped`` event) instead of crash-looping. The
trade-off is that a persistent poisoned row is now mostly SILENT — no automated
detector consumes it, so it is re-skipped every tick until a human notices.

What this closes
----------------
This module is the DETECTOR half of the fix (the ``recovery`` playbook
``quarantine-invalid-enum-story`` is the reconciler half). When a recent
``tick_end`` signal reports ``skipped > 0`` AND the DB still holds invalid-enum
rows, it escalates the poisoned row(s) to a GitHub issue so a human learns a
data-integrity anomaly occurred (and can fix the ROOT cause — how a bad enum got
written — which the reconciler cannot).

Reuse, not reinvention
----------------------
* The GitHub-issue plumbing is ``factory.manager.escalation.notify_escalation``
  (the same idempotent ``gh issue create`` channel L4 uses): one OPEN issue per
  stable ``concern_id``, a loud alert regardless of gh, best-effort throughout.
* The DEDUP + COOLDOWN is the SAME stable-signature + cooldown pattern the L2
  summarizer uses for concerns (``_recent_concern_with_signature``): a stable
  signature over the poisoned rows, checked against a bounded tail of the
  ``poison_escalations`` stream within a cooldown window, so a persistent row is
  escalated ONCE per window rather than re-spammed every tick.
* The poisoned-row detection reuses ``recovery.detect_invalid_enum_stories`` so
  "what is a poisoned row" is defined in exactly one place.

Best-effort contract
--------------------
Every path is wrapped so a failure here can never crash the watcher daemon. A
gh failure is surfaced by ``notify_escalation``'s own alert, never swallowed
silently.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from factory.app_config import FACTORY_REPO
from factory.manager.recovery import detect_invalid_enum_stories
from factory.manager.signals import write_event

# Stream this module appends its escalation decisions to (the cooldown source).
POISON_ESCALATION_STREAM = "poison_escalations"

# Cooldown for poisoned-row escalation dedup. Mirrors the L2 summarizer's
# ``_CONCERN_DEDUP_COOLDOWN``: a persistent poisoned row would otherwise re-fire
# the SAME escalation every watcher cycle. When an escalation with the same
# stable signature was emitted within this window, re-emission is suppressed.
DEFAULT_ESCALATION_COOLDOWN = timedelta(minutes=60)

# How far back to scan the ticks stream for a ``tick_end`` with ``skipped > 0``.
DEFAULT_SKIPPED_LOOKBACK = timedelta(hours=2)

# Tail bound on the streams scanned each cycle (avoid a full linear scan of a
# stream that may have grown to many MB — same posture as the summarizer).
_TICKS_TAIL_LINES = 2000
_ESCALATION_DEDUP_TAIL_LINES = 2000

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


# --------------------------------------------------------------------------- #
# Stream helpers
# --------------------------------------------------------------------------- #


def _events_path(root: Path, stream: str) -> Path:
    return Path(root) / "state" / "events" / f"{stream}.ndjson"


def _iter_tail(path: Path, tail_lines: int) -> list[dict[str, Any]]:
    """Return parsed JSON dict records from the last ``tail_lines`` of ``path``.

    Best-effort: unparseable/non-dict lines are skipped; a missing file yields
    an empty list. Never raises.
    """
    if not path.exists():
        return []
    try:
        from factory.events.rotation import read_tail_lines
    except Exception:  # noqa: BLE001 - defensive; rotation is always present
        return []
    out: list[dict[str, Any]] = []
    for raw in read_tail_lines(path, tail_lines):
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def recent_skipped_total(
    root: Path,
    *,
    now: datetime,
    lookback: timedelta = DEFAULT_SKIPPED_LOOKBACK,
) -> int:
    """Return the max ``skipped`` reported by any ``tick_end`` within ``lookback``.

    Reads a bounded tail of ``ticks.ndjson`` and inspects ``tick_end`` events
    for the ``skipped`` count carried by ``write_tick_event`` (Part 1). Returns
    0 when no in-window ``tick_end`` reports a positive skip — the trigger for
    escalation is a real, recent skip signal, not merely a poisoned DB row.
    """
    earliest_iso = (now - lookback).isoformat()
    now_iso = now.isoformat()
    best = 0
    for rec in _iter_tail(_events_path(root, "ticks"), _TICKS_TAIL_LINES):
        if rec.get("event") != "tick_end":
            continue
        ts = rec.get("ts")
        if not isinstance(ts, str) or ts < earliest_iso or ts > now_iso:
            continue
        skipped = rec.get("skipped")
        if isinstance(skipped, int) and skipped > best:
            best = skipped
    return best


# --------------------------------------------------------------------------- #
# Stable signature + cooldown (mirrors summarizer._recent_concern_with_signature)
# --------------------------------------------------------------------------- #


def poison_signature(poisoned: list[dict[str, Any]]) -> str:
    """Compute a STABLE dedup signature for a set of poisoned rows.

    Identical across cycles while the SAME set of rows is poisoned, and
    different when a new/different row appears — so a persistent condition is
    deduped but a genuinely new poisoned row re-escalates. Hashes only stable,
    low-cardinality facets (sorted ``app/story_id/invalid_state`` triples),
    DELIBERATELY excluding timestamps and volatile counts. Mirrors
    ``summarizer._concern_signature``.
    """
    facets = sorted(
        f"{p.get('app', '')}:{p.get('story_id', '')}:{p.get('invalid_state', '')}" for p in poisoned
    )
    material = "|".join(facets)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _recent_escalation_with_signature(
    root: Path,
    signature: str,
    *,
    now: datetime,
    cooldown: timedelta,
) -> dict[str, Any] | None:
    """Return the most recent in-cooldown escalation event matching ``signature``.

    Only events whose ``ts`` falls within ``[now - cooldown, now]`` count. Reads
    a bounded tail of ``poison_escalations.ndjson``. Mirrors
    ``summarizer._recent_concern_with_signature``.
    """
    if not signature:
        return None
    earliest_iso = (now - cooldown).isoformat()
    now_iso = now.isoformat()
    match: dict[str, Any] | None = None
    for rec in _iter_tail(
        _events_path(root, POISON_ESCALATION_STREAM), _ESCALATION_DEDUP_TAIL_LINES
    ):
        if rec.get("event") != "poison_escalated":
            continue
        if rec.get("signature") != signature:
            continue
        ts = rec.get("ts")
        if not isinstance(ts, str) or ts < earliest_iso or ts > now_iso:
            continue
        match = rec  # keep scanning; newest wins
    return match


# --------------------------------------------------------------------------- #
# Escalation
# --------------------------------------------------------------------------- #


def _build_proposal(poisoned: list[dict[str, Any]], signature: str) -> dict[str, Any]:
    """Shape the poisoned rows into the ``proposal`` dict ``notify_escalation``
    consumes (it dedups on ``concern_id`` and renders the body from these
    fields)."""
    rows_desc = ", ".join(
        f"story {p.get('story_id')} ({p.get('app')}/{p.get('slug')}) "
        f"state={p.get('invalid_state')!r}"
        for p in poisoned
    )
    return {
        "concern_id": signature,
        "proposal_id": "",
        "concern_title": f"poisoned story row(s) skipped every tick: {rows_desc}"[:200],
        "diagnosis": (
            "One or more story rows carry a `state` value OUTSIDE the StoryState "
            "enum (a bad manual/manager DB write). The tick guard skips them "
            "NON-FATALLY, but the skip is otherwise silent and the rows are "
            f"re-evaluated every tick until repaired. Poisoned rows: {rows_desc}."
        ),
        "proposal": {
            "target": "state/factory.db (stories table)",
            "rationale": (
                "Investigate how an invalid state string was written, then fix "
                "the root cause. The operational reconciler "
                "(`quarantine-invalid-enum-story`) will meanwhile park each row "
                "in the terminal `quarantined_invalid_state` sink (original "
                "state preserved in `error`) so it stops being re-skipped."
            ),
        },
        "escalation_reason": (
            "persistent invalid-enum story row(s) skipped by the tick (tick_end reported skipped>0)"
        ),
    }


def escalate_poisoned_rows(
    root: Path,
    *,
    db_path: Path | None = None,
    apps: list[str] | None = None,
    now: datetime | None = None,
    cooldown: timedelta = DEFAULT_ESCALATION_COOLDOWN,
    lookback: timedelta = DEFAULT_SKIPPED_LOOKBACK,
    repo: str | None = FACTORY_REPO,
    runner: Runner | None = None,
) -> dict[str, Any]:
    """Escalate persistent poisoned rows to a GitHub issue, deduped + cooldown'd.

    Fires only when BOTH hold: a recent ``tick_end`` reported ``skipped > 0``
    (the poisoned row is actively costing tick cycles) AND the DB still holds
    invalid-enum rows (identity to carry into the issue). The escalation is
    suppressed when an escalation with the same stable signature was emitted
    within ``cooldown`` — so a persistent row is escalated ONCE per window, not
    re-spammed every cycle.

    Returns a summary dict: ``{status, signature, poisoned, issue_number}``
    where ``status`` is one of ``"no_skip_signal"``, ``"no_poisoned_rows"``,
    ``"suppressed_cooldown"``, ``"escalated"``, or ``"error"``. Never raises.
    """
    now = now or datetime.now(UTC)
    try:
        # Cheap gate first: only bother when a recent tick actually skipped rows.
        skipped_total = recent_skipped_total(root, now=now, lookback=lookback)
        if skipped_total <= 0:
            return {"status": "no_skip_signal", "signature": None, "poisoned": []}

        # Identity: reuse the reconciler's detector so "poisoned row" is defined
        # once. Targets carry story_id/app/slug/invalid_state in ``extra``.
        targets = detect_invalid_enum_stories(root, db_path=db_path, apps=apps)
        poisoned = [
            {
                "story_id": t.story_id,
                "app": t.app,
                "slug": t.extra.get("slug"),
                "invalid_state": t.extra.get("invalid_state"),
            }
            for t in targets
        ]
        if not poisoned:
            # Signal fired but no poisoned row remains (already reconciled or
            # repaired). Nothing actionable to escalate.
            return {"status": "no_poisoned_rows", "signature": None, "poisoned": []}

        signature = poison_signature(poisoned)

        # Dedup + cooldown — the same stable-signature + cooldown gate the L2
        # concern path uses. Suppress a duplicate within the window.
        prior = _recent_escalation_with_signature(root, signature, now=now, cooldown=cooldown)
        if prior is not None:
            _log(
                root,
                event="poison_escalation_suppressed",
                signature=signature,
                poisoned=poisoned,
                reason="duplicate_within_cooldown",
                prior_ts=prior.get("ts"),
            )
            return {
                "status": "suppressed_cooldown",
                "signature": signature,
                "poisoned": poisoned,
                "issue_number": prior.get("issue_number"),
            }

        # Open (idempotently) a GitHub issue via the shared escalation channel.
        proposal = _build_proposal(poisoned, signature)
        issue_number: int | None = None
        try:
            from factory.manager.escalation import notify_escalation

            outcome = notify_escalation(
                proposal,
                root=root,
                repo=repo,
                classification="escalate_to_human",
                runner=runner,
                now=now,
            )
            issue_number = outcome.get("issue_number")
        except Exception as exc:  # noqa: BLE001 - notification is best-effort
            _log(
                root,
                event="poison_escalated",
                signature=signature,
                poisoned=poisoned,
                issue_number=None,
                error=repr(exc),
            )
            return {
                "status": "error",
                "signature": signature,
                "poisoned": poisoned,
                "error": repr(exc),
            }

        # Record the escalation so the NEXT cycle dedups on the cooldown.
        _log(
            root,
            event="poison_escalated",
            signature=signature,
            poisoned=poisoned,
            issue_number=issue_number,
        )
        return {
            "status": "escalated",
            "signature": signature,
            "poisoned": poisoned,
            "issue_number": issue_number,
        }
    except Exception as exc:  # noqa: BLE001 - never crash the watcher daemon
        return {"status": "error", "signature": None, "poisoned": [], "error": repr(exc)}


def _log(root: Path, *, event: str, **fields: Any) -> None:
    """Append one record to ``state/events/poison_escalations.ndjson``.

    Best-effort — a logging failure must never bubble out of the escalation
    cycle (mirrors every other FMS event writer)."""
    try:
        write_event(
            POISON_ESCALATION_STREAM,
            {"event": event, **fields},
            software_factory_root=root,
        )
    except Exception:  # noqa: BLE001
        pass


__all__ = [
    "POISON_ESCALATION_STREAM",
    "DEFAULT_ESCALATION_COOLDOWN",
    "DEFAULT_SKIPPED_LOOKBACK",
    "recent_skipped_total",
    "poison_signature",
    "escalate_poisoned_rows",
]
