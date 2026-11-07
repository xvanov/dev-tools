"""Operator story-resume: put a parked story back into the chain WITHOUT
rebuilding the work it already did.

WHY THIS EXISTS
---------------
Six terminal sinks in ``state_machine.StoryState`` document their own recovery
as "an operator moves the row back to a live dispatch state" —
``blocked_ci_unresolved``, ``blocked_dependency_unmet``,
``quarantined_invalid_state``, ``closed_by_operator``, ``blocked_underspecified``
and the pending-human blocks. **No command ever existed to do that.** The only
real recovery path an operator had was to close the story as superseded and
re-file the work as a brand-new story, which threw away every artifact the
story had already produced — its branch, its merged-quality diff, its dev
attempt history, its reviewer history, and the money already spent — and then
(before the same-day dependency-gate fix) deadlocked the replacement anyway.

That is the wrong shape for the failure this factory actually has. The common
wedge is not "the code is wrong". It is **the plumbing was wrong**: a leaked
docker network made the test gate permanently red on this host; a contract
specified a 401 body the app never produces, so an oracle authored from it could
never pass; an oracle graded a criterion the story was descoped out of. In every
one of those the dev's diff was correct and complete — 95% of the work was done
and paid for — and the only thing that needed to change was a gate, a spec, or
the host. Rebuilding the story from ``story_created`` re-runs the SM, re-runs
dev, re-runs the reviewer, and re-pays for all three to arrive back at the same
diff. Resuming re-runs only the part that was broken.

WHAT IT PRESERVES
-----------------
Everything that cost money or carries evidence: ``github_branch``,
``github_pr_number``, ``github_issue_number``, ``sm_result_json``,
``dev_attempts_json``, ``reviewer_history_json``, ``reviewer_result_json``,
``story_file_path``, and — critically — ``total_spend_usd``. The spend ledger is
the factory's cost truth; a resume is not permission to forget what a story
already cost, and zeroing it would make every audit and every budget breaker lie.

WHAT IT RESETS
--------------
Exactly the counters that would otherwise re-park the story on its first tick
back, and nothing else. This is the whole difficulty of the feature: a resume
that lands the story back in the same sink one tick later is not a resume, it is
a slower way to stay stuck (and it looks like a success in the operator's
terminal). See ``_RESET_NOTES`` for the itemised list and the reason for each.

WHAT IT REFUSES
---------------
A resume that provably cannot make progress is refused up-front rather than
performed and then silently undone by the next tick:

* the story is already ``deployed`` (nothing to resume);
* ``total_spend_usd`` is already at/over the per-story cap — the budget breaker
  would re-park it immediately, so the operator must raise the cap or pass
  ``--force`` and accept the overrun knowingly;
* resuming at the merge gates but the PR is closed and could not be reopened;
* the dependency gate would deadlock it again on the very next tick.

Refusing loudly beats "resumed!" followed by a silent re-park — that is the
``proxy != real`` failure class this repo keeps re-learning.

``--reauthor-oracle`` AND THE FREEZE
------------------------------------
The acceptance oracle is frozen before the dev starts, and that freeze is the
anti-reward-hack property — so deleting one to have it re-authored AFTER the
dev's code exists deserves the obvious objection. It does not weaken the
property, for the same reason ``acceptance.reauthor_missing_oracles`` may
already re-author on any later tick: the author is SPEC-ONLY
(``build_spec_prompt``), never sees the dev's diff, and writes into
``state/acceptance/`` outside the dev worktree. Independence is STRUCTURAL —
a function of what the author can read, not of when it runs. The gutted-
implementation control (``stub_runs.json``) is re-run against the new oracle
too, so a replacement that fails to discriminate is still caught.

What the flag actually buys is the case the freeze cannot handle on its own: the
SPEC was wrong. Direction 120's contract named a 401 body the app never
produces, so the frozen oracle asserted something no correct implementation
could satisfy, and the story was blocked for three evaluations by a defect in
the specification rather than in the code. Ratifying the contract changes what a
SPEC-ONLY author would write — but nothing re-authors a frozen oracle, so the
corrected spec could never reach the gate. Hence: explicit, operator-only,
audited in the ``story_resumed`` event, and never automatic.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlmodel import Session, create_engine, select

from factory.chain.state_machine import StoryRecord, StoryState

# Re-entry points an operator may name. Each maps to the state the story is put
# back into; the chain's own dispatch/poller tables take it from there.
#
# ``gates`` deliberately targets ``PR_OPEN``, which is NOT in the orchestrator's
# ``_DISPATCH`` table — it is in ``auto_merge._MERGEABLE_STATES``, so the
# auto-merge poller picks the story up and RE-EVALUATES THE MERGE GATES against
# the existing PR without re-running a single persona. That is the resume the
# oracle/gate/host failures need, and the reason this module exists at all.
#
# ``tech_writer`` exists because the automatic recovery for a late-stage failure
# is far blunter: ``orchestrator._recover_blocked_stories`` re-enters a
# ``BLOCKED_REVIEW_NONCONVERGENT`` story at ``SM_DONE``, re-running SM + dev +
# review to reach the same step that failed. Sacrifice story 177 died because the
# tech_writer model never returned parseable JSON, then burned two full recoveries
# ($5.96) rediscovering that. Resuming at ``reviewer_done`` re-runs ONLY the step
# that failed, keeping the approved diff and the reviewer's verdict.
RESUME_POINTS: dict[str, str] = {
    "gates": StoryState.PR_OPEN.value,
    "tech_writer": StoryState.REVIEWER_DONE.value,
    "review": StoryState.TESTS_GREEN.value,
    "dev": StoryState.DEV_RETRY.value,
    "sm": StoryState.STORY_CREATED.value,
}

# Human-readable justification for every counter this module clears, surfaced in
# the ``story_resumed`` event and in ``--dry-run`` output. Kept as data so the
# audit record and the operator preview can never drift from what the code does.
_RESET_NOTES: dict[str, str] = {
    "total_attempts": (
        "the global per-story attempt breaker; a resumed story that kept its old "
        "count would trip BLOCKED_BUDGET_EXCEEDED on its first dispatch. Resetting "
        "it matches the field's own semantics — the orchestrator already zeroes it "
        "on genuine forward progress (max_progress_ordinal decay)."
    ),
    "dependency_defer_count": (
        "consecutive stalled dependency deferrals; stale the moment the blockers "
        "are re-evaluated, and left set it would re-hit the deferral cap early."
    ),
    "last_rejection_reason": (
        "the operator-inbox marker for the park being undone; left set, the story "
        "stays in `factory inbox` forever after a successful resume."
    ),
    "error": "the park's explanatory text, now historical (preserved in the event).",
    "acceptance gate_block.json": (
        "the acceptance gate's 'needs a human' sidecar; it is what `factory inbox` "
        "reads, so an un-cleared one keeps reporting a block that was just resolved."
    ),
}


@dataclass
class ResumePlan:
    """What a resume WOULD do. Produced by :func:`plan_resume`, executed by
    :func:`apply_resume`. Separated so ``--dry-run`` is a PURE preview — the
    repo's ``pm-sync --dry-run`` shipped live stories once by not being."""

    story_id: int
    slug: str
    app: str
    from_state: str
    to_state: str
    point: str
    reason: str
    reauthor_oracle: bool
    resets: list[str] = field(default_factory=list)
    preserved: dict[str, Any] = field(default_factory=dict)
    refusals: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    pr_needs_reopen: bool = False

    @property
    def ok(self) -> bool:
        return not self.refusals


