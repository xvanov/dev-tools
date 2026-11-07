# Dispatch — gating story-handler dispatch via mode, caps, rate limits, and dependency ordering

## Overview

Every tick, `factory.chain.orchestrator.tick()` walks each in-flight
`StoryRecord` for an app, resolves the handler for its current `StoryState`,
and runs two gates before invoking that handler:

1. **The dependency-ordering gate**, inline in the tick loop in
   `orchestrator.py` (~line 2650 on) — a story is deferred, never
   dispatched, while a lower-id sibling in the same direction is still
   unresolved. Runs BEFORE the settings enforcer, so a story can be
   deferred here even when `can_dispatch` would otherwise allow it.
2. **The settings enforcer** — `factory.settings.enforcer.can_dispatch(job_kind,
   app, current_state, settings)`, a pure function returning
   `DispatchDecision(allowed, rejected_reason, retry_after_seconds)`.

If either gate rejects, the handler is not invoked this tick: the dependency
gate logs `dependency_deferred` (or, past its cap, `dependency_deferral_capped`)
and appends to `TickSummary.deferred`; an enforcer rejection sets
`story.last_rejection_reason`, appends to `TickSummary.rejected`, and
increments `TickSummary.blocked_by_caps`. Neither path fails the tick — the
story is simply retried next tick. `factory why <story-id>` runs both gates
live (read-only) and prints a "next-tick projection" so an operator sees
which gate would fire, and why, without waiting for the next tick.

## Key concepts

### `can_dispatch` check order (first rejection wins)

`can_dispatch` (`factory/settings/enforcer.py`) runs these checks in order
and returns on the first failure:

1. **Mode block** — `_mode_blocks(mode, job_kind)`. Reason
   `mode_{mode}_blocks_{job_kind}` (e.g. `mode_fix_only_blocks_dev`).
2. **Global concurrency** — `global_in_flight >= caps.global_concurrent_agents`
   → `global_concurrent_agents_cap_exceeded`, retry 60s.
3. **Per-repo concurrency** — `app_in_flight >= caps.per_repo_concurrent_agents`
   → `per_repo_concurrent_agents_cap_exceeded`, retry 60s.
4. **Daily spend** — `today_spend_usd >= caps.daily_spend_usd` →
   `daily_spend_cap_exceeded`, retry 3600s.
5. **Hourly spend** — `hour_spend_usd >= caps.hourly_spend_usd` →
   `hourly_spend_cap_exceeded`, retry 300s.
6. **Human-review PR ceiling** — `open_prs_for_app >= queues.human_review_max_open_prs`,
   skipped when `open_prs_for_app is None` (no `github_client`), exempted for
   `job_kind in {"review", "docs_enforcer"}` so review work always drains
   the queue it's gated on → `human_review_max_open_prs_exceeded`, retry 600s.
7. **Failing-CI pause** — `failing_ci_count >= queues.failing_ci_pause_threshold`,
   only for `job_kind in {"sm", "dev"}`, skipped when `None` →
   `failing_ci_pause_threshold_exceeded`, retry 900s.
8. **PM rate limit** — only for `job_kind == "pm"`:
   `pm_invocations_last_hour >= rate_limits.pm_invocations_per_hour` →
   `pm_invocations_per_hour_exceeded`, retry 600s.
9. **Scheduled-persona daily caps** — for `job_kind in {"security",
   "ux_auditor"}` (`ralph`/`bug_hunter` and their caps were deleted
   2026-08-07, 019 AC5): `<job_kind>_runs_today >=
   rate_limits.<job_kind>_runs_per_day` → `<job_kind>_rate_limit_exceeded`,
   retry 3600s.

Otherwise `DispatchDecision(allowed=True)`. All inputs come from the
`current_state` dict the orchestrator assembles fresh every tick
(`_build_current_state`); `can_dispatch` itself touches no DB or file,
which is what makes it pure and cheap to call from `factory why`.

### Mode catalog and blocking table

