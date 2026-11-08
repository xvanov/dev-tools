# Current state

## Active architectural decisions

- **Monorepo structure** — each tool is fully independent with its own dependencies, tests, and installers. There is no shared library or runtime between tools.
- **`software-factory` is the orchestrator** — it is a Python/uv project that uses OpenHands SDK, LiteLLM, and a persona-based pipeline to turn markdown directions into PRs. It was imported from `xvanov/software-factory` as a snapshot.
- **Chain pipeline** — directions flow through: PM (triage) → SM (stories) → Dev (OpenHands sandbox) → Reviewer → merge gates → PR auto-merge. Two chain variants exist: `tdd` (code + tests) and `docs` (documentation only).
- **Personas as markdown prompts** — each persona (`pm`, `sm`, `dev`, `reviewer`, `tech_writer`, etc.) has a `.md` prompt file in `factory/personas/`. Model routing per persona is in `factory/routes.yaml`.
- **Self-edit loop paused** — loop 2 (factory building itself) is disabled (`self_tick_enabled: false`) since the cutover to the dev-tools monorepo.
- **FMS manager LLM tiers deleted** — the four-tier L1-L4 manager pipeline was removed 2026-08-07 after costing 52% of all-time spend with zero fixes shipped. Only deterministic detectors, staging, recovery, circuit breaker remain.
- **SQLite persistence** — the factory uses SQLite via SQLModel for state storage, with events in `state/events/` NDJSON files.
- **Dual runtime for jobs** — `api` (OpenHands + LiteLLM) is the default; `claude_session` runs work via Claude Code in a termhub session.

## Module map

| Module | Path | Purpose |
|--------|------|---------|
| software-factory | `software-factory/factory/` | Core orchestrator — CLI, chain, personas, runners |
| chain | `factory/chain/` | State machine, handlers, gates, auto-merge, worktrees |
| manager | `factory/manager/` | Staging twin, detectors, circuit breaker, recovery, halt, signals |
| personas | `factory/personas/` | Markdown prompt files per persona role |
| observability | `factory/observability/` | Audit chain, conformance checking, schema, heartbeat |
| claude_session | `factory/claude_session/` | Claude Code session runtime for jobs |
| jobs | `factory/jobs/` | Research/report job types, task dispatching |
| tui | `factory/tui/` | Terminal UI dashboard |
| providers | `factory/providers/` | GitHub API client, LLM provider integrations |
| settings | `factory/settings/` | Factory configuration loading |
| apps | `apps/` | Per-app config, directions, stories (dev-tools, factory, template-probe) |
| bench | `bench/` | Benchmarks (SWE-bench adapter, convergence harness) |
| tests | `tests/` | 2,368+ tests (pytest) |

## Out-of-scope tools (independent modules)

| Tool | Path | Language | Purpose |
|------|------|----------|---------|
| bootstrap | `bootstrap/` | Bash | Linux machine provisioning |
| claude-ctx-statusline | `claude-ctx-statusline/` | JS | Claude Code status bar |
| disk-janitor | `disk-janitor/` | Python | Disk space reclamation |
| ios-messages | `ios-messages/` | Python | iPhone backup message export |
| keep-awake | `keep-awake/` | PowerShell | Windows session keep-awake |
| personal-assistant | `personal-assistant/` | JS/Node | Context layer over productivity tools |
| summarize-recording | `summarize-recording/` | Python | Audio transcription + summarization |
| termhub | `termhub/` | JS/Node | Web terminal over Tailscale |
| voice-dictation | `voice-dictation/` | Python | Push-to-talk transcription |

## Current constraints

- The chain is measurably behind a single agent (10/18 vs 12/18 on SWE-bench, 6.8× cost)
- `detector_watch` is disabled pending a soak re-measurement
- Factory runs on Linux (k-911-x17) from `/home/k/dev-tools/software-factory`; work stack runs natively on Windows via `factory serve`
- The `deployed` state records a merge, not an actual deployment — 109 deploy actions have produced 0 smoke checks
- Loop 2 (self-edit) is paused; operator PRs only for `factory/manager/**` and `bench/**`