def load_story(db: Path, story_id: int) -> StoryRecord | None:
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        return session.get(StoryRecord, story_id)


def _pr_state(app_repo: Path | None, pr_number: int) -> str | None:
    """GitHub's view of the PR: ``OPEN`` / ``CLOSED`` / ``MERGED``, or None when
    it cannot be established.

    None is NOT treated as OPEN by any caller. Never trust a local flag for merge
    reality — the repo's single most-repeated rule — and an unreachable GitHub is
    ambiguous evidence, which must block rather than wave a resume through.
    """
    if app_repo is None or not app_repo.exists():
        return None
    try:
        out = subprocess.run(
            ["gh", "pr", "view", str(pr_number), "--json", "state"],
            cwd=app_repo,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if out.returncode != 0:
            return None
        return str(json.loads(out.stdout).get("state") or "") or None
    except Exception:  # noqa: BLE001 - unreachable GitHub is "unknown", not "open"
        return None


def reopen_pr(app_repo: Path, pr_number: int) -> tuple[bool, str]:
    """Reopen a closed PR. Returns ``(ok, detail)``.

    Verifies by RE-READING the PR state afterwards rather than trusting the
    command's exit code — ``gh pr reopen`` exits 0 on a PR that was already open
    and, on some paths, on one it failed to reopen. The artifact is the state.
    """
    try:
        proc = subprocess.run(
            ["gh", "pr", "reopen", str(pr_number)],
            cwd=app_repo,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except Exception as exc:  # noqa: BLE001
        return False, f"gh pr reopen raised: {exc!r}"
    after = _pr_state(app_repo, pr_number)
    if after == "OPEN":
        return True, "reopened"
    return False, (
        f"PR #{pr_number} is {after or 'unknown'} after reopen "
        f"(rc={proc.returncode}): {(proc.stderr or proc.stdout or '').strip()[:200]}"
    )


def infer_point(story: StoryRecord) -> str:
    """The cheapest re-entry point that still re-runs whatever could be broken.

    Keyed off artifacts that actually exist, not off the state the story parked
    in — the park state records where it DIED, which for a gate block is
    ``blocked_ci_unresolved`` regardless of how much real work the story banked.

    * a PR exists              -> ``gates``  (re-grade the diff; no persona runs)
    * dev really ran           -> ``dev``    (dev continues from its own history)
    * the SM really ran        -> ``dev``    (skip the SM; its story file is on disk)
    * nothing banked           -> ``sm``     (a true rebuild)

    ``github_branch`` is deliberately NOT evidence, even though it reads like the
    most obvious signal. It is populated with a PLANNED branch name when the
    story row is spawned, long before anything is built — sacrifice story 182 sat
    in ``blocked_dependency_unmet`` having never run its SM, with
    ``github_branch='story/396-…'`` already set. Inferring ``dev`` from it would
    dispatch the dev persona against a story that has no story file and no SM
    output. A field that names an intended artifact is not the artifact
    (``proxy != real``); only ``dev_attempts_json`` and ``sm_result_json`` record
    that a persona actually ran, and only ``github_pr_number`` records a real PR.
    """
    if story.github_pr_number:
        return "gates"
    if _json_len(story.dev_attempts_json) > 0:
        return "dev"
    if story.sm_result_json:
        return "dev"
    return "sm"


def _acceptance_dir(root: Path, app: str, story_id: int) -> Path:
    from factory.chain.acceptance import acceptance_dir

    return acceptance_dir(root, app, story_id)


def plan_resume(
    *,
    story: StoryRecord,
    db: Path,
    root: Path,
    point: str = "auto",
    reason: str = "",
    reauthor_oracle: bool = False,
    app_repo: Path | None = None,
    force: bool = False,
) -> ResumePlan:
    """Compute (without performing) the resume. PURE: reads only."""
    from factory.settings.loader import load_settings

    chosen = infer_point(story) if point == "auto" else point
    to_state = RESUME_POINTS.get(chosen, StoryState.STORY_CREATED.value)
    plan = ResumePlan(
        story_id=int(story.id or 0),
        slug=story.slug,
        app=story.app,
        from_state=story.state,
        to_state=to_state,
        point=chosen,
        reason=reason,
        reauthor_oracle=reauthor_oracle,
    )

    if point != "auto" and point not in RESUME_POINTS:
        plan.refusals.append(
            f"unknown resume point {point!r}; valid: {', '.join(sorted(RESUME_POINTS))}"
        )
        return plan

    if story.state == StoryState.DEPLOYED.value:
        plan.refusals.append("story is already `deployed` — there is nothing to resume")
        return plan
    if story.state == to_state:
        plan.warnings.append(
            f"story is already in `{to_state}`; the resume still clears the counters "
            "and the gate-block window, which is usually the point"
        )

    # --- budget breaker. A resume into an exhausted spend cap re-parks instantly.
    try:
        caps = load_settings(root).caps
        cap = float(getattr(caps, "per_story_spend_usd", 0.0) or 0.0)
    except Exception:  # noqa: BLE001 - an unreadable settings file must not hide the check
        cap = 0.0
        plan.warnings.append("could not read caps.per_story_spend_usd — spend check skipped")
    if cap > 0 and story.total_spend_usd >= cap:
        msg = (
            f"total_spend_usd=${story.total_spend_usd:.2f} is already at/over "
            f"caps.per_story_spend_usd=${cap:.2f}; the budget breaker would re-park this "
            "story on its first dispatch. Raise the cap in factory_settings.yaml, or "
            "re-run with --force to accept the overrun."
        )
        (plan.warnings if force else plan.refusals).append(msg)

    # --- merge-gate resume needs a REALLY open PR (never a local flag).
    if chosen == "gates":
        if not story.github_pr_number:
            plan.refusals.append(
                "resume point `gates` needs a PR, but github_pr_number is unset — "
                "use --at dev to rebuild from the branch"
            )
        else:
            state = _pr_state(app_repo, int(story.github_pr_number))
            if state == "MERGED":
                plan.refusals.append(
                    f"PR #{story.github_pr_number} is already MERGED — the story should be "
                    "advanced to deploy_pending, not resumed at the gates"
                )
            elif state == "CLOSED":
                plan.pr_needs_reopen = True
            elif state is None:
                plan.refusals.append(
                    f"could not read PR #{story.github_pr_number} state from GitHub "
                    f"(app repo: {app_repo}); refusing rather than assuming it is open"
                )

    # --- dependency gate. Would the very next tick deadlock it again?
    from factory.chain.orchestrator import _deps_permanently_dead, _direction_deps_pending

    # ``story`` is passed as-is: ``_direction_deps_pending`` keys off id / app /
    # direction_id / slug and never reads the story's OWN state, so its answer is
    # the same before and after the resume. (It reads the SIBLINGS' states, which
    # this resume does not touch.) Building a mutated probe row would only imply a
    # dependence that does not exist.
    pending = _direction_deps_pending(db, story)
    if pending and _deps_permanently_dead(db, pending):
        plan.refusals.append(
            f"the dependency gate would re-park this story immediately: every pending "
            f"dependency {pending} is in a permanently-dead sink. Resume those first."
        )
    elif pending:
        plan.warnings.append(f"will wait behind pending dependencies {pending} before it builds")

    plan.resets = [
        f"total_attempts {story.total_attempts} -> 0",
        f"dependency_defer_count {story.dependency_defer_count} -> 0",
    ]
    if story.last_rejection_reason:
        plan.resets.append("last_rejection_reason -> cleared")
    if story.error:
        plan.resets.append("error -> cleared")
    if story.dev_step_checkpoint and chosen in {"dev", "sm"}:
        plan.resets.append("dev_step_checkpoint -> cleared (dev must really re-run)")
    acc = _acceptance_dir(root, story.app, int(story.id or 0))
    if (acc / "gate_block.json").exists():
        plan.resets.append("acceptance gate_block.json -> removed")
    plan.resets.append(
        "merge-gate block window -> reset (a `story_resumed` event makes "
        "_gate_block_history stop counting the historical blocks at this head sha)"
    )
    plan.resets.append(
        "CI-fix redispatch window -> reset (the same `story_resumed` event makes "
        "_handle_ci_failure stop counting historical ci_fix_redispatch events, so a "
        "story parked on cap_reached/identical_failure_signature gets a real retry)"
    )
    if reauthor_oracle:
        plan.resets.append(
            "acceptance oracle -> DELETED (test_acceptance.py, attempts.json, "
            "stub_runs.json, base_runs.json, auto_reauthor.json) so the next tick "
            "re-authors it from the current spec — and the bounded auto-re-author "
            "gets one fresh attempt this episode"
        )

    plan.preserved = {
        "github_branch": story.github_branch,
        "github_pr_number": story.github_pr_number,
        "github_issue_number": story.github_issue_number,
        "total_spend_usd": round(story.total_spend_usd, 4),
        "dev_retries": story.dev_retries,
        "reviewer_cycles": story.reviewer_cycles,
        "dev_attempts": _json_len(story.dev_attempts_json),
        "reviewer_history": _json_len(story.reviewer_history_json),
        "story_file_path": story.story_file_path,
    }
    return plan


def _json_len(raw: str | None) -> int:
    try:
        val = json.loads(raw or "[]")
        return len(val) if isinstance(val, list) else 0
    except Exception:  # noqa: BLE001
        return 0


def apply_resume(
    *,
    plan: ResumePlan,
    story: StoryRecord,
    db: Path,
    root: Path,
    app_repo: Path | None = None,
    actor: str = "operator",
) -> ResumePlan:
    """Execute ``plan``. Raises ``RuntimeError`` if the plan was not ``ok``.

    ORDER MATTERS. The PR is reopened FIRST, and a failure there aborts before
    anything is persisted: a story moved to ``pr_open`` whose PR is really closed
    is a phantom the auto-merge poller re-evaluates every tick forever. Then the
    oracle/sidecar files, then the ``story_resumed`` event, and the DB row LAST.

    The event goes BEFORE the row deliberately. It is not a record of the reset —
    it IS the reset: ``auto_merge._gate_block_history`` reads it to decide whether
    the historical blocks at this head sha still count. And ``log_story_event`` is
    best-effort by design; it swallows ``OSError`` and returns early if the log
    path cannot be resolved. So the two orderings fail very differently:

    * event first, row-write fails  -> the story stays parked (visible, safe) and
      a stale reset sits on a row that no poller evaluates, because parked states
      are not in ``auto_merge._MERGEABLE_STATES``. Harmless.
    * row first, event lost         -> the story is resumed with its window NOT
      reset, so the next evaluation re-parks it at the unchanged head sha — the
      exact bug this module exists to fix — while the operator reads a green
      "resumed" panel. A silent re-park wearing a success message.

    So the event is written first AND read back, and a missing one aborts before
    the row moves.
    """
    from factory.chain.acceptance import clear_gate_block
    from factory.chain.event_log import log_story_event, read_story_events
    from factory.chain.handlers import persist_story

    if not plan.ok:
        raise RuntimeError(f"refusing to resume story {plan.story_id}: {plan.refusals}")

    # ``plan`` and ``story`` arrive as independent arguments, and every mutation
    # below is applied to ``story`` while every decision above was computed from
    # whatever row ``plan`` was built from. A mismatch would silently write one
    # story's resume onto another row — no state string in ``RESUME_POINTS`` is
    # invalid, so nothing downstream would object.
    if plan.story_id != int(story.id or 0):
        raise RuntimeError(
            f"plan/story mismatch: the plan targets story {plan.story_id} but was handed "
            f"story.id={story.id}. Refusing rather than mutating an unplanned row."
        )

    if plan.pr_needs_reopen:
        if app_repo is None:
            raise RuntimeError("PR needs reopening but no app repo path was resolved")
        ok, detail = reopen_pr(app_repo, int(story.github_pr_number or 0))
        if not ok:
            raise RuntimeError(f"could not reopen PR: {detail}")

    if plan.reauthor_oracle:
        acc = _acceptance_dir(root, story.app, int(story.id or 0))
        for name in (
            "test_acceptance.py",
            "attempts.json",
            "stub_runs.json",
            "base_runs.json",
            "auto_reauthor.json",
        ):
            try:
                (acc / name).unlink()
            except OSError:
                pass
        story.acceptance_test_ref = None
    clear_gate_block(root, story.app, story.id)

    log_story_event(
        story.id,
        "story_resumed",
        {
            "from_state": plan.from_state,
            "to_state": plan.to_state,
            "point": plan.point,
            "reason": plan.reason,
            "actor": actor,
            "reauthored_oracle": plan.reauthor_oracle,
            "pr_reopened": plan.pr_needs_reopen,
            "resets": plan.resets,
            "preserved": plan.preserved,
        },
        software_factory_root=root,
        slug_hint=story.slug,
    )
    # Read it back. ``log_story_event`` reports failure by staying silent, and a
    # lost write here is not a missing audit line — it is a missing gate-block
    # reset (see the ordering note above). Abort BEFORE the row moves, so a
    # failure leaves the story parked rather than resumed-but-doomed.
    # ``story.id`` is not None here: the plan/story identity guard above compared
    # it against ``plan.story_id``, and ``plan_resume`` derives that from a
    # persisted row. Narrowed explicitly so the read-back is typed, not assumed.
    tail = read_story_events(
        int(story.id or 0), software_factory_root=root, slug_hint=story.slug, limit=5
    )
    if not any(e.get("event") == "story_resumed" for e in tail):
        raise RuntimeError(
            f"the `story_resumed` event for story {plan.story_id} could not be written to "
            f"{root}/state/logs — that event IS the merge-gate block reset, so resuming "
            "without it would re-park the story on the next evaluation. Nothing was "
            "changed; fix the log path/permissions and retry."
        )

    story.state = plan.to_state
    story.total_attempts = 0
    story.dependency_defer_count = 0
    story.last_rejection_reason = None
    story.error = None
    if plan.point in {"dev", "sm"}:
        story.dev_step_checkpoint = None
    # An operator revival is the one legitimate way out of closed_by_operator.
    persist_story(story, db, allow_reopen=True)
    return plan


# Parked sinks an operator can resume from. Deliberately NOT ``is_terminal``:
# several ACTIVE states are terminal-by-omission (``ci_pending`` is driven by the
# auto-merge poller, not a transition edge), and offering to "resume" a story
# that is mid-CI would yank a live one backwards. An explicit allowlist, same
# discipline as ``_DEAD_END_DEP_STATES`` and the tracker-issue resolved-states.
_PARKED_STATES: frozenset[str] = frozenset(
    {
        StoryState.BLOCKED_CI_UNRESOLVED.value,
        StoryState.BLOCKED_DEPENDENCY_UNMET.value,
        StoryState.BLOCKED_DEPLOY_FAILED.value,
        StoryState.BLOCKED_BUDGET_EXCEEDED.value,
        StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
        StoryState.BLOCKED_REVIEW_NONCONVERGENT.value,
        StoryState.BLOCKED_UNDERSPECIFIED.value,
        StoryState.QUARANTINED_INVALID_STATE.value,
        StoryState.CLOSED_BY_OPERATOR.value,
        StoryState.SUPERSEDED_BY_SIBLING.value,
    }
)

# Parked states whose rows are only worth OFFERING when their direction still has
# unfinished business. A ``superseded_by_sibling`` row is usually a dual-draft
# LOSER whose winner already shipped — correctly abandoned, nothing to resume —
# and ``closed_by_operator`` is a human's own ruling. Listing every one of those
# turns the suggestion surface into a wall of settled history: unscoped, this
# returned 60+ rows on the live DB, burying the two that actually needed an
# operator. Same failure the detector→direction storm taught (48 unfixable
# filings from cumulative signals on terminal work): perfect classification is
# not enough, the offer has to be LIVENESS-scoped.
_NEEDS_LIVE_DIRECTION: frozenset[str] = frozenset(
    {StoryState.SUPERSEDED_BY_SIBLING.value, StoryState.CLOSED_BY_OPERATOR.value}
)


def resumable_stories(db: Path, app: str | None = None) -> list[StoryRecord]:
    """Parked stories worth OFFERING to an operator as resumable.

    This is a SUGGESTION surface (``factory inbox``, ``factory why``), not a
    permission check: ``plan_resume`` deliberately does not consult it, so an
    operator who names a story explicitly can still resume anything that is not
    already ``deployed``. Filtering here shapes what the factory volunteers;
    filtering there would take away a recovery the operator may legitimately want.

    A genuinely BLOCKED row is ALWAYS offered: it is stuck by a failure, not by a
    decision, whatever the rest of its direction has managed. A row parked by a
    DECISION (``_NEEDS_LIVE_DIRECTION``) has to clear two further bars:

    * its direction has nothing deployed — once a sibling has landed, the work
      this row was abandoned in favour of is DONE, and resuming it would re-open
      settled history; and
    * it has BANKED WORK to preserve (:func:`has_banked_work`). This is the
      point of the whole feature, so it is the honest filter: a story with no PR,
      no dev attempt and $0 spent has nothing to recover, and re-triage is its
      correct path, not resume. On the live DB this is what separates ~10 real
      abandoned investments (a $6.25 story, a $4.31 story with an open PR) from
      ~50 never-started dual-draft alternates that only ever cost a DB row.
    """
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = list(session.exec(select(StoryRecord)).all())

    shipped: set[tuple[str, str]] = {
        (r.app, r.direction_id) for r in rows if r.state == StoryState.DEPLOYED.value
    }
    out: list[StoryRecord] = []
    for r in rows:
        if r.state not in _PARKED_STATES or (app is not None and r.app != app):
            continue
        if r.state in _NEEDS_LIVE_DIRECTION:
            if (r.app, r.direction_id) in shipped or not has_banked_work(r):
                continue
        out.append(r)
    return out


def has_banked_work(story: StoryRecord) -> bool:
    """Did this story produce anything a resume would actually preserve?

    A real PR, a real dev attempt, or real money spent. ``github_branch`` is
    excluded for the same reason :func:`infer_point` excludes it — it holds a
    PLANNED name written when the row was spawned, so it is true of stories that
    never ran a single persona.
    """
    return bool(
        story.github_pr_number
        or _json_len(story.dev_attempts_json) > 0
        or story.total_spend_usd > 0
    )


__all__ = [
    "RESUME_POINTS",
    "ResumePlan",
    "apply_resume",
    "infer_point",
    "load_story",
    "plan_resume",
    "reopen_pr",
    "resumable_stories",
]