`ModesConfig.available` / `factory_settings.yaml::modes.available`:
`normal`, `fix-only`, `drain-reviews`, `paused`, `exploratory`,
`deploy-frozen`, `ux-audit-only`. Default is `normal`. `load_settings`
raises `ValueError` at load time if `modes.default` isn't itself in
`modes.available`. `_MODE_BLOCKS` in `enforcer.py`:

| mode | blocked `job_kind`s |
|---|---|
| `paused` | everything (`"ALL"`) |
| `fix-only` | `sm`, `dev`, `review`, `tech_writer`, `docs_enforcer` — except `-bug` variants |
| `drain-reviews` | `sm`, `dev`, `tech_writer`, `docs_enforcer` |
| `deploy-frozen` | `deploy`, `release` |
| `ux-audit-only` | `sm`, `dev`, `review`, `tech_writer` |
| `normal`, `exploratory` | nothing extra |

### Bug-aware `job_kind` resolution (how `fix-only` lets bug work through)

The enforcer's `_mode_blocks()` special-cases four suffixed kinds
(`_BUG_FIX_JOB_KINDS = {"dev-bug", "review-bug", "test_design-bug",
"test_impl-bug"}`): under `fix-only` a `job_kind` in that set is never
blocked. The orchestrator is the sole producer of these suffixes: before
every dispatch it calls `_resolve_job_kind(story, direction, handler_kind)`
(`orchestrator.py:57`), appending `-bug` for `handler_kind in
_BUG_AWARE_HANDLER_KINDS = {"sm", "dev", "review"}` when the work is
bug-scoped (`direction.type_tag == "bug"`, case-insensitive, or
`story.scope == "bug"`). The two lists differ by design (enforcer's set
also covers `test_design-bug`/`test_impl-bug` produced elsewhere;
orchestrator's omits `tech_writer`/`docs_enforcer`, which stay blocked
under `fix-only`) and are kept aligned by comment convention, not shared
code (see Failure modes).

### Dependency-deferral cap

Independent of `can_dispatch`, the orchestrator enforces same-direction
build order: a story never builds while a lower-id sibling in its direction
is unresolved. That deferral used to be unbounded — a foundation story
stuck in a human-blocked sink (e.g. `blocked_deploy_failed`) left every
dependent deferring *every tick, forever*, un-escalated (2026-07-28, D018:
stories 168-171 idled behind story 167 for two hours while each tick
printed "No in-flight stories"). `_MAX_DEPENDENCY_DEFERRALS = 3` plus
supporting state (`orchestrator.py`) now caps that:

- **`_DEAD_END_DEP_STATES`** — definitively abandoned:
  `superseded_by_sibling`, `blocked_ci_unresolved`,
  `blocked_dependency_unmet`, `closed_by_operator`. If every pending
  dependency is in this set, `_deps_permanently_dead()` fires the
  pre-existing **deadlock guard** immediately: park in
  `blocked_dependency_unmet` as `dependency_deadlocked`, no counter, no
  cap window.
- **`_STALLED_DEP_STATES`** — the deadlock set UNION `_PENDING_HUMAN_STATES`
  (`blocked_deploy_failed`, `blocked_budget_exceeded`,
  `blocked_tests_need_clarification`, `blocked_review_nonconvergent` —
  recoverable by a human/FMS, not by a tick) UNION
  `quarantined_invalid_state`. If every pending dependency is in this
  broader set, `_deps_all_stalled()` is true and the deferral counts
  toward the cap; any dependency in a live state (e.g. `story_created`,
  `*_in_progress`, `pr_open`, `ci_pending`, `deploy_pending`) resets
  `story.dependency_defer_count` to 0 — ordinary foundation-waiting never
  counts, however long it takes.
- **Count**: `story.dependency_defer_count`, bumped by
  `_bump_dependency_defer_count()` per consecutive fully-stalled tick.
  Bypasses `persist_story` deliberately — it must NOT stamp `updated_at`,
  or the row would look freshly-worked to
  `manager/detectors/stalled_stories.py` (a MIN over all rows) and mask the
  very stall this cap exists to surface.
