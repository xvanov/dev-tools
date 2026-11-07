# state-machine — story lifecycle, rollback, and dependency parking

## Overview

`factory/chain/state_machine.py` defines the canonical lifecycle for a
`StoryRecord` (`state/factory.db.stories`). `advance(story, event, payload) ->
StoryState` is pure: it looks up `(current_state, event)` in the `_TRANSITIONS`
dict and returns the next `StoryState`, raising `IllegalTransitionError` for
any pair not in the table. It never mutates the story or touches the
database — `factory/chain/orchestrator.py` and `factory/chain/handlers.py`
own persistence and side effects (LLM calls, GitHub API calls, git writes).

Two chain variants share one enum, selected by `StoryRecord.chain_kind`
(`"tdd"` default, or `"docs"`):

* **`tdd`** (Loop-4, dev-owns-tests): `sm` → `dev` → `review` → `tech_writer`
  → `docs_enforcer` → `PR_OPEN`. The dev persona writes production code AND
  its own tests in one pass; there is no separate test-design/test-impl
  phase.
* **`docs`**: `docs_sm` → `docs_onboarder` → `docs_enforcer` → `PR_OPEN`.
  Used for documentation-only deliverables (e.g. the `context/` bootstrap);
  skips the red/green test loop entirely.

Both converge at `DOCS_ENFORCER_CHECK` and share the PR/CI/merge/deploy tail.
Beyond the happy path, the module also owns 8 terminal "sink" states that
stop the chain from driving a story further (`BLOCKED_*`, `SUPERSEDED_BY_SIBLING`,
`QUARANTINED_INVALID_STATE`, `CLOSED_BY_OPERATOR`) and a dependency-deferral
cap that turns "wait forever behind a dead foundation" into "park and
surface after 3 stalled ticks 45+ minutes apart".

## Key concepts

### The transition table is the only source of truth

`_TRANSITIONS: dict[tuple[StoryState, str], StoryState]` is read literally by
`advance()` — nothing is inferred. The happy-path edges (`state_machine.py:396-506`):

| From | Event | To |
|---|---|---|
| `STORY_CREATED` | `EVENT_SM_STARTED` | `SM_IN_PROGRESS` |
| `SM_IN_PROGRESS` | `EVENT_SM_DONE` | `SM_DONE` |
| `SM_DONE` | `EVENT_DEV_STARTED` | `DEV_IN_PROGRESS` |
| `DEV_IN_PROGRESS` | `EVENT_DEV_TESTS_GREEN` | `TESTS_GREEN` |
| `DEV_IN_PROGRESS` | `EVENT_DEV_TESTS_RED` | `DEV_RETRY` |
| `DEV_IN_PROGRESS` | `EVENT_DEV_EXHAUSTED` | `BLOCKED_TESTS_NEED_CLARIFICATION` |
| `DEV_RETRY` | `EVENT_DEV_STARTED` | `DEV_IN_PROGRESS` |
| `DEV_RETRY` | `EVENT_DEV_EXHAUSTED` | `BLOCKED_TESTS_NEED_CLARIFICATION` |
| `TESTS_GREEN` | `EVENT_REVIEWER_STARTED` | `REVIEWER_IN_PROGRESS` |
| `REVIEWER_IN_PROGRESS` | `EVENT_REVIEWER_APPROVE` | `REVIEWER_DONE` |
| `REVIEWER_IN_PROGRESS` | `EVENT_REVIEWER_REQUEST_CHANGES` | `REVIEWER_REQUESTED_CHANGES` |
| `REVIEWER_IN_PROGRESS` | `EVENT_REVIEW_NONCONVERGENT` | `BLOCKED_REVIEW_NONCONVERGENT` |
| `REVIEWER_REQUESTED_CHANGES` | `EVENT_DEV_STARTED` | `DEV_IN_PROGRESS` |
| `REVIEWER_DONE` | `EVENT_TECH_WRITER_STARTED` | `TECH_WRITER_IN_PROGRESS` |
| `TECH_WRITER_IN_PROGRESS` | `EVENT_TECH_WRITER_DONE` | `TECH_WRITER_DONE` |
| `TECH_WRITER_IN_PROGRESS` | `EVENT_REVIEWER_REQUEST_CHANGES` | `REVIEWER_REQUESTED_CHANGES` |
| `TECH_WRITER_IN_PROGRESS` | `EVENT_REVIEW_NONCONVERGENT` | `BLOCKED_REVIEW_NONCONVERGENT` |
| `TECH_WRITER_DONE` | `EVENT_DOCS_ENFORCER_CHECK` | `DOCS_ENFORCER_CHECK` |
| `DOCS_ENFORCER_CHECK` | `EVENT_DOCS_ENFORCER_PASS` | `PR_OPEN` |
| `DOCS_ENFORCER_CHECK` | `EVENT_DOCS_ENFORCER_FAIL` | `REVIEWER_REQUESTED_CHANGES` |
| `STORY_CREATED` | `EVENT_DOCS_SM_STARTED` | `DOCS_SM_IN_PROGRESS` |
| `DOCS_SM_IN_PROGRESS` | `EVENT_DOCS_SM_DONE` | `DOCS_SM_DONE` |
| `DOCS_SM_DONE` | `EVENT_DOCS_ONBOARDER_STARTED` | `DOCS_ONBOARDER_IN_PROGRESS` |
| `DOCS_ONBOARDER_IN_PROGRESS` | `EVENT_DOCS_ONBOARDER_DONE` | `DOCS_ONBOARDER_DONE` |
| `DOCS_ONBOARDER_IN_PROGRESS` | `EVENT_DOCS_ONBOARDER_FAILED` | `BLOCKED_TESTS_NEED_CLARIFICATION` |
| `DOCS_ONBOARDER_DONE` | `EVENT_DOCS_ENFORCER_CHECK` | `DOCS_ENFORCER_CHECK` |
| `READY_FOR_MERGE` / `CI_GREEN` / `PR_OPEN` | `EVENT_MERGED` | `DEPLOY_PENDING` |
| `PR_OPEN` / `CI_GREEN` / `READY_FOR_MERGE` | `EVENT_PR_UNMERGEABLE` | `BLOCKED_DEPLOY_FAILED` |
| `DEPLOY_PENDING` | `EVENT_DEPLOY_STARTED` | `DEPLOY_PENDING` (self-loop) |
| `DEPLOY_PENDING` | `EVENT_DEPLOY_SUCCEEDED` | `DEPLOYED` |
| `DEPLOY_PENDING` | `EVENT_DEPLOY_FAILED` | `BLOCKED_DEPLOY_FAILED` |
| `DEPLOY_PENDING` | `EVENT_DEPLOY_SKIPPED` | `DEPLOYED` |

