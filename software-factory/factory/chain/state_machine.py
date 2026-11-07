"""TDD chain state machine.

The chain advances each ``StoryRecord`` through a fixed sequence of states.
Each transition is driven by an *event* (handler completion, webhook
arrival, retry timer) carrying an optional payload (handler result, GitHub
event body, error string).

This module is pure: ``advance(story, event, payload) -> StoryState`` only
computes the next state from the current state and the event. Handlers in
``factory/chain/handlers.py`` are responsible for the side effects
(LLM calls, GitHub API calls, file writes); they consume the next-state
from ``advance`` to know what to persist.

State names mirror the plan section "TDD chain (the heart of the
workflow)". The story-record fields capture everything a handler needs to
resume from any state (test_plan_json, dev_retries, current_model_tier,
etc).
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from sqlmodel import Field, SQLModel


class StoryState(StrEnum):
    """Every state a story can be in.

    Two chain variants share the same enum; the orchestrator picks the
    starting handler based on ``story.chain_kind``:

    * ``tdd`` (default): SM → dev → reviewer → tech_writer → docs_enforcer →
      PR_OPEN. The dev persona writes the production code AND its tests in one
      pass (Loop-4, dev-owns-tests); there is no separate test-design /
      test-implementation phase.
    * ``docs``: docs_sm → docs_onboarder → docs_enforcer → PR_OPEN. Used for
      stories whose deliverable is canonical documentation (e.g. the initial
      ``context/`` bootstrap). Skips the code+test loop entirely.

    Both variants converge at ``DOCS_ENFORCER_CHECK`` and onward; the
    enforcer + PR + deploy states are shared.
    """

    STORY_CREATED = "story_created"
    SM_IN_PROGRESS = "sm_in_progress"
    SM_DONE = "sm_done"
    DEV_IN_PROGRESS = "dev_in_progress"
    DEV_RETRY = "dev_retry"
    TESTS_GREEN = "tests_green"
    REVIEWER_IN_PROGRESS = "reviewer_in_progress"
    REVIEWER_DONE = "reviewer_done"
    REVIEWER_REQUESTED_CHANGES = "reviewer_requested_changes"
    TECH_WRITER_IN_PROGRESS = "tech_writer_in_progress"
    TECH_WRITER_DONE = "tech_writer_done"
    # Docs chain: lightweight path for documentation-only stories. Onboarder
    # writes the canonical files in one shot; no test loop.
    DOCS_SM_IN_PROGRESS = "docs_sm_in_progress"
    DOCS_SM_DONE = "docs_sm_done"
    DOCS_ONBOARDER_IN_PROGRESS = "docs_onboarder_in_progress"
    DOCS_ONBOARDER_DONE = "docs_onboarder_done"
    DOCS_ENFORCER_CHECK = "docs_enforcer_check"
    PR_OPEN = "pr_open"
    CI_PENDING = "ci_pending"
    CI_GREEN = "ci_green"
    READY_FOR_MERGE = "ready_for_merge"
    DEPLOY_PENDING = "deploy_pending"
    DEPLOYED = "deployed"
    BLOCKED_TESTS_NEED_CLARIFICATION = "blocked_tests_need_clarification"
    BLOCKED_DEPLOY_FAILED = "blocked_deploy_failed"
    # Hard convergence guard: when the dev<->reviewer loop fails to converge
    # within _MAX_REVIEW_CYCLES reviewer passes, the reviewer handler routes
    # here instead of bouncing back to REVIEWER_REQUESTED_CHANGES. Terminal
    # (no outgoing transition) so the orchestrator stops dispatching the
    # story and it surfaces for human review instead of looping indefinitely.
    BLOCKED_REVIEW_NONCONVERGENT = "blocked_review_nonconvergent"
    # WS1.1 global per-story budget circuit breaker. The composed loops (dev
    # retries, reviewer cycles, auto-recovery re-dispatch, CI-fix) each have
    # their OWN counter but no aggregate per-story ceiling, so a pathological
    # story can burn dev(6)*review(6)+recovery(2)+CI-fix(3) loops of spend.
    # When a story's ``total_attempts`` or ``total_spend_usd`` crosses the
    # per-story cap, the orchestrator routes it here. Terminal (no outgoing
    # transition) so a broken story stops burning spend and surfaces for a
    # human with the evidence event the breaker emits.
    #
    # OPERATOR RESET (this is a terminal sink and its worktree gets pruned):
    # to re-run a story parked here, move it back to a live dispatch state
    # (e.g. ``sm_done`` to replay dev→review→merge, or ``story_created`` from
    # scratch) AND zero the accumulators (``total_attempts = 0``,
    # ``total_spend_usd = 0.0``) — otherwise the pre-dispatch breaker re-trips
    # immediately. To raise the ceiling globally instead, bump
    # ``caps.per_story_attempts`` / ``caps.per_story_spend_usd`` in
    # factory_settings.yaml. There is deliberately no auto-recovery path
    # (this state is absent from ``_AUTO_RECOVERABLE_STATES``).
    BLOCKED_BUDGET_EXCEEDED = "blocked_budget_exceeded"
    # Phase 7 dual-draft loser sink. An ambiguous/(explore) direction spawns
    # TWO ``draft-alternative`` siblings (slugs ``…-alt-a`` / ``…-alt-b``); only
    # ONE should ship. When the winner's PR merges, the loser is parked here by
    # ``dual_draft.close_abandoned_draft_sibling`` so the chain stops driving it
    # (otherwise a loser still in dev/review would open its own PR and merge a
    # redundant second interpretation to main — observed: direction 007 shipped
    # BOTH PR #67 and #69). TERMINAL: no outgoing transition, so ``is_terminal``
    # reports True, ``_dispatch_for_story`` returns None, and it is absent from
    # ``auto_merge._MERGEABLE_STATES``. A supersede can fire from ANY in-flight
    # state, so the caller sets this via a DIRECT state assignment rather than a
    # state-machine ``advance()`` edge — deliberately NOT wired as an EVENT_*
    # transition from every source state.
    SUPERSEDED_BY_SIBLING = "superseded_by_sibling"
    # CI-recovery exhausted sink. When ``auto_merge._handle_ci_failure`` gives up
    # on a red PR (``_MAX_CI_FIX_CYCLES`` re-dispatches reached, or the dev's fix
    # reproduced the IDENTICAL failure signature), the failure is app-blocked in a
    # way the isolated dev sandbox cannot resolve (e.g. a pre-existing lint error
    # in an unowned file, or a product-level smoke conflict). Before this sink such
    # a story sat in ``PR_OPEN`` forever, re-evaluated + failing the merge gate on
    # every tick (a hamster-wheel: ~30 min of git work per tick to reach the same
    # "blocked" conclusion). On give-up the auto-merge worker now CLOSES the PR with
    # an explanatory comment and parks the story here. TERMINAL (no outgoing
    # transition → ``is_terminal`` True, ``_dispatch_for_story`` returns None) and
    # absent from ``auto_merge._MERGEABLE_STATES`` so the chain stops re-driving it.
    # Because the PR is CLOSED (not merely parked-while-open), there is nothing left
    # for ``reconcile_from_github`` to record — this deliberately AVOIDS the
    # reconciliation regression that sank the earlier open-PR park attempt (#95).
    # RECOVERABLE: the direction remains on disk and can be re-filed once the
    # app-side blocker is fixed; an operator may also re-open the PR and move the
    # story back to a live dispatch state. Set via DIRECT state assignment (like
    # ``SUPERSEDED_BY_SIBLING``), not an EVENT_* edge. Classified as resolved for
    # tracker-issue closing (``tracker_issue._RESOLVED_STORY_STATES``). Used to
    # also be surfaced to the FMS via ``factory_improver._terminally_blocked_stories``,
    # deleted 2026-08-07 with the rest of the self-improvement tiers.
    BLOCKED_CI_UNRESOLVED = "blocked_ci_unresolved"
    # Dependency-deadlock sink. The dependency-ordering gate defers a story until
    # every lower-id sibling in its direction reaches ``deployed`` (id order == SM
    # build order). If one of those required siblings is instead TERMINALLY parked
    # in a never-to-deploy state (``blocked_*`` / ``superseded_by_sibling`` /
    # ``blocked_ci_unresolved``), the dependent can NEVER build — its foundation
    # will never land on main. Before this sink it sat in its pre-build state
    # (e.g. ``story_created``) FOREVER: never dispatched (so not a spend/tick
    # wheel) but never resolved either, so its direction never completes and its
    # tracker issue never closes (observed 2026-07-23: 6 dual-draft ``alt-b``
    # siblings stranded behind ``alt-b``'s abandoned ``alt-a`` pair). The
    # orchestrator now parks such a story here instead of deferring indefinitely.
    # TERMINAL (no outgoing transition), absent from ``_MERGEABLE_STATES`` and
    # ``_AUTO_RECOVERABLE_STATES``, in ``_NON_CAP_COUNTING_STATES``, classified
    # resolved for tracker-issue closing, and surfaced to the FMS. RECOVERY IS
    # MANUAL (deliberately absent from ``_AUTO_RECOVERABLE_STATES``): reviving the
    # blocking sibling does NOT by itself re-enter this story — an operator must
    # ALSO move this story back to a live dispatch state (e.g. ``story_created``).
    BLOCKED_DEPENDENCY_UNMET = "blocked_dependency_unmet"
    # Poisoned-row quarantine sink. A story row whose ``state`` string is OUTSIDE
    # this enum (a bad manual/manager write, e.g. the ``abandoned`` row that
    # halted the factory for days on 2026-07-07) is NON-FATALLY skipped by the
    # orchestrator's poisoned-row guard every tick — but that skip is otherwise
    # SILENT and permanent: the invalid row is re-evaluated (and re-skipped)
    # forever until a human hand-repairs it. The operational reconciler
    # (``factory.manager.recovery`` playbook ``quarantine-invalid-enum-story``)
    # moves such a row HERE — a VALID terminal enum value — preserving the
    # original invalid string in ``error`` for forensics. Once here the row is a
    # normal terminal state: ``StoryState(state)`` no longer raises, so the guard
    # stops tripping and the row stops being skipped/re-evaluated. TERMINAL (no
    # outgoing transition → ``is_terminal`` True, ``_dispatch_for_story`` returns
    # None), absent from ``auto_merge._MERGEABLE_STATES``, and classified resolved
    # for tracker-issue closing (``tracker_issue._RESOLVED_STORY_STATES``) — the
    # row produced nothing and never will, so its tracker should close rather than
    # linger. RECOVERY IS MANUAL: an operator who identifies the root cause can
    # move the row back to a live dispatch state (and clear ``error``). Set via
    # DIRECT state assignment (like ``SUPERSEDED_BY_SIBLING``), never an EVENT_*
    # edge — the SOURCE state is by definition not a valid enum, so no transition
    # table entry could name it.
    QUARANTINED_INVALID_STATE = "quarantined_invalid_state"
    # Operator-closed sink. GitHub is the system of record for whether work is
    # still wanted; the local DB is a PROJECTION of it. When an operator closes a
    # story's tracker ISSUE while the local row still sits in a
    # recoverable-pending-human block (``blocked_deploy_failed`` /
    # ``blocked_budget_exceeded`` / ``blocked_tests_need_clarification`` /
    # ``blocked_review_nonconvergent``), those two disagree: the human has decided
    # the work is done or abandoned, while the factory still lists it as awaiting
    # that same human. Before this sink there was NO way to record that decision —
    # the pending-human blocks are deliberately excluded from
    # ``tracker_issue._RESOLVED_STORY_STATES`` precisely because a human MIGHT
    # revive them, so a row whose human had already ruled sat in the operator
    # inbox forever (observed 2026-07-24: stories 81 and 130, tracker issues #267
    # and #337 closed by the operator days earlier, still listed as needing human
    # action with zero open PRs or issues on GitHub).
    #
    # ``orchestrator.reconcile_closed_trackers`` parks such a row here at the top
    # of a tick. TERMINAL (no outgoing transition → ``is_terminal`` True,
    # ``_dispatch_for_story`` returns None), absent from
    # ``auto_merge._MERGEABLE_STATES`` and ``_AUTO_RECOVERABLE_STATES``, in
    # ``_NON_CAP_COUNTING_STATES`` and ``_DEAD_END_DEP_STATES`` (an
    # operator-closed foundation will never deploy, so dependents must stop
    # waiting on it), and classified resolved for tracker-issue closing. Set via
    # DIRECT state assignment (like ``SUPERSEDED_BY_SIBLING``) because the closure
    # can arrive from ANY pending-human state, so no single EVENT_* edge fits.
    # RECOVERY: re-open the tracker issue and move the row back to a live dispatch
    # state — reconciliation never resurrects on its own (it only ever advances
    # toward terminal, so it stays idempotent).
    CLOSED_BY_OPERATOR = "closed_by_operator"
    # DEV-DECLARED underspecification. The dev persona may end a run with
    # ``UNDERSPECIFIED: <reason>`` when the story cannot be satisfied as
    # written — a contradictory or missing contract, an acceptance criterion
    # with no observable behaviour, a task whose premise is false. The dev
    # handler routes the story HERE instead of counting a retry.
    #
    # EVIDENCE (ImpossibleBench, ICLR 2026, arXiv 2510.20270): giving the agent
    # an explicit way to declare a task impossible/underspecified dropped
    # test-exploitation from 54% -> 9% (GPT-5) and 49% -> 12% (o3). Without the
    # escape hatch, an agent handed an unsatisfiable task does not stop — it
    # games whatever check is in reach. Under Loop-4 (dev owns its own tests)
    # that check is the dev's own test file, which is exactly the false-green
    # the 2026-08-04 hidden-oracle grading measured (self-verdict 40% precise).
    #
    # Properties this state must keep, all of them load-bearing:
    #   * TERMINAL — no outgoing transition, so ``is_terminal`` is True,
    #     ``_dispatch_for_story`` returns None and the chain stops driving it.
    #   * CONSUMES NO DEV RETRY — ``story.dev_retries`` is untouched on the way
    #     in. A declaration is not a failed attempt; charging a retry for it
    #     would make honesty cost the same as failure.
    #   * NOT auto-recoverable — deliberately absent from
    #     ``orchestrator._AUTO_RECOVERABLE_STATES``. Re-entering the chain at
    #     SM_DONE would re-dispatch dev against the SAME under-specified story
    #     and get the same declaration, i.e. a retry loop wearing a different
    #     hat. The story needs a human to rewrite it (or to reject the claim).
    #   * PENDING-HUMAN, not resolved — in
    #     ``orchestrator._PENDING_HUMAN_STATES`` and surfaced by
    #     ``factory inbox``; deliberately absent from
    #     ``tracker_issue._RESOLVED_STORY_STATES`` so the tracker issue stays
    #     open until the operator rules. ``reconcile_closed_trackers`` is the
    #     way out when they rule by closing the issue.
    # The reason the dev gave is recorded in ``StoryRecord.error`` (the repo
    # rule: every BLOCKED_* transition records a reason) and in a
    # ``dev_declared_underspecified`` story event.
    BLOCKED_UNDERSPECIFIED = "blocked_underspecified"
    # DELIVERY-LEVEL END STATES (``factory/delivery.py``, ``docs/JOBS-API.md``).
    # A story whose recorded ``delivery_level`` stops short of merging ends in
    # one of these once every chain gate up to the PR has passed:
    #
    #   * ``DELIVERED_LOCAL``  — level ``none``: the work is COMMITTED on the
    #     story branch (``story/<n>-<slug>``) in the factory's per-story worktree
    #     and NEVER pushed. The branch lives in the app's source checkout, so it
    #     survives the worktree pruner (which removes the directory, not the ref).
    #   * ``DELIVERED_BRANCH`` — level ``branch``: the branch is pushed to origin;
    #     no PR was opened.
    #   * ``DELIVERED_PR``     — level ``draft_pr`` / ``pr``: a PR is open (draft
    #     or ready, per ``delivery_level``); the factory never marks a draft ready
    #     and never merges either. Also where a ``push_to_main`` story lands when
    #     the fast-forward is refused (fail safe: it behaves as ``pr``).
    #
    # All three are TERMINAL (no outgoing transition → ``is_terminal`` True,
    # ``_dispatch_for_story`` returns None), absent from
    # ``auto_merge._MERGEABLE_STATES`` and ``_AUTO_RECOVERABLE_STATES``, in
    # ``_NON_CAP_COUNTING_STATES``, and in ``orchestrator._PENDING_HUMAN_STATES``:
    # the factory's job is done but the change is NOT on the default branch, so
    # a human owns the next step. They are deliberately NOT in
    # ``tracker_issue._RESOLVED_STORY_STATES`` — merge reality is GitHub, and an
    # unmerged change must not close its story issue or its direction's tracker.
    # ``reconcile_from_github`` keeps watching ``DELIVERED_PR`` so a human merge
    # flows into ``DEPLOY_PENDING`` exactly like an auto-merge would.
    DELIVERED_LOCAL = "delivered_local"
    DELIVERED_BRANCH = "delivered_branch"
    DELIVERED_PR = "delivered_pr"


# The delivery-level end states, as raw strings for allowlists that compare
# ``StoryRecord.state`` values. ONE definition so the in-flight / cap / inbox /
# progress sets can never disagree about them.
DELIVERED_UNMERGED_STATES: frozenset[str] = frozenset(
    {
        StoryState.DELIVERED_LOCAL.value,
        StoryState.DELIVERED_BRANCH.value,
        StoryState.DELIVERED_PR.value,
    }
)


class StoryRecord(SQLModel, table=True):
    """Per-story chain record, persisted in ``state/factory.db.stories``.

    One row per child_story spawned from a Direction's PM result. Carries
    every handler input/output and enough audit data to resume the chain
    after a crash.
    """

    __tablename__ = "stories"

    id: int | None = Field(default=None, primary_key=True)
    direction_id: str = Field(index=True)
    app: str = Field(index=True)
    title: str
    slug: str
    scope: str  # frontend | backend | infra | test | docs
    state: str = Field(default=StoryState.STORY_CREATED.value, index=True)
    # Which chain variant drives this story. ``tdd`` is the historical
    # default; ``docs`` routes through docs_sm → docs_onboarder →
    # docs_enforcer for documentation-only deliverables. The orchestrator
    # reads this when dispatching out of STORY_CREATED.
    chain_kind: str = Field(default="tdd", index=True)
    # Per-job routing, stamped ONCE at spawn (factory/job_routing.py) and never
    # re-read from the direction/app config: ``pipeline`` is ``chain`` or
    # ``solo``; ``model_overrides_json`` is the merged job>app persona->model
    # map (NULL = routes.yaml only). Handlers resolve models via
    # ``job_routing.route_for_story``.
    pipeline: str = Field(default="chain")
    model_overrides_json: str | None = None
    github_issue_number: int | None = None
    github_branch: str | None = None
    github_pr_number: int | None = None
    story_file_path: str = ""
    sm_result_json: str | None = None  # JSON-serialized SM persona output
    # Retained: still rendered into the REVIEWER's prompt (handlers.handle_review)
    # as the "## Test plan" section, even though the test_designer persona that
    # once populated it was removed in the Loop-4 collapse (usually None now).
    test_plan_json: str | None = None
    reviewer_result_json: str | None = None
    # JSON-serialised list of prior review cycles (capped to the last 4):
    # ``[{cycle, verdict, score, findings: [{severity, location, what,
    #    regression}], test_quality_findings: [...]}]``. Rendered into the
    # REVIEWER's re-review prompt (making the finality rule enforceable — the
    # reviewer otherwise has no memory of what it previously said) and into
    # DEV's prompt as an "already addressed, do not regress" digest.
    reviewer_history_json: str | None = None
    tech_writer_result_json: str | None = None
    dev_retries: int = 0
    # JSON-serialised list of prior dev attempts on this story. Each entry:
    # ``{"attempt": N, "ts": "...", "test_output_tail": "...",
    #    "files_touched": [...], "summary": "..."}``. Carried forward into
    # the next dev sandbox's initial message so the LLM sees what it tried
    # and what failed instead of re-discovering dead ends from scratch.
    dev_attempts_json: str | None = None
    # WS4.2 resume-from-checkpoint marker. Set to a small JSON blob
    # (``{"outcome": "green", "attempt": N, "ts": ...}``) by the dev handler the
    # instant a sandbox returns GREEN — persisted BEFORE the state advances out
    # of ``dev_in_progress`` and cleared the instant the advance is persisted.
    # It therefore survives ONLY a tick that died in the tiny window between
    # "sandbox finished green" and "state advanced". On the next dev dispatch the
    # handler reads this marker and resumes to ``tests_green`` WITHOUT re-running
    # the (already-complete, already-in-the-worktree) dev LLM. None in steady
    # state. See ``handlers._try_resume_dev_from_checkpoint``.
    dev_step_checkpoint: str | None = None
    # Hard convergence guard counter: incremented each time the reviewer
    # returns a request-changes verdict in handle_review. When it reaches
    # ``_MAX_REVIEW_CYCLES`` the story is routed to
    # ``BLOCKED_REVIEW_NONCONVERGENT`` instead of looping back to dev, so a
    # non-converging dev<->reviewer ping-pong cannot burn budget unbounded.
    reviewer_cycles: int = 0
    # WS1.1 global per-story budget circuit breaker accumulators. Unlike the
    # per-loop counters above (dev_retries, reviewer_cycles) these span EVERY
    # loop the story passes through — dev retries, reviewer cycles, tech_writer,
    # docs, auto-recovery re-dispatch, CI-fix — giving one aggregate ceiling no
    # single loop's counter can see. ``total_attempts`` is bumped once per
    # handler dispatch by the orchestrator; ``total_spend_usd`` is refreshed
    # from the D003 per-run ledger (runs.cost_usd attributed to this story)
    # after each dispatch. When either crosses the per-story cap the
    # orchestrator advances the story to BLOCKED_BUDGET_EXCEEDED.
    total_attempts: int = 0
    total_spend_usd: float = 0.0
    # WS1.1 advance-decay high-water mark: the highest happy-path progress
    # ordinal (see orchestrator._STATE_PROGRESS_ORDINAL) this story has ever
    # reached. When a dispatch advances the story to a state whose ordinal
    # EXCEEDS this mark — genuine, monotonic forward progress, not a dev<->review
    # oscillation that re-treads states already seen — the orchestrator resets
    # ``total_attempts`` (the spend cap stays the hard ceiling). This keeps a
    # story that is still making progress from tripping the attempt breaker on a
    # poisoned historical count, while a stuck/oscillating story still exhausts
    # it. Default 0 so a story's first real state always registers.
    max_progress_ordinal: int = 0
    # Dependency-deferral cap counter. Incremented once per tick that defers
    # this story behind foundations which are ALL human-blocked (see
    # ``orchestrator._STALLED_DEP_STATES``) and reset the moment any blocker is
    # live again, so a story waiting out its foundation's real work never
    # accumulates a count. At ``orchestrator._MAX_DEPENDENCY_DEFERRALS`` the
    # dependent is parked in ``BLOCKED_DEPENDENCY_UNMET`` and surfaced in
    # ``factory inbox`` instead of deferring silently forever.
    dependency_defer_count: int = 0
    current_model_tier: str = "standard"  # standard | hard
    created_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    error: str | None = None
    # Phase 3: last cap/mode rejection reason emitted by the dispatcher.
    last_rejection_reason: str | None = None
    # D002 Karpathy Layer-2 runtime verifier — DECLARED BUT NEVER WRITTEN.
    # The intent was "set True after the dev's sandbox boots the product and
    # the scripted smoke journey passes", but no handler was ever written to
    # do it, so this is always None. The ``smoke-green`` gate used to READ it
    # in dry-run and pass the gate when truthy; that reader was deleted
    # (2026-08-01) because a merge gate keyed on a never-written flag is
    # proxy != real waiting to happen. The gate now fails closed without a
    # real run.
    #
    # DO NOT start reading this field again. Either write it from the place
    # that actually observes the smoke journey — and re-verify the gate — or
    # drop the column. It sits alongside four other write-never columns
    # (``lint_passed``, ``format_passed``, ``types_passed``,
    # ``coverage_passed``); see PLAN.md Phase 3.2.
    smoke_passed: bool | None = None
    # Item 4 — harness precheck. Set True after a one-shot pytest
    # collect+exit pass succeeds against the per-story worktree (with
    # ONLY the test files committed, before dev writes production
    # code). The orchestrator's dispatch table reads this flag when
    # state==TESTS_RED to decide whether to fire ``harness_precheck``
    # or skip ahead to ``dev``. Default ``False`` so existing stories
    # transparently get the precheck on their next visit.
    harness_precheck_passed: bool = False
    # Phase 3 EBS (Evidence-Based Scheduling). PM assigns Fibonacci
    # story points at split time (1, 2, 3, 5, 8, 13). The chain
    # computes ``estimated_seconds`` from per-(persona, points)
    # baselines at story-creation time; the Monte Carlo simulator
    # uses points + persona velocities to project per-direction
    # ETAs. Both columns are nullable — legacy stories spawned
    # before this column existed keep ``None``.
    points: int | None = None
    estimated_seconds: float | None = None
    # WS1.2 independent acceptance oracle. Path (relative to the factory root)
    # of the acceptance test authored from THIS story's direction acceptance
    # criteria — the SPEC ONLY, blind to the dev's implementation and the dev's
    # own tests. Authored EARLY (at story spawn, before dev runs) and stored in
    # factory state UNDER ``state/acceptance/<app>/<story_id>/`` — deliberately
    # outside the app repo and outside the per-story dev worktree, so the dev
    # sandbox never receives it (the anti-reward-hack property: a coder that
    # cannot see the test judging it cannot special-case it — ImpossibleBench).
    # None means no oracle FILE is stored yet — which is NOT the same as "not
    # required": authoring can flake (transient LLM error) for a story that DOES
    # need an oracle. The required/blocking decision keys off
    # ``acceptance_expected`` below, never off this ref, so a failed author
    # cannot silently ship un-gated code.
    acceptance_test_ref: str | None = None
    # WS1.2 — whether this story is EXPECTED to have an acceptance oracle, set at
    # spawn to ``bool(gates.acceptance_oracle and direction.acceptance)``,
    # INDEPENDENT of whether authoring succeeded. This is the single source of
    # truth for "acceptance-verified is required for this story". When True but
    # ``acceptance_test_ref`` is missing (authoring flaked), the gate BLOCKS
    # authoritatively and the tick self-heal re-authors from the spec on a later
    # tick — expected-but-missing never silently passes and never blocks forever.
    acceptance_expected: bool = False
    # S4 (019 fail-silent audit): consecutive ``gh pr create`` (or the push
    # ahead of it) failures for this story. ``handle_docs_enforcer`` used to
    # advance to ``PR_OPEN`` even when PR creation returned ``None`` — a
    # state with no ``orchestrator._DISPATCH`` entry, so nothing ever drove
    # the story again and the failure was visible ONLY as a
    # ``git_op result=error`` line in ``state/events/git.ndjson``. Now the
    # story stays in ``DOCS_ENFORCER_CHECK`` (which DOES have a dispatch
    # entry, so the next tick retries PR creation for free — no LLM call)
    # until this counter hits ``handlers._MAX_PR_CREATE_RETRIES``, at which
    # point it's parked in ``BLOCKED_DEPLOY_FAILED``. Reset to 0 on success.
    pr_create_retries: int = 0
    # The story's delivery level (``factory.delivery.DeliveryLevel`` value),
    # resolved ONCE at spawn from the direction's ``delivery:`` frontmatter
    # (else the app's ``delivery.default``; there is no per-app ceiling) and
    # recorded here so it cannot drift mid-flight: a later config change never
    # moves it. Only fail-safe adjustments lower it (unreadable → ``none``;
    # factory self-edit ``push_to_main`` → ``pr``). ``None`` only on rows that predate per-story recording;
    # ``factory.chain.delivery_gate.story_level`` resolves and records those on
    # first touch.
    delivery_level: str | None = None


# Event names — strings the chain emits when a handler completes.
EVENT_SM_STARTED = "sm_started"
EVENT_SM_DONE = "sm_done"
EVENT_DEV_STARTED = "dev_started"
EVENT_DEV_TESTS_GREEN = "dev_tests_green"
EVENT_DEV_TESTS_RED = "dev_tests_red"  # dev finished but tests still red
EVENT_DEV_EXHAUSTED = "dev_exhausted"  # max retries hit
# The dev DECLARED the story underspecified/unsatisfiable as written (the
# ``UNDERSPECIFIED:`` marker in its final message). Distinct from
# EVENT_DEV_EXHAUSTED: nothing was retried to exhaustion, the dev is refusing
# to guess. Routes to the terminal BLOCKED_UNDERSPECIFIED sink.
EVENT_DEV_UNDERSPECIFIED = "dev_underspecified"
EVENT_REVIEWER_STARTED = "reviewer_started"
EVENT_REVIEWER_APPROVE = "reviewer_approve"
EVENT_REVIEWER_REQUEST_CHANGES = "reviewer_request_changes"
# Reviewer requested changes for the _MAX_REVIEW_CYCLES-th time without the
# story converging — the hard convergence guard fires this instead of
# EVENT_REVIEWER_REQUEST_CHANGES to break the dev<->reviewer ping-pong.
EVENT_REVIEW_NONCONVERGENT = "review_nonconvergent"
EVENT_TECH_WRITER_STARTED = "tech_writer_started"
EVENT_TECH_WRITER_DONE = "tech_writer_done"
EVENT_DOCS_ENFORCER_CHECK = "docs_enforcer_check"
EVENT_DOCS_ENFORCER_PASS = "docs_enforcer_pass"
EVENT_DOCS_ENFORCER_FAIL = "docs_enforcer_fail"
# S4 (019 fail-silent audit): ``gh pr create`` failed for the
# ``_MAX_PR_CREATE_RETRIES``-th consecutive time — park the story instead of
# retrying forever. See ``StoryRecord.pr_create_retries``.
EVENT_PR_CREATE_EXHAUSTED = "pr_create_exhausted"
# Delivery-level end events (see ``StoryState.DELIVERED_*``).
EVENT_DELIVERED_LOCAL = "delivered_local"
EVENT_DELIVERED_BRANCH = "delivered_branch"
EVENT_DELIVERED_PR = "delivered_pr"
# Docs chain events.
EVENT_DOCS_SM_STARTED = "docs_sm_started"
EVENT_DOCS_SM_DONE = "docs_sm_done"
EVENT_DOCS_ONBOARDER_STARTED = "docs_onboarder_started"
EVENT_DOCS_ONBOARDER_DONE = "docs_onboarder_done"
EVENT_DOCS_ONBOARDER_FAILED = "docs_onboarder_failed"
# Phase 5: post-merge deploy chain.
EVENT_MERGED = "merged"  # auto-merge or webhook flips READY_FOR_MERGE -> DEPLOY_PENDING.
EVENT_DEPLOY_STARTED = "deploy_started"
EVENT_DEPLOY_SUCCEEDED = "deploy_succeeded"
EVENT_DEPLOY_FAILED = "deploy_failed"
EVENT_DEPLOY_SKIPPED = "deploy_skipped"  # mode/cap rejection or deploy.enabled=false
# Auto-merge worker gave up: the PR is terminally un-mergeable (closed,
# already-merged out-of-band, or CONFLICTING/DIRTY). Routes the story to the
# terminal BLOCKED_DEPLOY_FAILED sink so it stops being retried every tick.
EVENT_PR_UNMERGEABLE = "pr_unmergeable"
# WS1.1 per-story budget circuit breaker fired: the story's aggregate
# ``total_attempts`` or ``total_spend_usd`` crossed the per-story cap. Routes
# every budget-metered dispatch state to the terminal BLOCKED_BUDGET_EXCEEDED
# sink so the story stops burning spend across composed loops.
EVENT_BUDGET_EXCEEDED = "budget_exceeded"


# Lookup table: (current_state, event) -> next_state.
# This is the source of truth for the chain's transition graph. Any
# (state, event) pair not in this map is an illegal transition.
_TRANSITIONS: dict[tuple[StoryState, str], StoryState] = {
    # ---- TDD chain (chain_kind == "tdd"), Loop-4 dev-owns-tests ----
    # SM_DONE dispatches dev DIRECTLY. The dev persona writes BOTH production
    # code and its tests in one context and runs them; there is no separate
    # test_design/test_impl/harness phase and no frozen test artifact authored
    # by another agent. Test quality is gated downstream by the reviewer + the
    # programmatic slop detector.
    (StoryState.STORY_CREATED, EVENT_SM_STARTED): StoryState.SM_IN_PROGRESS,
    (StoryState.SM_IN_PROGRESS, EVENT_SM_DONE): StoryState.SM_DONE,
    (StoryState.SM_DONE, EVENT_DEV_STARTED): StoryState.DEV_IN_PROGRESS,
    (StoryState.DEV_IN_PROGRESS, EVENT_DEV_TESTS_GREEN): StoryState.TESTS_GREEN,
    (StoryState.DEV_IN_PROGRESS, EVENT_DEV_TESTS_RED): StoryState.DEV_RETRY,
    (StoryState.DEV_IN_PROGRESS, EVENT_DEV_EXHAUSTED): StoryState.BLOCKED_TESTS_NEED_CLARIFICATION,
    (StoryState.DEV_RETRY, EVENT_DEV_STARTED): StoryState.DEV_IN_PROGRESS,
    (StoryState.DEV_RETRY, EVENT_DEV_EXHAUSTED): StoryState.BLOCKED_TESTS_NEED_CLARIFICATION,
    # ImpossibleBench escape hatch. The LIVE edge is the DEV_IN_PROGRESS one:
    # ``_handle_dev_once`` advances to DEV_IN_PROGRESS before it runs the
    # sandbox, so that is the state a declaration is always parsed in. The
    # DEV_RETRY edge is belt-and-braces for any future caller that declares
    # without having advanced first — an IllegalTransitionError here would crash
    # a tick over an honest answer.
    (
        StoryState.DEV_IN_PROGRESS,
        EVENT_DEV_UNDERSPECIFIED,
    ): StoryState.BLOCKED_UNDERSPECIFIED,
    (StoryState.DEV_RETRY, EVENT_DEV_UNDERSPECIFIED): StoryState.BLOCKED_UNDERSPECIFIED,
    (StoryState.TESTS_GREEN, EVENT_REVIEWER_STARTED): StoryState.REVIEWER_IN_PROGRESS,
    # SOLO pipeline (``factory/chain/solo.py``): the ONE new edge B.1 needs. A
    # story stamped ``pipeline: solo`` at spawn skips the reviewer round-trip and
    # goes straight from green to the tech-writer, then the shared docs-enforcer /
    # delivery / merge-gate path. No new StoryState, so every derived state set
    # (terminal, metered, mergeable, recoverable, progress ordinals) is
    # unchanged. Chain stories never take it: ``orchestrator._dispatch_for_story``
    # only routes TESTS_GREEN → tech_writer for solo rows, and
    # ``handlers.handle_tech_writer`` refuses TESTS_GREEN for a non-solo row.
    (StoryState.TESTS_GREEN, EVENT_TECH_WRITER_STARTED): StoryState.TECH_WRITER_IN_PROGRESS,
    (StoryState.REVIEWER_IN_PROGRESS, EVENT_REVIEWER_APPROVE): StoryState.REVIEWER_DONE,
    (
        StoryState.REVIEWER_IN_PROGRESS,
        EVENT_REVIEWER_REQUEST_CHANGES,
    ): StoryState.REVIEWER_REQUESTED_CHANGES,
    # Hard convergence guard: the Nth (N=_MAX_REVIEW_CYCLES) consecutive
    # request-changes verdict routes to a terminal blocked state instead of
    # looping back to dev. No outgoing transition → orchestrator stops
    # dispatching; the story waits for a human.
    (
        StoryState.REVIEWER_IN_PROGRESS,
        EVENT_REVIEW_NONCONVERGENT,
    ): StoryState.BLOCKED_REVIEW_NONCONVERGENT,
    # Loop-4: every actionable reviewer rejection (code defects AND
    # test-quality/slop findings) routes back to dev, who owns both code and
    # tests. There is no separate test author to route to.
    (StoryState.REVIEWER_REQUESTED_CHANGES, EVENT_DEV_STARTED): StoryState.DEV_IN_PROGRESS,
    (
        StoryState.REVIEWER_DONE,
        EVENT_TECH_WRITER_STARTED,
    ): StoryState.TECH_WRITER_IN_PROGRESS,
    (StoryState.TECH_WRITER_IN_PROGRESS, EVENT_TECH_WRITER_DONE): StoryState.TECH_WRITER_DONE,
    # Phase 3 cleanup: if tech_writer's apply_context_updates fails (e.g. the
    # writer tried to touch a forbidden path), bounce the story back through
    # reviewer_requested_changes so the dev loop can replay rather than
    # leaving the chain stuck mid-write.
    (
        StoryState.TECH_WRITER_IN_PROGRESS,
        EVENT_REVIEWER_REQUEST_CHANGES,
    ): StoryState.REVIEWER_REQUESTED_CHANGES,
    # Fail-closed diff precondition (2026-08-01): tech_writer could not fetch
    # the PR diff (or it is empty when the reviewer just approved a non-empty
    # one) — an INFRA fault, not a content verdict. Bouncing through
    # REVIEWER_REQUESTED_CHANGES would burn a full dev+review loop on a fault
    # dev cannot fix, so route to the same human-visible blocked sink the
    # review path uses (bounded auto-recovery re-enters at SM_DONE for
    # transient causes; see orchestrator._AUTO_RECOVERABLE_STATES).
    (
        StoryState.TECH_WRITER_IN_PROGRESS,
        EVENT_REVIEW_NONCONVERGENT,
    ): StoryState.BLOCKED_REVIEW_NONCONVERGENT,
    (
        StoryState.TECH_WRITER_DONE,
        EVENT_DOCS_ENFORCER_CHECK,
    ): StoryState.DOCS_ENFORCER_CHECK,
    (StoryState.DOCS_ENFORCER_CHECK, EVENT_DOCS_ENFORCER_PASS): StoryState.PR_OPEN,
    (
        StoryState.DOCS_ENFORCER_CHECK,
        EVENT_DOCS_ENFORCER_FAIL,
    ): StoryState.REVIEWER_REQUESTED_CHANGES,
    # S4 (019 fail-silent audit): a self-loop so a failed ``gh pr create`` can
    # be retried on the NEXT tick — ``orchestrator._DISPATCH`` maps
    # DOCS_ENFORCER_CHECK back to the ``docs_enforcer`` handler (which
    # re-enters via this same EVENT_DOCS_ENFORCER_CHECK at its top), and
    # retrying costs no LLM call (canonical-paths/vacuous-diff checks are
    # deterministic). Bounded by ``pr_create_retries`` /
    # ``handlers._MAX_PR_CREATE_RETRIES``, not by this transition itself.
    (StoryState.DOCS_ENFORCER_CHECK, EVENT_DOCS_ENFORCER_CHECK): StoryState.DOCS_ENFORCER_CHECK,
    # PR creation failed ``_MAX_PR_CREATE_RETRIES`` times in a row — park
    # rather than retry forever. Same terminal sink ``EVENT_PR_UNMERGEABLE``
    # uses for a PR that DOES exist but can't be merged; here the PR never
    # existed at all.
    (
        StoryState.DOCS_ENFORCER_CHECK,
        EVENT_PR_CREATE_EXHAUSTED,
    ): StoryState.BLOCKED_DEPLOY_FAILED,
    # ---- Docs chain (chain_kind == "docs") ----
    # Skips the TDD red→green loop. Onboarder produces canonical doc files
    # in one sandbox pass; the enforcer + PR open path is shared with TDD.
    (StoryState.DOCS_ENFORCER_CHECK, EVENT_DELIVERED_LOCAL): StoryState.DELIVERED_LOCAL,
    (StoryState.DOCS_ENFORCER_CHECK, EVENT_DELIVERED_BRANCH): StoryState.DELIVERED_BRANCH,
    (StoryState.DOCS_ENFORCER_CHECK, EVENT_DELIVERED_PR): StoryState.DELIVERED_PR,
    # A merge-capable story whose level turns out not to merge (a refused
    # push_to_main fast-forward, or a factory self-edit's push_to_main lowered
    # to pr) settles
    # here from wherever the auto-merge worker holds it.
    (StoryState.PR_OPEN, EVENT_DELIVERED_PR): StoryState.DELIVERED_PR,
    (StoryState.CI_GREEN, EVENT_DELIVERED_PR): StoryState.DELIVERED_PR,
    (StoryState.READY_FOR_MERGE, EVENT_DELIVERED_PR): StoryState.DELIVERED_PR,
    (StoryState.PR_OPEN, EVENT_DELIVERED_BRANCH): StoryState.DELIVERED_BRANCH,
    (StoryState.PR_OPEN, EVENT_DELIVERED_LOCAL): StoryState.DELIVERED_LOCAL,
    # Every mergeable state must be able to settle to every level's end, or a
    # non-merging story parked in CI_GREEN / READY_FOR_MERGE raised
    # IllegalTransitionError on every tick (adversarial review 2026-11-02).
    (StoryState.CI_GREEN, EVENT_DELIVERED_BRANCH): StoryState.DELIVERED_BRANCH,
    (StoryState.CI_GREEN, EVENT_DELIVERED_LOCAL): StoryState.DELIVERED_LOCAL,
    (StoryState.READY_FOR_MERGE, EVENT_DELIVERED_BRANCH): StoryState.DELIVERED_BRANCH,
    (StoryState.READY_FOR_MERGE, EVENT_DELIVERED_LOCAL): StoryState.DELIVERED_LOCAL,
    (StoryState.STORY_CREATED, EVENT_DOCS_SM_STARTED): StoryState.DOCS_SM_IN_PROGRESS,
    (StoryState.DOCS_SM_IN_PROGRESS, EVENT_DOCS_SM_DONE): StoryState.DOCS_SM_DONE,
    (
        StoryState.DOCS_SM_DONE,
        EVENT_DOCS_ONBOARDER_STARTED,
    ): StoryState.DOCS_ONBOARDER_IN_PROGRESS,
    (
        StoryState.DOCS_ONBOARDER_IN_PROGRESS,
        EVENT_DOCS_ONBOARDER_DONE,
    ): StoryState.DOCS_ONBOARDER_DONE,
    # Onboarder failure (e.g. sandbox crash, no files produced) goes to the
    # same BLOCKED state the TDD chain uses for "humans must look at this".
    (
        StoryState.DOCS_ONBOARDER_IN_PROGRESS,
        EVENT_DOCS_ONBOARDER_FAILED,
    ): StoryState.BLOCKED_TESTS_NEED_CLARIFICATION,
    (
        StoryState.DOCS_ONBOARDER_DONE,
        EVENT_DOCS_ENFORCER_CHECK,
    ): StoryState.DOCS_ENFORCER_CHECK,
    # Phase 5 — post-merge deploy. The auto-merge worker flips
    # READY_FOR_MERGE → DEPLOY_PENDING on successful merge (also reachable
    # from CI_GREEN and PR_OPEN since some chains skip the intermediate
    # READY_FOR_MERGE recording). DEPLOY_PENDING is the orchestrator's cue
    # to dispatch handle_deploy. EVENT_DEPLOY_SKIPPED handles
    # apps with ``deploy.enabled=false`` so the story reaches a terminal
    # state without staying in DEPLOY_PENDING forever.
    (StoryState.READY_FOR_MERGE, EVENT_MERGED): StoryState.DEPLOY_PENDING,
    (StoryState.CI_GREEN, EVENT_MERGED): StoryState.DEPLOY_PENDING,
    (StoryState.PR_OPEN, EVENT_MERGED): StoryState.DEPLOY_PENDING,
    # Auto-merge gave up on a terminally un-mergeable PR (closed/conflicting):
    # route the story to the blocked sink so the worker stops retrying it every
    # tick and the chain can reach DONE. Reachable from every mergeable state.
    (StoryState.PR_OPEN, EVENT_PR_UNMERGEABLE): StoryState.BLOCKED_DEPLOY_FAILED,
    (StoryState.CI_GREEN, EVENT_PR_UNMERGEABLE): StoryState.BLOCKED_DEPLOY_FAILED,
    (StoryState.READY_FOR_MERGE, EVENT_PR_UNMERGEABLE): StoryState.BLOCKED_DEPLOY_FAILED,
    # ---- WS1.1 per-story budget circuit breaker ----
    # Every budget-metered dispatch state (the LLM-persona loop states that
    # burn spend) gets an edge to the terminal BLOCKED_BUDGET_EXCEEDED sink.
    # The orchestrator fires EVENT_BUDGET_EXCEEDED *before* dispatching a
    # handler when the story's aggregate attempts/spend cross the per-story
    # cap. DEPLOY_PENDING is intentionally NOT metered: a story that reached
    # deploy already passed every gate, and blocking it would strand merged
    # work un-deployed without saving meaningful LLM spend.
    (StoryState.STORY_CREATED, EVENT_BUDGET_EXCEEDED): StoryState.BLOCKED_BUDGET_EXCEEDED,
    (StoryState.SM_DONE, EVENT_BUDGET_EXCEEDED): StoryState.BLOCKED_BUDGET_EXCEEDED,
    (StoryState.DEV_RETRY, EVENT_BUDGET_EXCEEDED): StoryState.BLOCKED_BUDGET_EXCEEDED,
    (
        StoryState.REVIEWER_REQUESTED_CHANGES,
        EVENT_BUDGET_EXCEEDED,
    ): StoryState.BLOCKED_BUDGET_EXCEEDED,
    (StoryState.TESTS_GREEN, EVENT_BUDGET_EXCEEDED): StoryState.BLOCKED_BUDGET_EXCEEDED,
    (StoryState.REVIEWER_DONE, EVENT_BUDGET_EXCEEDED): StoryState.BLOCKED_BUDGET_EXCEEDED,
    (StoryState.TECH_WRITER_DONE, EVENT_BUDGET_EXCEEDED): StoryState.BLOCKED_BUDGET_EXCEEDED,
    (StoryState.DOCS_SM_DONE, EVENT_BUDGET_EXCEEDED): StoryState.BLOCKED_BUDGET_EXCEEDED,
    (StoryState.DOCS_ONBOARDER_DONE, EVENT_BUDGET_EXCEEDED): StoryState.BLOCKED_BUDGET_EXCEEDED,
    # S4 (019 fail-silent audit): DOCS_ENFORCER_CHECK joins ``_DISPATCH`` (it
    # can now be re-entered on a PR-create retry), so it must be metered too
    # — see the invariant test in tests/chain/test_per_story_budget.py.
    (
        StoryState.DOCS_ENFORCER_CHECK,
        EVENT_BUDGET_EXCEEDED,
    ): StoryState.BLOCKED_BUDGET_EXCEEDED,
    (StoryState.DEPLOY_PENDING, EVENT_DEPLOY_STARTED): StoryState.DEPLOY_PENDING,
    (StoryState.DEPLOY_PENDING, EVENT_DEPLOY_SUCCEEDED): StoryState.DEPLOYED,
    (StoryState.DEPLOY_PENDING, EVENT_DEPLOY_FAILED): StoryState.BLOCKED_DEPLOY_FAILED,
    (StoryState.DEPLOY_PENDING, EVENT_DEPLOY_SKIPPED): StoryState.DEPLOYED,
}


class IllegalTransitionError(ValueError):
    """Raised when ``advance`` is called with a (state, event) pair not in
    the transition table."""


def advance(story: StoryRecord, event: str, payload: dict[str, Any] | None = None) -> StoryState:
    """Compute the next state for ``story`` given ``event`` (and optional ``payload``).

    Pure: this function does not mutate ``story``, does not touch the
    database, does not call any handler. The caller is responsible for
    persisting the new state. Returns the ``StoryState`` enum value.

    Special-case logic:
      * ``EVENT_DEV_TESTS_RED`` advances to ``DEV_RETRY``. The caller MUST
        also bump ``story.dev_retries`` and may bump ``current_model_tier``
        before invoking the dev handler again. When retries exhaust, the
        caller passes ``EVENT_DEV_EXHAUSTED`` instead.
    """
    current = StoryState(story.state)
    key = (current, event)
    if key not in _TRANSITIONS:
        raise IllegalTransitionError(f"No transition: state={current.value!r} event={event!r}")
    return _TRANSITIONS[key]


def is_terminal(state: StoryState) -> bool:
    """A state is terminal for the chain when no outgoing transitions exist."""
    return not any(s == state for (s, _) in _TRANSITIONS)


# Marker prefix the orchestrator writes into ``StoryRecord.last_rejection_reason``
# when the dependency-deferral CAP parks a dependent (see
# ``orchestrator._MAX_DEPENDENCY_DEFERRALS``). Two DIFFERENT situations land in
# ``BLOCKED_DEPENDENCY_UNMET`` and must be told apart everywhere:
#
#   * DEADLOCK park — every blocker is a definitive dead end. The work is
#     abandoned for good; resolved for tracker/issue purposes.
#   * CAP park — the blockers are only HUMAN-blocked and may still be revived.
#     The dependent is waiting on an operator DECISION, so it must stay visible
#     (``factory inbox``), keep its GitHub issue OPEN, keep its direction's
#     tracker open, and be settleable by the operator closing that issue.
#
# Lives here (a leaf module) rather than in the orchestrator so ``factory/cli.py``
# and ``factory/directions/tracker_issue.py`` can key off it without importing the
# orchestrator.
DEP_DEFER_CAP_REASON_PREFIX = "dependency_deferral_cap_exhausted"


def is_dependency_cap_parked(state: str | None, last_rejection_reason: str | None) -> bool:
    """True for a story parked by the dependency-deferral CAP (not a deadlock park).

    Single predicate so the inbox, the tracker-issue sweep and the
    closed-tracker reconciler can never disagree about which parks are
    "abandoned" and which are "awaiting a human".
    """
    return (state or "") == StoryState.BLOCKED_DEPENDENCY_UNMET.value and (
        last_rejection_reason or ""
    ).startswith(DEP_DEFER_CAP_REASON_PREFIX)


def list_transitions_from(state: StoryState) -> list[tuple[str, StoryState]]:
    """Return ``[(event, next_state)]`` for all transitions out of ``state``.

    Useful for the `factory story <id>` CLI and for tests.
    """
    out: list[tuple[str, StoryState]] = []
    for (s, ev), ns in _TRANSITIONS.items():
        if s == state:
            out.append((ev, ns))
    return out