- **Age gate**: `_MIN_DEP_STALL_SECONDS = 45*60` — blockers must also be
  untouched (`updated_at`) for 45 minutes (`_deps_stalled_long_enough()`),
  clearing the FMS `retry-mergeable-blocked-story` playbook's 30-minute
  cooldown with margin before the cap gives up on it.
- **Trip** (`_cap_park`, all must hold): deps fully stalled AND
  `dependency_defer_count >= 3` AND story state is not `deploy_pending`
  (merged code is never abandoned — it'd strand deployed work and let its
  tracker close over it) AND not a dry run AND mode not in
  `{"paused", "drain-reviews"}` AND the age gate passes.
- **On trip**: state → `blocked_dependency_unmet`, `last_rejection_reason`
  prefixed `dependency_deferral_cap_exhausted`
  (`DEP_DEFER_CAP_REASON_PREFIX` in `state_machine.py`), event
  `dependency_deferral_capped` logged, counted in both
  `TickSummary.deferred` and `TickSummary.stories_blocked`.
- **Revival**: `_revive_capped_dependents()` runs every tick, un-parking any
  row carrying the cap-reason marker — resuming at the SAME state it was
  parked from (not `story_created`, to avoid re-burning spend and
  discarding a reviewer verdict) — the moment none of its pending
  dependencies are still in `_STALLED_DEP_STATES`. Counter resets to 0.
  `is_dependency_cap_parked()` (`state_machine.py`) distinguishes a
  cap-park from a deadlock-park sharing the same terminal state.