Every budget-metered dispatch state (`STORY_CREATED`, `SM_DONE`, `DEV_RETRY`,
`REVIEWER_REQUESTED_CHANGES`, `TESTS_GREEN`, `REVIEWER_DONE`,
`TECH_WRITER_DONE`, `DOCS_SM_DONE`, `DOCS_ONBOARDER_DONE`) also has an
`EVENT_BUDGET_EXCEEDED` → `BLOCKED_BUDGET_EXCEEDED` edge. `DEPLOY_PENDING` is
deliberately unmetered — a merged story must still be allowed to deploy.

`CI_PENDING`, `CI_GREEN`, `READY_FOR_MERGE` have **no edges into them** in
`_TRANSITIONS`; `factory/chain/auto_merge.py` drives a story through those by
**direct state assignment**, not `advance()`. `is_terminal()` — "no outgoing
transition exists" — is therefore true for `CI_PENDING` even though it is not
actually done; callers that need real terminality (dependency-deadlock
detection, tracker-issue closing) use their own explicit allowlists instead
of `is_terminal()` (see "Dependency-deferral cap" below).

### Rollback / rework states

* **`DEV_RETRY`** — the dev sandbox finished with tests still red.
  `story.dev_retries` is bumped and `current_model_tier` may escalate before
  the next dev dispatch. `factory/chain/orchestrator.py:_DISPATCH` maps
  `DEV_RETRY` back to the `dev` handler. Exhausting retries fires
  `EVENT_DEV_EXHAUSTED` → `BLOCKED_TESTS_NEED_CLARIFICATION`.
* **`REVIEWER_REQUESTED_CHANGES`** — the reviewer rejected the diff (code
  defects or test-quality/slop findings). Loop-4 has no separate test
  author, so this state dispatches straight back to `dev`
  (`orchestrator.py:150`). `story.reviewer_cycles` counts consecutive
  request-changes verdicts; at `handlers.py:_MAX_REVIEW_CYCLES = 3` the
  reviewer fires `EVENT_REVIEW_NONCONVERGENT` instead, landing on the
  terminal `BLOCKED_REVIEW_NONCONVERGENT` sink so a non-converging
  dev↔reviewer ping-pong cannot loop unbounded. Two early exits fire
  strictly below that hard cap: identical findings repeating
  `_MAX_REVIEW_STUCK = 2` times (stability guard), and a review score that
  does not IMPROVE between consecutive rejecting cycles (non-improving-score
  guard, 2026-08-01) — flat trajectories buy expensive wrong answers, so
  they block instead of cycling to the cap. Both route only to the blocked
  sink, never to approve.
