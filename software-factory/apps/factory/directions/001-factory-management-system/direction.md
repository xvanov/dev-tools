---
title: Factory Management System — LLM-in-the-loop self-monitoring & self-improvement
type: feature
priority: p0
explore: false
created_at: 2026-05-26
---

# Factory Management System — LLM-in-the-loop self-monitoring & self-improvement

## Why

The factory is the build system. Today it can build other apps but it cannot
build itself: there is no closed loop that lets the factory observe its own
behavior, diagnose its own breakdowns, and improve its own prompts and code.

We just observed the cost of that gap. The Story Manager persona (azure/gpt-5.4)
silently hit `max_tokens=65536` with `finish_reason=length` on seven consecutive
calls, returning truncated JSON, rolling each story back to `story_created`,
and burning ≈$1.73 × 7 = ~$12 on a single broken state — invisible to the
existing `factory_improver` because:

* The improver only sees `factory_needs_redesign` events, emitted from exactly
  three code sites (`BLOCKED_TESTS_NEED_CLARIFICATION`, dev retry observed,
  dev exhaustion). Persona-internal call failures emit no event.
* The improver fires inside `factory tick`. The current tick has been
  running 2 h 52 min because the dispatch loop walks story_created
  sequentially. During that window the improver was never polled.
* The improver's persona prompt is dev/test-oriented. Even if it had been
  invoked, its mental model is "story stuck in dev"; it has no language
  for "the persona's own LLM call exploded its output budget."

The factory is otherwise "v1 done" — the BMAD chain (analyst → architect →
PM → SM → test_designer → test_implementer → dev → reviewer → release)
ships features into `apps/sacrifice/` reliably when nothing is broken. What's
missing is the **self-monitoring and self-improvement loop** that makes the
chain robust enough to ship into other apps without an operator babysitting
every tick. That loop is this direction's MVP. Once it ships, we can onboard
new apps with confidence the factory will diagnose and self-heal its own
breakdowns.

## Design principles

These principles are constraints, not suggestions. Implementation choices
that violate them must be rewritten.

1. **LLMs are the basis. Heuristics are tools the LLMs call.**
   The system's detection, classification, and proposal layers must be
   driven by an agent (an LLM with structured I/O), not by a fixed list of
   thresholds or regexes. Deterministic checks may exist, but only as
   *tools* the agent invokes when it suspects something — they save tokens,
   they do not replace judgment. The set of tools is open and grows over
   time: the agent authors new ones as it discovers new failure modes.

2. **No hardcoded taxonomy of "what counts as a failure."**
   The system has no enumerable list of error classes, no fixed table of
   detectors, no compile-time set of anomaly names. Concerns are described
   in natural language by the agent that surfaced them, classified by
   downstream agents, and grouped emergently. The taxonomy is built bottom-up
   by what the factory actually does, not top-down by what we predict it
   will do.

3. **Same chain, applied to itself.**
   The factory uses the existing BMAD chain (analyst, architect, PM, SM,
   dev, etc.) to build the FMS. There is no parallel "meta-chain." The
   factory is registered as an app the factory can build — `apps/factory/`
   with a `config.yaml` pointing at the factory's own repo — and this
   direction (and the directions that follow from it) flow through PM-sync,
   SM, dev, reviewer, etc. exactly as a `sacrifice` direction would.

4. **Tiered model escalation, mirroring `factory/routes.yaml`.**
   The monitoring loop has multiple agents. Cheap, fast agents (Haiku,
   DeepSeek) run continuously and summarize. Mid-tier agents (Sonnet) review
   summaries and decide whether to escalate. Frontier agents (Opus,
   GPT-5-class) are invoked only when a concern is escalated — they propose
   fixes. Humans are the last tier; the system explicitly escalates with
   `escalate_to_human` when frontier confidence is low. Costs and latency
   scale with concern severity, not with event volume.

