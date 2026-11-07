<!-- STALE as of 2026-08-07: the four manager LLM tiers and factory_improver described below were deleted (op/019-p0). Regeneration pending. -->

# manager — the Factory Management System (FMS)

## Overview

The FMS is the factory's self-observation and self-modification loop, living
entirely under `factory/manager/`. It has grown from a four-tier escalation
pipeline into two cooperating layers:

1. **The escalation pipeline** (LLM-driven): L1 `watcher.py` → L2
   `summarizer.py` → L3 `diagnostician.py` → L4 `apply.py`. Detection and
   diagnosis are agentic; `factory/personas/manager_watcher.md`,
   `manager_summarizer.md`, and `manager_diagnostician.md` hold the judgment.
   The Python in `watcher.py`/`summarizer.py`/`diagnostician.py` is plumbing
   only — it assembles context, calls `factory.runner.text_run`, and persists
   results.
2. **The operational recovery layer** (deterministic): `recovery.py` runs
   BEFORE the escalation pipeline every daemon iteration and directly fixes a
   short list of known operational faults (stuck stories, phantom PRs, a
   wedged `fix-only` mode, poisoned DB rows) instead of routing them through
   three LLM calls to land on `escalate_to_human`. This closed the FMS's
   worst blind spot: before `recovery.py` existed, 100% of 124 production
   proposals for these fault classes ended as `escalate_to_human` because
   L3's action space was code-diffs-only and none of these faults are fixed
   by a code diff — they need a DB write or a config flip.

Two more subsystems make self-modification safe: `staging.py` (a shadow
deploy that runs a self-edit on a throwaway clone before it ever reaches the
live factory) and `escalation.py` / `poison_escalation.py` (which turn a
dead-end `escalate_to_human`/`forbidden`/poisoned-row verdict into a visible,
deduped GitHub issue instead of a silent line in a history file). `halt.py`
and `circuit_breaker.py` remain the two stop mechanisms. `self_context.py`
keeps the factory's own architecture docs (including this file) fresh so L3's
diagnosis stays grounded. `factory/power.py` is a separate, non-LLM kill
switch for the systemd units the whole FMS runs on.

Design principle carried over unchanged from the original FMS: **"LLMs are
the basis; heuristics are tools the LLMs call."** Every heuristic in this
subsystem — `apply.py`'s classifier, every `recovery.py` precondition
detector, the detector functions under `detectors/` — is deliberately
deterministic and LLM-free, because the actions they gate (mutating live
story/deploy state, applying a patch to the running factory) need hard
guarantees an LLM cannot provide. Every judgment call about whether an
observation is *anomalous* stays with an LLM persona.

## Key concepts

### The four-tier escalation pipeline

- **L1 `run_watcher_once`** (`watcher.py`) — runs every 60s via
  `run_watcher_daemon`, but only pays for an LLM call when
  `_streams_have_new_events` finds new events since the last watcher note
  (the L1 cost gate: measured 2026-07-24 at 44,111 calls / $971.86 / 87% of
  all run rows against a 7.2% escalation rate before this gate existed).
  Calls all 11 detectors in `factory/manager/detectors/` (see below), reads
  raw streams `runs, ticks, queue, webhooks, git, spend, recovery, idle`
  (capped at 200 lines/stream, 500 chars/string), and the last 10 prior
  watcher notes for continuity. Writes to
  `state/events/watcher_notes.ndjson`. When `stalled_stories` reports
  `healthy_drain=true`, `_build_user_message` injects an explicit
  "do not escalate on the aged backlog" instruction — the prior failure mode
  was a churn loop that escalated a normal end-of-backlog drain.