* **Fail-closed reviewer diff precondition (2026-08-01)** — before any
  reviewer model call, `handlers._fetch_pr_diff_for_review` must yield a real
  diff (`gh pr diff` for PRs; `git diff <base>...HEAD` in the worktree
  otherwise, with an `origin/<base>` → local `<base>` fallback). A fetch
  FAILURE raises and routes the story straight to
  `BLOCKED_REVIEW_NONCONVERGENT` via `EVENT_REVIEW_NONCONVERGENT` without
  burning a reviewer cycle (it used to return the error text AS the diff —
  blind reviews). An EMPTY diff never reaches the model either: the handler
  emits a deterministic request_changes ("commit your work") that stays
  bounded by the guards above. `handle_tech_writer` applies the same
  precondition via its `TECH_WRITER_IN_PROGRESS` →
  `BLOCKED_REVIEW_NONCONVERGENT` edge.
* **`TECH_WRITER_IN_PROGRESS` → `REVIEWER_REQUESTED_CHANGES`** — if
  `apply_context_updates` fails (e.g. tech_writer wrote outside
  `CANONICAL_CONTEXT_PATHS`), the story bounces back through the dev-rework
  path rather than sticking mid-write.
* **`DOCS_ENFORCER_CHECK` fail** — `EVENT_DOCS_ENFORCER_FAIL` also routes to
  `REVIEWER_REQUESTED_CHANGES`, reusing the same rework edge for both chains.
* **CI-failure recovery is NOT a `StoryState` transition** — `auto_merge.py`'s
  `_handle_ci_failure` re-dispatches a red PR up to
  `_MAX_CI_FIX_CYCLES = 3` times by resetting the story back into the dev
  loop directly; only when it gives up (cap reached, or the fix reproduces
  an identical failure signature) does it close the PR and set
  `BLOCKED_CI_UNRESOLVED` by direct assignment.
* **Auto-recovery of blocked stories** — `orchestrator._AUTO_RECOVERABLE_STATES`
  maps `BLOCKED_TESTS_NEED_CLARIFICATION` and `BLOCKED_REVIEW_NONCONVERGENT`
  back to `SM_DONE` (re-runs dev→review→merge). `_recover_blocked_stories`
  applies this at most `_MAX_AUTO_RECOVERIES = 2` times per story and only
  when the story's current failure signature (`_story_failure_signature`,
  volatile bits like timestamps/paths/hex ids stripped) differs from the one
  recorded at the prior recovery — an unchanged signature escalates
  immediately instead of burning another cycle. `BLOCKED_DEPLOY_FAILED` is
  excluded on purpose; that's handled by `auto_merge._attempt_pr_reconcile`.

### Dual-draft sibling supersession

`factory/chain/dual_draft.py` implements the ambiguous-direction flow
(`should_spawn_dual_draft`: PM `confidence < 0.6` or an `(explore)` tag).
Two `StoryRecord`s are spawned per direction, slugs suffixed `-alt-a` /
`-alt-b`. Each runs the normal chain independently and opens its own
`draft-alternative` PR. `close_abandoned_draft_sibling` runs when one
sibling's PR merges (the "winner"):

1. Closes the loser's open PR (`gh pr close --delete-branch`) so it can
   never auto-merge.
2. Closes the loser's tracker issue with `state_reason="not_planned"`
   (best-effort, needs a GitHub client).
3. Sets the loser's `StoryRecord.state` to `SUPERSEDED_BY_SIBLING`
   **by direct assignment**, not via `advance()` — a supersede can fire
   from any in-flight state, so there is no single `EVENT_*` edge that
   fits. This is a pure local DB write and runs even without a GitHub
   client (`github_client is None` only skips the issue-close).

