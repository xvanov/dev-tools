"""factory.manager — FMS signal infrastructure.

This package implements the structured event-stream layer written under
``state/events/`` by the chain itself, plus the deterministic pieces of the
FMS that consume it.

Operator decision 2026-08-07: the four LLM tiers (L1 Watcher, L2 Summarizer,
L3 Diagnostician, L4 Apply, ~4,704 LOC) were deleted — they cost $1,028.58
(52% of all-time spend) and shipped 0 applied fixes. See STATUS.md and the
Exteroception v1 direction, P0.

What survives:
  * ``signals.py`` — shared ``write_event`` helper + per-stream wrappers.
  * ``halt.py`` — fail-safe halt on integrity/poison conditions.
  * ``staging.py`` — canary/shadow deploy for factory self-modification.
  * ``recovery.py`` — auto-fix layer for known operational faults.
  * ``circuit_breaker.py`` — auto-revert a bad self-edit after the fact.
  * ``forbidden_paths.py`` — the shared forbidden-path classifier.
  * ``detectors/`` — deterministic detectors over the event streams.
  * ``factory manager signals dump`` / ``circuit-breaker`` / ``refresh-context``
    CLI surface for operator inspection.
"""
