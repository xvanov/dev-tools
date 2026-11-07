# Orchestrator — tick loop, dispatch, reconcile, and merge

## Overview

`factory/chain/orchestrator.py:tick()` is the single entry point that drives
every in-flight `StoryRecord` for one app forward. A tick, in order: (1)
reconciles the local DB against GitHub's authoritative PR/issue state, (2)
recovers stale/blocked/capped rows via pure DB rewrites, (3) drives each story
through up to `max_advances_per_story` (default 10) handler dispatches —
gated by the dependency-ordering rule, the docs-chain serialization rule, and
the settings enforcer — (4) runs the auto-merge worker twice (once before the
story loop, once after, so a PR reaching `PR_OPEN` mid-tick still gets a merge
attempt the same tick), and (5) runs the post-merge CI-health monitor and the
hourly issue-hygiene reconcile. `factory tick --app X` calls this directly;
`factory-tick@<app>.timer` calls it every 5 minutes. A real-run tick usually
advances a story by exactly one handler because most next steps are
webhook/CI-gated (`_dispatch_for_story` returns `None` until the precondition
is met), but nothing prevents several advances in one tick if preconditions
are already satisfied.

`factory/chain/auto_merge.py:auto_merge_tick()` is the companion worker: given
open PRs (real, via `github_client`, or synthesized from `StoryRecord`s in a
mergeable state), it evaluates gates, merges, recovers CI failures by feeding
them back to dev, rebuilds genuinely conflicting PRs on a fresh branch, and
refuses factory self-edits that fail staging validation. `ci_health.py` is a
smaller tick-adjacent module that watches `main` for a required check that
turned red *after* merge. `idle.py` (idle detection + on-demand backlog
refill) was deleted 2026-08-07 (019 AC5) — it fired ~957 times and produced
zero human-visible outcomes; see "Idle detection was deleted" below.

## Key concepts

- **Reconcile-before-dispatch.** When `dry_run=False`, `tick()` calls, in
  order: `reconcile_from_github` (PR merged/closed drift),
  `reconcile_closed_trackers` (tracker issue closed by an operator while the
  story sat in `_PENDING_HUMAN_STATES`), `reconcile_dual_draft_winners`
  (standing supersede of dual-draft losers whose sibling shipped), and
  `freshen_behind_prs` (`gh pr update-branch` on PRs merely BEHIND). Local
  `factory.db` is a projection; GitHub is the system of record, so this runs
  before any recovery/dispatch decision — a merge that happened out-of-band
  flows into `DEPLOY_PENDING` instead of being re-processed as still open.

- **`reconcile_from_github` detects a merge from ANY non-terminal state**, not
  just `_MERGEABLE_STATES` (`pr_open`/`ci_green`/`ready_for_merge`) — a PR that
  merged while its story had bounced back to `reviewer_requested_changes` or
  `dev_in_progress` (post CI-fix re-dispatch) is still caught, forcing
  `DEPLOY_PENDING` directly when no ordinary `advance()` edge exists. It also
  revives a `blocked_ci_unresolved` story whose closed PR an operator
  re-opened and merged, and then re-evaluates anything parked in
  `BLOCKED_DEPENDENCY_UNMET` behind it (`_revive_dependents_of_revived_blocker`).
  Every detected merge also records a `MergeActionRecord` + enqueues the
  deploy (`_record_reconciled_merge_and_enqueue_deploy`) and runs dual-draft
  cleanup — because `gh pr merge --auto` only *enables* async merge and
  returns `merged=False`, reconcile is the primary detector of the real merge
  for that (now-common) case, not the auto-merge worker itself.

- **Dual-draft supersession has three independent triggers**, all converging
  on `close_abandoned_draft_sibling` / `SUPERSEDED_BY_SIBLING`: auto-merge's
  own merged path, the reconcile path (async `--auto` case), and the standing
  per-tick sweep `reconcile_dual_draft_winners` (catches a loser mid-dispatch
  when its sibling shipped, or whose winner already went terminal). A fourth,
  independent check (`_sibling_already_shipped` inside `_evaluate_one_pr`)
  additionally refuses to merge a loser's own PR in the same window.