- **L2 `run_summarizer_once`** (`summarizer.py`) — triggered immediately when
  L1 sets `escalate_to_l2=true`, else every 180s. Reads flagged watcher notes
  since the last concern, reconstructs the underlying signal window for each,
  and asks a mid-tier model to produce a *concern document* (title,
  description, evidence, `proposed_area`, `urgency`, `escalate_to_l3`).
  Writes `state/concerns/<ts>-<slug>.json` + `state/events/concerns.ndjson`.
  Every concern is stamped with a stable `concern_id` (`concern_id_for`,
  `_concern_signature`) hashing normalized title + app + proposed_area +
  urgency + evidence kinds — NOT timestamps or run ids — so a re-fired
  concern about the same condition is recognized as the same concern. A
  concern with a signature seen within `_CONCERN_DEDUP_COOLDOWN` (60 min) is
  suppressed (returns `{"suppressed": True, ...}`) rather than re-emitted —
  this killed a 25-concerns/day draining-mode storm.
- **L3 `run_diagnostician_once`** (`diagnostician.py`) — triggered
  immediately when L2 sets `escalate_to_l3=true`, else finds the most recent
  unprocessed concern via `_find_unprocessed_concern` (dedup on `concern_id`,
  falling back to title match for legacy proposals). Pre-loads source files
  by `proposed_area` (`_pre_load_source`): `prompt`/`prompt_edit` loads all
  personas; `persona_settings` adds `routes.yaml`; `detector_tool` loads
  `manager/detectors/*.py` + `signals.py`; `dispatch_code` and the
  `unknown`/else branch load the WHOLE `factory/chain/` directory (widened
  2026-07 after a 3-file hardcoded allowlist caused ~100% escalation on
  dispatch_code concerns), priority files guaranteed to load first, 560KB
  bundle cap (vs 100KB for the narrow prompt/settings/detector/observability
  areas). Also injects up to 5 prior FAILED apply attempts for the same
  `concern_title` (`_load_recent_failed_applies`, including
  `escalation_acknowledged`/`staging_rejected` — omitting those hid 66% of
  lifetime outcomes from this feedback channel) and the matching
  `apps/factory/context/modules/*.md` self-context module. Writes
  `state/manager_proposals/<ts>-<slug>.json` + a stable content-derived
  `proposal_id`. L3 alone may set `request_halt`/`halt_reason` (Phase 7 halt
  authority).
- **L4 `apply_manager_proposals`** (`apply.py`) — processes every unprocessed
  proposal in `state/manager_proposals/*.json` (dedup by `proposal_id` then
  path, `_is_already_processed`). First checks `circuit_breaker.is_tripped`
  — if tripped, returns immediately with `halted_by_circuit_breaker=True` and
  applies nothing. Classifies via `_classify_manager_proposal` (the one
  rule-based judgment in the pipeline, detailed below), then routes:
  `safe` → branch + apply patch + run test suite + commit + push + open a PR
  with `auto_merge=True`; `risky` → same but PR is review-only (no
  auto-merge); `forbidden`/`escalate_to_human` → no repo mutation, instead
  `escalation.notify_escalation` fires. Every apply attempt (success or
  failure) is recorded to `state/.manager_apply_history.json` including the
  `error` field — its 2026-07-24 addition retroactively explained 53
  consecutive `dirty_working_tree` aborts that had been invisible for 59
  days because only a bare `status` was kept.

### The operational recovery layer (`recovery.py`)

Runs every daemon iteration in `run_watcher_daemon`, BEFORE the poisoned-row
escalation check and BEFORE the L1/L2/L3/L4 chain, so a fault it fixes never
reaches an LLM at all. Structure: pure `detect_*` functions (read-only DB +
read-only `gh`/`git` calls that fail to `None`/uncertain rather than guess)
paired with `execute_*` functions (the actual mutation, gated by `dry_run`).
Six playbooks, registered declaratively in `build_recovery_registry`:

1. **`retry-mergeable-blocked-story`** — a story stuck
   `blocked_deploy_failed` whose PR is provably OPEN + MERGEABLE on GitHub
   now (the block was transient) → reset state to `pr_open`, clear error.
2. **`redispatch-phantom-pr-open`** — a story stuck in `pr_open` with no PR
   number and no matching branch on origin, older than 30 minutes (dispatcher
   died mid-create) → reset to `story_created`, clear PR/branch/error fields.