`SUPERSEDED_BY_SIBLING` is terminal (no outgoing transition), excluded from
`auto_merge._MERGEABLE_STATES`, and excluded from concurrency-cap counting.
A sibling already in any terminal state, or at `DEPLOY_PENDING` (the
transient both-merged race), is skipped — a legitimately shipped sibling is
never downgraded. Before this existed, a loser still mid-dev/review could
open its own PR later and ship a second interpretation to main (direction
007 landed both PR #67 and #69).

### Terminal sinks

Twelve states have no outgoing transition (`is_terminal()` returns True) and
are absent from `_DISPATCH` and `auto_merge._MERGEABLE_STATES`:

| State | Set by | Recovery |
|---|---|---|
| `DEPLOYED` | `EVENT_DEPLOY_SUCCEEDED` / `EVENT_DEPLOY_SKIPPED` | n/a — success |
| `BLOCKED_TESTS_NEED_CLARIFICATION` | dev/docs-onboarder exhaustion | auto-recovered to `SM_DONE` (capped), `factory resume-story`, or human |
| `BLOCKED_DEPLOY_FAILED` | `EVENT_DEPLOY_FAILED` / `EVENT_PR_UNMERGEABLE` | `auto_merge._attempt_pr_reconcile`, or human |
| `BLOCKED_REVIEW_NONCONVERGENT` | `EVENT_REVIEW_NONCONVERGENT` (stuck/non-improving/capped review cycles, empty-diff short-circuit, or an unfetchable diff at review/tech_writer time) | auto-recovered to `SM_DONE` (capped), `factory resume-story`, or human |
| `BLOCKED_BUDGET_EXCEEDED` | `EVENT_BUDGET_EXCEEDED` | `factory resume-story` (zeroes `total_attempts`, NEVER the spend ledger; refuses over-cap without `--force`) or raise `caps.per_story_*` |
| `SUPERSEDED_BY_SIBLING` | `dual_draft.close_abandoned_draft_sibling` (direct assignment) | `factory resume-story` (offered only while the direction has nothing deployed AND the row banked real work) |
| `BLOCKED_CI_UNRESOLVED` | `auto_merge._handle_ci_failure` giving up (direct assignment) | `factory resume-story --at gates` (reopens the PR and re-grades it; no persona re-runs) |
| `BLOCKED_DEPENDENCY_UNMET` | dependency-deadlock OR dependency-deferral cap (see below) | deadlock: `factory resume-story`; cap: automatic once blockers move |
| `QUARANTINED_INVALID_STATE` | `factory.manager.recovery` playbook `quarantine-invalid-enum-story` | operator repairs root cause, then `factory resume-story` |
| `CLOSED_BY_OPERATOR` | `orchestrator.reconcile_closed_trackers` (direct assignment) | operator re-opens tracker issue, then `factory resume-story` |
| `DELIVERED_LOCAL` | `EVENT_DELIVERED_LOCAL` — delivery level `none` | n/a — success at that level; the work is committed on the local `story/<n>-<slug>` branch, never pushed |
| `DELIVERED_BRANCH` | `EVENT_DELIVERED_BRANCH` — delivery level `branch` | n/a — success at that level; branch pushed, no PR |
| `DELIVERED_PR` | `EVENT_DELIVERED_PR` — level `draft_pr` / `pr` (from `PR_OPEN`, after the CI watch), or a refused `push_to_main` | n/a — a human merges; `reconcile_from_github` then routes it to `DEPLOY_PENDING`. Closed unmerged → `reconcile_from_github` settles it to `CLOSED_BY_OPERATOR` (direct assignment) |

### Delivery levels (how far finished work goes)

Each story carries `StoryRecord.delivery_level` (`none < branch < draft_pr <
pr < auto_merge < push_to_main`, vocabulary in `factory/delivery.py`). It is
resolved ONCE at spawn (`handle_stories_spawned` →
`delivery_gate.record_spawn_level`: the direction's `delivery:` frontmatter
wins outright — there is NO per-app ceiling — else the app's
`delivery.default`; garbage → `none`) and logged as a
`delivery_level_resolved` story event. Every later decision reads it through
`delivery_gate.story_level()`; app-config edits never move it. The only
adjustments are fail-safe ones (an unreadable value → `none`; `push_to_main`
on a factory self-edit → `pr`, because a direct push would skip the staging
gate), recorded as `delivery_level_lowered`. Rows that predate the column
resolve on first touch to the pre-existing default, `auto_merge`, whatever
the app's default is now (they were spawned before levels were enforced).

Enforcement sites:

* `handlers.handle_docs_enforcer` (the PR-open site): `none` →
  `delivery_gate.commit_local_work`, `DELIVERED_LOCAL`; `branch` →
  `_push_story_branch`, `DELIVERED_BRANCH`; `draft_pr`/`pr` →
  `_open_pr_for_story(draft=…, will_auto_merge=False)`, `PR_OPEN` (the CI
  watch below settles it to `DELIVERED_PR`);
  `auto_merge` → unchanged (`PR_OPEN`); `push_to_main` → `_push_story_branch`,
  `PR_OPEN` with NO PR. Push/PR failures share the `pr_create_retries` cap.
* `handlers._handle_dev_once` dev-exhausted WIP preservation: commits always,
  pushes only when the level pushes.
* `auto_merge.auto_merge_tick`, `draft_pr`/`pr` CI WATCH (first, before the
  draft guard): `_watch_ci_then_deliver` reads ALL the PR's checks
  (`_query_pr_checks`, `jobs.github.summarize_checks`). Green →
  `_settle_non_merging_story` → `DELIVERED_PR`. Red →
  `_redispatch_ci_fix` (shared with `_handle_ci_failure`: CI log as a
  finding, `REVIEWER_REQUESTED_CHANGES`, `ci_fix_redispatch`); the fix is
  pushed to the same PR by `handle_docs_enforcer`. Capped at
  `_MAX_CI_FIX_CYCLES` + the identical-signature guard; after that, or no
  verdict within `DELIVERY_CI_WAIT_S` (2 h; no checks: 10 min), it still
  settles to `DELIVERED_PR` with a `ci_note` on the `delivered` event
  (`factory job status` → `delivery_note`) — never closes the PR. Clock =
  first `delivery_ci_watch_started` after the last redispatch. Writes run
  under `story_lock` after re-reading state and `is_job_cancelled`. Such
  stories skip `_story_worktree` and `freshen_behind_prs`; a PR closed
  during the watch reconciles to `CLOSED_BY_OPERATOR`. Runs even with
  `auto_merge.enabled: false` (`auto_merge_tick(watch_only=True)`).
  Delivered-with-note, never re-dispatched: the last fix was not pushed
  (`fix_push_failed` / `fix_push_skipped_no_commits` /
  `fix_push_refused_foreign_commits` — `_push_fix_to_existing_pr` pushes
  fast-forward only for these levels and refuses when origin has commits the
  factory did not write); the PR head is not the factory's last pushed sha
  (`delivery_pr_head_pushed` / `fix_push.head_sha`); infra-only red (no
  `FAILURE` conclusion); no fetchable Actions log; docs chain. A dev that
  exhausts on a CI fix: no WIP push, `deliver_watched_pr_with_note` →
  `DELIVERED_PR` (direct write).
* `auto_merge.auto_merge_tick`: a guard at the top of the per-PR loop (before
  the main-green hold, the CI-failure re-dispatch and gate evaluation) skips
  draft PRs and settles any mergeable story whose level does not merge
  (`_settle_non_merging_story` → `DELIVERED_*`; it first DISARMS any GitHub
  auto-merge via `delivery_gate.disable_auto_merge`, recording
  `auto_merge_disarm_failed` if gh refuses). `push_to_main` stories are
  synthesised from the worktree (`delivery_gate.worktree_head_and_files`, real
  head sha, `pr_number = -(story.id)`). Before any gate runs,
  `_push_to_main_preflight_gate` (→ `delivery_gate.push_to_main_preflight`)
  HOLDS while the base branch's checks are red/running/unreadable (no gate
  run, nothing counted, `ci_hold_main_red:` reason; checked before
  protection) and, for a green base that requires status checks or a PR,
  FALLS BACK via `_fall_back_push_to_main_to_pr`: opens a ready PR, re-stamps
  `delivery_level = auto_merge`, logs `push_to_main_fell_back_to_pr` (reason
  `push_to_main_fell_back_to_pr:<why>`) + `delivery_level_lowered`; state
  stays `PR_OPEN` and the next tick takes the normal auto-merge path. Never
  pushed directly, never forced; PR-create failure is capped by
  `_MAX_PR_CREATE_RETRIES` → `BLOCKED_DEPLOY_FAILED`. Otherwise the same gate set runs;
  its block cap is keyed per STORY (`_gate_block_history(per_story=True)`) —
  the worktree sha is not a stable key — and parks in `BLOCKED_CI_UNRESOLVED`
  after 3. `delivery_gate.fast_forward_default_branch` pushes the gated commit
  to the default branch — non-force, refused unless it is a genuine
  fast-forward of the exact gated sha. A refusal records the downgrade to
  `pr`, opens a ready PR and ends in `DELIVERED_PR`.