- **Dispatch is a static map plus one dynamic branch.** `_DISPATCH` maps
  `StoryState → handler`: `STORY_CREATED → sm`, `SM_DONE → dev`,
  `DEV_RETRY → dev`, `REVIEWER_REQUESTED_CHANGES → dev`, `TESTS_GREEN →
  review`, `REVIEWER_DONE → tech_writer`, `TECH_WRITER_DONE → docs_enforcer`,
  `DOCS_SM_DONE → docs_onboarder`, `DOCS_ONBOARDER_DONE → docs_enforcer`,
  `DEPLOY_PENDING → deploy`. `_dispatch_for_story()` adds exactly one dynamic
  branch: at `STORY_CREATED`, `story.chain_kind == "docs"` routes to
  `docs_sm` instead of `sm`. This is the Loop-4 "dev-owns-tests" chain —
  `SM_DONE` dispatches `dev` directly; there is no separate test-design/
  test-impl/harness-precheck phase. `_invoke_handler()` maps a name to a
  callable in `factory.chain.handlers` (`sm`, `dev`, `review`, `tech_writer`,
  `docs_enforcer`, `docs_sm`, `docs_onboarder`, `deploy`); an unknown name
  raises `RuntimeError`.

- **Bug-aware job kinds.** `_resolve_job_kind()` appends `-bug` for
  `handler_kind in {"sm", "dev", "review"}` (`_BUG_AWARE_HANDLER_KINDS`) when
  `direction.type_tag == "bug"` or `story.scope == "bug"`, so `can_dispatch`'s
  `fix-only` mode lets bug work through while still blocking feature work.

- **Docs-chain serialization.** A `chain_kind == "docs"` story may leave
  `STORY_CREATED` only when `_count_app_docs_active()` (spans
  `docs_sm_in_progress` through `deploy_pending`) is zero for its app — two
  concurrent docs PRs rewrite overlapping `context/*.md` files and conflict.

- **Per-dispatch gates run in order inside the per-story loop:** the WS1.1
  budget breaker, the dependency-ordering gate, the docs-serialization gate,
  then the settings enforcer. The budget breaker
  (`_story_budget_breaker_reason`) checks `story.total_attempts` /
  `total_spend_usd` (spend from the real per-run ledger, never hand-summed)
  against `settings.caps.per_story_attempts` / `per_story_spend_usd` for every
  dispatch state except `DEPLOY_PENDING`; a trip advances via
  `EVENT_BUDGET_EXCEEDED` to the terminal `BLOCKED_BUDGET_EXCEEDED`.
  Advance-decay (`_apply_advance_decay`, keyed on `_STATE_PROGRESS_ORDINAL`)
  resets `total_attempts` whenever a story crosses a genuinely new happy-path
  milestone, so a dev↔review oscillation still exhausts the budget while real
  progress never false-trips it. `can_dispatch` runs last; on refusal
  `story.last_rejection_reason` is set, `summary.blocked_by_caps`/`.rejected`
  record it, and the loop moves on.

