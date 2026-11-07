"""Detector: conformance_breach — control-plane state changes the model rejects.

This module exposes ``conformance_breach``, which replays the ``state_writes``
trace through ``factory.observability.conformance`` and surfaces every hop the
abstract model does not accept. The calling agent decides whether a given
finding is a bug in the chain or a legitimate path missing from the model.

Two finding kinds, with different meanings:

* ``illegal_transition`` — a sanctioned writer produced a state it is not
  permitted to produce. The control plane was violated.
* ``coverage_breach`` — a writer that is not declared in the model changed a
  story's state, or the write could not be attributed at all. This is the
  load-bearing one: it means control-plane state moved through a path nobody
  documented, so nothing verified it.

Neither blocks a merge. The point is that a state change no one recorded stops
being invisible.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any


def conformance_breach(*, root: Path, since: datetime | None = None) -> list[dict[str, Any]]:
    """Return control-plane state writes that fail the conformance model.

    Parameters
    ----------
    root:
        Factory root directory (the ``state/events/`` parent).
    since:
        Only consider trace records at or after this timestamp. ``None``
        considers the whole retained stream.

    Returns
    -------
    list[dict[str, Any]]
        One dict per finding, most recent last:

        * ``verdict`` — ``"illegal_transition"`` or ``"coverage_breach"``
        * ``story_id`` / ``app`` — the story whose state moved
        * ``from_state`` / ``to_state`` — the hop
        * ``writer`` — ``module.function`` that performed the write, or
          ``"unknown"`` when attribution failed
        * ``reason`` — why the model rejected it
        * ``ts`` — when the write happened

        Returns an empty list when the trace is empty, absent, or fully
        conformant — the expected steady state. A non-empty list is always
        worth reading: either the chain did something it should not have, or
        the model is missing a path that exists in production.
    """
    try:
        from factory.observability.conformance import check_trace, load_model
        from factory.observability.state_trace import read_state_writes
    except Exception:  # noqa: BLE001 - a detector must never break the L1 cycle
        return []

    try:
        records = read_state_writes(software_factory_root=root)
    except Exception:  # noqa: BLE001
        return []

    if since is not None:
        cutoff = since.isoformat()
        # ISO-8601 UTC strings with a fixed offset compare lexicographically in
        # timestamp order, which is how every other detector windows a stream.
        records = [r for r in records if str(r.get("ts", "")) >= cutoff]

    if not records:
        return []

    try:
        report = check_trace(records, model=load_model())
    except Exception:  # noqa: BLE001 - a malformed model must not break L1
        return []

    return [finding.as_dict() for finding in report.findings]