* `handlers.handle_deploy`: a `push_to_main` story deploys the sha recorded
  under `-(story.id)` instead of skipping for "no PR number".

Concurrency and robustness (review 2026-11-02):

* **Cancel vs. merge.** `_evaluate_one_pr` runs the irreversible tail (the
  fast-forward / `gh pr merge` and the `DEPLOY_PENDING` write) under
  `delivery_gate.story_lock` (a per-story `flock` in `state/locks/`), after
  re-reading the committed state; the write is `delivery_gate.cas_story_state`
  from `_MERGEABLE_STATES` (`MergeAction.state_committed`). `factory job
  cancel` takes the same lock. Gate evaluation itself is outside the lock.
  A durable per-job marker (`delivery_gate.mark_job_cancelled` /
  `is_job_cancelled`, table `job_cancellations`) is checked inside that
  locked section and by `orchestrator._repark_cancelled_job_stories` before
  dispatch. `handlers.persist_story` keeps a committed `closed_by_operator`
  against a stale write-back (`stale_writeback_blocked` event) unless
  `allow_reopen=True` (only `resume.py`). `_gh_pr_merge` has a 90 s timeout.
* **Settle from every mergeable state.** `CI_GREEN` / `READY_FOR_MERGE` have
  `DELIVERED_BRANCH` / `DELIVERED_LOCAL` edges too; a settle that raises
  `_MAX_SETTLE_FAILURES` (3) times parks in `BLOCKED_DEPLOY_FAILED`.
* **Push_to_main hold cap.** The hold reason carries `held since <iso>`;
  after `_P2M_HOLD_CAP_SECONDS` (24 h) the story falls back to level `pr`
  (`_p2m_hold_exhausted_to_pr` → `DELIVERED_PR`).
* **Draft guard on the DB-fixture path.** `_query_pr_is_draft` sets
  `FixturePR.is_draft`; unknown → not a draft (GitHub refuses to merge drafts).