5. **The factory reads its own source as context.**
   The same way the dev persona reads `apps/sacrifice/context/modules/*.md`
   when implementing a sacrifice story, agents in this system read the
   factory's source tree, its persona files, its dispatch code, and its
   own context modules (newly generated under `apps/factory/context/`).
   Context generation for the factory is itself a chain artifact, refreshed
   on the same cadence as sacrifice's context refresh.

6. **Recursion-safe.**
   The FMS edits the factory, which contains the FMS. Specific files are
   marked operator-only (forbidden class). Manager-authored commits that
   regress tests on `main` are auto-reverted and the manager's apply
   pipeline halts pending operator review. The system cannot brick itself
   without an operator's signature.

7. **Halt before burn.**
   When the system detects sustained failure it cannot diagnose, it sets
   `factory_mode = halted`. The driver loop reads this between ticks and
   exits cleanly. Operator runs `factory resume` to clear. A halted
   factory costs $0/hour; a confused factory costs $7/hour.

## What this is (and isn't)

**This is**: a self-monitoring and self-improvement layer that wraps the
existing chain. Every persona call, every tick, every dispatch decision,
every webhook, every git operation emits a structured signal. Agents read
those signals continuously, summarize them, decide what's anomalous,
escalate to a frontier agent for diagnosis, and produce proposals that
flow through the existing L2 apply pipeline (PR + CI + auto-merge for safe
classes, operator-review PR for risky classes).

**This is not**: a replacement for `factory_improver`. `factory_improver`
stays — it continues to handle dev/test breakdowns as it does today. The
FMS is the broader layer that covers infrastructure: persona-internal call
failures, dispatch serialization, cost anomalies, queue stalls, model
errors, anything that isn't already captured by a `factory_needs_redesign`
event. The two systems coexist; the FMS can in principle propose retiring
`factory_improver` once it subsumes the dev/test signal as well.

## Architecture overview (high-level)

The system has four loops running at different cadences. Every loop is an
agent — none is a fixed rule engine.

```
   Source of signals             Loops (each is an agent)
  ─────────────────────         ────────────────────────────
   runs table                    L1 — Watcher (cheap, ~1/min)
   state/logs/*.log              L2 — Summarizer (cheap, ~1/5min)
   state/events/*.ndjson    →    L3 — Diagnostician (frontier, on escalation)
   queue snapshots               L4 — Apply pipeline (existing L2 apply, extended)
   git/PR/CI signals
   tick heartbeats
   webhook ingress
```

* **L1 Watcher** runs continuously. It reads the signal streams since its
  last wake, produces a one-paragraph natural-language summary of what
  happened ("seven SM calls in the last hour, six failed, all with the
  same finish_reason=length error; story_created queue grew by 0; one
  worktree was created at 14:17, never destroyed"), and decides whether
  anything in that paragraph deserves L2's attention. Output: a "watcher
  note" appended to `state/events/watcher_notes.ndjson` and a structured
  `escalate_to_l2` flag.

* **L2 Summarizer** runs when L1 raises a flag (or on a slower default
  cadence). It reads the last hour of watcher notes plus the signals L1
  flagged, decides whether the pattern is anomalous in context, and
  produces a `concern` document — a structured artifact with a free-text
  description, supporting evidence (specific run IDs, log excerpts),
  proposed area (prompt / persona settings / dispatch code / detector
  tooling), and urgency (continue / warn / halt). Concerns land in
  `state/concerns/<ts>-<slug>.json`. L2 also decides whether to escalate
  to L3.

* **L3 Diagnostician** is the frontier model. It runs only when escalated.
  It receives the concern, reads the relevant factory source files
  itself (just like dev reads app source), and produces a proposal —
  same shape as today's `factory_improver` proposal (kind, target,
  rationale, suggested_patch unified diff, evidence, confidence) — plus
  a `target_class` (prompt_edit / persona_settings / dispatch_code /
  detector_tool / escalate_to_human).

