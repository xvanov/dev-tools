"""Typed, replayable chain step-event stream (Tier 4 WS4.2).

Every handler dispatch appends a typed ``chain_step`` record to an
append-only per-app stream (``state/events/chain_steps.ndjson``), turning a
story's chain progression into a first-class, REPLAYABLE, auditable record
instead of state scattered across DB columns + per-story logs.

Two primitives:

* :func:`emit_chain_step` — append one typed ``chain_step`` (story_id,
  from_state, to_state, handler, outcome, + a content hash/ref of the step's
  persisted artifact). Best-effort; never raises (telemetry must not crash a
  tick). Reuses ``factory.manager.signals.write_event``, which already applies
  size-based rotation (WS0.3).
* :func:`replay_chain_history` — deterministically reconstruct one story's
  chain history from the stream (live file + rotated segments, oldest-first).
  Read-only; supports "replay a run" / post-mortem debugging.

Design mirrors ``factory.manager.signals`` (append-only NDJSON) and
``factory.chain.event_log`` (per-story audit). This stream is a PROJECTION
consistent with WS2.1 (GitHub authoritative) + WS2.2 (stable ids): it only
OBSERVES the chain — it never changes merge/gate semantics.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from factory.chain.state_machine import StoryRecord

# Bare stream name (→ ``state/events/chain_steps.ndjson``) and the event
# discriminator every record carries.
CHAIN_STEP_STREAM = "chain_steps"
CHAIN_STEP_EVENT = "chain_step"

# Per-handler mapping to the persisted DB column each step produces. The
# ``artifact_ref`` names WHERE the step's output lives; the ``artifact_hash`` is
# a stable digest of that column's value, so a replay can detect whether a
# re-run reproduced the same artifact (idempotent-resume verification / drift
# detection). Handlers whose deliverable is not a single JSON column (deploy,
# docs_onboarder — which write files) map to no artifact field and emit a null
# ref/hash; the (from_state, to_state, handler) triple still fully identifies
# the step.
_HANDLER_ARTIFACT_FIELD: dict[str, str] = {
    "sm": "sm_result_json",
    "docs_sm": "sm_result_json",
    "dev": "dev_attempts_json",
    "review": "reviewer_result_json",
    "tech_writer": "tech_writer_result_json",
}


def _artifact_ref_and_hash(
    story: StoryRecord, handler: str
) -> tuple[str | None, str | None]:
    """Return ``(artifact_ref, artifact_hash)`` for ``handler``'s persisted step
    output. Both ``None`` when the handler has no single-column artifact; the
    hash is ``None`` when the column is empty."""
    field = _HANDLER_ARTIFACT_FIELD.get(handler)
    if field is None:
        return None, None
    value = getattr(story, field, None)
    if value in (None, ""):
        return field, None
    digest = hashlib.sha256(str(value).encode("utf-8", "replace")).hexdigest()[:16]
    return field, digest


def emit_chain_step(
    story: StoryRecord,
    *,
    handler: str,
    from_state: str,
    to_state: str,
    outcome: str,
    software_factory_root: Path | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Append one typed ``chain_step`` record for a single handler dispatch.

    ``outcome`` is a short discriminator (``"advanced"``, ``"error"``,
    ``"exception"``). Best-effort: any failure is swallowed so a telemetry
    hiccup can never crash a tick.
    """
    try:
        from factory.manager.signals import write_event

        ref, digest = _artifact_ref_and_hash(story, handler)
        payload: dict[str, Any] = {
            "event": CHAIN_STEP_EVENT,
            "story_id": story.id,
            "app": story.app,
            "slug": story.slug,
            "chain_kind": story.chain_kind,
            "handler": handler,
            "from_state": from_state,
            "to_state": to_state,
            "outcome": outcome,
            "attempt": story.total_attempts,
            "artifact_ref": ref,
            "artifact_hash": digest,
        }
        if extra:
            payload.update(extra)
        write_event(
            CHAIN_STEP_STREAM, payload, software_factory_root=software_factory_root
        )
    except Exception:  # noqa: BLE001 - telemetry path, never crash the tick
        pass


def _ordered_segments(directory: Path) -> list[Path]:
    """Chain-step stream files oldest-first: rotated ``.N`` (highest N = oldest)
    down to ``.1``, then the live file."""
    base = directory / f"{CHAIN_STEP_STREAM}.ndjson"
    try:
        rotated = sorted(
            directory.glob(f"{CHAIN_STEP_STREAM}.ndjson.*"),
            key=lambda p: int(p.suffix.lstrip("."))
            if p.suffix.lstrip(".").isdigit()
            else 0,
            reverse=True,
        )
    except OSError:
        rotated = []
    return [*rotated, base]


def replay_chain_history(
    story_id: int,
    *,
    software_factory_root: Path | None = None,
) -> list[dict[str, Any]]:
    """Deterministically reconstruct ``story_id``'s chain history.

    Reads the append-only ``chain_steps`` stream (rotated segments oldest-first,
    then the live file) and returns the ``chain_step`` records for ``story_id``
    in chronological append order. Deterministic: the ordering is the file's own
    append order, so the same on-disk stream always replays identically.
    Read-only — never mutates state. Returns ``[]`` when nothing is recorded.
    """
    from factory.manager.signals import _events_dir

    directory = _events_dir(software_factory_root)
    out: list[dict[str, Any]] = []
    for seg in _ordered_segments(directory):
        if not seg.exists():
            continue
        try:
            with seg.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if (
                        isinstance(rec, dict)
                        and rec.get("event") == CHAIN_STEP_EVENT
                        and rec.get("story_id") == story_id
                    ):
                        out.append(rec)
        except OSError:
            continue
    return out


def replay_transition_path(
    story_id: int,
    *,
    software_factory_root: Path | None = None,
) -> list[tuple[str, str, str]]:
    """Reconstruct ``story_id``'s CONTROL-FLOW path as ordered transition hops.

    Returns ``[(from_state, to_state, handler), ...]`` in chronological append
    order — the deterministic projection of the ``chain_step`` stream that WS4.1
    treats as the story's control-plane trajectory. Read-only; a thin wrapper
    over :func:`replay_chain_history`, so it inherits that function's
    determinism (same on-disk stream → identical path) and never mutates state.

    The path is the CONTROL plane, not the handler bodies: each hop names the
    deterministic dispatch (which handler ran for ``from_state``) and the
    resulting ``to_state``. Handler BODIES are non-deterministic LLM calls, but
    given the recorded per-step outcomes this hop sequence is reproducible —
    which is exactly what makes a run replayable/auditable.
    """
    return [
        (
            str(rec.get("from_state", "")),
            str(rec.get("to_state", "")),
            str(rec.get("handler", "")),
        )
        for rec in replay_chain_history(story_id, software_factory_root=software_factory_root)
    ]