* **Stacking.** `delivery_gate.stack_parent` picks the latest `DELIVERED_*`
  lower sibling for a non-merging story; `_writing_worktree` passes its branch
  as `ensure_worktree_for_story(stack_on=…)` (local branch first, then
  `origin/<branch>`) and `_open_pr_for_story` notes `Stacked on …` in the body.
* **Closed issue vs. merged delivered PR.** `reconcile_closed_trackers` only
  settles a `DELIVERED_PR` row when its PR is OPEN or CLOSED on GitHub; MERGED
  (or unknown) is left for `reconcile_from_github` to deploy.

`DELIVERED_*` are in `_NON_CAP_COUNTING_STATES` and `_PENDING_HUMAN_STATES`
(dependents are capped-then-surfaced, closing the story issue settles to
`CLOSED_BY_OPERATOR`), shown in `factory inbox`, and deliberately NOT in
`tracker_issue._RESOLVED_STORY_STATES` — unmerged work never closes its story
issue. They DO count toward `tracker_issue._direction_is_complete` (via
`_DELIVERED_STORY_STATES`), so a job whose stories all end `DELIVERED_*`
completes and its tracker closes. They are terminal in
`manager/detectors/stalled_stories._TERMINAL_STATES` (never "stalled").
`_direction_deps_pending` drops a `DELIVERED_*` sibling from the dependency
set when the DEPENDENT's own level does not merge (otherwise multi-story jobs
below `auto_merge` deadlock on story 1); stories are not stacked.

### Dependency ordering and the deferral cap

`orchestrator._direction_deps_pending()` treats story-id order within a
direction as build order (SM emits foundational-first): a story is
dependency-ready only when every lower-id sibling in its direction has
reached `DEPLOYED`. Dual-draft `-alt-a`/`-alt-b` pairs are exempt from each
other (competing interpretations, not a serial dependency). A
`SUPERSEDED_BY_SIBLING` sibling is exempt from **everything** (2026-08-09): its
work belongs to another story now, so it is not an un-built foundation and never
enters the dependency set.

Two outcomes for a story stuck behind unmet dependencies:

* **Deadlock park** — if every pending dependency sits in
  `_DEAD_END_DEP_STATES` (`SUPERSEDED_BY_SIBLING`, `BLOCKED_CI_UNRESOLVED`,
  `BLOCKED_DEPENDENCY_UNMET`, `CLOSED_BY_OPERATOR` — states that will
  *never* deploy), the dependent is parked in `BLOCKED_DEPENDENCY_UNMET`
  immediately; it can never build.
* **Cap park** — if every pending dependency sits in `_STALLED_DEP_STATES`
  (`_DEAD_END_DEP_STATES` plus the recoverable-pending-human blocks
  `BLOCKED_DEPLOY_FAILED`, `BLOCKED_BUDGET_EXCEEDED`,
  `BLOCKED_TESTS_NEED_CLARIFICATION`, `BLOCKED_REVIEW_NONCONVERGENT`, plus
  `QUARANTINED_INVALID_STATE`) and has been so for at least
  `_MIN_DEP_STALL_SECONDS = 45 * 60` (measured off each blocker's
  `updated_at`), `story.dependency_defer_count` increments. At
  `_MAX_DEPENDENCY_DEFERRALS = 3` consecutive stalled deferrals the
  dependent is parked in `BLOCKED_DEPENDENCY_UNMET` with
  `last_rejection_reason` prefixed `dependency_deferral_cap_exhausted`
  (`state_machine.DEP_DEFER_CAP_REASON_PREFIX`). The counter resets to 0 the
  moment any blocker becomes live again — a story waiting out normal
  dev/review/merge work never accumulates a count no matter how long it
  takes.

`state_machine.is_dependency_cap_parked(state, last_rejection_reason)` is the
single predicate distinguishing a cap-park (revivable) from a deadlock-park
(abandoned) — used by `factory inbox`, the tracker-issue sweep, and the
closed-tracker reconciler so they never disagree.

Cap-parked rows self-heal: `orchestrator._revive_capped_dependents()` scans
`BLOCKED_DEPENDENCY_UNMET` rows carrying the cap marker each tick and, once
no pending dependency is stalled or dead, resumes the story at the state it
was parked *from* (read from the `dependency_deferral_capped` event via
`_dep_cap_resume_state`, falling back to `STORY_CREATED` if that state is no
longer dispatchable) — not from scratch, so a story capped out of
`REVIEWER_DONE` doesn't re-burn SM+dev+review spend. Deadlock-parked rows
have no automatic revival; an operator must move the row back to a live
dispatch state by hand.

## Key files

* `factory/chain/state_machine.py` — `StoryState`, `StoryRecord`, the event
  constants, `_TRANSITIONS`, `advance()`, `is_terminal()`,
  `DEP_DEFER_CAP_REASON_PREFIX`, `is_dependency_cap_parked()`.