* **L4 Apply** is the existing `factory/chain/factory_improver_apply.py`
  pipeline, expanded to handle the new `target_class` types. Safe
  classes auto-PR + auto-merge after CI. Risky classes open a PR with
  the `factory-self-improvement-review` label. Forbidden classes never
  auto-apply; they alert the operator and halt the apply pipeline.

The L1 → L2 → L3 escalation is the user's "simpler agent → more complex
model → frontier model" pattern. Nothing in this system is a fixed-cadence
LLM call. L1 runs every minute because that's cheap; L2 runs when L1
flags; L3 runs when L2 escalates. Quiet periods cost almost nothing.

## Signal sources (the most important deliverable)

Signals are the ground truth the agents observe. If a signal isn't on
disk, the agents are blind to that thing happening. This direction's
**core deliverable** is a uniform, structured signal stream covering
every action the factory takes.

Existing signal sources (already on disk; the FMS reads these):

* `state/factory.db` — `runs` table (persona call audit), `stories` table
  (state transitions), `live_handlers` + `handler_baselines` (the
  observability commit `e8c3e3a` heartbeats).
* `state/logs/<story_id>-<slug>.log` — per-story append-only JSONL of
  every event (handler_start/end, dispatch_rejected, persona_call,
  test_command, dev_retry, commit, etc.).
* `state/improvements/<ts>.json` — historical improver proposals.
* `state/.improver_run_history.json` — improver firing history.

New signal sources this direction adds (the gaps that made today's
incident invisible):

* `state/events/runs.ndjson` — every persona call writes a structured
  end-of-call record: `started_at`, `ended_at`, `duration_s`, `cost_usd`,
  `success`, `error_class` (derived from the existing `error` string by a
  cheap LLM call, NOT a regex — see Principle 1), `tokens_in`, `tokens_out`,
  `model`, `model_tier`, `attempt_n`, `story_id`, `persona`, `worktree_path`,
  `tick_id`. A row exists for every `runs` row; the file is the structured
  side-feed L1 reads.
* `state/events/ticks.ndjson` — tick start/end with `tick_id`, `duration_s`,
  `stories_advanced`, `stories_blocked`, `merges_attempted`. Today there is
  no record that a tick happened beyond what `runs` implicitly shows; with
  this stream we can detect "the current tick has been running 172 minutes."
* `state/events/queue.ndjson` — periodic queue snapshot: `{ts, app,
  counts_by_state}`. Lets L1 see "story_created grew by 0 in the last
  hour" without re-querying the DB on every wake.
* `state/events/webhooks.ndjson` — every webhook the orchestrator
  receives (OpenHands callbacks, GitHub PR events). Lets the agents see
  the asynchronous side of the chain, not just the synchronous tick path.
* `state/events/git.ndjson` — every git operation the chain performs
  (worktree create/destroy, commit, push, PR open/close, merge,
  auto-merge attempt). Surfaces the merging-and-conflict side that today
  is buried in subprocess output.
* `state/events/spend.ndjson` — periodic spend snapshot:
  `{ts, today_usd, last_hour_usd, projected_eod_usd, by_persona}`.

All `.ndjson` streams are append-only, one JSON object per line, with
a `schema_version` field. The agent layer never parses freeform text from
logs; it reads structured events.

The L1 agent's first job, every wake, is to produce a *summary of what
happened since last wake*, written to `state/events/watcher_notes.ndjson`.
Those summaries are the input L2 reads. **The signal-stream design is the
hill this direction has to take first**; everything else builds on it.

## Tool authorship (the loop closes)

When the L3 Diagnostician identifies a concern type that recurs but isn't
captured by any existing tool, it can propose a `detector_tool` — a small
script (Python module under `factory/manager/detectors/`) that takes the
signal streams as input and surfaces a specific pattern. The tool is then
available for the L1 and L2 agents to call in subsequent runs.

A detector tool is just a deterministic function: read the signal store,
return a list of "things matching this pattern." It has no decision power
— that's the agent's job. The tool exists purely to save the agent
tokens: instead of reading 500 lines of `runs.ndjson` and noticing that
runs with `duration_s > 900` cluster on the SM persona, the agent calls
`detectors.long_runs(persona="sm", since="1h")` and gets a 5-row table.