3. **`revert-premature-deploy-enable`** — an app's effective
   `deploy.enabled=true` but the deploy artifact its own
   `docker compose -f <file>` pre-deploy command references does not exist
   on disk → set a machine-only `deploy_enabled=false` OVERRIDE in
   `state/runtime/<app>.json` (never touches the operator's `config.yaml`).
4. **`conflicting-gated-pr`** (escalate-only, never mutates) — a story past
   a gate state (`pr_open`/`ci_green`/`ready_for_merge`) whose PR is
   `mergeable=CONFLICTING` → produces a concrete rebase recommendation for a
   human; a real content conflict needs human judgment, so no auto-rebase is
   attempted.
5. **`recover-stuck-fixonly-mode`** — factory mode is `fix-only` AND every
   in-scope app has `deploy.enabled=False` (nothing live could be regressing)
   → set mode back to `normal`. `fix-only` is set by
   `factory/deploy/orchestrator.py` on a deploy failure but nothing else ever
   flips it back. (`factory/chain/rollback.py` — the `factory rollback-watch`
   post-merge CI-revert worker — also used to set `fix-only` on a revert; it
   was deleted 2026-08-07, 019 AC5, so that second setter is gone too.)
6. **`quarantine-invalid-enum-story`** — a story row whose `state` string is
   outside the `StoryState` enum (a "poisoned" row from a bad manual/manager
   write) → move it to the terminal `quarantined_invalid_state` sink,
   preserving the original invalid value in `error` for forensics.

Anti-thrash rails, shared by every mutating playbook via `_apply_playbook`:
a `(playbook, target_key)` pair that was `recovered` within the cooldown
(default 30 min, `_recently_recovered`) is skipped and escalated instead of
re-looped; a hard per-cycle cap (default 5 real mutations,
`DEFAULT_MAX_ACTIONS_PER_CYCLE`) bounds blast radius; every precondition is
re-checked at execute time (`skipped_stale`) in case it changed between
detection and execution within the same cycle. Every decision — recovered,
dry-run, skipped, escalated, error — is appended to
`state/events/recovery.ndjson`. If the factory is halted
(`factory.manager.halt.is_halted`), `run_recovery_cycle` forces
`dry_run=True` regardless of the caller's argument: recovery keeps detecting
and logging but performs zero mutation while halted.

### Poisoned-row escalation (`poison_escalation.py`)

The DETECTOR half of the fix whose reconciler half is playbook 6 above. The
tick guard already skips an invalid-enum row non-fatally, but that skip is
otherwise silent forever. `escalate_poisoned_rows` (called once per daemon
iteration, BEFORE `run_recovery_cycle` so it captures the row's identity
before playbook 6 quarantines it and the identity disappears) fires only
when BOTH hold: a recent `tick_end` reported `skipped > 0`
(`recent_skipped_total`) AND `detect_invalid_enum_stories` still finds
poisoned rows. Dedupes on a stable signature over sorted
`app:story_id:invalid_state` triples (`poison_signature`) against a 60-minute
cooldown read from `state/events/poison_escalations.ndjson`, then opens a
GitHub issue via the shared `escalation.notify_escalation` channel.

### Escalation visibility (`escalation.py`)

Before this module, a proposal classified `forbidden` or `escalate_to_human`
died silently in `.manager_apply_history.json` — given the FMS escalates
~66% of proposals, this was the single biggest hole in the loop.
`notify_escalation` now, best-effort, always: (1) opens a `gh issue create`
on the factory repo labelled `fms-escalation`, body carrying the diagnosis,
proposed action, escalation reason, and (if every rendered field came back
empty) the raw payload verbatim so a mis-keyed proposal is never invisible;
(2) is idempotent on the stable `concern_id`/`proposal_id` — the dedup
AUTHORITY is whether an OPEN `fms-escalation` issue for that id currently
exists on GitHub (`_open_issue_lookup`), NOT the local
`.manager_escalation_history.json` ledger (only a fallback for when `gh`
cannot be reached) — so a concern whose issue a human closed and which then
recurs can re-escalate instead of being permanently suppressed;
(3) emits a `write_alert_event` regardless of whether `gh` succeeds. A `gh`
failure is itself recorded on the outcome and alerted, never swallowed.

### Staging: the shadow-deploy gate for self-edits (`staging.py`)

The runtime safety net that lets the WS3.1-broadened "safe" classifier rule
(below) exist at all. Any proposal whose patch touches `factory/**` (checked
via `staging.is_self_edit`) is NOT applied directly to the live factory.
`apply._apply_one_manager_proposal` instead calls `staging.gate_self_edit`:

1. **Sync** a throwaway COPY repo's `main`
   (`git@github.com:xvanov/software-factory-copy.git`) to the real
   `origin/main` (`sync_copy_from_main`, force-push mirror) so validation
   always runs on top of current factory code.
2. **Apply** the proposal's diff on a fresh `staging/<proposal_id>` branch of
   the COPY, commit, force-push it to the COPY (never the real repo).
3. **Validate** on a separate isolated checkout of that pushed branch, in
   order, stopping at the first failure: `uv sync --all-extras` → `uv run
   pytest -q` (full suite) → `uv run factory --help` (import + CLI load) →
   `uv run factory tick --app <app> --dry-run` (the real tick orchestration
   path; `--dry-run` performs no LLM/GitHub/repo writes, so this exercises
   the real code for free). A real non-dry-run tick is deliberately never
   run — a deliberate cost/coverage tradeoff.
4. Only `healthy=True` (every stage passed) yields `promote=True`
   (`StagingDecision.promote`). Anything else — an unhealthy stage, a
   clone/push/apply failure, a subprocess timeout — resolves to
   `promote=False` and the real factory is never touched; `apply.py` records
   `staging_rejected` or `staging_infra_failed` without ever creating a
   branch on the live repo.

This is why `_classify_manager_proposal` can safely call a broad
`factory/**/*.py` self-edit "safe" — the safety net moved from static
classification to a runtime clone-and-run.

### Self-context refresh (`self_context.py`)

Generates the six `apps/factory/context/modules/*.md` files (including this
one) that `diagnostician._pre_load_source` injects into L3's context bundle
by `proposed_area` (`_AREA_TO_MODULES`), so L3's architectural understanding
of the factory stays current without re-reading raw source every proposal.
`refresh_factory_context(module=None)` regenerates all six via
`factory manager refresh-context`; each module is capped at 16KB, written
atomically (temp file + rename), and every outcome is logged to
`state/events/context_refresh.ndjson`. LLM failures are logged, never
propagated — a stale context module is a quality issue, not a crash.

### L4 classifier (`_classify_manager_proposal` in `apply.py`)

Checked in this exact order:

1. `target_class == "escalate_to_human"` or `escalate_to_human=True` →
   `escalate_to_human` (checked first).
2. Patch is empty, not a valid unified diff, or has no target paths →
   `forbidden`.
3. Any target path matches a forbidden pattern (below; patch-context aware
   via `_any_path_is_forbidden_in_patch` so the new-detector carve-out
   applies) → `forbidden`.
4. Any target path matches `factory/personas/manager_[^/]+\.md$` (the
   manager editing its own persona prompts) → `risky` — checked before the
   broadened self-edit rule below so it can never sneak through as "safe".
5. **Every** target path matches `factory/.+\.py$` (a pure factory-Python
   self-edit, `_all_paths_are_factory_python_self_edit`) → `safe`. The
   WS3.1 broadening: covers `dispatch_code` and any other Python-only
   self-edit because `staging.py` actually runs the change before
   promotion — the safety net moved off this static rule. NOT covered:
   `apps/**` app code, or non-Python factory files (`.md`/`.yaml` — those
   keep the specific validators below).
6. `target_class == "dispatch_code"` and NOT a pure factory/*.py self-edit
   (touches app code or non-Python files) → `risky`.
7. `target_class == "prompt_edit"` → `safe` iff `_validate_prompt_edit`
   passes: only `factory/personas/*.md`, no new files, no frontmatter `---`
   delimiter added/removed (that's a settings change), ≤50 added/≤30
   deleted lines, no heading removed. Else `risky`.
8. `target_class == "persona_settings"` → `safe` iff
   `_validate_persona_settings` passes: only `factory/routes.yaml` or
   `factory/personas/*.md`; numeric fields in added lines within
   `_PERSONA_NUMERIC_CLAMPS` (`max_tokens`: 4000–65000, `temperature`:
   0.0–1.5); no novel lowercase numeric field names. Else `risky`.
9. `target_class == "detector_tool"` → `safe` iff `_validate_detector_tool`
   passes: only adds NEW files under `factory/manager/detectors/*.py`, or
   modifies `__init__.py` with import/registry-only lines; new files must
   `py_compile`. Modifying an existing detector file is never safe. Else
   `risky`.
10. Anything else (unknown `target_class`) → `risky` (already passed the
    forbidden-path check, but never auto-applied).

**Forbidden path patterns** (`_FORBIDDEN_PATH_PATTERNS`), matching CLAUDE.md's
"forbidden to self-edit" framing exactly, plus two classes CLAUDE.md doesn't
enumerate by file:

- `factory/manager/.+\.py$` — the manager editing itself, any depth. A
  narrow carve-out exists ONLY for a diff that *creates* (not modifies) a new
  file under `factory/manager/detectors/*.py` — that path is validated by
  `_validate_detector_tool` instead (the detector-authorship loop).
- `factory/chain/factory_improver_apply.py` and `factory/manager/apply.py`
  themselves — the apply pipeline cannot rewrite its own gate.
- `bench/.+$` — the held-out benchmark harness that judges the factory.
  Forbidden unconditionally, regardless of the staging gate: staging
  validates "does the factory run", not "is the bench still honest".
- `factory/observability/audit_chain.py`, `conformance.py`,
  `conformance_model.yaml`, `state_trace.py` — the integrity chain, the
  trace conformance checker, its abstract model, and the trace emitter.
  Weng's rule: a self-improving agent must not edit the tracer, the
  verifier, or the config that judges it — an editable grader is
  unfalsifiable.

### Two stop mechanisms

- **`halt.py`** — L3 is the ONLY writer (`request_halt`); only a human
  operator may clear it (`clear_halt`, via `factory resume`). `is_halted()`
  fails SAFE: a corrupt/unreadable halt file (after 3 bounded retries) is
  treated as `halted=True` plus a CRITICAL alert — the opposite of the
  historical fail-open bug. A 30-minute "resume grace window"
  (`_RESUME_GRACE_MINUTES`) after an operator clears a halt suppresses any
  new halt request — without it, a stall-class concern re-halted the
  factory 94 seconds after a live resume, before the first post-resume tick
  could land.
- **`circuit_breaker.py`** — deterministic, no LLM. `check_and_trip` runs the
  test suite; if it fails AND the current `HEAD` is a SHA previously recorded
  via `record_manager_commit` (called by `apply.py` after every manager
  commit), it auto-reverts on `factory-manager-revert/<ts>`, opens a
  human-review PR (never auto-merged), and writes
  `state/circuit_breaker.json` with a 24h `halt_until`. While tripped,
  `apply_manager_proposals` refuses ALL safe auto-apply (fails CLOSED on
  corrupt state); risky/operator-reviewed proposals are unaffected.
- Both daemons check `is_halted` every iteration and skip all LLM work while
  halted; a tripped circuit breaker is logged but only gates L4 apply.

### `factory/power.py` — the systemd kill switch (distinct from mode/halt)

Three genuinely different control surfaces: `factory pause`/`resume` set the
in-DB *mode* (processes keep ticking, just decline to dispatch — L1 watcher
still fires, spend doesn't go to zero); `factory halt` (FMS, above) is an
in-DB emergency brake the daemon checks per iteration; `factory on`/`off`/
`power` (`power.py`) stops or starts the actual systemd USER units —
`factory-tick@<app>.timer` (discovered dynamically from `apps/*/config.yaml`
via `discover_units`, not hardcoded), `<app>-redeploy-main.timer`,
`factory-self-deploy.timer`, `factory-manager.service` — so nothing runs and
nothing is billed. `power_off` stops timers first, drains in-flight tick
services for up to `DEFAULT_DRAIN_TIMEOUT_S` (300s), then stops the manager
service, then `reset-failed`s every unit. `power_on` clears `reset-failed`
state first, then starts services before timers (manager up before the
ticks it watches). Both are idempotent from any starting state — a half-up
factory (timers live, manager down, or vice versa) used to be
indistinguishable from healthy at a glance.

### The 11 detectors (`factory/manager/detectors/`)

Every detector is a pure, side-effect-free function; `DETECTOR_DOCS`
(`detectors/__init__.py`) maps name → docstring so the L1/L2 LLMs see what
each field means without reading source. None make a judgment call — they
all describe raw or lightly-aggregated data.

- **`runs_failed_since`** — every `success=False` run event since a
  timestamp, verbatim.
- **`retry_storm`** — failed-run counts grouped by `(story_id, persona)`,
  plus error excerpts.
- **`review_churn`** — CUMULATIVE (ignores the window) count of successful
  `reviewer`/`dev` runs per story; surfaces the green-but-never-converging
  dev↔reviewer ping-pong `retry_storm` cannot see (every run in that loop
  succeeds). Returns only stories with `reviewer_cycles >= 3` (default).
- **`cost_spike`** — recent spend vs. a trailing baseline from the spend/runs
  stream.
- **`conformance_breach`** — replays `state_writes` trace records through
  `factory.observability.conformance.check_trace`; returns
  `illegal_transition` (a sanctioned writer produced a disallowed state) or
  `coverage_breach` (an undeclared writer changed state, or attribution
  failed — the load-bearing case: state moved through a path nobody's model
  verified). Never blocks a merge by itself.
- **`fms_yield`** — reads `.manager_apply_history.json` + manager-persona
  spend from `runs.ndjson`; reports proposal→PR conversion (`shipped` =
  `opened_pr`/`applied`/`queued_for_review`) and `spend_per_shipped_usd`.
  Added 2026-07-24 after an audit found 59 days of measured lifetime yield
  ZERO (163 apply attempts, 0 ever set a `pr_number`, $1,028 spent — 53% of
  all factory LLM spend) with nothing in the system watching the watcher.
- **`tick_duration_outliers`** — pairs `tick_start`/`tick_end` events,
  computes p95 duration, flags outliers and still-running ticks.
- **`state_distribution_skew`** — per-app fraction of stories in each state
  from the latest `queue_snapshot`; flags a state exceeding 50% (bottleneck).
- **`worktree_orphans`** — cross-references `state/worktrees/*` directory
  names against the `stories` table; flags worktrees whose story is
  `done`/`cancelled` but the directory still exists.
- **`placeholder_prompts`** — surfaces `prompts.ndjson` rows where a literal
  placeholder string leaked into an actual LLM prompt — added after this
  exact bug caused stories 5/15/16/18/19/22 to churn dev↔reviewer 5+ times
  because the model never saw real data.
- **`stalled_stories`** — the ABSOLUTE liveness detector; ignores the event
  window and reads current DB state + last-tick timestamp directly, because
  every window-based detector goes blind exactly when the factory silently
  stalls (no events → empty window → "quiet, healthy"). Three alarm classes:
  `stuck_in_progress` (a `*_in_progress` story aged past 30 min), `stalled`
  (no state change in 120 min), `no_tick_recently` (no tick in 15 min AND no
  visible in-flight work). Also computes `healthy_drain` — an explicit
  "do not escalate" signal (no alarms AND draining AND a recent `app_idle`
  event) that stopped a 25-concerns/day churn loop during a normal
  end-of-backlog drain.

## Key files

- `factory/manager/watcher.py` — L1: cost-gated (`_streams_have_new_events`),
  60s-cadence LLM monitor over 11 detectors + 8 raw streams; triggers L2/L3/L4
  inline on escalation; runs recovery + poison-escalation + circuit-breaker
  checks every iteration ahead of any LLM call.
- `factory/manager/summarizer.py` — L2: turns escalated watcher notes into
  content-signature-deduped concern documents (`state/concerns/*.json`).
- `factory/manager/diagnostician.py` — L3: frontier-model proposal generator;
  `proposed_area`-scoped source pre-loading, failed-apply memory, self-context
  injection, halt-request handling.
- `factory/manager/apply.py` — L4: the one static classifier
  (`_classify_manager_proposal`) plus the full branch/patch/test/commit/PR
  apply loop, staging-gate integration, and circuit-breaker commit tracking.
- `factory/manager/recovery.py` — operational auto-fix layer: 6 deterministic
  playbooks (detect/execute pairs) with cooldown + per-cycle cap anti-thrash,
  logged to `state/events/recovery.ndjson`.
- `factory/manager/escalation.py` — makes `forbidden`/`escalate_to_human`
  verdicts visible: idempotent (GitHub-OPEN-state-authoritative) issue
  creation + guaranteed alert event.
- `factory/manager/poison_escalation.py` — escalates persistent invalid-enum
  DB rows to a GitHub issue when a recent tick actually skipped one, deduped
  on a stable row-signature + 60-min cooldown.
- `factory/manager/staging.py` — shadow-deploy validator: clones a throwaway
  COPY repo, applies a self-edit, and ACTUALLY RUNS it (deps, full suite,
  import/CLI smoke, dry-run tick) before the caller may promote it live.
- `factory/manager/self_context.py` — LLM-generated refresh of the six
  `apps/factory/context/modules/*.md` files L3 pre-loads by `proposed_area`.
- `factory/manager/halt.py` — halt-state authority (L3 requests, human
  clears); fail-safe (unreadable file → treated as halted).
- `factory/manager/circuit_breaker.py` — post-apply regression guard: revert
  + 24h halt of safe auto-apply on a manager-caused test failure; fail-closed
  on corrupt state.
- `factory/manager/detectors/*.py` — the 11 pure-function detectors listed
  above, registered in `detectors/__init__.py`'s `DETECTORS`/`DETECTOR_DOCS`.
- `factory/power.py` — systemd on/off/status for every factory-owned unit;
  distinct from both `factory pause`/`resume` (mode) and FMS `halt`.

## Failure modes

- **Watcher misses evidence due to windowing/truncation/cost-gating** — event
  files exceeding `_MAX_LINES_PER_STREAM` (200), payload strings over
  `_PAYLOAD_STRING_CAP` (500 chars), or (rarer, by design) the L1 cost gate
  skipping a cycle because no stream mtime changed since the last note.
  Symptom: `escalate_to_l2` stays false despite a real issue in the raw logs.
- **Recovery playbook thrash or under-fire** — a target flapping faster than
  the 30-min cooldown escalates instead of looping (by design); a target
  whose precondition detector cannot get a confident `gh`/`git` answer
  (`None`) is silently skipped forever rather than guessed at, falling
  through to an LLM escalation chain that may also never fire.
- **Staging false-negative from a shared-fate bug** — a self-edit that is
  individually correct but breaks only in combination with something the
  COPY's `main` doesn't yet reflect (a sync race) validates healthy and
  later regresses live main; the circuit breaker is the backstop for this.
- **Escalation gh-unreachable degradation** — when `gh` is down,
  `notify_escalation` falls back to the local
  `.manager_escalation_history.json` ledger, which (unlike the
  GitHub-OPEN-state check) cannot un-suppress a recurring, previously-
  resolved concern until `gh` recovers. The alert event still fires either
  way.
- **Poisoned-row escalation only fires on a live skip signal** — a poisoned
  row that predates the current `tick_end` window, or that no tick has
  skipped recently, produces `status: "no_skip_signal"` and stays invisible
  here (though other detectors may catch its symptoms).
- **Classifier misroutes an edge-case diff** — a patch that is ALL
  factory-Python yet logically entangled with app behavior (e.g. a shared
  config schema) is classified `safe` and only caught by staging's full
  test suite, not by static review.
- **Circuit breaker trips on an unrelated flaky test** — `check_and_trip`
  treats any non-zero test-suite exit on a tracked manager commit as a
  regression, triggering a real revert PR and a 24h halt of ALL safe
  auto-apply, not just the offending change.
- **Halt/resume-grace interaction** — a genuine new stall inside the 30-min
  post-resume grace window is deliberately NOT re-halted
  (`halt_suppressed_by_resume_grace=True`) — an operator must catch it
  manually during that window.
- **`factory off` drain timeout** — `power_off`'s default 300s drain window
  can expire while a legitimately long tick is still in flight;
  `drain_timed_out=True` is reported and the service is force-stopped
  anyway, recoverable via the normal stale-state reclaim path on `factory on`.

## Escalation paths

**Every daemon iteration, before any LLM call:**

1. Halt check (`is_halted`) — skip the entire iteration if halted.
2. Circuit-breaker check (informational only — detection continues either way).
3. `poison_escalation.escalate_poisoned_rows` — captures poisoned-row
   identity before recovery quarantines it.
4. `recovery.run_recovery_cycle` — the 6 playbooks, each either mutating
   (with cooldown/cap) or escalate-only. Anything a playbook cannot fix or
   that is deliberately human-judgment-only (playbook 4) falls through
   unresolved to the pipeline below.
5. L1 cost gate (`_streams_have_new_events`) — skip the paid watcher cycle
   if nothing changed since the last note.

**Normal LLM escalation chain** (only for what recovery/poison-escalation
didn't already resolve):

1. **L1 Watcher** reads streams + detectors, writes a note. If
   `escalate_to_l2=true`, L2 runs immediately in the same daemon iteration.
2. **L2 Summarizer** emits a concern document. Dedup/cooldown may suppress a
   repeat concern (`suppressed: True`) — no L3 run follows a suppressed
   concern. If `escalate_to_l3=true` and the concern isn't already processed
   (`_is_concern_processed`), L3 runs immediately.
3. **L3 Diagnostician** produces a proposal. If `escalate_to_human=true` or
   `request_halt=true`, that's handled directly (escalation channel / halt
   file) rather than flowing to L4's classifier. Otherwise L4 runs
   immediately when `auto_apply` is enabled (daemon default: ON).
4. **L4 Apply** classifies and either applies (`safe`), opens a
   review-required PR (`risky`), or calls `escalation.notify_escalation`
   (`forbidden`/`escalate_to_human`) — which opens/reuses a GitHub issue and
   always emits an alert, so nothing dies silently. A `safe` self-edit
   (touches `factory/**`) is routed through `staging.gate_self_edit` first;
   only a healthy clone reaches the PR/auto-merge step.

**If a manager-authored commit regresses `main`:** `circuit_breaker.
check_and_trip` (periodic, every `circuit_breaker_interval_min` — default
30 — when there are tracked commits) reverts it on
`factory-manager-revert/<ts>`, opens a human-review PR, and blocks all safe
auto-apply for 24h. Operator must merge/discard the revert PR, then run
`factory manager circuit-breaker reset`.

**If L3 requests a halt:** `state/factory_mode.json` is written with
`mode: "halted"`; the orchestrator's driver loop and `tick()` refuse to
dispatch. Only `factory resume` (human-invoked `clear_halt`) clears it — no
LLM path may call it, and the 30-min resume grace window suppresses an
immediate re-halt.

**Operator surface for all of the above:**

- `factory manager watch` / `diagnose` / `apply` — run one tier by hand.
- `factory manager circuit-breaker status` / `check` / `reset`.
- `factory manager refresh-context [--module <name>]` — force a self-context
  regeneration.
- `factory resume` — clear an FMS halt (operator-only, never automate).
- `factory on` / `off` / `power` — start/stop/inspect the systemd units the
  whole FMS (and the tick loop it watches) runs on.
- Inspect: `state/concerns/*.json`, `state/manager_proposals/*.json`,
  `state/factory_mode.json`, `state/circuit_breaker.json`,
  `state/.manager_apply_history.json`, `state/events/recovery.ndjson`,
  `state/events/poison_escalations.ndjson`, open GitHub issues labelled
  `fms-escalation`.