* `factory/chain/orchestrator.py` — `_DISPATCH` (state → handler name),
  `_dispatch_for_story()` (adds the `chain_kind` branch out of
  `STORY_CREATED`), `_STATE_PROGRESS_ORDINAL` / `_apply_advance_decay`
  (per-story spend-breaker decay), `_NON_CAP_COUNTING_STATES` /
  `_DOCS_ACTIVE_STATES` (concurrency-cap and docs-serialization exclusions),
  `_DEAD_END_DEP_STATES` / `_STALLED_DEP_STATES` / `_MAX_DEPENDENCY_DEFERRALS`
  / `_MIN_DEP_STALL_SECONDS` (the dependency-deferral cap),
  `_AUTO_RECOVERABLE_STATES` / `_recover_blocked_stories` (blocked-state
  auto-recovery), `reconcile_closed_trackers` (sets `CLOSED_BY_OPERATOR`).
* `factory/chain/rollback.py` — **deleted 2026-08-07 (019 AC5)**, dead code
  with tests that only guarded it. It was a separate post-merge safety net,
  NOT part of the `StoryState` machine: `rollback_watch_tick()` read recent
  rows from `merge_actions` (written by `auto_merge.py`), checked
  main-branch CI for each recent merge, and on red opened a revert PR
  (`gh pr revert`), filed a `priority/p0` regression issue, and flipped the
  factory mode to `fix-only` via `factory.settings.modes.set_mode`. Its
  decisions were recorded in `state/factory.db.rollback_actions`
  (`RollbackActionRecord`). The CLI's `factory rollback-watch` command was
  removed with it.
* `factory/chain/dual_draft.py` — `should_spawn_dual_draft`,
  `produce_interpretations`, `link_alternatives` (idempotent tracker
  comment via `LINK_ALTERNATIVES_SENTINEL`), `close_abandoned_draft_sibling`
  (the `SUPERSEDED_BY_SIBLING` supersede logic).
* `factory/chain/handlers.py` — the side-effect layer: each handler (`sm`,
  `dev`, `review`, `tech_writer`, `docs_sm`, `docs_onboarder`,
  `docs_enforcer`, `deploy`) consumes `advance()`'s next-state and persists
  it. Owns `_MAX_REVIEW_CYCLES = 6`.
* `factory/chain/auto_merge.py` — drives `PR_OPEN` → `CI_PENDING` →
  `CI_GREEN` → `READY_FOR_MERGE` → (`EVENT_MERGED`) by direct state
  assignment (these transitions are not in `_TRANSITIONS`); owns
  `_MERGEABLE_STATES`, `_MAX_CI_FIX_CYCLES = 3`, `_handle_ci_failure`, and
  the `BLOCKED_CI_UNRESOLVED` / `BLOCKED_DEPLOY_FAILED` sink assignments.
* `factory/chain/delivery_gate.py` — per-story delivery level: spawn
  resolution (`record_spawn_level`), the drift-proof read (`story_level`), and
  the git side of `none` (`commit_local_work`) and `push_to_main`
  (`fast_forward_default_branch`, `worktree_head_and_files`).
* `factory/chain/event_log.py` — `log_story_event()` /
  `read_story_events()`. Append-only JSONL at
  `state/logs/<story_id:04d>-<slug>.log`, one file per story so `factory why`
  is a direct file read rather than a scan. Best-effort: every write is
  wrapped so a logging failure (missing dir, permission glitch) can never
  crash a handler or a tick. Event payloads with non-JSON-serializable
  values are stored via `repr()` instead of raising.

## Failure modes

* **`CI_PENDING`/`CI_GREEN` false-terminal via `is_terminal()`.** These
  states have no `_TRANSITIONS` edges (they're driven by `auto_merge.py`
  directly), so a naive `is_terminal(CI_PENDING)` reports `True` even
  though the story is actively mid-merge. Any new caller that needs real
  terminality must use the explicit allowlists (`_DEAD_END_DEP_STATES`,
  `tracker_issue._RESOLVED_STORY_STATES`) instead of `is_terminal()`.
* **Dev↔reviewer non-convergence.** Capped at `_MAX_REVIEW_CYCLES = 3`
  cycles → `BLOCKED_REVIEW_NONCONVERGENT`; auto-recovered to `SM_DONE` at
  most `_MAX_AUTO_RECOVERIES = 2` times, gated on the failure signature
  actually changing between recoveries.
* **CI-fix hamster-wheel.** Before `BLOCKED_CI_UNRESOLVED` existed, a red
  PR that a dev sandbox couldn't fix (pre-existing lint error in an
  unowned file, product-level smoke conflict) sat in `PR_OPEN` forever,
  re-evaluated and re-failing the merge gate every tick (~30 min of git
  work per tick for the same "blocked" conclusion). Now capped at
  `_MAX_CI_FIX_CYCLES = 3` re-dispatches (or an identical failure
  signature) before the PR is closed and the story parked.