Bootstrap detector tools (LLM-authored, but seed-set provided in Phase
2 of this direction so we don't start empty):

* `runs_failed_since(ts)` — return failed `runs.ndjson` rows
* `retry_storm(persona, story_id, hours)` — return retry counts
* `cost_spike(window)` — compare last hour to trailing N-hour average
* `tick_duration_outliers()` — return ticks longer than N× rolling p95
* `state_distribution_skew(threshold)` — counts by state, flag any > threshold
* `worktree_orphans()` — worktrees with no active story

After bootstrap, the L3 Diagnostician can write new tools when it
notices a recurring concern that would be cheaper to detect with a script.
New tools are L4-applied like any other code change (safe class:
`factory/manager/detectors/*.py` if pure functions with no side effects).

## Self-context (the factory reads itself)

Today, `apps/sacrifice/context/modules/*.md` contains LLM-generated
context modules describing sacrifice's backend, frontend, navigation,
etc., refreshed by `factory/chain/context_refresh.py`. Dev reads these
when implementing a story.

This direction adds the same for the factory itself:

* `apps/factory/context/modules/orchestrator.md` — what the tick loop
  does, what `_dispatch_for_story` returns when, what `_invoke_handler`
  does on success/failure/exception.
* `apps/factory/context/modules/personas.md` — every persona in
  `factory/personas/*.md`, what it consumes, what it produces, what model
  tier it runs at, what it can break.
* `apps/factory/context/modules/state-machine.md` — every state, who
  transitions out of it, what the rollback paths are.
* `apps/factory/context/modules/observability.md` — every signal source,
  schema, where it's written, who consumes it.
* `apps/factory/context/modules/dispatch.md` — `can_dispatch`, the cap
  system, mode gating, rejection reasons.
* `apps/factory/context/modules/manager.md` — once the FMS is built,
  the FMS itself becomes a context module the FMS reads. The loop closes.

These modules are refreshed via the same `context_refresh` chain as
sacrifice's, with the factory's source tree as the read target. When the
L3 Diagnostician needs to propose a code change, it loads the relevant
context module first, just like dev does.

## App bootstrap (Phase 0)

Create `apps/factory/config.yaml`:

```yaml
name: factory
repo: <factory's own remote>
default_branch: main
context_dir: apps/factory/context
app_repo_path: "."  # factory IS the app
deploy:
  enabled: false  # the factory deploys nothing of itself
gates:
  lint_command: "uv run ruff check ."
  format_check_command: "uv run ruff format --check ."
  type_check_command: "uv run mypy factory"
  test_command: "uv run pytest -q"
  coverage_command: ""
  e2e_command: ""
  mutation_testing: false
models: {}
```

This is the smallest bootstrap that lets `factory pm-sync --app factory`
discover this direction and create stories. Phase 0 is one story: land
the config, land the empty context dir, land this PRD.

## Phasing (each phase is one or more SM-generated stories)

The phases below are the chunks the SM persona will split this direction
into when PM-sync runs against `apps/factory/`. They're sized so each
ships independently and each ratchets the system closer to MVP.

**Phase 0 — App bootstrap (1 story)**
* Create `apps/factory/config.yaml` per above.
* Create `apps/factory/context/` empty.
* This PRD lives at the canonical location.
* Acceptance: `uv run factory pm-sync --app factory --dry-run` discovers
  this direction without erroring.

**Phase 1 — Signal foundation (3-5 stories)**
* Implement the structured event writers for `runs.ndjson`, `ticks.ndjson`,
  `queue.ndjson`, `webhooks.ndjson`, `git.ndjson`, `spend.ndjson` listed
  in §Signal sources. Each is a small additive change in the relevant
  emit site (e.g., `runs.ndjson` writer wraps the existing `runs` table
  insert; `ticks.ndjson` wraps the existing `tick` entry/exit).
* Add a `factory manager signals dump --since 1h` CLI for operator
  inspection — proves the streams are populated correctly before agents
  consume them.
* Acceptance: every action the factory takes leaves a structured trace
  on disk readable by an agent without parsing log lines. A
  human-readable `factory manager signals dump` shows all activity from
  a recent tick.

**Phase 2 — Seed detector tools (1-2 stories)**
* Implement the seed detectors listed in §Tool authorship as pure
  functions under `factory/manager/detectors/`.
* Each detector has a docstring describing what pattern it surfaces;
  the agent uses these docstrings to know what's available.
* Acceptance: each detector returns a structured list for any non-empty
  signal stream; covered by unit tests with fixture event streams.

**Phase 3 — L1 Watcher agent (2-3 stories)**
* Add `factory/manager/watcher.py` — a daemon mode entry point.
* Add `factory/personas/manager_watcher.md` — the L1 persona prompt
  (cheap model, e.g. deepseek). Inputs: signal streams since last wake,
  list of available detectors with docstrings, prior watcher notes from
  the last 6 hours. Output: a one-paragraph summary appended to
  `state/events/watcher_notes.ndjson`, and a structured `escalate_to_l2`
  flag (boolean + free-text reason).
* Add `factory manager watch` CLI subcommand that loops the L1 agent
  on the configured cadence.
* Acceptance: a 2-hour synthetic event stream (with a planted SM
  token-overflow pattern) produces a watcher note that mentions the
  pattern and sets `escalate_to_l2=true` within 5 minutes of the
  pattern emerging.

**Phase 4 — L2 Summarizer + concern generation (2-3 stories)**
* Add `factory/personas/manager_summarizer.md` — the L2 persona prompt
  (mid-tier, e.g. sonnet). Inputs: the watcher notes + the underlying
  signals the watcher flagged + the factory's context modules. Output:
  a concern document in `state/concerns/<ts>-<slug>.json` with a free-text
  description, evidence (run IDs / event timestamps), proposed area, and
  urgency, plus `escalate_to_l3` boolean.
* Plumb the L1 → L2 escalation through the watcher loop.
* Acceptance: the same synthetic SM-overflow stream produces a concern
  document with urgency >= warn and clear evidence linking back to the
  failing run IDs.

**Phase 5 — L3 Diagnostician + proposal generation (2-3 stories)**
* Add `factory/personas/manager_diagnostician.md` — the L3 persona
  prompt (frontier, opus). Inputs: a concern document, the factory
  source tree, and the relevant context modules. Output: a proposal in
  the same shape as today's `factory_improver` output, plus
  `target_class` ∈ `{prompt_edit, persona_settings, dispatch_code,
  detector_tool, escalate_to_human}`.
* Acceptance: given the synthetic SM-overflow concern, the L3 agent
  produces a `persona_settings` or `prompt_edit` proposal (one of:
  lower `max_tokens`, split SM into multiple calls, downgrade model)
  with a coherent rationale and a unified-diff patch that applies cleanly.

**Phase 6 — L4 Apply pipeline extension (1-2 stories)**
* Extend `factory/chain/factory_improver_apply.py` to handle the new
  `target_class` types. Safe classes: `prompt_edit` (existing),
  `persona_settings` (new, with numeric clamps), `detector_tool` (new,
  pure-function additions only). Risky: `dispatch_code`. Forbidden:
  edits to `factory/manager/*` itself (operator-only).
* Acceptance: a `persona_settings` proposal lands as a PR, CI passes,
  auto-merges.

**Phase 7 — Halt authority (1 story)**
* Add `factory_mode = halted` and the trip conditions. The
  Diagnostician (L3) is the only agent that can request halt; the
  driver loop reads the mode file and exits cleanly between ticks.
  `factory resume` clears it.
* Acceptance: a planted concern with urgency=halt sets the mode and the
  driver exits at the next tick boundary without burning an LLM call.

**Phase 8 — Recursion safety & circuit breaker (1 story)**
* Mark `factory/manager/watcher.py`, `factory/manager/summarizer.py`,
  the manager personas, and the manager config schema as forbidden
  class in the L4 apply pipeline.
* On `main` tests failing after a manager-authored commit, auto-revert
  that commit and halt the apply pipeline for 24h pending operator
  review.
* Acceptance: a synthetic L4 PR that introduces a test failure is
  reverted within one CI cycle and the apply pipeline reports halted.

**Phase 9 — Self-context (1-2 stories)**
* Generate the initial `apps/factory/context/modules/*.md` set listed
  in §Self-context using the same `context_refresh` chain that
  sacrifice uses.
* Refresh cadence: same as sacrifice.
* Acceptance: dev/diagnostician runs against the factory have access
  to module-level context, and a context-refresh tick updates the
  modules without manual intervention.

**MVP cutline** is Phases 0–6. Phases 7–9 are required for production
robustness but the system is functional end-to-end after Phase 6 — at
that point a planted incident reproduces the SM-overflow detection and
auto-patches it.

## Acceptance Criteria (MVP, end of Phase 6)

A single end-to-end synthetic test reproduces what today's incident
*should* have looked like, and demonstrates the loop closes:

1. With the chain running and an empty incident state, inject a
   sequence of 3 fake persona-call failures into `state/factory.db` +
   `state/events/runs.ndjson` matching the SM `max_tokens` pattern
   (`success=0`, `error_class=max_tokens`, same persona, distinct
   `story_id`s, ~16 min apart in event timestamps).
2. Within 5 simulated minutes, an L1 watcher note appears mentioning
   the pattern.
3. Within 15 simulated minutes, a concern document lands in
   `state/concerns/` with urgency >= warn, evidence pointing at the
   three injected runs.
4. Within 30 simulated minutes, a proposal lands in
   `state/manager_proposals/` (new directory) with target_class ∈
   {persona_settings, prompt_edit} for the SM persona, and a unified
   diff that applies cleanly.
5. The L4 apply pipeline opens a PR labeled
   `factory-self-improvement-safe` (or `-review` if classified risky),
   CI runs, and the PR auto-merges (or queues for review) without
   operator action.
6. The full test runs in CI with all LLM calls mocked via recorded
   fixtures, so the loop is testable without spending money.

Additional non-test acceptance:

* Every signal listed in §Signal sources is being written by the live
  chain (verifiable via `factory manager signals dump`).
* The factory's own context modules exist under
  `apps/factory/context/modules/`.
* No new hardcoded heuristic gates any decision in the L1/L2/L3 layer.
  Every classification, anomaly call, and urgency rating is the output
  of an LLM, not a regex or a numeric threshold. (Detectors return
  *data*; agents make decisions.)
* `factory_improver` continues to run for dev/test signals — this
  direction adds, doesn't replace.

## Out of scope for this direction

* Replacing `factory_improver`. The two systems coexist; subsumption
  is a follow-up.
* Multi-app aggregation. The FMS watches the factory; per-app concern
  routing (e.g., sacrifice-specific dashboards) can come later.
* Cross-tick parallel dispatch. The "tick loop is sequential" finding
  from today's incident is a legitimate redesign target, but it's a
  *consequence* the FMS will surface, not part of the FMS itself. The
  FMS's job is to detect the bottleneck and propose a fix; landing the
  fix is a separate direction the FMS itself will spawn.
* Externalising signals to a TSDB / Prometheus / etc. NDJSON files on
  disk are sufficient at MVP; an external store can come later if the
  retention or query needs justify the operational cost.
* Frontend / TUI changes. The existing `factory tui` already shows the
  data we need; concerns and proposals can surface there in a follow-up
  direction.

## Implementation status (post-Phase-9)

Phases 0-9 complete. MVP cutline (Phase 6) closed with the chained
integration test. Recursion safety + circuit breaker live. The factory
now reads context modules describing itself; the L3 Diagnostician's
proposals are informed by the same architectural summaries the L4
apply pipeline gates against. The loop closes.
