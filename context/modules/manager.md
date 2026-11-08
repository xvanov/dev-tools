# Module: manager

**Path:** `software-factory/factory/manager/`

## Purpose

Deterministic operational management layer — staging twin, detectors, circuit breaker, recovery, halt, signals. This is what survives of the old FMS (the four LLM tiers were deleted 2026-08-07).

## Key files

| File | Role |
|------|------|
| `staging.py` | Staging twin — clones the repo, applies a self-edit diff, runs tests, promotes only if healthy. Used for loop-2 (paused). |
| `recovery.py` | Auto-fixes known operational faults. |
| `circuit_breaker.py` | Circuit breaker — stops repeated failures from burning spend. |
| `halt.py` | Halt mechanism — stops all factory activity until operator runs `factory resume`. |
| `signals.py` | Signal definitions for inter-component communication. |
| `forbidden_paths.py` | Shared self-edit path classifier — paths that the factory is forbidden to edit. |
| `escalation.py` | Escalation logic — when to escalate to a human operator. |
| `poison_escalation.py` | Poison-pill escalation for dangerous states. |
| `self_context.py` | Self-context loading for factory self-edit. |
| `detectors/` | Deterministic detectors (11 total): `conformance_breach`, `cost_spike`, `fms_yield`, `placeholder_prompts`, `retry_storm`, `review_churn`, `runs_failed_since`, `stalled_stories`, `state_distribution_skew`, `tick_duration_outliers`, `worktree_orphans`. |

## Dependencies

- `factory/chain/detector_watch.py` — integration point into chain tick (disabled)
- `factory/observability/` — conformance model, audit chain
- `factory_settings.yaml` — detector configuration
- `factory/chain/` — for filing directions from detector findings