* **Dependency deadlock behind a dead foundation.** Before
  `BLOCKED_DEPENDENCY_UNMET` existed, a dependent whose foundation landed
  in a never-to-deploy sink sat in its pre-build state (e.g.
  `STORY_CREATED`) forever — never dispatched (no spend wheel) but never
  resolved, so its direction never completed and its tracker issue never
  closed. Observed 2026-07-23: 6 dual-draft `-alt-b` siblings stranded
  behind `-alt-b`'s abandoned `-alt-a` pair.
* **Dependency deferral without a cap.** `BLOCKED_DEPLOY_FAILED` is
  deliberately not a dead end (an FMS playbook really does revive it), so
  before the cap existed, a dependent behind one deferred every tick
  forever with nothing surfaced to an operator (2026-07-28 deadlock).
  Deferring is correct; deferring unboundedly is the bug the cap closes.
* **Double-merge from an un-retired dual-draft loser.** Before
  `close_abandoned_draft_sibling` closed the loser's PR and superseded its
  `StoryRecord`, only the loser's GitHub issue was closed — a loser already
  holding an auto-merge-enabled PR still merged minutes later, shipping
  both interpretations (direction 007: PR #67 AND #69 both landed).
* **Poisoned rows outside the enum.** A `StoryRecord.state` string set
  outside `StoryState` (a bad manual/manager write, e.g. an `abandoned` row
  that halted the factory for days on 2026-07-07) is skipped by the
  orchestrator's poisoned-row guard every tick — silently and permanently,
  until `factory.manager.recovery`'s `quarantine-invalid-enum-story`
  playbook moves it to `QUARANTINED_INVALID_STATE`, preserving the
  original invalid string in `story.error`.
* **Operator-tracker/local-state disagreement.** A human closing a
  story's tracker issue while the local row still sits in a
  recoverable-pending-human block used to have no representation — the
  factory kept listing the story as awaiting a human days after the human
  had already ruled (observed 2026-07-24: stories 81 and 130, tracker
  issues #267/#337). `reconcile_closed_trackers` now sets
  `CLOSED_BY_OPERATOR` at the top of every tick to close that gap.
* **Rollback is post-merge only, not a `StoryState` concept.** A regression
  that lands on main flips factory mode to `fix-only` and opens a revert
  PR, but the merged story's own `StoryRecord` stays at whatever state it
  reached (typically `DEPLOYED`) — the rollback is tracked in
  `rollback_actions`, not in the chain's state machine.

## Escalation paths

* **Dispatch-time policy rejection** — the orchestrator's cap/mode checks
  (`can_dispatch()`) reject a handler call without any state transition;
  `StoryRecord.last_rejection_reason` records why and the story shows up in
  `factory inbox`. No state change means no event either — the story is
  simply not chosen this tick.
* **Blocked sinks awaiting a human** — `BLOCKED_TESTS_NEED_CLARIFICATION`,
  `BLOCKED_DEPLOY_FAILED`, `BLOCKED_REVIEW_NONCONVERGENT`,
  `BLOCKED_BUDGET_EXCEEDED` are the four states `orchestrator._PENDING_HUMAN_STATES`
  tracks as revivable-by-operator; `factory inbox` surfaces them.
  `BLOCKED_TESTS_NEED_CLARIFICATION` and `BLOCKED_REVIEW_NONCONVERGENT` also
  get automatic bounded re-attempts via `_AUTO_RECOVERABLE_STATES` before a
  human needs to act.
* **Permanent sinks** — `SUPERSEDED_BY_SIBLING`, `BLOCKED_CI_UNRESOLVED`,
  `BLOCKED_DEPENDENCY_UNMET` (deadlock variant), `QUARANTINED_INVALID_STATE`,
  `CLOSED_BY_OPERATOR` all resolve their tracker issue automatically
  (`tracker_issue._RESOLVED_STORY_STATES`) and are surfaced to the FMS
  (`factory_improver._terminally_blocked_stories`) rather than to the
  interactive operator inbox — there is nothing actionable left except a
  manual state reset for the rare case an operator wants to retry.
* **Rollback escalation** — `rollback_watch_tick()` files a
  `priority/p0` GitHub issue with the merged PR link, the suspect commit,
  and the failing test names, then calls `set_mode("fix-only", ...)` so
  feature work pauses factory-wide until the regression is addressed.
  This is the one escalation path that changes factory *mode* rather than
  any single story's state.
* **`factory why <id>` / `factory trace <id>`** — read
  `state/logs/<story_id>-<slug>.log` via `event_log.read_story_events()`.
  This is the audit trail of *how* a story reached its current state and
  *why* a transition happened (handler start/end, `dev_retry`,
  `dev_exhausted`, `dependency_deferral_capped`, `dependency_defer_revived`,
  `auto_recovery`, `handler_exception`, etc.) — the chain's own state only
  tells you *what* state a story is in now.