`factory why <story-id>` computes this live and prints "would PARK
(dependency deadlock)", "would DEFER ... (blockers still in progress; cap
doesn't count while any blocker is live)", or "would DEFER ... stalled
deferrals N/3 ... parks after K more stalled tick(s) / holding for the 45m
stall window".

### Caps, rate limits, and their live config

`FactorySettings` (`factory/settings/loader.py`) loads once per process
from `factory_settings.yaml` at repo root (memoized per root by
`load_settings`; `reload_settings` busts the cache). Current values:

- **`caps`**: `global_concurrent_agents: 10`, `per_repo_concurrent_agents: 10`
  (raised from the historical 2 — each story runs in its own git worktree
  under `state/worktrees/`, so concurrency no longer contends on a shared
  tree), `daily_spend_usd: 300`, `hourly_spend_usd: 40` (raised from 15 on
  2026-05-30 for ~29 re-dispatched stories to reprocess in parallel; the
  operator-approved real ceiling per `CLAUDE.md` is $200/day with
  notification at $50/$75/$100). Also `per_story_spend_usd: 5.0` and
  `per_story_attempts: 20` — a per-story circuit breaker NOT enforced by
  `can_dispatch`; it bounds one story's aggregate cost across every
  composed loop (dev retries, reviewer cycles, tech_writer, docs,
  auto-recovery re-dispatch, CI-fix), advancing it to
  `BLOCKED_BUDGET_EXCEEDED` when crossed.
- **`queues`**: `human_review_max_open_prs: 5`, `failing_ci_pause_threshold: 3`.
- **`rate_limits`**: `pm_invocations_per_hour: 4`, `security_runs_per_day: 2`,
  `ux_auditor_runs_per_day: 1` (throttled 2026-07-24, was 4). `ralph_runs_per_day`
  and `bug_hunter_runs_per_day` were deleted 2026-08-07 (019 AC5) along with
  the `ralph`/`bug_hunter` personas and schedules. `factory_improver` (and its
  `factory_improver_runs_per_day` circuit-breaker cap) was also retired
  2026-08-07 — 1 commit landed in 196 proposals.
- **`modes`**: `default: normal`, `available` as above.

### Scheduled-persona cadence vs. rate-limit cap

`factory/scheduler/cron.py` reads `factory_settings.yaml::schedules`
(independent of `rate_limits`) for WHEN a persona is due; `rate_limits`
(via `can_dispatch`'s daily-cap block) decides whether it's still ALLOWED
to fire once due. Live schedule: `security_weekly` weekly, Mondays at 09:00 (`0 9 * * 1`,
bounded by `security_runs_per_day: 2`) — fixed 2026-08-08 (pre-sim hygiene,
S11) after drift left the deployed cron as `0 9 * * *` (daily, despite the
schedule's name) and it filed two operator-approval-gated directions in a
single day; `_DEFAULT_SCHEDULES` in `factory/scheduler/cron.py` was the
weekly cadence all along. `ux_audit` is pinned to `0 9 1 1 *` (once a year) — a deliberate
near-total disable after the auditor filed self-referential directions
faster than an operator could review them; `factory ux-audit-now` is the
on-demand escape hatch. The `ralph` (hourly) and `bug_hunt` (every 4h)
schedules/personas were deleted 2026-08-07 (019 AC5) — `ralph` had
previously locked itself out for weeks on its own `rate_limited` rows
(6,328 `rate_limited` rows vs. 91 real runs) before that counting bug was
fixed; that history stays as a regression note in
`tests/test_cron_scheduler.py` even though the persona itself is gone.
`is_due()` compares the schedule's cron fire-time against
`cron_schedules.last_run` (a failed run still counts as "ran" so a broken
persona doesn't refire every tick). `due_schedules()` separately checks
`runs_in_window()` (rolling 24h/1h count, excluding `rate_limited`/
`rejected` rows) against `rate_limits.<rate_limit_key>`, writing an audit
row on a rate-limited skip so it's visible in `factory schedules`/
`factory inbox`.

## Key files

- **`factory/settings/enforcer.py`** — `can_dispatch()` / `_mode_blocks()`;
  sole producer of `rejected_reason` strings. Pure function of its args.
- **`factory/settings/loader.py`** — `FactorySettings` and nested models
  (`CapsConfig`, `QueuesConfig`, `RateLimitsConfig`, `ModesConfig`, plus
  `AutoMergeConfig`/`AutoPMSyncConfig`/`AutoIntakeConfig`/
  `DevConvergenceConfig`/`CiHealthConfig` — these gate other tick behavior,
  not dispatch); `load_settings`/`reload_settings`/`is_valid_mode`.
- **`factory/settings/modes.py`** — `FactoryState` (single-row SQLModel
  table `factory_state`); `get_mode()` lazily seeds from
  `settings.modes.default`; `set_mode()` validates against
  `modes.available`.
- **`factory/settings/spend.py`** — `today_spend_usd()`, `hour_spend_usd()`,
  `persona_runs_today()` (feeds `can_dispatch`'s `_DAILY_CAPS` block),
  `projected_end_of_day()`, all over the `runs` table.
- **`factory/chain/orchestrator.py`** — integration point: calls
  `_resolve_job_kind()` then `can_dispatch()` per story, and ahead of that
  runs the dependency-ordering/deferral-cap block (`_DEAD_END_DEP_STATES`,
  `_STALLED_DEP_STATES`, `_MAX_DEPENDENCY_DEFERRALS`,
  `_MIN_DEP_STALL_SECONDS`, `_deps_permanently_dead()`,
  `_deps_all_stalled()`, `_deps_stalled_long_enough()`,
  `_bump_dependency_defer_count()`, `_revive_capped_dependents()`).
  Populates `TickSummary` (`blocked_by_caps`, `stories_blocked`,
  `rejected`, `deferred`, `handler_runs`).
- **`factory/chain/state_machine.py`** — `StoryState.BLOCKED_DEPENDENCY_UNMET`;
  `dependency_defer_count` on `StoryRecord`; `DEP_DEFER_CAP_REASON_PREFIX`;
  `is_dependency_cap_parked()`.
- **`factory/scheduler/cron.py`** — `load_schedules()`, `is_due()`,
  `due_schedules()`, `runs_in_window()`.
- **`factory/cli.py`** (`why_cmd`, ~line 1839) — runs both gates live and
  prints the "next-tick projection" line.
- **`factory_settings.yaml`** (repo root) — actual current values, see above.

## Failure modes

- **Bug/feature misclassification under `fix-only`.** A missing or
  misspelled `type_tag`/`scope` on bug-typed work resolves to the bare
  job_kind, gets blocked, and reads identically to a real feature-work
  block (`rejected_reason=mode_fix_only_blocks_dev`) — an operator must
  check the direction's `type_tag` to tell them apart.
- **`_BUG_AWARE_HANDLER_KINDS` (orchestrator) and `_BUG_FIX_JOB_KINDS`
  (enforcer) drifting out of sync** — kept aligned by comment convention,
  not shared code. Editing one without the other either lets `fix-only`
  block a real bug fix, or lets feature work slip through.
- **Invalid `modes.default` in YAML** fails `load_settings()` at load
  time — takes down every tick, not just mode-gated ones.
- **`set_mode()` rejects an unknown mode name** (raises `ValueError`); the
  persisted mode is untouched, so a typo'd `factory mode` invocation fails
  loudly rather than silently taking effect.
- **Settings memoization staleness** — `load_settings()` caches per root
  for the process lifetime; editing `factory_settings.yaml` without a
  restart or `reload_settings()` leaves `can_dispatch` enforcing stale
  caps/modes/rate-limits.
- **Dependency-cap bookkeeping fails open, not closed** — any exception
  bumping `dependency_defer_count` or writing the cap-park is caught,
  logged as `dependency_deferral_cap_error`, and `_cap_park` forced False,
  so the story falls through to a plain uncapped deferral. Prevents a
  locked-DB write from crashing the tick, but a persistently failing write
  silently reverts that one story to the pre-2026-07-30 unbounded-wait
  behavior.
- **`deploy_pending` stories never cap-park, by design** — if their
  blocking sibling stays human-blocked forever, they defer every tick with
  no ceiling (deliberate: "cap everything" lost to "never abandon merged
  code").
- **The 45-minute stall-age gate can mask a cap that "should" fire** — a
  blocker whose `updated_at` keeps advancing never crosses
  `_MIN_DEP_STALL_SECONDS`, so the dependent keeps deferring past 3
  stalled ticks; intentional, but the count and the age gate can disagree
  for a long time.
- **`open_prs_for_app`/`failing_ci_count` of `None` disables their gates
  entirely**, not just relaxes them — running a tick without a working
  `github_client` silently removes the PR-ceiling and failing-CI checks.

## Escalation paths

**Mode/cap/rate-limit rejections** never advance chain state — the story
stays put, `last_rejection_reason` is set, and it shows in
`TickSummary.rejected`/`blocked_by_caps`. There is no automatic escalation
beyond visibility: `factory why <story-id>` reads
`last_rejection_reason` and re-runs `can_dispatch` live to project the next
tick. An operator resolves these by editing `factory_settings.yaml` (caps,
rate limits, mode's allowed set) plus a restart or `reload_settings()`, or
by running `factory mode <name>` (calls `set_mode()` — an OPERATOR action
per `CLAUDE.md`, never automated by the chain).

**Dependency deadlocks** (`_deps_permanently_dead`) park immediately into
`blocked_dependency_unmet` with a `dependency_deadlocked` event — a
terminal-by-design sink surfaced via the direction's tracker issue and
`factory inbox`; the only way out is an operator decision on the dead-end
sibling.

**Dependency-deferral cap exhaustion** (`dependency_deferral_capped`) also
parks into `blocked_dependency_unmet`, but is NOT abandoned the same way:
`_revive_capped_dependents()` runs every tick and automatically un-parks
the row (resuming at its pre-park state, counter reset) the instant its
blockers leave `_STALLED_DEP_STATES` — via an operator action, the FMS
`retry-mergeable-blocked-story` playbook (30-minute cooldown), or a
`reconcile` pass finding the blocker's PR merged out-of-band. This closes
the "detect-without-remediate" loop the cap exists to fix: a blocked
foundation used to leave its dependents idling forever with no path back.

Neither dispatch rejections nor dependency defers/parks raise or fail the
tick's exit code — `orchestrator.tick()` completes normally with a
populated `TickSummary`, which `factory tick`, `factory status`, and
`factory inbox` all read from.