- **Dependency-ordering gate.** `_direction_deps_pending()` returns lower-id,
  not-yet-`DEPLOYED` siblings in the same direction (SM emits foundation-first,
  so id order is build order); dual-draft `-alt-*` siblings are exempt from
  each other. **`superseded_by_sibling` siblings are excluded entirely**
  (2026-08-09) — that state means another story took the work over, so nothing
  is left un-built. While they counted as pending they were also permanent dead
  ends, which made re-triage after any story failure impossible (the replacement
  deadlocked on the very rows it replaced) and stranded every non-alt story
  filed after a dual-draft pair. If every pending dep is in
  `_DEAD_END_DEP_STATES` (`blocked_ci_unresolved`, `blocked_dependency_unmet`,
  `closed_by_operator`; `superseded_by_sibling` is still listed there but is now
  unreachable by construction) the story is a permanent deadlock and parks in
  `BLOCKED_DEPENDENCY_UNMET` immediately. If every pending dep is merely
  human-blocked (`_STALLED_DEP_STATES` — dead ends plus
  `_PENDING_HUMAN_STATES` plus `quarantined_invalid_state`) for
  `_MAX_DEPENDENCY_DEFERRALS` (3) consecutive ticks **and** for at least
  `_MIN_DEP_STALL_SECONDS` (45 min, keyed on each blocker's `updated_at`), the
  deferral CAP parks the story the same way, tagged
  `DEP_DEFER_CAP_REASON_PREFIX`. A story at `DEPLOY_PENDING` is never
  cap-parked. `_revive_capped_dependents()` /
  `_revive_dependents_of_revived_blocker()` reverse the park once every
  blocker clears the stalled set, resuming at the state recorded in the
  `dependency_deferral_capped` event, falling back to `STORY_CREATED` if that
  state is no longer dispatchable.

- **Self-healing recovery passes** (pure DB rewrites, real-run only):
  `_prune_stale_in_progress()` rolls an `*_in_progress` row back to its
  dispatchable predecessor after `_STALE_THRESHOLD_SECONDS` (10 min) with no
  update, since `_dispatch_for_story` returns `None` for `*_in_progress`
  states and nothing else can nudge a crashed handler's row.
  `_recover_blocked_stories()` re-enters `BLOCKED_TESTS_NEED_CLARIFICATION` /
  `BLOCKED_REVIEW_NONCONVERGENT` at `SM_DONE`, capped at `_MAX_AUTO_RECOVERIES`
  (2), short-circuiting when a recovery reproduces the identical failure
  signature.

- **E6 stage-2 environment hold (ACTIVE 2026-08-10, #294 + #298 + branch
  protection).** Before the CI-failure loop and before `_evaluate_one_pr`,
  the tick short-circuits any real PR whose ONLY failing required check is
  `main-green` (main's post-merge full lane is red): no dev dispatch, no
  park, no PR close — one deduped `ci_hold_main_red` event and one
  `merge_actions` row per hold EPISODE. A hold older than 30 min sets
  `last_rejection_reason` (`ci_hold_main_red:` prefix, column-scoped write
  that deliberately does not stamp `updated_at`) so the story reaches
  `factory inbox`; when main's HEAD moves, the held PR's failed `main-green`
  run is re-run (`gh run rerun --failed`) once per new main commit, at most
  `_MAX_HOLD_RERUNS=3` per episode; the rerun's `pending` window stays inside
  the hold (evaluating it would run the gates against red main and burn
  `_MAX_GATE_BLOCK_CYCLES`). The stale hold reason is cleared (prefix-guarded)
  as soon as checks resolve. Do not `resume-story` a held story — fix main.

- **Auto-merge gate order** (`_evaluate_one_pr`): dual-draft loser self-check
  → real-run short-circuit if already merged → TDD 7-gate check
  (`evaluate_all_gates`) or, for docs, just `canonical-paths-only` →
  story-state guard (`_MERGEABLE_STATES`) → blocking-label check
  (`do-not-merge`, `needs-human-verification`, `needs-direction`,
  `tests-slop`, `needs-test-quality-fix`) → placeholder-PR guard (never shells
  a synthesized negative PR number into `gh`) →, for a factory-repo story,
  `_evaluate_self_edit_gate` (diff must be readable, must not touch
  `factory/manager/**`/`bench/**` — hard refusal — and any runtime self-edit
  must pass `staging.gate_self_edit`, a cloned, actually-run factory).
  `gh pr merge --auto` only *enables* async auto-merge; `MergeAction.merged`
  is `True` only once `_pr_is_merged_on_github` confirms it — otherwise
  `auto_merge_enabled=True` and reconcile picks the merge up later.

- **`tests-meaningful` is the static slop detector and nothing else** (2026-08-05,
  A.5). It carried a second, opt-in layer — real ablation/mutation testing behind
  `gates.mutation_testing` — that never ran in any app while the gate itself is
  in `LOOP4_REQUIRED_GATE_LABELS`: one flag stood between four verified defects
  (symbols the diff never touched, fail-open on a timeout or an already-red
  suite, mutation of the live `state/worktrees/` checkout, `passed=False` in
  dry-run) and every merge. The branch was deleted, not re-wired. The repaired
  measurement is `factory/chain/mutation.py`, reachable only from
  `factory mutation-score`; no gate imports it, and a test in
  `tests/test_mutation.py` keeps it that way. `gates.mutation_testing` is now an
  inert config field. Scores land in `state/mutation/<app>/<head_sha>.json`,
  which is also the per-`(head_sha, symbol)` cache.

- **Two bounded recovery loops inside auto-merge.** Real CI `"failure"` runs
  `_handle_ci_failure()` before the merge decision: re-dispatch to
  `REVIEWER_REQUESTED_CHANGES` with the CI log fed in as a reviewer finding,
  bounded by `_MAX_CI_FIX_CYCLES` (3) + a failure-signature guard; it only
  parks (`BLOCKED_CI_UNRESOLVED`) when the red is genuine
  (`_ci_failure_is_genuine`, not an infra-transient timeout/cancel) **and**
  the PR close is confirmed, else it retries next tick. Separately, a
  terminally-unmergeable PR first gets one `_attempt_pr_reconcile` (`gh pr
  update-branch`) for a merely-BEHIND branch; if that fails on a genuine
  content conflict (`_pr_is_conflicting`), `_handle_pr_conflict_rebuild()`
  persists the redispatch intent, then closes the PR/branch/worktree and
  rebuilds fresh off main — bounded by `_MAX_CONFLICT_REBUILDS` (2), falling
  through to `EVENT_PR_UNMERGEABLE → BLOCKED_DEPLOY_FAILED` on exhaustion.

- **Post-merge CI-health monitor** (`ci_health.py:main_ci_health_tick`, gated
  by `settings.ci_health.enabled`). Reads `main`'s required checks from branch
  protection and check-runs at `main`'s tip. A red non-required check only
  emits a warning event; a red *required* check files a `ci-health`,
  `explore=True` direction via `create_direction`, deduped by a signature of
  `(sorted required-check names, main head sha)` — the flaky log-digest fetch
  is deliberately excluded from that signature.

- **Idle detection was deleted (019 AC5, 2026-08-07).** `factory/chain/idle.py`
  (`detect_idle()`, `maybe_generate_idle_work()`, `open_idle_issue()`) and the
  `if not dry_run:` block in `tick_cmd` that called it, plus the CLI's
  `factory idle-check` command and the `inbox_cmd` "idle apps" table, are gone.
  The old behavior: on a fully-drained app (zero non-terminal stories, zero
  scheduled-persona findings, zero deploys within 2h) it emitted an
  `app_idle` event AND, once a day's rotation through
  `(bug_hunter, ux_auditor, security)` wasn't fully rate-capped, dispatched an
  on-demand scanner run — the mechanism the direction measured at "957 fires,
  zero human-visible outcomes." **Interim gap**: `manager/detectors/
  stalled_stories.py` reads `state/events/idle.ndjson` for `app_idle` to
  compute `healthy_drain` (suppresses an aged-backlog escalation during a
  legitimate drain); with no writer left, `healthy_drain` is permanently
  `False` until 019 AC6 ships an idle→ping replacement that re-emits
  `app_idle`. That failure direction is deliberate: it means MORE alarms
  (noise), never a suppressed real stall (silence).

- **`pm_sync()` is triage, called separately from `tick()`** — `factory
  tick`'s CLI command calls `maybe_auto_pm_sync()`. Machine-filed directions
  (`scheduled-<persona>` source, or undeterminable) park as
  `awaiting_approval` until `factory approve-direction`; only human-filed or
  approved directions reach `validate_direction` → PM persona →
  `open_or_update_tracker_issue` → `handle_stories_spawned`. `dry_run=True` is
  a pure preview — no `state.yaml` write, no LLM/GitHub call, no
  `StoryRecord` persisted — after a 2026-07-20 incident where a "safe"
  dry-run spawned live stories. `_validate_pm_story_sizes()` rejects oversized
  `child_stories` and re-prompts the PM up to
  `MAX_PM_REDECOMPOSITION_RETRIES` (3) times with structured feedback.

- **`step_events.py`** appends one typed `chain_step` record per handler
  dispatch to `state/events/chain_steps.ndjson`, including a content hash of
  the handler's persisted artifact column. `replay_chain_history()` /
  `replay_transition_path()` deterministically reconstruct a story's step
  sequence or control-flow path for post-mortem/replay tooling.

- **`TickSummary`** (the dataclass every tick returns) carries: `app`,
  `dry_run`, `stories_advanced`, `blocked_by_caps` (rejected by
  `can_dispatch`), `stories_blocked` (parked mid-chain), `handler_runs`
  (`(slug, from_state, to_state)`), `rejected` (`(slug, reason)`), `deferred`
  (`(slug, waiting-on description)` — dependency-gate waits, always populated
  even when nothing dispatched), `errors` (`(slug, error)`), `skipped`
  (poisoned-row quarantines), `merges` (`list[MergeAction]`), `ci_health`
  (`CiHealthResult | None`), `issue_hygiene` (`dict[str, int] | None`), and
  `halted` / `halt_reason`.

## Key files

- `factory/chain/orchestrator.py` — `tick()`, `_dispatch_for_story()`,
  `_invoke_handler()`, `_resolve_job_kind()`, `TickSummary`,
  `reconcile_from_github()`, `reconcile_closed_trackers()`,
  `reconcile_dual_draft_winners()`, `freshen_behind_prs()`, the
  dependency-deferral / budget-breaker / stale-recovery helpers.
- `factory/chain/auto_merge.py` — `auto_merge_tick()`, `_evaluate_one_pr()`,
  `MergeAction`, `_handle_ci_failure()`, `_handle_pr_conflict_rebuild()`,
  `_evaluate_self_edit_gate()`, `_sibling_already_shipped()`.
- `factory/chain/ci_health.py` — `main_ci_health_tick()`,
  `query_main_ci_status()`, `CiHealthResult`.
- `factory/chain/pm_sync.py` — `pm_sync()`, `maybe_auto_pm_sync()`,
  `_validate_pm_story_sizes()`.
- `factory/chain/step_events.py` — `emit_chain_step()`,
  `replay_chain_history()`, `replay_transition_path()`.
- `factory/chain/state_machine.py` — `StoryState`, `StoryRecord`, `advance()`.
- `factory/chain/handlers.py` — the per-persona handlers `_invoke_handler()`
  calls into.
- `factory/settings/enforcer.py`, `modes.py`, `loader.py`, `spend.py` —
  `can_dispatch()` and the mode/config/spend inputs it and the budget breaker
  read.
- `factory/manager/halt.py` — the Phase-7 halt check at the top of `tick()`.
- `factory/chain/dual_draft.py` — `_draft_alt_suffix()`,
  `close_abandoned_draft_sibling()`, shared by reconcile and auto-merge.

## Failure modes

- **A poisoned `StoryRecord.state`** (any value outside `StoryState`) is
  quarantined per-row, not fatal to the tick: `StoryState(story.state)` is
  wrapped in `try/except`, the row is appended to `summary.skipped`, a deduped
  `invalid_state_skipped` event is logged, and the loop continues. There is no
  automatic reconciler for a quarantined row and no FMS escalation on the
  skip — it persists until an operator repairs it by hand.
- **A handler exception rolls the story back** to its pre-dispatch state and
  records `story.error = repr(exc)`, so the next tick retries the same
  handler instead of stranding the row in an `*_in_progress` state
  `_dispatch_for_story` would never pick up again; the spend accumulator is
  still refreshed from the ledger first, so a crashed handler's real cost
  isn't hidden from the budget breaker.
- **An uncapped dependency wait used to rot a whole direction silently.**
  Before the deferral cap, a dependent behind a `blocked_deploy_failed`
  foundation deferred every tick forever, printing "No in-flight stories"
  while the queue behind it never moved (2026-07-28, D018 stories 168-171).
  The cap now parks such a story after 3 stalled deferrals *and* 45 minutes,
  and `summary.deferred` always surfaces a waiting story even when nothing
  dispatched.
- **CI-failure recovery and conflict rebuild both hard-stop** at
  `_MAX_CI_FIX_CYCLES` (3) / `_MAX_CONFLICT_REBUILDS` (2), but only when the
  underlying signal is genuine — an infra-transient CI red is never treated
  as exhausted, so the PR stays mergeable and retries later rather than being
  destroyed over a flake.
- **A factory self-edit that fails staging is never merged, but the story
  still needs a human.** `_evaluate_self_edit_gate` refusal sets
  `MergeAction.staging_blocked=True`; the caller advances via
  `EVENT_PR_UNMERGEABLE` and the gate calls `_escalate_self_edit` (reuses
  `manager.escalation.notify_escalation`) with the concrete `staging_status`
  and diagnosis populated — a prior version of this escalation shipped with
  `concern_id: ?` and an empty diagnosis (GitHub issue #179).
- **Reconcile is fail-safe toward "do nothing" on ambiguity.** Every
  `gh`-querying helper (`_query_pr_state`, `_query_issue_state`,
  `_query_pr_merge_state`) returns `None` on any timeout/non-zero-exit/
  unparseable-output, and every caller treats `None` as "don't act" — a `gh`
  outage never mass-advances or mass-closes stories, but a genuinely stuck
  merge/close is also invisible to reconcile until `gh` recovers.

## Escalation paths

- **Settings-enforcer rejection** is the routine, non-exceptional path:
  `story.last_rejection_reason` is set, `TickSummary.blocked_by_caps`/
  `.rejected` record it, a `dispatch_rejected` event is logged, and the
  operator inspects via `factory why <story-id>`.
- **Budget-breaker trip** (`EVENT_BUDGET_EXCEEDED → BLOCKED_BUDGET_EXCEEDED`)
  and **dependency deadlock/cap park** (`BLOCKED_DEPENDENCY_UNMET`) are both
  terminal-but-visible: the former via a `budget_exceeded` event recording the
  full accumulator state, the latter via `factory inbox`
  (`reconcile_closed_trackers`'s `_awaits_human` predicate explicitly includes
  the cap-park case, so closing the tracker issue is a valid exit) and
  automatic reversal once every blocker clears the stalled set.
- **CI-recovery / conflict-rebuild exhaustion** logs a deduped
  `ci_fix_exhausted` / `conflict_rebuild_exhausted` event before parking the
  story in `BLOCKED_CI_UNRESOLVED` / `BLOCKED_DEPLOY_FAILED`; the PR-close
  comment (for CI) explains why and how to retry once the blocker is fixed.
- **Self-edit staging refusal** escalates through
  `manager.escalation.notify_escalation` with a fully populated proposal
  (`concern_id`, `diagnosis`, `proposal.rationale`, `staging_status`) — the
  same channel and shape an L3-Diagnostician proposal uses.
- **Factory halt** (`factory.manager.halt.is_halted`) short-circuits `tick()`
  before any dispatch, returning `TickSummary(halted=True, halt_reason=...)`.
  A broken halt-check *module* (not a corrupt halt file, which already fails
  safe inside `halt.is_halted`) fails OPEN but emits a `critical`-severity
  `halt_check_module_error` alert so the break gets fixed.
- **Post-merge CI-health red** self-files a `ci-health` direction into the
  normal PM-sync → SM → dev → review → merge chain rather than notifying an
  operator directly. **An idle app** used to either self-file a
  work-generating persona run or, via `factory idle-check`, open a
  `factory-idle` GitHub issue; both were deleted 2026-08-07 (019 AC5) with
  `idle.py` — see "Idle detection was deleted" above. Until 019 AC6 ships its
  idle→ping replacement, a drained app surfaces no operator-facing signal at
  all (`factory new-direction`/`factory tell`/a GitHub issue labeled
  `direction` are still the way to feed it work in the meantime).
