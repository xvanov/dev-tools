# Module: chain

**Path:** `software-factory/factory/chain/`

## Purpose

The TDD chain state machine — the heart of the factory pipeline. Advances stories through a fixed sequence of states driven by events (handler completion, webhook, retry timer).

## Key files

| File | Role |
|------|------|
| `state_machine.py` | Pure state machine — `advance(story, event, payload) -> StoryState`. Defines `StoryState` enum (both `tdd` and `docs` chain variants) and `StoryRecord` SQLModel. |
| `handlers.py` | Side-effect handlers for each state transition (LLM calls, GitHub API, file writes). |
| `orchestrator.py` | Top-level tick orchestrator — picks up in-flight stories and drives them one step. |
| `pickup.py` | Story pickup logic — which stories to advance on each tick. |
| `pm_sync.py` | Direction-to-story triage (PM sync logic). |
| `boot.py` | Chain bootstrap logic. |
| `branch.py` | Git branch management for story worktrees. |
| `worktree.py` | Git worktree management for isolated Dev persona environments. |
| `auto_merge.py` | PR auto-merge logic after gates pass. |
| `contract.py` | Contract generation for stories. |
| `dual_draft.py` | Dual-draft mode support. |
| `red_green.py` | Red-green test cycle support. |
| `solo.py` | Solo (no-reviewer) chain mode. |
| `resume.py` | Resume logic for interrupted stories. |
| `oracle_probe.py` | Oracle probe for acceptance test generation. |
| `oracle_run.py` | Oracle run execution. |
| `acceptance.py` | Acceptance criteria processing. |
| `ci_health.py` | CI health checking for PRs. |
| `context_refresh.py` | Context doc refresh after story completion. |
| `delivery_gate.py` | Delivery gate logic (draft PR vs full merge). |
| `detector_watch.py` | Integration point for detectors in the chain tick (disabled pending soak). |
| `event_log.py` | Event logging for chain transitions. |
| `factory_status.py` | Factory status reporting. |
| `idle_ping.py` | Idle ping to keep agents alive. |
| `issue_intake.py` | GitHub issue intake for direction filing. |
| `mutation.py` | State mutation helpers. |
| `route_table.py` | Route table for persona-to-model resolution. |
| `scheduled_tasks.py` | Scheduled task management. |
| `security.py` | Security checks for chain operations. |
| `slop_detector.py` | Detector for low-quality / sloppy code. |
| `step_events.py` | Step event definitions. |
| `stub_server.py` | Stub server for testing. |
| `ux_auditor.py` | UX audit logic for generated output. |
| `gates/` | Merge gate implementations: `tests_green`, `smoke_green`, `acceptance_verified`, `canonical_paths_only`, `docs_current`, `production_tree_changed`, `evaluator`. |

## Dependencies

- `factory/chain/gates/` — all gate implementations
- `factory/personas/` — persona prompts used by handlers
- `factory/runner.py` — sandbox_run for Dev persona
- `factory/model_router.py` — model routing per persona
- `factory/observability/` — conformance checking, audit chain
- SQLite via SQLModel for story persistence