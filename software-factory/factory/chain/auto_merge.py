"""Auto-merge worker — merges PRs that pass all required gates.

Polls every open PR for an app, evaluates the gate set, and squash-merges
when:

  * every gate label is present on the PR (the chain handlers add them
    as gates pass on previous ticks)
  * no blocking label (``do-not-merge`` / ``needs-human-verification`` /
    ``needs-direction`` / ``tests-slop`` / ``needs-test-quality-fix``) is
    present
  * the StoryRecord linked to the PR is in a state where merge is
    expected (``pr_open``, ``ci_green``, ``ready_for_merge``)

Records every merge attempt in ``state/factory.db.merge_actions`` for
the rollback worker to consult.

Dry-run is truly dry: GH is not contacted at all; the worker takes a
``fixture_prs`` list so tests can exercise the decision-and-record path
without network.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Field, Session, SQLModel, create_engine, select

from factory.app_config import (
    FACTORY_REPO,  # noqa: F401 - re-exported for callers/tests
    AppConfig,
    load_app_config,
    targets_factory_repo,
)
from factory.chain import delivery_gate
from factory.chain.gates.evaluator import (  # noqa: F401 - ALL_GATE_LABELS re-exported
    ALL_GATE_LABELS,
    LOOP4_REQUIRED_GATE_LABELS,
    PRContext,
    evaluate_all_gates,
    required_gate_labels,
)
from factory.chain.state_machine import StoryRecord, StoryState
from factory.delivery import DeliveryLevel

# Labels that, when present, BLOCK merge regardless of gate status.
BLOCKING_LABELS: frozenset[str] = frozenset(
    {
        "do-not-merge",
        "needs-human-verification",
        "needs-direction",
        "tests-slop",
        "needs-test-quality-fix",
    }
)

# Story states from which the worker will consider merging.
_MERGEABLE_STATES = {
    StoryState.PR_OPEN.value,
    StoryState.CI_GREEN.value,
    StoryState.READY_FOR_MERGE.value,
}

# ``gh pr checks`` status buckets that mean "this required check is RED".
# Factored out of ``_query_ci_state`` so the ``main-green`` hold discrimination
# below reduces over exactly the same set the failure verdict does — two copies
# would drift and the hold would silently start swallowing real failures.
_CI_FAILURE_BUCKETS = frozenset(
    {"fail", "failing", "failure", "cancel", "cancelled", "timed_out", "error"}
)

# --------------------------------------------------------------------------- #
# E6 STAGE 2 — "main is red" is an ENVIRONMENT HOLD, not a PR defect.
#
# `.github/workflows/test.yml`'s ``main-green`` job is a PR check that reports
# whether MAIN's own post-merge full lane is green. Once an operator makes it a
# REQUIRED check, a PR whose ``main-green`` ran while main was red carries a red
# required-check aggregate — which, without this, would have been read as "this
# PR failed CI":
#
#   tick 1: ``_handle_ci_failure`` burns a dev-sandbox run per affected PR on a
#           finding the dev cannot act on (main's breakage is not in its diff);
#   tick 2: ``_ci_failure_signature`` is stable -> ``identical_failure_signature``
#           -> ``_park``, and ``_ci_failure_is_genuine`` says True (the check IS
#           required and its conclusion IS FAILURE) -> the PR is CLOSED and the
#           story parked terminally in ``blocked_ci_unresolved``.
#
# Two ticks of a red main would therefore have destroyed those stories. So a red
# required-check set whose ONLY red member is ``main-green`` resolves to
# ``_CI_STATE_HOLD`` instead of ``"failure"``:
#
#   * no dev dispatch, no ``ci_fix_redispatch``, no ``ci_fix_exhausted``;
#   * no ``_park``, no PR close, no story-state write of ANY kind;
#   * no gate evaluation either — so it also cannot feed
#     ``_gate_block_history``'s ``_MAX_GATE_BLOCK_CYCLES`` counter and park the
#     story through THAT sink three ticks later (the second destroyer, which
#     lives on the missing-labels path rather than the CI-failure path);
#   * one deduped ``ci_hold_main_red`` event AND one ``merge_actions`` row per
#     hold episode, then the story is simply re-checked next tick.
#
# WHICH PRs A RED MAIN ACTUALLY AFFECTS (adversarial review, 2026-08-09 —
# corrects an earlier claim here that a red main "turns EVERY open PR's
# aggregate red"; it does not). ``main-green`` runs on ``pull_request``, and
# GitHub does NOT re-run pull_request checks when the BASE branch moves. The
# verdict is computed at open/synchronize and then FROZEN on that head SHA. So:
#
#   * a PR opened or pushed-to AFTER main went red gets a red ``main-green`` and
#     is held — this is the guard working;
#   * a PR already open with a green ``main-green`` KEEPS it. A red main does
#     NOT stop the standing queue. The guard bounds NEW work, not in-flight
#     work.
#   * symmetrically, a hold NEVER SELF-CLEARS. Making main green does not
#     re-run the held PR's checks; something has to re-run them. This is the
#     starvation the review flagged, and it is why the checklist below exists.
#
# ACTIVATION CHECKLIST — status as of 2026-08-10. (a) and (b) are IMPLEMENTED
# (this file, ``_handle_main_green_hold`` / ``_continue_hold_episode``); (c)
# remains ACCEPTED, not mitigated. The remaining activation step is manual and
# operator-only: deploy this code, then add ``main-green`` to
# ``required_status_checks.contexts`` in branch protection.
#
#   (a) BOUND THE HOLD — DONE 2026-08-10. A hold episode older than
#       ``_HOLD_SURFACE_AFTER_SECONDS`` (30 min) sets
#       ``last_rejection_reason`` (prefix ``ci_hold_main_red:``, once per
#       episode) so the story surfaces in ``factory inbox``'s needs-human list
#       (the ``blocked_ci_unresolved`` inbox carve-out in ``cli.py`` is the
#       precedent). It does NOT park and does NOT close the PR — the whole
#       point of the hold is that the PR is innocent. An unbounded hold is an
#       invisible stall, which is the ``detect-without-remediate`` class.
#   (b) RECOVERY TRIGGER — DONE 2026-08-10. When the base branch's HEAD has
#       moved since the episode's last recorded sha, the failed ``main-green``
#       run is re-run (``gh run rerun <id> --failed``), at most once per new
#       main commit (the ``ci_hold_rerun`` event records the sha and is the
#       dedupe). Backstop if the rerun fails: the (a) escalation plus the
#       runbook step — after fixing main, re-run checks on every open PR.
#   (c) ACCEPT (or close) THE ``.github/**`` SELF-EDIT GAP. A chain PR that
#       touches ONLY ``.github/**`` does not trip the factory self-edit staging
#       twin, so nothing runs a clone before it lands. Such a PR could rename a
#       workflow job to ``main-green`` and thereby convert its OWN genuine CI
#       failure into an eternal hold — the one shape in which the hold does
#       suppress a real red. It requires a PR that edits workflow YAML and
#       names the job exactly ``main-green``; it is ACCEPTED FOR NOW and
#       recorded here rather than mitigated. Closing it means either adding
#       ``.github/**`` to the staging-gated self-edit paths or deriving the
#       hold name from something a PR cannot rewrite.
#
# FAIL DIRECTION: any uncertainty (an unparseable check name, a second red
# required check, a red ``main-green`` next to a red ``pytest``) resolves to the
# historical ``"failure"`` path. A hold must never be a way for a real failure
# to be waved through — it only ever SUPPRESSES action, never authorizes a
# merge: ``tests_green`` compares ``ci_state == "success"``, so a hold is a
# non-merge exactly like a failure is.
_MAIN_GREEN_CHECK_NAME = "main-green"
_CI_STATE_HOLD = "hold"

# CI-failure -> dev re-fix loop (the operator's "run the real CI, check the
# output, and if it craps out, fix what crapped out" loop). Bounds how many
# times ``_handle_ci_failure`` will re-dispatch the SAME story back to dev
# before giving up and leaving it for a human — mirrors
# ``orchestrator._MAX_AUTO_RECOVERIES``'s cap + signature-guard pattern so a
# CI failure the dev cannot fix escalates instead of looping forever.
#
# DO NOT RAISE IT AS AN "IMPROVEMENT". The literature says extra feedback rounds
# buy gaming rather than assurance — ImpossibleBench (ICLR 2026, arXiv
# 2510.20270) measured cheating rising 33% -> 38% when agents get multiple
# submissions with feedback, and self-repair at matched budget buys 3-10% (arXiv
# 2306.09896). The full argument, and what to do instead, is at
# ``handlers._MAX_REVIEW_CYCLES``.
_MAX_CI_FIX_CYCLES = 3

# Required-gate-block exhaustion. A "missing gate labels" MergeAction used to
# just sit there: PR_OPEN is not in ``orchestrator._AUTO_RECOVERABLE_STATES``,
# a gate failure is not a CI failure so ``_handle_ci_failure`` never fires for
# it, and ``merge_actions`` rows are written but never read back as a counter
# — so the SAME PR got re-evaluated every tick FOREVER. Measured live
# 2026-08-07: PR 88 alone re-evaluated 436 times on 'missing gate labels:
# [smoke-green]' (580 across all evaluations), each re-running tests-green AND
# smoke-green at 600s a piece, on BOTH the start-of-tick and end-of-tick
# ``auto_merge_tick`` calls. Same cap, same rationale as ``_MAX_CI_FIX_CYCLES``
# just above: nothing loops more than 3 times (CLAUDE.md).
_MAX_GATE_BLOCK_CYCLES = 3

# CONFLICT -> dev REBUILD loop. When an open PR is genuinely CONFLICTING with
# main (a real content conflict, mergeable=="CONFLICTING" / mergeStateStatus
# DIRTY — NOT merely BEHIND, which ``_attempt_pr_reconcile``'s
# ``gh pr update-branch`` already fixes), the branch was cut from an OLDER main
# that has since advanced. Re-dispatching dev on the SAME stale branch just
# re-conflicts at PR-open's ``git merge origin/main`` — so instead we REBUILD
# the change on a FRESH branch cut from CURRENT main (close the conflicting PR,
# wipe the stale local/remote branch + worktree, and re-dispatch dev). Bounded
# by ``_MAX_CONFLICT_REBUILDS`` via the event log so a genuinely-unresolvable
# conflict PARKS after N rebuilds instead of looping forever — the conflict
# analogue of ``_MAX_CI_FIX_CYCLES``. We never silently auto-resolve a conflict;
# we regenerate the change cleanly via dev.
_MAX_CONFLICT_REBUILDS = 2

# Gate labels the docs chain produces. The docs chain skips the TDD
# red→green loop, so the 10 TDD gate labels don't apply. The single
# label the docs chain DOES enforce is ``canonical-paths-only`` — when
# ``handle_docs_enforcer`` reaches PR_OPEN with no violations, the
# canonical-paths gate has effectively passed for the PR.
#
# Kept as a frozenset so the worker can swap the gate set on
# ``chain_kind`` without re-checking the TDD list.
_DOCS_CHAIN_GATE_LABELS: frozenset[str] = frozenset({"canonical-paths-only"})

# Gates a PR LABEL may never satisfy — only a fresh passing evaluation counts.
# ``present_labels`` unions the PR's applied labels with the gates that just
# passed, which is fine for gates whose label the chain itself once applied. It
# is NOT fine for a fail-closed precondition: a PR carrying the literal label
# ``production-tree-changed`` would otherwise clear the requirement without the
# diff ever being looked at — the recorded-flag hole that gate's own docstring
# says must not exist.
# Gates that ONLY a fresh passing evaluation can satisfy — a PR label with the
# same name never counts. ``acceptance-verified`` belongs here for the same reason
# ``production-tree-changed`` does, and more so: its entire value is that an
# INDEPENDENT test was actually executed against the merge candidate. Accepting a
# label as evidence would let anything that can label a PR (an operator, a bot, a
# future chain step) substitute a string for the run.
_RESULT_ONLY_GATE_LABELS: frozenset[str] = frozenset(
    {"production-tree-changed", "acceptance-verified"}
)


def _story_targets_factory_repo(app_config: AppConfig) -> bool:
    """True when ``app_config`` builds the factory's own repo (a self-edit app).

    Scoping guard for the chain-side staging gate: only factory-repo stories are
    ever routed through staging. Every other app (sacrifice, ...) targets a
    different repo and bypasses the gate entirely.
    """
    return targets_factory_repo(app_config.repo)


def _fetch_pr_merge_commit_sha(  # pragma: no cover - real-run path; queries live GH state
    *, app_config: AppConfig, pr_number: int
) -> str | None:
    """Best-effort: the merge-commit SHA for an already-merged PR, or ``None``.

    Squash-merging a PR creates a NEW commit on the base branch that is not
    the PR's ``head_sha`` — the only way to learn it after the fact is to ask
    GitHub. Fail-safe: any failure (``gh`` missing/timeout, non-zero exit,
    unparseable payload, no merge commit recorded yet) returns ``None`` rather
    than a wrong sha, since the circuit breaker must never track a made-up
    commit.
    """
    import json as _json
    import subprocess

    if pr_number <= 0:
        return None
    cmd = [
        "gh",
        "pr",
        "view",
        str(pr_number),
        "--repo",
        app_config.repo,
        "--json",
        "mergeCommit",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    try:
        data = _json.loads(proc.stdout)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    merge_commit = data.get("mergeCommit")
    if not isinstance(merge_commit, dict):
        return None
    oid = merge_commit.get("oid")
    return oid if isinstance(oid, str) and oid else None


def _record_self_edit_commit_if_applicable(
    *,
    app_config: AppConfig,
    fixture: FixturePR,
    root: Path | None,
    merge_commit_sha_provider: Any = None,
) -> None:
    """Track a just-merged factory self-edit commit for the circuit breaker.

    ``factory.manager.circuit_breaker.record_manager_commit`` had ZERO
    production callers after PR #247 deleted ``factory/manager/apply.py`` (its
    only caller) — the breaker's commit ledger never gained an entry, so
    ``check_and_trip`` could never find a tracked SHA at HEAD and the breaker
    was permanently inert despite ``factory manager circuit-breaker status/
    check/reset`` still existing. This is the chain-side replacement caller: a
    factory-repo PR that touches ``factory/`` (a self-edit, the same notion
    ``_evaluate_self_edit_gate``/``staging.is_self_edit`` use) is exactly what
    the breaker was built to guard, so once such a PR has ACTUALLY merged we
    record its merge-commit SHA.

    Advisory only: this NEVER raises and never affects the merge decision — a
    failure to record just means the breaker can't track *this* commit, not a
    failed or reverted merge. ``merge_commit_sha_provider`` is an injection
    seam (defaults to ``_fetch_pr_merge_commit_sha``) so tests can pin the
    wiring without shelling out to ``gh``.
    """
    try:
        if not _story_targets_factory_repo(app_config):
            return
        from factory.manager.staging import is_self_edit

        if not is_self_edit(list(fixture.files_changed)):
            return
        provider = merge_commit_sha_provider or _fetch_pr_merge_commit_sha
        sha = provider(app_config=app_config, pr_number=fixture.pr_number)
        if not sha:
            return
        from factory.manager.circuit_breaker import record_manager_commit

        record_manager_commit(
            root=Path(root) if root is not None else Path.cwd(),
            sha=sha,
            proposal_path=f"chain:{app_config.repo}:pr-{fixture.pr_number}",
        )
    except Exception:  # noqa: BLE001 - advisory tracking must never break a merge
        pass


class MergeActionRecord(SQLModel, table=True):
    """One row per auto-merge decision (merged or no-op)."""

    __tablename__ = "merge_actions"

    id: int | None = Field(default=None, primary_key=True)
    app: str = Field(index=True)
    pr_number: int = Field(index=True)
    head_sha: str
    merged: bool
    reason: str
    gates_passed_json: str  # JSON list of labels that passed
    # JSON list of FAILING GateResult dicts (label/passed/reason/details).
    # Without this the table recorded only which gates passed, so a blocked
    # merge said "missing gate labels: ['smoke-green']" and the reason — the
    # exit code and the command's output tail, both of which the gate had
    # already computed — was discarded at the call site and unrecoverable.
    gates_failed_json: str = Field(default="[]")
    blocking_labels_json: str  # JSON list of blocking labels present
    ts: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())


@dataclass
class MergeAction:
    """Returned to the caller — pure data shape for the CLI/tests."""

    app: str
    pr_number: int
    merged: bool
    reason: str
    gates_passed: list[str] = field(default_factory=list)
    # Full ``GateResult.as_dict()`` for every gate that FAILED this evaluation,
    # carrying each gate's ``reason`` and ``details`` (e.g. the smoke gate's
    # ``exit_code`` + ``output_tail``). ``gates_passed`` holds bare labels
    # because that is all a passing gate needs to say; a failing gate has to
    # explain itself or the block is undiagnosable.
    gates_failed: list[dict[str, Any]] = field(default_factory=list)
    blocking_labels: list[str] = field(default_factory=list)
    # Set True when a factory self-edit was refused by the chain-side staging
    # gate (``_evaluate_self_edit_gate``): the live factory was NOT touched and
    # the story should be sunk to a blocked/attention state by the caller.
    staging_blocked: bool = False
    # The staging-gate status when blocked: ``"staging_rejected"`` (a stage
    # failed on the clone), ``"staging_infra_failed"`` (harness could not
    # determine health), ``"forbidden"`` (touched factory/manager/** or
    # bench/**), or ``"diff_unavailable"`` (could not fetch the diff to
    # validate). ``None`` when the merge was not staging-blocked.
    staging_status: str | None = None
    # Set True when ``gh pr merge --auto`` succeeded but the PR is NOT merged
    # yet — GitHub's auto-merge was merely ENABLED and the merge will happen
    # asynchronously once the required checks pass. This is the critical
    # ``merged != auto-merge-requested`` distinction: with ``merged=False`` the
    # caller must NOT record a merged row, NOT enqueue a deploy, and NOT advance
    # the story — it STAYS in ``_MERGEABLE_STATES`` so ``reconcile_from_github``
    # and the CI-failure->dev loop keep watching it. If a required check later
    # FAILS, the PR never merges and the story is still re-dispatchable instead
    # of being stranded at ``deploy_pending``.
    auto_merge_enabled: bool = False
    # Set True when the per-PR evaluation REFUSED to merge because this story is
    # a dual-draft alternative whose SIBLING already shipped (Part 2 — the
    # defense-in-depth self-check that composes with the reconcile-detected
    # ``--auto`` merge path). ``merged`` is always False when this is True. The
    # caller terminally supersedes the story (``SUPERSEDED_BY_SIBLING``) and
    # closes its PR so it can never merge a redundant second interpretation.
    superseded_by_sibling: bool = False
    # Delivery level ``push_to_main`` only: the fast-forward of the default
    # branch was REFUSED (not a fast-forward, push rejected, HEAD moved). The
    # caller falls back to level ``pr`` — opens a ready PR, never merges it.
    push_to_main_refused: bool = False
    # The merged story's DEPLOY_PENDING write already happened, as a
    # compare-and-set under the story lock (``_evaluate_one_pr``); the tick
    # must not write the state again from its own (possibly stale) copy.
    state_committed: bool = False


@dataclass
class FixturePR:
    """A fixture PR shape for dry-run tests.

    Mirrors the subset of GH fields the worker reads. ``story`` may be
    omitted if the fixture wants the worker to look up the StoryRecord by
    pr_number from the local DB.
    """

    pr_number: int
    head_sha: str
    base_branch: str
    labels: list[str] = field(default_factory=list)
    files_changed: list[str] = field(default_factory=list)
    ci_state: str | None = "success"
    story: StoryRecord | None = None
    repo_root: Path | None = None
    # GitHub's draft flag. A draft PR is NEVER merged by this worker.
    is_draft: bool = False


# ``merge_actions`` columns added after the table shipped. SQLModel's
# ``create_all`` only creates missing TABLES — it never adds a column to an
# existing one, so a live ``factory.db`` needs an explicit idempotent ALTER or
# every insert fails with "no such column". Mirrors ``_ensure_story_columns``.
_MERGE_ACTION_MIGRATION_COLUMNS: dict[str, str] = {
    "gates_failed_json": "TEXT DEFAULT '[]'",
}


def _ensure_merge_action_columns(eng: Any) -> None:
    """Idempotently add any missing ``merge_actions`` columns."""
    from sqlalchemy import text

    with eng.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(merge_actions)")).fetchall()
        existing = {r[1] for r in rows}
        for col, sqltype in _MERGE_ACTION_MIGRATION_COLUMNS.items():
            if col in existing:
                continue
            conn.execute(text(f"ALTER TABLE merge_actions ADD COLUMN {col} {sqltype}"))


def _engine(db_path: Path) -> Any:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    eng = create_engine(f"sqlite:///{db_path}", echo=False)
    SQLModel.metadata.create_all(eng)
    _ensure_merge_action_columns(eng)
    return eng


def _record_merge_action(action: MergeAction, head_sha: str, db_path: Path) -> None:
    eng = _engine(db_path)
    rec = MergeActionRecord(
        app=action.app,
        pr_number=action.pr_number,
        head_sha=head_sha,
        merged=action.merged,
        reason=action.reason,
        gates_passed_json=json.dumps(action.gates_passed),
        gates_failed_json=json.dumps(action.gates_failed),
        blocking_labels_json=json.dumps(action.blocking_labels),
    )
    with Session(eng) as session:
        session.add(rec)
        session.commit()


def _is_docs_chain(story: StoryRecord | None) -> bool:
    """Return True if ``story`` is part of the docs chain.

    A missing story is treated as TDD (the historical default) so the
    full 10-gate check still applies — this keeps the worker
    conservative when the fixture skips the StoryRecord lookup.
    """
    return story is not None and story.chain_kind == "docs"


# ---------------------------------------------------------------------------
# Chain-side staging gate for factory self-edits (Tier 3 — self-tick safety)
# ---------------------------------------------------------------------------


@dataclass
class _SelfEditDecision:
    """Outcome of the chain-side staging gate for one factory-repo story.

    ``allow=True`` means the change is safe to merge (either it is not a factory
    self-edit, or the staging clone validated it healthy). Every other outcome
    is ``allow=False`` — the live factory is NEVER touched on uncertainty.
    """

    allow: bool
    status: str
    logs_tail: str = ""
    forbidden: bool = False


def _default_patch_provider(
    app_config: AppConfig, pr_number: int, *, root: Path | None = None
) -> str | None:  # pragma: no cover - real-run gh shell-out
    """Fetch a PR's unified diff via ``gh pr diff``. ``None`` on any failure.

    ``gh pr diff`` (and the GitHub diff view it wraps) refuses any PR whose
    diff exceeds 20,000 lines (``HTTP 406: Sorry, the diff exceeded the
    maximum number of lines``). That is a GitHub-side rendering cap, not a
    property of the change — a large-but-legitimate factory self-edit (e.g.
    direction 018's ~226-file, ~25,600-line untracking) trips it and would
    otherwise be PERMANENTLY unmergeable, forever, with a message that says
    nothing about the change's health. When ``root`` is given (the local
    checkout of ``app_config.repo``), fall back to fetching the PR head ref
    directly and diffing it with local ``git``, which has no such cap.

    A ``None`` return is still treated as fail-safe by the caller (a factory
    self-edit whose diff cannot be read, by either path, is never merged).
    """
    import subprocess

    if pr_number <= 0:
        return None
    try:
        proc = subprocess.run(
            ["gh", "pr", "diff", str(pr_number), "--repo", app_config.repo],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode == 0:
        return proc.stdout or ""
    return _local_git_patch_fallback(app_config, pr_number, root=root)


def _local_git_patch_fallback(
    app_config: AppConfig, pr_number: int, *, root: Path | None
) -> str | None:  # pragma: no cover - real-run git shell-out
    """Diff a PR locally by fetching its head ref straight from GitHub.

    Recovery path for PRs ``gh pr diff`` refuses to serve (most commonly
    GitHub's 20,000-line diff cap). Fetches ``refs/pull/<pr>/head`` into a
    scratch local ref, diffs it against the fetched base branch with
    ``git diff <base>...<head>`` (the same merge-base semantics as the GitHub
    PR diff view), and always deletes the scratch ref afterward. ``None`` on
    any failure — this is a recovery path, not a second fail-safe hole.
    """
    import subprocess

    if root is None:
        return None
    base = app_config.default_branch or "main"
    tmp_ref = f"refs/tmp/self-edit-gate-pr-{pr_number}"
    try:
        base_fetch = subprocess.run(
            ["git", "fetch", "origin", base],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=180,
        )
        if base_fetch.returncode != 0:
            return None
        head_fetch = subprocess.run(
            [
                "git",
                "fetch",
                "origin",
                f"pull/{pr_number}/head:{tmp_ref}",
                "--force",
            ],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=180,
        )
        if head_fetch.returncode != 0:
            return None
        diff = subprocess.run(
            ["git", "diff", f"origin/{base}...{tmp_ref}"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=180,
        )
        if diff.returncode != 0:
            return None
        return diff.stdout or ""
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
    finally:
        subprocess.run(
            ["git", "update-ref", "-d", tmp_ref],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=30,
        )


def _self_edit_escalation_proposal(
    *,
    story: StoryRecord | None,
    app_config: AppConfig,
    pr_number: int,
    classification: str,
    detail: str,
    staging_status: str,
    patch: str = "",
) -> dict[str, Any]:
    """Build the escalation proposal for a refused factory self-edit.

    An escalation that names no concern, no target and no diagnosis is a
    notification that *something, somewhere* wants attention — worthless to the
    operator. GitHub issue #179 was exactly that: ``concern_id: ?``,
    ``target: ?``, "Concern / diagnosis: _(none provided)_". The cause is a
    CONTRACT MISMATCH, not a rendering bug: ``manager.escalation._build_issue_body``
    renders ``concern_id`` / ``proposal.target`` / ``diagnosis`` /
    ``proposal.rationale`` / ``escalation_reason``, and this caller used to pass
    only ``concern_title``, ``proposal.suggested_patch`` and a ``detail`` key the
    renderer never reads.

    Every field the renderer reads is populated here, so the issue body always
    carries the concrete ``staging_status``, the reason the change could not be
    validated, and the PR + story it concerns.
    """
    story_id = getattr(story, "id", None)
    story_slug = getattr(story, "slug", None) or "?"
    story_title = getattr(story, "title", None) or ""
    status = staging_status or classification

    subject = f"factory self-edit PR #{pr_number} refused ({status})"

    # Stable per-PR ids. ``concern_id`` is the escalation channel's PREFERRED
    # dedup key, so it must identify the thing a human would fix — this PR —
    # and nothing coarser (a shared id across PRs would over-dedup and hide
    # every refusal after the first).
    concern_id = f"chain-selfedit:{app_config.repo}:pr-{pr_number}"
    proposal_id = f"chain-selfedit-story-{story_id}-pr-{pr_number}"

    diagnosis = "\n".join(
        [
            f"The chain-side staging gate REFUSED to merge factory self-edit PR #{pr_number}.",
            "",
            f"- repo: `{app_config.repo}`",
            f"- pull request: #{pr_number}",
            f"- story: {story_id if story_id is not None else '?'} (`{story_slug}`)"
            + (f" — {story_title}" if story_title else ""),
            f"- classification: `{classification}`",
            f"- staging_status: `{status}`",
            "",
            "Why it could not be validated / merged:",
            "",
            detail or "(no detail recorded)",
        ]
    )

    if classification == "forbidden":
        rationale = (
            f"Do NOT merge PR #{pr_number} as-is: it edits a path the chain may never "
            "touch (`factory/manager/**` or `bench/**`). Split the forbidden files out "
            "into an operator-authored PR and let the chain keep the remainder."
        )
    else:
        rationale = (
            f"Operator action: inspect PR #{pr_number} on `{app_config.repo}`, reproduce "
            f"the staging failure (`staging_status={status}`), then either fix the story "
            "and re-run the gate or close the PR. The live factory was left untouched."
        )

    return {
        "proposal_id": proposal_id,
        "concern_id": concern_id,
        "concern_title": subject,
        # Read by manager.escalation._build_issue_body:
        "diagnosis": diagnosis,
        "escalation_reason": detail,
        "proposal": {
            "target": f"{app_config.repo}#{pr_number}",
            "rationale": rationale,
            "suggested_patch": patch,
        },
        # Machine-readable extras for anything else consuming the proposal.
        "detail": detail,
        "staging_status": status,
        "pr_number": pr_number,
        "story_id": story_id,
        "app": app_config.name,
    }


def _escalate_self_edit(
    escalate: Any,
    *,
    story: StoryRecord | None,
    app_config: AppConfig,
    root: Path,
    pr_number: int,
    classification: str,
    detail: str,
    staging_status: str = "",
    patch: str = "",
) -> None:
    """Best-effort escalation for a refused factory self-edit. Never raises.

    Reuses the WS3.1 ``escalation.notify_escalation`` channel (the same one the
    manager proposal path uses) so a chain-built self-edit that fails staging or
    hits a forbidden path is surfaced to a human exactly like a manager-proposed
    one — and, since the #179 fix, with the same actionable content.
    """
    proposal = _self_edit_escalation_proposal(
        story=story,
        app_config=app_config,
        pr_number=pr_number,
        classification=classification,
        detail=detail,
        staging_status=staging_status,
        patch=patch,
    )
    try:
        escalate(
            proposal,
            root=root,
            repo=app_config.repo,
            classification=classification,
            # ``error`` is the key the escalation renderer falls back to for the
            # failure evidence; ``detail`` is kept for existing consumers.
            result={
                "error": detail,
                "detail": detail,
                "pr_number": pr_number,
                "staging_status": proposal["staging_status"],
            },
        )
    except Exception:  # noqa: BLE001 - escalation is best-effort; never block the tick
        pass


def _evaluate_self_edit_gate(
    *,
    app_config: AppConfig,
    story: StoryRecord | None,
    pr_number: int,
    root: Path | None,
    patch_provider: Any = None,
    self_edit_gate: Any = None,
    escalate: Any = None,
) -> _SelfEditDecision:
    """Decide whether a factory-repo story is safe to merge.

    This is the chain analogue of the manager proposal path's staging gate: a
    story that modifies the factory's OWN code must be validated by ACTUALLY
    RUNNING a cloned factory (``staging.gate_self_edit``) before it can land on
    the live factory. The manager path had this protection; the chain
    (pm-sync → dev → review → auto_merge) did not — this closes that gap.

    Fail-safe contract (never merge an unvalidated factory self-edit):
      * app does not target the factory repo → ``allow=True`` (app-repo stories
        bypass staging entirely — unchanged path).
      * diff cannot be obtained → ``allow=False`` (cannot validate → refuse).
      * touches a forbidden path (``factory/manager/**`` or ``bench/**``) →
        ``allow=False`` (the chain can never edit the safety mechanism or the
        grader, staging-validated or not).
      * not a runtime self-edit (e.g. only ``apps/factory/directions`` docs) →
        ``allow=True`` (staging validates "does the factory run"; a non-code
        change can't change that, so no staging is required).
      * runtime self-edit → routed through the staging gate; ``allow`` mirrors
        ``decision.promote`` (healthy → merge, unhealthy/infra → refuse).

    Any uncertainty — a missing diff, a staging harness exception, a
    non-promote decision — resolves to ``allow=False``.
    """
    if not _story_targets_factory_repo(app_config):
        return _SelfEditDecision(allow=True, status="not_factory_repo")

    root = Path(root) if root is not None else Path.cwd()

    from factory.diff_paths import _diff_target_paths
    from factory.manager import staging
    from factory.manager.forbidden_paths import _any_path_is_forbidden_in_patch

    if patch_provider is None:
        import functools

        patch_provider = functools.partial(_default_patch_provider, root=root)
    if self_edit_gate is None:
        self_edit_gate = staging.gate_self_edit
    if escalate is None:
        from factory.manager.escalation import notify_escalation as escalate

    try:
        patch = patch_provider(app_config, pr_number)
    except Exception:  # noqa: BLE001 - fail-safe: cannot read diff → do not merge
        patch = None

    if not patch or not patch.strip():
        reason = (
            f"factory self-edit PR #{pr_number}: could not obtain the diff to "
            f"validate; refusing to merge an unvalidated factory change."
        )
        _escalate_self_edit(
            escalate,
            story=story,
            app_config=app_config,
            root=root,
            pr_number=pr_number,
            classification="escalate_to_human",
            detail=reason,
            staging_status="diff_unavailable",
        )
        return _SelfEditDecision(allow=False, status="diff_unavailable", logs_tail=reason)

    paths = _diff_target_paths(patch)

    # Fail-safe: a NON-empty diff that parses to NO target paths is
    # unparseable. For a factory-repo story we cannot determine what it
    # touches, so we cannot rule out a self-edit or a forbidden path — refuse
    # rather than fall through to the "not a self-edit → merge" branch below
    # (which would be a fail-OPEN on an unreadable factory diff).
    if not paths:
        reason = (
            f"factory self-edit PR #{pr_number}: diff is non-empty but no target "
            f"paths could be parsed; refusing to merge a factory change whose "
            f"scope cannot be determined."
        )
        _escalate_self_edit(
            escalate,
            story=story,
            app_config=app_config,
            root=root,
            pr_number=pr_number,
            classification="escalate_to_human",
            detail=reason,
            staging_status="unparseable_diff",
            patch=patch,
        )
        return _SelfEditDecision(allow=False, status="unparseable_diff", logs_tail=reason)

    # Forbidden-path guard FIRST — the chain must never edit the safety
    # mechanism (factory/manager/**) or the grader (bench/**), regardless of
    # whether staging would pass. Reuses the exact classifier the manager
    # apply path uses so the two paths can never diverge.
    if _any_path_is_forbidden_in_patch(paths, patch):
        reason = (
            f"factory self-edit PR #{pr_number} touches a forbidden path "
            f"(factory/manager/** or bench/**); the chain may not edit the "
            f"safety mechanism or the grader. Refusing to merge."
        )
        _escalate_self_edit(
            escalate,
            story=story,
            app_config=app_config,
            root=root,
            pr_number=pr_number,
            classification="forbidden",
            detail=reason,
            staging_status="forbidden",
            patch=patch,
        )
        return _SelfEditDecision(allow=False, status="forbidden", forbidden=True, logs_tail=reason)

    # Not a runtime self-edit (touches no factory/ code) → nothing for staging
    # to validate; safe to merge like any other content/docs change.
    if not staging.is_self_edit(paths):
        return _SelfEditDecision(allow=True, status="not_self_edit")

    # Runtime self-edit → validate by actually running the cloned factory.
    proposal = {
        "proposal_id": f"chain-selfedit-story-{getattr(story, 'id', None)}-pr-{pr_number}",
        "concern_title": (
            getattr(story, "title", None) or f"chain factory self-edit PR #{pr_number}"
        ),
        "proposal": {"suggested_patch": patch},
    }
    proposal_path = f"chain:{app_config.repo}:pr-{pr_number}"
    try:
        decision = self_edit_gate(proposal, proposal_path, root=root)
    except Exception as exc:  # noqa: BLE001 - fail-safe: harness error → do not merge
        reason = f"factory self-edit staging harness errored: {exc!r}"
        _escalate_self_edit(
            escalate,
            story=story,
            app_config=app_config,
            root=root,
            pr_number=pr_number,
            classification="escalate_to_human",
            detail=reason,
            staging_status="staging_infra_failed",
            patch=patch,
        )
        return _SelfEditDecision(allow=False, status="staging_infra_failed", logs_tail=reason)

    if getattr(decision, "promote", False):
        return _SelfEditDecision(allow=True, status="staging_validated")

    # Not promoted (unhealthy validation or infra failure). gate_self_edit
    # already emitted its own alert/event; add the chain escalation so the
    # blocked story is visible on the same channel as manager escalations.
    status = getattr(decision, "status", "staging_rejected") or "staging_rejected"
    logs_tail = getattr(decision, "logs_tail", "") or ""
    _escalate_self_edit(
        escalate,
        story=story,
        app_config=app_config,
        root=root,
        pr_number=pr_number,
        classification="escalate_to_human",
        detail=(
            f"factory self-edit failed staging (status={status}): "
            f"{logs_tail[:500] or '(no staging logs captured)'}"
        ),
        staging_status=status,
        patch=patch,
    )
    return _SelfEditDecision(allow=False, status=status, logs_tail=logs_tail)


# --------------------------------------------------------------------------- #
# Part 2 — dual-draft loser self-check (defense-in-depth)
# --------------------------------------------------------------------------- #

# A dual-draft sibling that reaches one of these states has WON the race — any
# OTHER alternative of the same direction must not also merge (that redundant
# second merge is exactly the dual-draft over-fire the loser-cleanup exists to
# prevent). ``superseded_by_sibling`` is included so a loser already retired by
# the winner's cleanup can never be resurrected into a merge, and
# ``deploy_pending`` covers the winner the instant its merge is detected (by the
# auto-merge path OR by ``reconcile_from_github``) — before it has deployed.
_SIBLING_SHIPPED_STATES: frozenset[str] = frozenset(
    {
        StoryState.DEPLOYED.value,
        StoryState.DEPLOY_PENDING.value,
        StoryState.SUPERSEDED_BY_SIBLING.value,
    }
)


def _default_sibling_rows(*, direction_id: str, app: str, db_path: Path) -> list[StoryRecord]:
    """All StoryRecords sharing ``direction_id`` + ``app`` (the sibling set)."""
    eng = _engine(db_path)
    with Session(eng) as session:
        return list(
            session.exec(
                select(StoryRecord).where(
                    StoryRecord.direction_id == direction_id,
                    StoryRecord.app == app,
                )
            ).all()
        )


def _default_merged_pr_exists(*, app: str, pr_number: Any, db_path: Path) -> bool:
    """True iff a ``merged=True`` merge-action row exists for ``pr_number``.

    Catches a sibling whose PR already merged on GitHub (recorded by either the
    auto-merge path or ``reconcile._record_reconciled_merge_and_enqueue_deploy``)
    even in the brief window before its StoryRecord advances to a shipped state.
    """
    try:
        n = int(pr_number)
    except (TypeError, ValueError):
        return False
    if n <= 0:
        return False
    eng = _engine(db_path)
    with Session(eng) as session:
        row = session.exec(
            select(MergeActionRecord).where(
                MergeActionRecord.app == app,
                MergeActionRecord.pr_number == n,
                MergeActionRecord.merged == True,  # noqa: E712
            )
        ).first()
    return row is not None


def _sibling_already_shipped(
    *,
    story: StoryRecord | None,
    db_path: Path,
    sibling_rows: Any = None,
    merged_pr_exists: Any = None,
) -> bool:
    """Return True iff ``story`` is a dual-draft alternative that LOST the race.

    ``story`` loses when it carries a dual-draft ``-alt-*`` slug suffix AND a
    SIBLING (same ``direction_id`` + ``app`` but a DIFFERENT alt-suffix) is
    already in a terminal-shipped state (``deployed`` / ``deploy_pending`` /
    ``superseded_by_sibling``) OR already has a merged PR. Such a ``story`` must
    NOT merge — the winner already landed, and merging this one would ship a
    redundant second interpretation (the dual-draft over-fire).

    ``sibling_rows`` / ``merged_pr_exists`` are injection seams so the check is
    testable with a fake DB/github; both default to the real DB-backed queries.

    Fail-safe: a non-dual-draft story, no shipped sibling, OR **any error**
    returns False — the check must never wrongly supersede a legitimate story
    nor block a legitimate merge on a query hiccup.
    """
    if story is None:
        return False
    try:
        from factory.chain.dual_draft import _draft_alt_suffix

        my_suffix = _draft_alt_suffix(getattr(story, "slug", "") or "")
        if my_suffix is None:
            return False  # not a dual-draft story — nothing to guard

        rows_fn = sibling_rows or _default_sibling_rows
        merged_fn = merged_pr_exists or _default_merged_pr_exists
        rows = rows_fn(direction_id=story.direction_id, app=story.app, db_path=db_path)
        for sib in rows:
            if getattr(sib, "id", None) == getattr(story, "id", None):
                continue  # never compare a story to itself
            sib_suffix = _draft_alt_suffix(getattr(sib, "slug", "") or "")
            if sib_suffix is None or sib_suffix == my_suffix:
                # Not a dual-draft sibling, or the SAME interpretation — skip.
                continue
            if getattr(sib, "state", "") in _SIBLING_SHIPPED_STATES:
                return True
            if merged_fn(
                app=getattr(sib, "app", None) or story.app,
                pr_number=getattr(sib, "github_pr_number", None),
                db_path=db_path,
            ):
                return True
        return False
    except Exception:  # noqa: BLE001 - fail-safe: never wrongly supersede/block
        return False


def _gate_block_history(
    *,
    story_id: int,
    head_sha: str,
    root: Path | None,
    slug: str | None,
    per_story: bool = False,
) -> tuple[int, dict[str, Any] | None]:
    """Prior REQUIRED-gate blocks already recorded for THIS exact head sha.

    Derived from the existing ``merge_gates_failed`` event stream rather than a
    new mutable counter column — every one of those events already carries
    ``head_sha``, and (since the fix alongside this) ``missing_labels``.
    Counting them back out is cheap and needs no schema change.

    Returns ``(count, last_payload)``: ``count`` is how many prior events for
    ``(story_id, head_sha)`` had a non-empty ``missing_labels`` (i.e. actually
    BLOCKED the merge, not merely a non-required gate failing); ``last_payload``
    is the most recent one, which the caller reuses to skip re-running the
    gates. A NEW commit produces a NEW ``head_sha``, so both the count and the
    skip reset for free the moment the story pushes a fix — nothing here needs
    to notice a commit happened, it just stops matching.

    OPERATOR RESUME (2026-08-09): a ``story_resumed`` event RESETS this window —
    only ``merge_gates_failed`` events logged AFTER the most recent resume are
    counted. Without that, ``factory resume-story`` was a no-op wearing a
    success message: the common resume is "the GATE was wrong (a bad oracle, a
    leaked docker network, a spec that named a body the app never produces), the
    CODE is fine", so there is no new commit and the head sha is unchanged — the
    very next evaluation re-read its own three historical blocks, hit the cap on
    evaluation #1, and re-parked the story before the fixed gate ever ran. The
    reset is derived from the event stream exactly like the count itself, so the
    two can never disagree and no counter column is introduced.

    ``per_story=True`` (delivery level ``push_to_main``): the COUNT is keyed by
    the story, not the head sha — every real-run block since the last resume
    counts, whatever commit it evaluated. A ``push_to_main`` story has no PR;
    its "head" is the worktree commit, which can move between ticks without a
    human pushing a fix (adversarial review 2026-11-02, finding 3), so a
    per-sha count reset every tick and the gate set re-ran forever. The skip
    payload stays sha-scoped: a verdict is only reused for the commit it judged.
    """
    from factory.chain.event_log import read_story_events

    events = read_story_events(story_id, software_factory_root=root, slug_hint=slug or "")
    # Everything before the last operator resume is history, not evidence about
    # the current attempt. ``story_resumed`` is not head-sha-scoped on purpose: a
    # resume clears the slate for whatever head the story is on, including the
    # unchanged one it was parked at.
    resume_idx = -1
    for i, e in enumerate(events):
        if e.get("event") == "story_resumed":
            resume_idx = i
    if per_story:
        story_matches = [
            e
            for e in events[resume_idx + 1 :]
            if e.get("event") == "merge_gates_failed"
            and e.get("missing_labels")
            and not e.get("dry_run")
        ]
        same_head = [e for e in story_matches if e.get("head_sha") == head_sha]
        return len(story_matches), (same_head[-1] if same_head else None)
    matches = [
        e
        for e in events[resume_idx + 1 :]
        if e.get("event") == "merge_gates_failed"
        and e.get("head_sha") == head_sha
        and e.get("missing_labels")
    ]
    if not matches:
        return 0, None
    return len(matches), matches[-1]


def _park_gate_block_exhausted(
    *,
    story: StoryRecord,
    fixture: FixturePR,
    missing_labels: list[str],
    block_count: int,
    root: Path | None,
    db_path: Path | None,
) -> None:
    """Required-gate-block exhaustion -> the SAME terminal sink a real CI
    failure already has (``_handle_ci_failure``'s ``_park``): the story parks
    in ``BLOCKED_CI_UNRESOLVED`` so it stops being re-evaluated every tick.

    Unlike the CI-failure park, this does NOT close the PR — a required-gate
    block (e.g. a flaky ``smoke-green``) is not necessarily a wrong
    implementation the way a genuine CI red is, and an operator may want to fix
    the harness and let the SAME PR through rather than have it destroyed
    out from under them. Only the story's own state stops looping; the PR
    stays open for a human (or a future commit) to resolve.

    Sets ``last_rejection_reason`` — unlike the CI-failure park, which does
    not — so this reaches ``factory inbox``: ``blocked_ci_unresolved`` is on
    the tracker-closer's resolved-states allowlist (by design: the ticket
    genuinely IS done rotting the tick loop), but the inbox predicate carves
    an exception back out for exactly this reason field (see ``cli.py``).
    """
    from factory.chain.event_log import log_story_event
    from factory.chain.handlers import persist_story

    if fixture.pr_number > 0:
        reason = (
            f"gate_block_exhausted: required gate(s) {missing_labels!r} never passed "
            f"after {block_count} consecutive evaluations of head {fixture.head_sha[:12]}"
        )
        hint = (
            f"fix the failing gate(s) for PR #{fixture.pr_number} and push a new commit "
            "to resume (a new head sha resets this), or close the PR by hand."
        )
    else:
        # push_to_main: no PR, cap keyed per story (a new commit does NOT reset it).
        reason = (
            f"gate_block_exhausted: push_to_main — required gate(s) {missing_labels!r} "
            f"never passed after {block_count} evaluations of this story "
            f"(last head {fixture.head_sha[:12]})"
        )
        hint = (
            "nothing was pushed to the default branch. Fix the failing gate(s) and "
            "`factory resume-story` it, or re-submit the job at a PR level."
        )
    story.state = StoryState.BLOCKED_CI_UNRESOLVED.value
    story.last_rejection_reason = reason
    story.error = f"auto-merge: {reason}. Parked so it stops being re-evaluated every tick — {hint}"
    if db_path is not None:
        try:
            persist_story(story, db_path)
        except Exception:  # noqa: BLE001 - best-effort; the event below still fires
            pass
    try:
        log_story_event(
            story.id,
            "gate_block_exhausted",
            {
                "pr_number": fixture.pr_number,
                "head_sha": fixture.head_sha,
                "missing_labels": missing_labels,
                "block_count": block_count,
                "cap": _MAX_GATE_BLOCK_CYCLES,
            },
            software_factory_root=root,
            slug_hint=story.slug,
        )
    except Exception:  # noqa: BLE001 - telemetry only, never break the park
        pass


def _evaluate_one_pr(
    *,
    app: str,
    fixture: FixturePR,
    app_config: AppConfig,
    dry_run: bool,
    github_client: Any,
    merge_method: str = "squash",
    wait_for_ci: bool = True,
    delete_branch_after_merge: bool = True,
    software_factory_root: Path | None = None,
    self_edit_gate: Any = None,
    patch_provider: Any = None,
    escalate: Any = None,
    merge_fn: Any = None,
    pr_merged_query: Any = None,
    db_path: Path | None = None,
    sibling_shipped_query: Any = None,
    merge_commit_sha_provider: Any = None,
    push_to_main: bool = False,
    fast_forward_fn: Any = None,
) -> MergeAction:
    """Decide if a PR should be merged; merge it in real-run.

    ``push_to_main=True`` (delivery level ``push_to_main``): the story has NO
    PR — ``fixture.pr_number`` is the ``-(story.id)`` placeholder and
    ``fixture.head_sha`` the worktree commit. The SAME gate set runs; on a pass
    the default branch is fast-forwarded by ``fast_forward_fn`` (default
    ``delivery_gate.fast_forward_default_branch``) instead of ``gh pr merge``.
    A refused fast-forward returns ``push_to_main_refused=True``.

    Branches on ``story.chain_kind``:

    * ``tdd`` (or unknown): the historical 10-gate check.
    * ``docs``: the docs chain skips the TDD red→green loop and
      doesn't apply the 10 TDD labels; the canonical-paths enforcer
      runs before reaching PR_OPEN, so we only check
      mergeable-state + blocking-labels.

    ``merge_fn`` / ``pr_merged_query`` are injection seams for the real-run
    merge shell-out (``_gh_pr_merge``) and the authoritative
    "is-this-PR-actually-merged" query (``_pr_is_merged_on_github``). Tests
    pass fakes to drive the "auto-merge enabled but not merged yet" vs "really
    merged" branches without touching GitHub. ``merge_commit_sha_provider`` is
    the analogous seam for ``_record_self_edit_commit_if_applicable`` (the
    circuit-breaker commit tracker).
    """
    story = fixture.story
    docs_chain = _is_docs_chain(story)
    merge_fn = merge_fn or _gh_pr_merge
    pr_merged_query = pr_merged_query or _pr_is_merged_on_github

    # Part 2 — dual-draft loser self-check (defense-in-depth for the reconcile
    # window). If THIS story is a dual-draft alternative and a SIBLING has
    # already shipped (deployed / deploy_pending / superseded_by_sibling / a
    # merged PR), REFUSE to merge — the winner already landed and merging this
    # loser would ship a redundant second interpretation (the dual-draft
    # over-fire). This composes with Part 1 (reconcile's proactive sibling
    # cleanup): Part 1 supersedes losers the cleanup can reach; this catches a
    # loser whose own PR reaches the merge worker in the SAME window. Runs
    # regardless of dry_run so a simulated tick reproduces the guard. Fail-safe:
    # ``_sibling_already_shipped`` swallows any query error → False, so a query
    # hiccup NEVER wrongly supersedes a legitimate story nor blocks its merge.
    if db_path is not None and story is not None:
        _sib_shipped = sibling_shipped_query or _sibling_already_shipped
        try:
            _lost = bool(_sib_shipped(story=story, db_path=db_path))
        except Exception:  # noqa: BLE001 - fail-safe: proceed normally on error
            _lost = False
        if _lost:
            return MergeAction(
                app=app,
                pr_number=fixture.pr_number,
                merged=False,
                reason="superseded: sibling already shipped",
                superseded_by_sibling=True,
            )

    # Real-run short-circuit: if the PR is ALREADY merged on GitHub, we are
    # done — record the merge and let the caller enqueue the deploy + advance
    # the story. This cheaply handles the "auto-merge completed between ticks"
    # case (the async merge that ``--auto`` requested on a prior tick has since
    # landed) AND avoids re-running the expensive staging gate every tick while
    # a merge is pending. Fail-safe: an unconfirmed state returns False, so we
    # fall through to the normal gated evaluation. Dry-run never touches GH.
    if not dry_run and fixture.pr_number > 0:
        try:
            already_merged = bool(
                pr_merged_query(
                    app_config=app_config,
                    pr_number=fixture.pr_number,
                    github_client=github_client,
                )
            )
        except Exception:  # noqa: BLE001 - fail-safe: cannot confirm → not merged
            already_merged = False
        if already_merged:
            _record_self_edit_commit_if_applicable(
                app_config=app_config,
                fixture=fixture,
                root=software_factory_root,
                merge_commit_sha_provider=merge_commit_sha_provider,
            )
            return MergeAction(
                app=app,
                pr_number=fixture.pr_number,
                merged=True,
                reason="already merged on GitHub",
            )

    # The TDD gate evaluator is only relevant for the TDD chain; for
    # docs PRs we skip it (the enforcer already vetted the diff in the
    # ``handle_docs_enforcer`` step).
    # Tracks the gate-block cap + skip below — only meaningful for a real,
    # persisted story evaluated in real-run: dry-run previews and placeholder
    # (no-PR) fixtures must behave exactly as before (existing tests pin that
    # shape), and there is no stable per-commit key to cap without a real PR.
    gate_block_tracked = (
        not dry_run
        # push_to_main has no PR; its cap is keyed per STORY (see
        # ``_gate_block_history(per_story=True)``) — without it a gate-red
        # story would re-run the whole gate set every tick forever.
        and (fixture.pr_number > 0 or push_to_main)
        and story is not None
        and story.id is not None
    )
    prior_block_count = 0
    prior_block: dict[str, Any] | None = None
    if gate_block_tracked:
        assert story is not None and story.id is not None
        prior_block_count, prior_block = _gate_block_history(
            story_id=story.id,
            head_sha=fixture.head_sha,
            root=software_factory_root,
            slug=story.slug,
            # push_to_main: cap per STORY (its worktree sha is not a stable key).
            per_story=push_to_main,
        )

    if docs_chain:
        gates_passed: list[str] = sorted(_DOCS_CHAIN_GATE_LABELS)
        gates_failed: list[dict[str, Any]] = []
        missing_labels: list[str] = []
        skipped_reevaluation = False
    elif prior_block is not None:
        # Cheap short-circuit (found 2026-08-07, measured live: PR 88 alone
        # re-evaluated 436 times — tests-green + smoke-green both re-run at
        # 600s a piece, on EVERY start-of-tick AND end-of-tick
        # ``auto_merge_tick`` call, for a verdict that cannot change without a
        # new commit). This exact head sha ALREADY has a recorded
        # required-gate block on file — reuse that verdict instead of paying
        # for tests-green/smoke-green again. A new commit produces a new
        # ``head_sha``, which never matches a stale ``prior_block`` and falls
        # straight through to a fresh evaluation below.
        skipped_reevaluation = True
        gates_passed = list(prior_block.get("gates_passed") or [])
        gates_failed = list(prior_block.get("failed") or [])
        missing_labels = list(prior_block.get("missing_labels") or [])
    else:
        pr_ctx = PRContext(
            pr_number=fixture.pr_number,
            head_sha=fixture.head_sha,
            base_branch=fixture.base_branch,
            files_changed=fixture.files_changed,
            labels=list(fixture.labels),
            ci_state=fixture.ci_state,
            repo_root=fixture.repo_root,
            software_factory_root=software_factory_root,
            story=story,
            dry_run=dry_run,
        )
        results = evaluate_all_gates(pr_ctx, app_config)
        gates_passed = [label for label, r in results.items() if r.passed]
        # Keep the FAILING results too. Every gate already computes a ``reason``
        # and ``details`` (the smoke gate's are its exit code and output tail);
        # discarding them here was the reason a blocked merge could say WHICH
        # gate failed but never WHY. Persisted on the MergeAction and logged as
        # a story event so ``factory trace <id>`` shows the diagnosis.
        gates_failed = [r.as_dict() for r in results.values() if not r.passed]
        skipped_reevaluation = False

        # Compute the labels the chain would have added on previous
        # ticks. In real-run we trust the actual PR labels; in dry-run
        # we synthesize from the gate results so a test fixture with
        # all gates green is "all labels present" without having to
        # enumerate them in the fixture.
        # A gate is satisfied by an applied PR label OR by the evaluation
        # that just ran — in real-run too. Nothing applies gate labels
        # under Loop-4 (the labelling stages died with the test-first
        # machinery), and a fresh evaluator pass is strictly stronger
        # evidence than a label applied on some earlier tick anyway.
        # ...EXCEPT for the gates in ``_RESULT_ONLY_GATE_LABELS``, which only a
        # fresh passing evaluation satisfies. A gate whose whole purpose is
        # "fail closed on the real artifact" cannot be satisfied by a label
        # somebody (or some bot) put on the PR.
        present_labels = (set(fixture.labels) - _RESULT_ONLY_GATE_LABELS) | set(gates_passed)
        missing_labels = [
            label
            for label in required_gate_labels(app_config, story)
            if label not in present_labels
        ]

    if not docs_chain:
        # ``story.id`` is None for an unpersisted fixture story; the per-story
        # event log is keyed on it, so skip the event rather than writing an
        # orphan. The MergeAction and the merge_actions row still carry the
        # diagnosis in that case.
        if gates_failed and story is not None and story.id is not None:
            from factory.chain.event_log import log_story_event

            log_story_event(
                story.id,
                "merge_gates_failed",
                {
                    "pr_number": fixture.pr_number,
                    "head_sha": fixture.head_sha,
                    "failed": gates_failed,
                    "missing_labels": missing_labels,
                    "gates_passed": gates_passed,
                    # This write is NOT suppressed in dry-run, so mark it. A
                    # preview's gate evaluation is real but its verdict is
                    # provisional (dry-run gates read recorded flags instead of
                    # shelling out), and ``factory auto-merge`` defaults to
                    # --dry-run. An unlabelled record is indistinguishable from
                    # a real merge-time failure by ``factory trace`` or by any
                    # future consumer. Suppressing it outright is the more
                    # correct "dry-run is a pure preview" behaviour but needs
                    # the real-run coverage in
                    # tests/test_auto_merge_failed_gate_diagnostics.py rebuilt
                    # against a non-dry-run tick, which is out of scope here.
                    "dry_run": dry_run,
                    "skipped_reevaluation": skipped_reevaluation,
                },
                software_factory_root=software_factory_root,
                slug_hint=story.slug,
            )

    blocking_present = sorted(set(fixture.labels) & BLOCKING_LABELS)

    # Story state guard (applies to both chains).
    if story is not None and story.state not in _MERGEABLE_STATES:
        return MergeAction(
            app=app,
            pr_number=fixture.pr_number,
            merged=False,
            reason=f"story.state={story.state} not in mergeable states",
            gates_passed=gates_passed,
            gates_failed=gates_failed,
            blocking_labels=blocking_present,
        )

    if blocking_present:
        return MergeAction(
            app=app,
            pr_number=fixture.pr_number,
            merged=False,
            reason=f"blocking labels present: {blocking_present!r}",
            gates_passed=gates_passed,
            gates_failed=gates_failed,
            blocking_labels=blocking_present,
        )

    if missing_labels:
        if gate_block_tracked:
            block_count = prior_block_count + 1
            if block_count >= _MAX_GATE_BLOCK_CYCLES:
                assert story is not None
                _park_gate_block_exhausted(
                    story=story,
                    fixture=fixture,
                    missing_labels=missing_labels,
                    block_count=block_count,
                    root=software_factory_root,
                    db_path=db_path,
                )
                return MergeAction(
                    app=app,
                    pr_number=fixture.pr_number,
                    merged=False,
                    reason=(
                        f"gate block exhausted: required gate(s) {missing_labels!r} never "
                        f"passed after {block_count} consecutive evaluations of head "
                        f"{fixture.head_sha[:12]} — parked (blocked_ci_unresolved)"
                    ),
                    gates_passed=gates_passed,
                    gates_failed=gates_failed,
                    blocking_labels=blocking_present,
                )
        return MergeAction(
            app=app,
            pr_number=fixture.pr_number,
            merged=False,
            reason=f"missing gate labels: {missing_labels!r}",
            gates_passed=gates_passed,
            gates_failed=gates_failed,
            blocking_labels=blocking_present,
        )

    # Synthesized placeholder (no real PR exists — ``pr_no = -(story.id)``
    # in the fixture-synthesis path). NEVER shell it into ``gh pr merge``:
    # a negative number parses as a flag ("unknown shorthand flag: '5' in
    # -56", observed live 2026-07-18) and the failure terminally blocked the
    # story. Record an auditable no-PR decision instead; the story needs PR
    # (re-)creation, not a merge.
    if fixture.pr_number <= 0 and not push_to_main:
        return MergeAction(
            app=app,
            pr_number=fixture.pr_number,
            merged=False,
            reason=(
                "no real PR exists for this story (placeholder number); "
                "needs PR creation via docs_enforcer/_open_pr_for_story"
            ),
            gates_passed=gates_passed,
            gates_failed=gates_failed,
            blocking_labels=blocking_present,
        )

    # Chain-side staging gate for factory self-edits. A story that modifies the
    # factory's OWN code must be validated by running a cloned factory before it
    # can land on the live factory — the same protection the manager proposal
    # path has (WS3.5). App-repo stories (sacrifice, ...) short-circuit to
    # allow=True inside the helper, so this is a no-op for them. Skipped in
    # dry-run UNLESS a gate is injected (tests): a dry-run merges nothing, so
    # there is nothing to protect, and we avoid the network/clone cost.
    if (not dry_run) or (self_edit_gate is not None):
        se_decision = _evaluate_self_edit_gate(
            app_config=app_config,
            story=story,
            pr_number=fixture.pr_number,
            root=software_factory_root,
            patch_provider=patch_provider,
            self_edit_gate=self_edit_gate,
            escalate=escalate,
        )
        if not se_decision.allow:
            return MergeAction(
                app=app,
                pr_number=fixture.pr_number,
                merged=False,
                reason=(
                    f"factory self-edit refused by chain-side staging gate "
                    f"({se_decision.status}); live factory not touched"
                ),
                gates_passed=gates_passed,
                gates_failed=gates_failed,
                blocking_labels=blocking_present,
                staging_blocked=True,
                staging_status=se_decision.status,
            )

    reason = (
        "docs chain enforcer passed; no blocking labels"
        if docs_chain
        else "all required gates passed; no blocking labels"
    )

    # Dry-run merges nothing; the decision path still returns merged=True so
    # tests exercise the record/deploy plumbing without touching GitHub.
    if dry_run:
        return MergeAction(
            app=app,
            pr_number=fixture.pr_number,
            merged=True,
            reason=reason,
            gates_passed=gates_passed,
            gates_failed=gates_failed,
            blocking_labels=blocking_present,
        )

    def _do_merge() -> MergeAction:
        if push_to_main:
            # Gates passed + no blockers, no PR: fast-forward the default branch to
            # the exact commit the gates evaluated. Never force; any doubt refuses.
            ff = fast_forward_fn or delivery_gate.fast_forward_default_branch
            ff_ok, ff_detail = ff(
                worktree=fixture.repo_root,
                base=fixture.base_branch,
                expected_sha=fixture.head_sha,
            )
            if not ff_ok:
                return MergeAction(
                    app=app,
                    pr_number=fixture.pr_number,
                    merged=False,
                    reason=f"push_to_main refused: {ff_detail}",
                    gates_passed=gates_passed,
                    gates_failed=gates_failed,
                    blocking_labels=blocking_present,
                    push_to_main_refused=True,
                )
            return MergeAction(
                app=app,
                pr_number=fixture.pr_number,
                merged=True,
                reason=f"push_to_main: fast-forwarded {fixture.base_branch} to {ff_detail[:12]}",
                gates_passed=gates_passed,
                gates_failed=gates_failed,
                blocking_labels=blocking_present,
            )

        # Gates passed + no blockers. Merge.
        merge_err = merge_fn(
            app_config=app_config,
            pr_number=fixture.pr_number,
            merge_method=merge_method,
            wait_for_ci=wait_for_ci,
            delete_branch=delete_branch_after_merge,
            github_client=github_client,
        )
        if merge_err is not None:
            return MergeAction(
                app=app,
                pr_number=fixture.pr_number,
                merged=False,
                reason=f"gh merge failed: {merge_err}",
                gates_passed=gates_passed,
                gates_failed=gates_failed,
                blocking_labels=blocking_present,
            )

        # CRITICAL: ``merged`` must reflect a REAL GitHub merge, not merely that a
        # merge was requested. With ``wait_for_ci=False`` ``gh pr merge`` (no
        # ``--auto``) merges SYNCHRONOUSLY, so success == merged. With
        # ``wait_for_ci=True`` the shell-out used ``--auto``, which only ENABLES
        # auto-merge and returns 0 immediately WITHOUT merging when required checks
        # are still pending — so we must QUERY GitHub's authoritative state and only
        # claim a merge if the PR actually merged now (e.g. checks were already
        # green so ``--auto`` merged immediately). If it is NOT merged yet, return a
        # NON-merged action flagged ``auto_merge_enabled`` so the caller leaves the
        # story in ``_MERGEABLE_STATES`` (reconcile + the CI-failure loop keep
        # watching it) instead of stranding it at ``deploy_pending``.
        if wait_for_ci:
            try:
                really_merged = bool(
                    pr_merged_query(
                        app_config=app_config,
                        pr_number=fixture.pr_number,
                        github_client=github_client,
                    )
                )
            except Exception:  # noqa: BLE001 - fail-safe: cannot confirm → not merged
                really_merged = False
            if not really_merged:
                return MergeAction(
                    app=app,
                    pr_number=fixture.pr_number,
                    merged=False,
                    reason="auto-merge enabled; awaiting required checks",
                    gates_passed=gates_passed,
                    gates_failed=gates_failed,
                    blocking_labels=blocking_present,
                    auto_merge_enabled=True,
                )

        _record_self_edit_commit_if_applicable(
            app_config=app_config,
            fixture=fixture,
            root=software_factory_root,
            merge_commit_sha_provider=merge_commit_sha_provider,
        )
        return MergeAction(
            app=app,
            pr_number=fixture.pr_number,
            merged=True,
            reason=reason,
            gates_passed=gates_passed,
            gates_failed=gates_failed,
            blocking_labels=blocking_present,
        )

    # MUST 1 (adversarial review 2026-11-02): the gates above can run for
    # minutes against the ``story`` loaded at the start of the pass. A
    # ``factory job cancel`` (another process) may have parked the row in the
    # meantime. So the irreversible part — the fast-forward / merge AND the
    # DEPLOY_PENDING write — runs under the per-story lock cancel also takes,
    # after a RE-READ of the committed state, and the state write is a
    # compare-and-set from the mergeable states. A storyless / unpersisted
    # fixture has nothing to race with and keeps the old path.
    if story is None or story.id is None or db_path is None or software_factory_root is None:
        return _do_merge()
    with delivery_gate.story_lock(software_factory_root, story.id) as held:
        if not held:
            return MergeAction(
                app=app,
                pr_number=fixture.pr_number,
                merged=False,
                reason="story lock busy (job cancel in progress?) — not merged; re-evaluated next tick",
                gates_passed=gates_passed,
                gates_failed=gates_failed,
                blocking_labels=blocking_present,
            )
        if delivery_gate.is_job_cancelled(db_path, story.app, story.direction_id):
            # N2: the durable job-cancel marker wins over whatever a stale
            # handler wrote back into the story row.
            return MergeAction(
                app=app,
                pr_number=fixture.pr_number,
                merged=False,
                reason="job was cancelled (factory job cancel) — not merged",
                gates_passed=gates_passed,
                gates_failed=gates_failed,
                blocking_labels=blocking_present,
            )
        live_state = delivery_gate.current_story_state(db_path, story.id)
        if live_state is None or live_state not in _MERGEABLE_STATES:
            return MergeAction(
                app=app,
                pr_number=fixture.pr_number,
                merged=False,
                reason=(
                    f"story state changed to {live_state!r} while gates ran "
                    "(e.g. job cancelled) — not merged"
                ),
                gates_passed=gates_passed,
                gates_failed=gates_failed,
                blocking_labels=blocking_present,
            )
        action = _do_merge()
        if action.merged:
            from factory.chain.state_machine import EVENT_MERGED, advance

            story.state = live_state
            try:
                target = advance(story, EVENT_MERGED).value
            except Exception:  # noqa: BLE001 - no edge: leave it to reconcile
                target = None
            if target is not None and delivery_gate.cas_story_state(
                db_path, story.id, _MERGEABLE_STATES, target
            ):
                story.state = target
                action.state_committed = True
        return action


#: Upper bound on one ``gh pr merge`` call (it runs under the story lock).
_GH_MERGE_TIMEOUT_S = 90


def _gh_pr_merge(
    *,
    app_config: AppConfig,
    pr_number: int,
    merge_method: str,
    wait_for_ci: bool,
    delete_branch: bool,
    github_client: Any,
) -> str | None:  # pragma: no cover - real-run path; no tests exercise gh shell-out
    """Invoke ``gh pr merge`` for the PR. Returns None on success or an
    error string on failure.

    Uses the ``gh`` CLI (rather than pygithub) so ``--auto`` is
    available — pygithub's ``pr.merge()`` cannot wait for required
    checks. The shell-out is fenced behind ``pragma: no cover`` because
    no test exercises this real-run path.
    """
    import subprocess

    method_flag = {"squash": "--squash", "merge": "--merge", "rebase": "--rebase"}.get(
        merge_method, "--squash"
    )
    cmd = ["gh", "pr", "merge", str(pr_number), "--repo", app_config.repo, method_flag]
    if wait_for_ci:
        cmd.append("--auto")
    if delete_branch:
        cmd.append("--delete-branch")
    # It runs under the per-story lock now, so it must never hang: a stuck gh
    # would hold the lock and starve ``factory job cancel`` indefinitely.
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=_GH_MERGE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return f"gh pr merge timed out after {_GH_MERGE_TIMEOUT_S}s"
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        # ``--auto`` ENABLES auto-merge, which GitHub refuses when nothing
        # blocks the merge: "clean status" (no required checks pending) or
        # "Protected branch rules not configured". The PR is immediately
        # mergeable — merge it directly instead of reporting failure
        # (PR 111, 2026-06-11; also the May-29/30 docs-chain merge errors).
        if wait_for_ci and (
            "clean status" in stderr or "Protected branch rules not configured" in stderr
        ):
            direct_cmd = [c for c in cmd if c != "--auto"]
            try:
                subprocess.run(
                    direct_cmd,
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=_GH_MERGE_TIMEOUT_S,
                )
                return None
            except subprocess.TimeoutExpired:
                return f"gh pr merge timed out after {_GH_MERGE_TIMEOUT_S}s"
            except subprocess.CalledProcessError as exc2:
                return f"gh exit={exc2.returncode}: {(exc2.stderr or '').strip()}"
        return f"gh exit={exc.returncode}: {stderr}"
    except FileNotFoundError:
        # gh not installed — fall back to pygithub if available.
        if github_client is None:
            return "gh CLI not found and no github_client provided"
        try:
            repo = github_client.get_repo(app_config.repo)
            pr = repo.get_pull(pr_number)
            pr.merge(merge_method=merge_method)
        except Exception as exc:
            return f"pygithub merge failed: {exc!r}"
    return None


def _pr_is_merged_on_github(
    *, app_config: AppConfig, pr_number: int, github_client: Any = None
) -> bool:  # pragma: no cover - real-run path; queries live GH state
    """Return True iff the PR is ACTUALLY merged on GitHub right now.

    ``gh pr merge --auto`` returns exit 0 the instant it ENABLES auto-merge —
    it does NOT wait for or perform the merge. So a successful ``_gh_pr_merge``
    is NOT evidence the PR merged; only GitHub's authoritative state is. This
    queries ``gh pr view <n> --json state,mergedAt`` and treats the PR as merged
    iff ``mergedAt`` is non-null (equivalently ``state == "MERGED"``).

    Fail-safe: ANY failure (gh missing, timeout, non-zero exit, unparseable
    payload, non-positive placeholder PR) returns ``False``. We NEVER claim a
    merge we cannot positively confirm, so a story is never advanced to
    ``deploy_pending`` on an unconfirmed merge.
    """
    import json as _json
    import subprocess

    if pr_number <= 0:
        return False
    cmd = [
        "gh",
        "pr",
        "view",
        str(pr_number),
        "--repo",
        app_config.repo,
        "--json",
        "state,mergedAt",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    if proc.returncode != 0:
        return False
    try:
        data = _json.loads(proc.stdout)
    except (ValueError, TypeError):
        return False
    if not isinstance(data, dict):
        return False
    merged_at = data.get("mergedAt")
    state = str(data.get("state", "")).upper()
    return bool(merged_at) or state == "MERGED"


def _pr_terminally_unmergeable(
    *, app_config: AppConfig, pr_number: int, github_client: Any
) -> bool:  # pragma: no cover - real-run path; queries live GH state
    """Return True when a PR can never be merged by retrying.

    A merge can fail transiently (CI still pending, ``--auto`` not yet
    enabled). But a PR that is CLOSED, already MERGED out-of-band, or
    CONFLICTING/DIRTY will fail on *every* tick — retrying it forever wedges
    the auto-merge worker and keeps drive_chain idle-spinning on a story that
    can never advance. Detect those terminal conditions so the caller can sink
    the story to a blocked state instead.
    """
    import json as _json
    import subprocess

    cmd = [
        "gh",
        "pr",
        "view",
        str(pr_number),
        "--repo",
        app_config.repo,
        "--json",
        "state,mergeable,mergeStateStatus",
    ]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
        data = _json.loads(out)
    except subprocess.CalledProcessError:
        # gh couldn't resolve the PR at all (deleted / wrong repo) — that is
        # itself terminal: retrying will never succeed.
        return True
    except (FileNotFoundError, ValueError):
        # gh missing or unparseable output — don't make a terminal call we
        # can't justify; let the normal retry path continue.
        return False
    state = str(data.get("state", "")).upper()
    mergeable = str(data.get("mergeable", "")).upper()
    merge_status = str(data.get("mergeStateStatus", "")).upper()
    return state in ("CLOSED", "MERGED") or mergeable == "CONFLICTING" or merge_status == "DIRTY"


def _query_pr_is_draft(*, app_config: AppConfig, pr_number: int) -> bool | None:
    """GitHub's draft flag for ``pr_number`` (``gh pr view --json isDraft``);
    ``None`` on any failure. A draft PR is never merged by the factory."""
    import subprocess

    if pr_number <= 0:
        return False
    cmd = [
        "gh", "pr", "view", str(pr_number), "--repo", app_config.repo,
        "--json", "isDraft", "-q", ".isDraft",
    ]  # fmt: skip
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    out = (proc.stdout or "").strip().lower()
    if out in ("true", "false"):
        return out == "true"
    return None


def _query_pr_head_sha(*, app_config: AppConfig, pr_number: int) -> str | None:
    """The REAL head commit sha for ``pr_number``, via ``gh pr view --json
    headRefOid``. ``None`` on any failure — ``gh`` missing/timeout, no such PR,
    a non-zero exit, or output that doesn't even look like a commit id.

    Found 2026-08-07: the tick path (``auto_merge_tick``'s local-fixture
    synthesis, below) never had a ``github_client``, so it always synthesized
    ``head_sha=f"local-{story.id}"`` — a string that can NEVER pass
    ``red_green.head_contains_sha``'s ``_SHA_RE`` shape check, which sends the
    (deliberately never-waivable) provenance gate into an unwaivable block on
    every single real-run story. This is the fix: resolve the real sha for a
    real PR number.  The caller must NOT fabricate a sha on failure — returning
    ``None`` here (so the caller falls back to the honest ``local-<id>``
    placeholder) keeps that failure legible as "not a commit id" rather than
    quietly forging something that merely LOOKS like one. Mirrors
    ``_query_ci_state``'s shell-out style and error handling.
    """
    import re
    import subprocess

    if pr_number <= 0:  # synthesized placeholder (no real PR) — nothing to query
        return None
    cmd = [
        "gh",
        "pr",
        "view",
        str(pr_number),
        "--repo",
        app_config.repo,
        "--json",
        "headRefOid",
        "-q",
        ".headRefOid",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    sha = (proc.stdout or "").strip()
    if not re.match(r"^[0-9a-fA-F]{7,40}$", sha):
        # An empty/malformed answer must never be handed back as if it were a
        # real commit id — the caller's placeholder fallback is the honest
        # outcome here, not this.
        return None
    return sha


def _query_pr_files_changed(*, app_config: AppConfig, pr_number: int) -> list[str] | None:
    """The REAL changed-file list for ``pr_number``, via ``gh pr view --json
    files``. ``None`` on any failure (never ``[]``): the tick path's local
    fixtures used to hardcode ``files_changed=[]``, which made two REQUIRED
    gates — ``tests-meaningful`` (``scan_diff`` iterates the file list) and
    ``canonical-paths-only`` (``scan_pr_diff`` does too) — pass VACUOUSLY
    (nothing to scan, so no finding, so green) instead of actually running.
    ``None`` here lets the caller keep the distinction between "really no
    files" and "couldn't ask GitHub" instead of collapsing both into the same
    empty list. Mirrors ``_query_ci_state``'s shell-out style and error
    handling.
    """
    import subprocess

    if pr_number <= 0:
        return None
    cmd = [
        "gh",
        "pr",
        "view",
        str(pr_number),
        "--repo",
        app_config.repo,
        "--json",
        "files",
        "-q",
        ".files[].path",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return [line.strip() for line in (proc.stdout or "").splitlines() if line.strip()]


def _query_ci_state(*, app_config: AppConfig, pr_number: int) -> str | None:
    """Query the REAL CI conclusion for a PR via the ``gh`` CLI.

    Returns ``"success"`` (every REQUIRED check passed/skipped), ``"failure"``
    (at least one required check failed/cancelled/errored), ``"hold"`` (the
    ONLY failing required check is the E6 environment guard ``main-green`` —
    see ``_CI_STATE_HOLD``), ``"pending"`` (required checks still
    queued/running), or ``None`` when there is nothing to gate on — no branch
    protection / no required checks, ``gh`` missing/timeout, a placeholder
    (non-positive) PR number, or unparseable output. ``None`` makes the
    ``tests-green`` gate fall back to the recorded dev flag, so apps without
    CI/protection (e.g. sacrifice pre-CI) are unaffected while protected repos
    gate on their real Actions run.

    This replaces the historical hardcoded ``ci_state="success"``, which let
    the gate pass on a string literal instead of a real signal (the "thinks
    CI passed then it crashes" class). Read-only; safe in dry-run.

    Implementation note: ``gh pr checks`` (v2.45) does NOT support ``--json``,
    so we parse its tab-separated rows and use ``--required`` so non-required
    integrations (e.g. CodeRabbit, which can sit PENDING forever) never poison
    the aggregate and block the factory's own merges. CRITICAL: gh prints
    "no required checks reported" and exits 0 when protection is absent —
    that must map to ``None`` (nothing to consult), never ``"success"``.
    """
    import subprocess

    if pr_number <= 0:  # synthesized placeholder (dry-run docs) — nothing to query
        return None
    cmd = [
        "gh",
        "pr",
        "checks",
        str(pr_number),
        "--repo",
        app_config.repo,
        "--required",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    combined = ((proc.stdout or "") + " " + (proc.stderr or "")).lower()
    if "no required checks" in combined or "no checks reported" in combined:
        # No protection / no required checks → nothing real to gate on.
        return None
    # Each row: "<name>\t<status>\t<elapsed>\t<url>"; name is the 1st column and
    # status the 2nd. The NAME is only load-bearing for the ``main-green``
    # environment-hold discrimination below; every other verdict reduces over
    # statuses exactly as before.
    statuses: set[str] = set()
    failing_names: list[str] = []
    name_parse_uncertain = False
    for line in (proc.stdout or "").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[1].strip():
            status = parts[1].strip().lower()
            statuses.add(status)
            if status in _CI_FAILURE_BUCKETS:
                name = parts[0].strip()
                if not name:
                    # A failing row we cannot NAME must never be discounted as
                    # an environment hold. Fail towards today's behaviour.
                    name_parse_uncertain = True
                failing_names.append(name.lower())
    if not statuses:
        return None
    if statuses & _CI_FAILURE_BUCKETS:
        # E6 STAGE 2 — ENVIRONMENT HOLD, not a PR defect. ``main-green`` is the
        # required check that reports whether MAIN's own post-merge full lane is
        # green (see .github/workflows/test.yml). When it is the ONLY red
        # required check, this PR's own code is fine and nothing about it should
        # be touched: the whole repo is held until an operator fixes main. Any
        # OTHER red required check means the PR really did fail CI, and we take
        # the historical failure path unchanged — including the case where
        # main-green is red *alongside* a real failure.
        if (
            not name_parse_uncertain
            and failing_names
            and set(failing_names) == {_MAIN_GREEN_CHECK_NAME}
        ):
            return _CI_STATE_HOLD
        return "failure"
    if statuses & {"pending", "in_progress", "queued", "waiting"}:
        return "pending"
    # Remaining rows are all pass/skipping/neutral → required set is green.
    return "success"


# GitHub check-run CONCLUSION values (from ``statusCheckRollup``) that mean a
# genuine test/build DEFECT vs. an INFRA-transient red that clears on its own.
# ``gh pr checks`` (the merge gate's ``_query_ci_state``) BUCKETS timed-out /
# errored runs into the token ``"fail"`` — indistinguishable from a real failure
# — so it CANNOT be used to gate the auto-close. The GraphQL ``statusCheckRollup``
# exposes the real conclusion (``TIMED_OUT`` / ``CANCELLED`` / ``FAILURE`` / …),
# which is what lets us avoid destroying a PR over a transient.
_GENUINE_FAILURE_CONCLUSIONS = {"FAILURE"}  # CheckRun.conclusion / StatusContext.state
_INFRA_FAILURE_CONCLUSIONS = {
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STALE",
    "STARTUP_FAILURE",
    "ERROR",  # StatusContext.state for setup/integration errors
}


def _ci_failure_is_genuine(*, app_config: AppConfig, pr_number: int) -> bool:
    """True iff at least one REQUIRED check reports a genuine ``FAILURE``.

    Two-source join, because neither ``gh`` command alone is sufficient:
      * ``gh pr checks --required`` lists WHICH checks are required (the same
        set the merge gate's ``_query_ci_state`` consults), but its short buckets
        collapse ``TIMED_OUT``/``ERROR`` into ``"fail"`` — it cannot tell a real
        failure from a transient.
      * ``gh pr view --json statusCheckRollup`` exposes the REAL conclusion
        (``FAILURE`` vs ``TIMED_OUT``/``CANCELLED``/…) but does NOT mark which
        checks are required (``isRequired`` is a parameterized field gh only
        populates for ``pr checks``).
    Genuine ⇔ some check that is REQUIRED (from source 1) has a real ``FAILURE``
    conclusion (from source 2). This is scoped to required checks so a
    non-required optional check's ``FAILURE`` — which never blocks merge — can't
    trigger an auto-close of a PR whose only required-check red was a transient
    timeout. A red made only of infra-transient required conclusions returns
    ``False`` → the caller does NOT close the PR.

    FAIL-SAFE: gh missing/timeout, non-zero exit, placeholder PR, no required
    checks, unparseable output, or a name mismatch between the two sources all
    return ``False``. Read-only.

    Residual (documented): a required job KILLED by OOM or a hang is reported by
    GitHub as conclusion ``FAILURE`` (indistinguishable from a real test failure
    at the API level) → treated as genuine. Rare, usually the PR's own fault, and
    recoverable (the close comment tells a human to re-open if it was spurious).
    """
    import json as _json
    import subprocess

    if pr_number <= 0:
        return False
    # Source 1: names of the REQUIRED checks (pr checks --required lists only them).
    try:
        chk = subprocess.run(
            ["gh", "pr", "checks", str(pr_number), "--repo", app_config.repo, "--required"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    combined = ((chk.stdout or "") + " " + (chk.stderr or "")).lower()
    if "no required checks" in combined or "no checks reported" in combined:
        return False
    required_names = {
        parts[0].strip()
        for parts in (line.split("\t") for line in (chk.stdout or "").splitlines())
        if parts and parts[0].strip()
    }
    if not required_names:
        return False
    # Source 2: real conclusions keyed by check name.
    try:
        view = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                str(pr_number),
                "--repo",
                app_config.repo,
                "--json",
                "statusCheckRollup",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    if view.returncode != 0:
        return False
    try:
        rollup = (_json.loads(view.stdout or "{}") or {}).get("statusCheckRollup") or []
    except (ValueError, AttributeError):
        return False
    # Group real conclusions by check name. A single name can map to MULTIPLE
    # rollup entries (a required check and a non-required check sharing a name, or
    # a re-run) and ``statusCheckRollup`` does NOT mark which entry is required, so
    # name alone cannot tell them apart.
    verdicts_by_name: dict[str, list[str]] = {}
    for check in rollup:
        if not isinstance(check, dict):
            continue
        name = (check.get("name") or check.get("context") or "").strip()
        if name not in required_names:
            continue  # non-required check failing never blocks merge
        # CheckRun uses ``conclusion``; legacy StatusContext uses ``state``.
        verdict = (check.get("conclusion") or check.get("state") or "").upper()
        verdicts_by_name.setdefault(name, []).append(verdict)
    # Genuine ⇔ some REQUIRED name's entries ALL agree on a real FAILURE. A name
    # with MIXED conclusions (e.g. a required TIMED_OUT colliding with a non-
    # required same-named FAILURE) is AMBIGUOUS → NOT genuine: safe under-close, so
    # the CI-recovery wheel keeps turning instead of destroying a PR over a
    # transient red. A single unambiguous FAILURE, or duplicate entries that all
    # agree on FAILURE, stays genuine.
    for verdicts in verdicts_by_name.values():
        if verdicts and all(v in _GENUINE_FAILURE_CONCLUSIONS for v in verdicts):
            return True
    return False


def _pr_state(pr_number: int, repo: str) -> str | None:
    """Return the PR's OPEN/CLOSED/MERGED state (upper-cased), or None on any
    query problem. Read-only."""
    import subprocess

    try:
        proc = subprocess.run(
            ["gh", "pr", "view", str(pr_number), "--repo", repo, "--json", "state", "-q", ".state"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip().upper() or None


def _close_pr_and_confirm(pr_number: int, repo: str, *, comment: str) -> bool:
    """Close an OPEN PR and CONFIRM it closed. Returns True iff the PR is closed
    (and it is safe to park the story terminally).

    State-first, so it fixes three sharp edges:
      * ``MERGED`` (out-of-band merge between fixture-build and now) → return
        ``False`` so the caller does NOT park to a non-deploy terminal; the next
        ``reconcile_from_github`` records the merge and enqueues the deploy.
      * already ``CLOSED`` → return ``True`` without re-commenting/re-closing.
      * ``OPEN`` → ``gh pr close``, re-verify, and post the explanatory comment
        ONLY after the close is confirmed — so a persistent can-comment-but-
        cannot-close PR never accrues one comment per tick.
    ``check=True`` on the close makes a non-zero exit raise → treated as
    not-closed. FAIL-SAFE: any query/close problem returns ``False``.
    """
    import subprocess

    state = _pr_state(pr_number, repo)
    if state == "MERGED":
        return False  # let reconcile record merge -> deploy; never park a merge
    if state == "CLOSED":
        return True  # already closed; safe to park, no duplicate comment/close
    if state != "OPEN":
        return False  # unknown / unqueryable -> fail-safe
    try:
        subprocess.run(
            ["gh", "pr", "close", str(pr_number), "--repo", repo],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return False
    if _pr_state(pr_number, repo) != "CLOSED":
        return False  # close didn't take -> retry next tick, NO comment (no spam)
    try:
        subprocess.run(
            ["gh", "pr", "comment", str(pr_number), "--repo", repo, "--body", comment],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass  # comment is best-effort; the close (the important part) succeeded
    return True


def _ci_failure_signature(log_text: str) -> str:
    """Signature of a real-CI failure digest.

    Normalized the SAME way ``orchestrator._story_failure_signature``
    normalizes dev/review failure text (timestamps/paths/durations/addresses
    stripped) — reusing that normalization (rather than maintaining a second
    copy of the regex list) is what lets ``_handle_ci_failure`` tell "the dev
    fixed something and CI failed for a NEW reason" apart from "CI failed for
    the exact same reason again", the same distinction
    ``_recover_blocked_stories`` makes for blocked-state recoveries.

    Returns ``""`` when there is no log text (e.g. the best-effort log fetch
    came back empty) — an empty signature never matches a prior one, so a
    missing-evidence case never falsely looks like "no new signal".
    """
    from factory.chain.orchestrator import _normalize_failure_text

    text = (log_text or "").strip()
    if not text:
        return ""
    normalized = _normalize_failure_text(text)
    return hashlib.sha256(normalized[-500:].encode("utf-8")).hexdigest()


def _fetch_ci_failure_logs(*, app_config: AppConfig, pr_number: int) -> str:
    """Best-effort fetch of the failing CI run's log digest for ``pr_number``.

    Finds the PR's most recent failed Actions run via ``gh pr view --json
    headRefName,statusCheckRollup`` — preferring a failed check's
    ``detailsUrl`` (points straight at its run) and falling back to ``gh run
    list --branch <headRefName>`` when no ``detailsUrl`` resolves to a run id
    — then pulls the failing job's log lines via ``gh run view --log-failed``.

    Returns the last ~4000 chars of the digest, or ``""`` on ANY error,
    timeout, or empty result. This feeds a dev prompt, not a merge gate — a
    fetch failure must never crash the auto-merge tick.
    """
    import re as _re
    import subprocess

    if pr_number <= 0:  # synthesized placeholder — nothing real to look up
        return ""
    try:
        view = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                str(pr_number),
                "--repo",
                app_config.repo,
                "--json",
                "headRefName,statusCheckRollup",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    if view.returncode != 0:
        return ""
    try:
        data = json.loads(view.stdout or "{}")
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""

    head_ref = str(data.get("headRefName") or "")
    run_id: str | None = None
    rollup = data.get("statusCheckRollup") or []
    if isinstance(rollup, list):
        for check in rollup:
            if not isinstance(check, dict):
                continue
            conclusion = str(check.get("conclusion") or "").upper()
            if conclusion in {"FAILURE", "CANCELLED", "TIMED_OUT", "ERROR"}:
                url = str(check.get("detailsUrl") or "")
                m = _re.search(r"/actions/runs/(\d+)", url)
                if m:
                    run_id = m.group(1)
                    break

    if run_id is None and head_ref:
        try:
            listed = subprocess.run(
                [
                    "gh",
                    "run",
                    "list",
                    "--repo",
                    app_config.repo,
                    "--branch",
                    head_ref,
                    "--limit",
                    "5",
                    "--json",
                    "databaseId,conclusion,status",
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return ""
        if listed.returncode == 0:
            try:
                runs = json.loads(listed.stdout or "[]")
            except ValueError:
                runs = []
            if isinstance(runs, list):
                for run in runs:
                    if (
                        isinstance(run, dict)
                        and str(run.get("conclusion") or "").lower() == "failure"
                    ):
                        run_id = str(run.get("databaseId"))
                        break

    if not run_id:
        return ""

    try:
        log_proc = subprocess.run(
            ["gh", "run", "view", run_id, "--repo", app_config.repo, "--log-failed"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    digest = (log_proc.stdout or "").strip() or (log_proc.stderr or "").strip()
    if not digest:
        return ""
    return digest[-4000:]


#: A hold longer than this surfaces the story in ``factory inbox`` via
#: ``last_rejection_reason`` (ACTIVATION CHECKLIST item (a)). Long enough that
#: an ordinary "operator merges the fix to main" cycle never trips it; short
#: enough that an unattended run cannot starve silently for hours.
_HOLD_SURFACE_AFTER_SECONDS = 30 * 60

#: Marker prefix for the (a) escalation — the dedupe key for "already
#: surfaced", and what an operator greps for. Never a park: state is untouched.
_HOLD_REASON_PREFIX = "ci_hold_main_red:"

#: Events that mean "this story is already inside a hold episode". The rerun
#: trigger (item (b)) writes its own event, so episode detection must accept
#: either — keying on ``ci_hold_main_red`` alone would make every rerun attempt
#: look like a fresh episode and re-emit the transition event each tick.
_HOLD_EPISODE_EVENTS = frozenset({"ci_hold_main_red", "ci_hold_rerun"})

#: One-shot bookkeeping events that may land in a held story's stream WITHOUT
#: ending the episode. ``delivery_gate.story_level`` records a legacy row's
#: level on first touch (``delivery_level_resolved``) at the top of every
#: auto-merge pass — before the hold check — so "the last event" stopped being
#: a sound episode boundary the moment delivery levels shipped (compose bug,
#: caught by ``test_pending_inside_a_hold_episode_is_not_evaluated``). The
#: episode readers skip these instead of treating them as the boundary.
_HOLD_TRANSPARENT_EVENTS = frozenset({"delivery_level_resolved", "delivery_level_lowered"})


def _hold_stream(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """``events`` minus ``_HOLD_TRANSPARENT_EVENTS`` — the stream the hold-episode
    boundary is defined over."""
    return [e for e in events if e.get("event") not in _HOLD_TRANSPARENT_EVENTS]


#: Absolute per-episode ceiling on (b)'s rerun attempts. One rerun per new
#: main commit is the dedupe; this is the backstop against a long red-main
#: incident with frequent commits turning into unbounded Actions load — the
#: same cost class ``_MAX_GATE_BLOCK_CYCLES`` bounds. By attempt 3 the (a)
#: escalation has long since surfaced the story to the operator.
_MAX_HOLD_RERUNS = 3


def _parse_event_ts(ts: object) -> float | None:
    """Epoch seconds from an event-log ``ts`` (ISO-8601 string), or None.

    ``log_story_event`` writes ``datetime.now(UTC).isoformat()`` — a STRING.
    Treating it as a float would make every episode age unparseable and the
    (a) escalation silently never fire (`detect-without-remediate`). A naive
    string is assumed UTC (``stalled_stories._parse_ts`` precedent): letting
    ``timestamp()`` read it as LOCAL time would, west of UTC, put every event
    hours in the future and silently starve the escalation the other way."""
    if isinstance(ts, int | float):
        return float(ts)
    if isinstance(ts, str):
        try:
            dt = datetime.fromisoformat(ts)
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.timestamp()
    return None


def _in_hold_episode(story: StoryRecord | None, root: Path) -> bool:
    """True when the story's most recent event is a hold-episode event.

    Used to keep the (b) rerun's in-flight window INSIDE the hold: a re-run
    check reports ``pending``, and an unintercepted pending evaluation would
    run the full gate set against a possibly-still-red main and write a
    ``merge_gates_failed`` event — both the sink the hold exists to prevent
    and a break of the episode boundary the (a) clock depends on.
    """
    from factory.chain.event_log import read_story_events

    if story is None or story.id is None:
        return False
    try:
        events = _hold_stream(
            read_story_events(story.id, software_factory_root=root, slug_hint=story.slug)
        )
    except Exception:  # noqa: BLE001 - unknowable stream = not provably in a hold
        return False
    return bool(events) and events[-1].get("event") in _HOLD_EPISODE_EVENTS


def _set_hold_reason(
    story: StoryRecord, db_path: Path | None, reason: str | None, error: str | None = None
) -> None:
    """Column-scoped write of the (a) escalation — deliberately NOT
    ``persist_story``, which stamps ``updated_at`` and would push the
    independent ``stalled_stories`` 120-min alarm out by 30 min per episode
    (the exact move ``orchestrator._bump_dependency_defer_count``'s comment
    forbids: "stamping updated_at here would hide this very stall from the
    stalled-story detector"). Passing ``reason=None`` clears a stale hold
    reason once the hold has genuinely ended. Best-effort."""
    if db_path is None or story.id is None:
        return
    try:
        eng = _engine(db_path)
        with Session(eng) as session:
            row = session.get(StoryRecord, story.id)
            if row is None:
                return
            if reason is None:
                # Clearing: remove only OUR text — never wipe an unrelated
                # reason or error another mechanism wrote.
                if (row.last_rejection_reason or "").startswith(_HOLD_REASON_PREFIX):
                    row.last_rejection_reason = None
                if (row.error or "").startswith(_HOLD_REASON_PREFIX):
                    row.error = None
            else:
                row.last_rejection_reason = reason
                row.error = error or reason
            new_reason, new_error = row.last_rejection_reason, row.error
            session.add(row)
            session.commit()
        story.last_rejection_reason = new_reason
        story.error = new_error
    except Exception:  # noqa: BLE001 - surfacing is advisory, the hold is not
        pass


def _main_head_sha(*, app_config: AppConfig, base_branch: str) -> str | None:
    """The base branch's current HEAD sha via ``gh``, or None (best-effort)."""
    import subprocess

    try:
        proc = subprocess.run(
            [
                "gh",
                "api",
                f"repos/{app_config.repo}/branches/{base_branch}",
                "--jq",
                ".commit.sha",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    sha = (proc.stdout or "").strip()
    return sha if proc.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", sha) else None


def _rerun_failed_main_green(*, app_config: AppConfig, pr_number: int) -> tuple[bool, str]:
    """Re-run the failed workflow run behind this PR's red ``main-green`` check.

    GitHub freezes ``pull_request`` check verdicts at the head sha: when main
    goes green again, a held PR's red ``main-green`` NEVER re-evaluates on its
    own (ACTIVATION CHECKLIST item (b) — the starvation this closes). The run
    id comes from the failing row's details URL in ``gh pr checks``; the rerun
    is ``gh run rerun <id> --failed``, which re-executes only the failed jobs.

    Returns ``(ok, detail)``. Best-effort: a False simply leaves the hold in
    place — the (a) escalation and the operator runbook remain the backstop.
    """
    import subprocess

    try:
        proc = subprocess.run(
            ["gh", "pr", "checks", str(pr_number), "--repo", app_config.repo, "--required"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return False, f"gh pr checks unavailable: {exc!r}"
    run_id: str | None = None
    for line in (proc.stdout or "").splitlines():
        parts = line.split("\t")
        if len(parts) >= 4 and parts[0].strip().lower() == _MAIN_GREEN_CHECK_NAME:
            # The row must STILL be failing: this re-query runs later than the
            # fixture's ci_state read, and re-running a run whose main-green
            # already recovered (or is in flight) would burn the sha's single
            # recovery attempt on a no-op.
            if parts[1].strip().lower() not in _CI_FAILURE_BUCKETS:
                return False, (
                    f"main-green row is no longer failing "
                    f"(now {parts[1].strip()!r}) — nothing to re-run"
                )
            m = re.search(r"/actions/runs/(\d+)", parts[3])
            if m:
                run_id = m.group(1)
            break
    if run_id is None:
        return False, "could not resolve the main-green run id from gh pr checks"
    try:
        rerun = subprocess.run(
            ["gh", "run", "rerun", run_id, "--failed", "--repo", app_config.repo],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return False, f"gh run rerun unavailable: {exc!r}"
    if rerun.returncode != 0:
        return (
            False,
            f"gh run rerun {run_id} exited {rerun.returncode}: {(rerun.stderr or '')[:200]}",
        )
    return True, f"re-ran failed jobs of run {run_id}"


def _handle_main_green_hold(
    *,
    story: StoryRecord | None,
    pr_number: int,
    root: Path,
    app_config: AppConfig | None = None,
    base_branch: str = "main",
    db_path: Path | None = None,
) -> bool:
    """Record that this PR is held because MAIN is red — and (almost) nothing else.

    Returns True iff this call is the TRANSITION into a hold episode (i.e. it
    just emitted the event). The caller uses that to decide whether to persist a
    ``merge_actions`` row too — see below.

    The point of the hold (see ``_CI_STATE_HOLD``) is that the story is NOT
    acted on: no dev run is dispatched, no PR is closed, no state transition.
    Beyond the transition event, exactly two bounded side effects exist — the
    two ACTIVATION CHECKLIST items that used to block making ``main-green`` a
    required check:

    * **(a) BOUNDED SURFACING.** A hold episode older than
      ``_HOLD_SURFACE_AFTER_SECONDS`` sets ``last_rejection_reason`` (prefix
      ``_HOLD_REASON_PREFIX``, written once per episode — the prefix is the
      dedupe) so the story appears in ``factory inbox``'s needs-human list.
      State stays ``pr_open``; nothing parks, nothing closes. The write is
      column-scoped (:func:`_set_hold_reason`), NOT ``persist_story`` — a
      ``updated_at`` stamp would hide the hold from the independent
      ``stalled_stories`` detector. The tick loop clears the text (prefix-
      guarded) as soon as the PR's checks resolve to success or failure, so
      a merged story never carries a stale "main is red" into deploy states.
    * **(b) RECOVERY TRIGGER.** GitHub freezes ``pull_request`` verdicts at
      the head sha, so a hold never self-clears when main goes green. When the
      base branch's HEAD has MOVED since the episode's last recorded sha, the
      failed ``main-green`` run is re-run once (``_rerun_failed_main_green``)
      and a ``ci_hold_rerun`` event records the new sha — at most ONE rerun
      attempt per new main commit, so a rerun that fails (or a still-red main)
      cannot hammer Actions every tick. While the rerun is in flight the PR's
      ci_state is ``pending``, which never enters this branch at all.

    DEDUPE — "emit on transition into the hold". Ticks run every minute and a
    red main can last hours; one event per tick per PR would bury the story's
    real history. We emit only when the story's most recent event is not
    already a hold-episode event (``_HOLD_EPISODE_EVENTS``), so a hold episode
    costs exactly one transition event and a hold that clears and returns is
    legible as two. Nothing else writes to a held story's stream except the
    one-shot ``_HOLD_TRANSPARENT_EVENTS``, which the boundary skips, so "last
    event" is a sound episode boundary.

    The SAME transition test gates the ``merge_actions`` row (adversarial
    review, 2026-08-09). A held PR is re-evaluated every tick and a per-tick row
    is 1,440 rows/PR/day on a 60 s timer — the exact unbounded-row pathology
    ``_MAX_GATE_BLOCK_CYCLES`` was introduced for after PR 88 accumulated 436
    identical evaluations. One row per hold EPISODE says everything a repeated
    row would.

    NO STORY, NO ROW: a PR with no ``StoryRecord`` has no event stream, so there
    is no substrate to detect a transition against. We return False rather than
    write a row every tick — an unbounded audit trail is worse than a missing
    one, and a storyless PR is not part of the story queue a hold is explaining
    anyway. (It is still held: the short-circuit is unconditional.)

    Best-effort throughout: an unwritable event log must never turn a hold into
    an action, so any failure returns False (hold, but record nothing).
    """
    from factory.chain.event_log import log_story_event, read_story_events

    if story is None or story.id is None:
        return False
    try:
        events = _hold_stream(
            read_story_events(story.id, software_factory_root=root, slug_hint=story.slug)
        )
        if events and events[-1].get("event") in _HOLD_EPISODE_EVENTS:
            _continue_hold_episode(
                story=story,
                pr_number=pr_number,
                root=root,
                events=events,
                app_config=app_config,
                base_branch=base_branch,
                db_path=db_path,
            )
            return False
        log_story_event(
            story.id,
            "ci_hold_main_red",
            {
                "pr_number": pr_number,
                "required_check": _MAIN_GREEN_CHECK_NAME,
                "main_sha": (
                    _main_head_sha(app_config=app_config, base_branch=base_branch)
                    if app_config is not None
                    else None
                ),
                "detail": (
                    f"main's post-merge full lane is red, so this PR's required "
                    f"`{_MAIN_GREEN_CHECK_NAME}` check is failing. This is an "
                    "ENVIRONMENT hold, not a defect in this PR: the story is left "
                    "exactly where it is and re-checked next tick. An operator must "
                    "make main green; when main's HEAD moves, the factory re-runs "
                    "this PR's failed main-green check once per new main commit "
                    "(ci_hold_rerun)."
                ),
            },
            software_factory_root=root,
            slug_hint=story.slug,
        )
        return True
    except Exception:  # noqa: BLE001 - a hold must never fail louder than it holds
        return False


def _continue_hold_episode(
    *,
    story: StoryRecord,
    pr_number: int,
    root: Path,
    events: list[dict[str, Any]],
    app_config: AppConfig | None,
    base_branch: str,
    db_path: Path | None,
) -> None:
    """The two bounded side effects of an ONGOING hold episode — see
    :func:`_handle_main_green_hold` items (a) and (b). Best-effort: any
    failure leaves the hold exactly as it was."""
    import time as _time

    from factory.chain.event_log import log_story_event

    # Episode facts, from the stream: start = the most recent transition
    # event; last recorded main sha = the newest episode event carrying one;
    # rerun attempts spent so far this episode.
    started_at: float | None = None
    last_main_sha: str | None = None
    episode_reruns = 0
    for e in reversed(events):
        name = e.get("event")
        if name not in _HOLD_EPISODE_EVENTS:
            break
        if name == "ci_hold_rerun":
            episode_reruns += 1
        if last_main_sha is None and e.get("main_sha"):
            last_main_sha = str(e["main_sha"])
        if name == "ci_hold_main_red":
            started_at = _parse_event_ts(e.get("ts"))
            break

    # (a) surface a long hold in the inbox — once per episode, never a park.
    if (
        started_at is not None
        and (_time.time() - started_at) > _HOLD_SURFACE_AFTER_SECONDS
        and not (story.last_rejection_reason or "").startswith(_HOLD_REASON_PREFIX)
    ):
        held_since = datetime.fromtimestamp(started_at, tz=UTC).isoformat(timespec="minutes")
        _set_hold_reason(
            story,
            db_path,
            f"{_HOLD_REASON_PREFIX} PR #{pr_number} held since {held_since} "
            "because main's post-merge full lane is red. Not a PR defect and "
            "not parked. Fix main — the factory re-runs the held check when "
            "main's HEAD moves. Do NOT `factory resume-story` for this: a "
            "resume clears this notice and restarts the hold's clock without "
            "fixing anything.",
        )

    # (b) main moved -> re-run the frozen main-green check, once per new sha,
    # never more than _MAX_HOLD_RERUNS times per episode.
    if app_config is None or episode_reruns >= _MAX_HOLD_RERUNS:
        return
    current = _main_head_sha(app_config=app_config, base_branch=base_branch)
    if current is None or current == last_main_sha:
        return
    ok, detail = _rerun_failed_main_green(app_config=app_config, pr_number=pr_number)
    try:
        log_story_event(
            story.id,
            "ci_hold_rerun",
            {
                "pr_number": pr_number,
                "main_sha": current,
                "rerun_ok": ok,
                "detail": detail,
            },
            software_factory_root=root,
            slug_hint=story.slug,
        )
    except Exception:  # noqa: BLE001 - the rerun already happened; telemetry only
        pass


def _redispatch_ci_fix(
    *,
    story: StoryRecord,
    pr_number: int,
    logs: str,
    signature: str,
    attempt: int,
    db: Path,
    root: Path,
    extra: dict[str, Any] | None = None,
) -> None:
    """Send a red CI run back to dev: the failing log becomes a reviewer-style
    finding, the story re-enters at ``REVIEWER_REQUESTED_CHANGES`` and a
    ``ci_fix_redispatch`` event (the cap counter) is logged.

    Shared by the auto-merge CI loop (``_handle_ci_failure``) and the
    ``draft_pr`` / ``pr`` CI watch (``_watch_ci_then_deliver``) so both feed the
    dev the SAME finding shape and count against the SAME
    ``_MAX_CI_FIX_CYCLES``. The dev's fix reaches the PR via
    ``handlers._push_fix_to_existing_pr`` when the story comes back round
    through ``handle_docs_enforcer``.
    """
    from factory.chain.event_log import log_story_event
    from factory.chain.handlers import persist_story

    digest = logs.strip() or (
        "(no CI log digest could be fetched; inspect the GitHub Actions run "
        f"for PR #{pr_number} directly)"
    )
    # Emit a well-formed finding DICT (not a bare string): every downstream
    # consumer — runner._build_initial_message, _findings_signature,
    # _append_reviewer_history, _render_reviewer_history_section — indexes
    # findings with ``f.get(...)``. A string element crashed the dev
    # re-dispatch ("'str' object has no attribute 'get'"), silently breaking
    # this entire CI-failure feedback loop.
    finding = {
        "severity": "high",
        "criterion": "ci",
        "location": f"GitHub Actions CI (PR #{pr_number})",
        "what": (
            f"Real GitHub Actions CI failed on PR #{pr_number}. Fix the exact "
            f"failure it reported below — do not just re-run or ignore it:\n\n{digest}"
        ),
    }
    reviewer_payload = {
        "findings": [finding],
        "source": "ci_failure",
        "summary": "Real GitHub Actions CI failed; fix the exact failure it reported.",
    }

    # Re-entry point: REVIEWER_REQUESTED_CHANGES (not DEV_IN_PROGRESS) is the
    # correct target — ``DEV_IN_PROGRESS`` has no entry in the orchestrator's
    # per-state dispatch table (it's the transient "handler is actively
    # running" state that ``handle_dev`` itself transitions into and out of
    # within a single invocation; see ``orchestrator._DISPATCH``). Setting
    # the state directly to DEV_IN_PROGRESS would strand the story with no
    # handler ever picking it up again. REVIEWER_REQUESTED_CHANGES dispatches
    # to "dev" on the next tick AND is the exact existing path that feeds
    # ``story.reviewer_result_json`` into ``handle_dev``'s reviewer_findings
    # (see ``handlers._handle_dev_once``) — precisely the plumbing this
    # re-dispatch needs to reuse.
    story.reviewer_result_json = json.dumps(reviewer_payload)
    story.state = StoryState.REVIEWER_REQUESTED_CHANGES.value
    # Reset BOTH counters (mirror _recover_blocked_stories). A CI-fix redispatch
    # hits an already-approved story whose reviewer_cycles may be near
    # _MAX_REVIEW_CYCLES; without resetting it, the follow-up review pass could
    # trip BLOCKED_REVIEW_NONCONVERGENT on the first non-approving pass and
    # mislabel a CI-only hiccup as review non-convergence.
    story.dev_retries = 0
    story.reviewer_cycles = 0
    persist_story(story, db)

    try:
        log_story_event(
            story.id,
            "ci_fix_redispatch",
            {
                "pr_number": pr_number,
                "attempt": attempt,
                "cap": _MAX_CI_FIX_CYCLES,
                "failure_signature": signature,
                **(extra or {}),
            },
            software_factory_root=root,
            slug_hint=story.slug,
        )
    except Exception:  # noqa: BLE001
        pass


def _handle_ci_failure(
    *,
    story: StoryRecord,
    app_config: AppConfig,
    pr_number: int,
    db: Path,
    root: Path,
    close_pr_fn: Any = None,
) -> str:
    """Feed a real CI failure back to dev instead of just skipping the merge.

    This closes the loop the operator asked for: "run the real CI, check the
    output, and if it craps out, fix what crapped out, then move on." Before
    this, ``_query_ci_state`` returning ``"failure"`` only made the merge
    gate decline to merge — nothing told the dev WHAT failed.

    Called when a mergeable-state story's real ``ci_state`` is ``"failure"``.
    Returns one of:

      * ``"redispatched"`` — the story was fed back to dev for a fix; the caller
        should skip merging it this tick.
      * ``"parked"`` — CI-recovery is EXHAUSTED (``_MAX_CI_FIX_CYCLES`` reached,
        or the dev's last fix reproduced the identical failure signature). The
        failure is app-blocked beyond what the isolated dev sandbox can fix, so
        the PR is CLOSED (with an explanatory comment) and the story is parked in
        the terminal ``BLOCKED_CI_UNRESOLVED`` sink — it stops being re-evaluated
        every tick (killing the hamster-wheel) and reaches a clean closed state.
        Because the PR is closed, nothing is left for ``reconcile_from_github`` to
        record, which is why this is safe where the earlier open-PR park (#95) was
        not. The caller should skip merging it this tick.
      * ``"left"`` — the story was left untouched (defensive: not in a mergeable
        state); the caller proceeds to the normal gate evaluation.

    ``close_pr_fn`` is an injection seam for tests (defaults to
    ``_close_pr_and_confirm``); it MUST return truthy iff the PR close is
    confirmed. It is only invoked on the give-up path, only for a real (positive)
    PR number, and only after the failure is confirmed genuine (not infra).

    Bounded two ways so this can never become a new infinite loop, mirroring
    ``orchestrator._recover_blocked_stories``:

      * a hard cap (``_MAX_CI_FIX_CYCLES``) on prior ``ci_fix_redispatch``
        events for THIS story, counted only SINCE the most recent
        ``story_resumed`` (the ``_gate_block_history`` precedent);
      * a signature guard — if the current CI failure digest hashes
        identically to the one recorded at the story's most recent
        ``ci_fix_redispatch``, the dev's last attempt didn't actually fix it,
        so we stop instead of burning another dev cycle on the same dead end.

    Either bound trips a deduped ``ci_fix_exhausted`` event (an operator/FMS
    signal) and returns ``False``. Otherwise it re-dispatches the story back
    to dev via the EXISTING reviewer-findings plumbing (``handle_dev`` already
    reads ``story.reviewer_result_json`` into a findings list and feeds it to
    the sandbox — see ``handlers._handle_dev_once``) and returns ``True``.
    """
    from factory.chain.event_log import log_story_event, read_story_events

    if story.state not in _MERGEABLE_STATES:
        # Defensive: callers already guard on this, but never re-dispatch a
        # story that isn't actually sitting in a mergeable state.
        return "left"

    events = read_story_events(story.id, software_factory_root=root, slug_hint=story.slug)
    # OPERATOR RESUME (2026-08-09): scope the CI-fix window to events logged
    # AFTER the most recent ``story_resumed``, exactly the way
    # ``_gate_block_history`` already does it (see its OPERATOR RESUME note —
    # same precedent, same derivation from the event stream, no counter column).
    # Without this, ``factory resume-story`` could not undo a CI park: the
    # redispatch count was read over ALL history, so a resumed story hit
    # ``cap_reached``/``identical_failure_signature`` on its very first
    # evaluation and re-parked before the fixed environment ever got a turn.
    # That is exactly the shape a red main produces — the redispatches were
    # never the story's fault, and the resume is the operator saying so.
    _resume_idx = -1
    for _i, _e in enumerate(events):
        if _e.get("event") == "story_resumed":
            _resume_idx = _i
    scoped_events = events[_resume_idx + 1 :]
    prior_redispatches = [e for e in scoped_events if e.get("event") == "ci_fix_redispatch"]
    already_escalated = any(e.get("event") == "ci_fix_exhausted" for e in scoped_events)

    def _escalate(reason: str) -> None:
        if already_escalated:
            return
        try:
            log_story_event(
                story.id,
                "ci_fix_exhausted",
                {
                    "pr_number": pr_number,
                    "redispatches": len(prior_redispatches),
                    "cap": _MAX_CI_FIX_CYCLES,
                    "reason": reason,
                },
                software_factory_root=root,
                slug_hint=story.slug,
            )
        except Exception:  # noqa: BLE001
            pass

    def _park(reason: str) -> str:
        """CI-recovery gave up: try to close the PR + park the story terminally.

        FAIL-SAFE — parks (returns ``"parked"``) ONLY when BOTH hold for a real
        (positive) PR:
          1. the red is a GENUINE test/build failure, not an infra-transient
             (``cancelled``/``timed_out``/``error``) that clears on its own
             (``_query_ci_state`` collapses both into ``"failure"``); AND
          2. the PR close is CONFIRMED (a follow-up query reports it closed).
        If EITHER is not established, we do NOT park — we return ``"left"`` so the
        caller falls through to the normal gate (leaving the story mergeable) and
        the next tick retries. Rationale: a persistent hamster-wheel is strictly
        safer than (a) destroying a PR over a transient infra red, or (b) parking
        a story to a non-reconcilable terminal while its PR is still open on
        GitHub — the exact #95 strand (a later human-merge / flaky-green would
        never be recorded). ``ci_fix_exhausted`` was already logged by the caller,
        so a retry does not re-escalate.

        ``close_pr_fn`` (test seam) MUST return truthy iff the close is confirmed;
        the default verifies via ``_close_pr_and_confirm``.
        """
        from factory.chain.handlers import persist_story as _persist

        if pr_number > 0:
            if not _ci_failure_is_genuine(app_config=app_config, pr_number=pr_number):
                # Infra/transient red only (timeout/cancel/error) — not a real
                # defect. Do not close; let it clear / retry.
                return "left"
            comment = (
                "Auto-closing: the factory's CI-recovery loop is exhausted for this "
                f"PR (reason: {reason}). The failing checks could not be resolved by "
                "re-dispatching to the dev agent — the failure is app-blocked beyond "
                "what an isolated story sandbox can fix (e.g. a pre-existing error in "
                "an unowned file, or a product-level conflict). The story is parked "
                "terminally so it stops being re-evaluated every tick. The direction "
                "remains on file: once the underlying blocker is fixed, re-file it "
                "(or re-open this PR and move the story back to a live state) to retry."
            )
            confirm = close_pr_fn or _close_pr_and_confirm
            try:
                confirmed = bool(confirm(pr_number, app_config.repo, comment=comment))
            except Exception:  # noqa: BLE001
                confirmed = False
            if not confirmed:
                # Close could not be confirmed — do NOT strand an open PR behind a
                # terminal story. Leave it mergeable; retry next tick.
                return "left"
        story.state = StoryState.BLOCKED_CI_UNRESOLVED.value
        try:
            _persist(story, db)
        except Exception:  # noqa: BLE001
            pass
        try:
            log_story_event(
                story.id,
                "ci_unresolved_parked",
                {"pr_number": pr_number, "reason": reason},
                software_factory_root=root,
                slug_hint=story.slug,
            )
        except Exception:  # noqa: BLE001
            pass
        return "parked"

    if len(prior_redispatches) >= _MAX_CI_FIX_CYCLES:
        _escalate("cap_reached")
        return _park("cap_reached")

    try:
        logs = _fetch_ci_failure_logs(app_config=app_config, pr_number=pr_number)
    except Exception:  # noqa: BLE001
        logs = ""
    signature = _ci_failure_signature(logs)

    if prior_redispatches:
        last_signature = prior_redispatches[-1].get("failure_signature")
        if signature and last_signature is not None and signature == last_signature:
            # The last redispatch's CI failure recurred verbatim — the dev
            # didn't actually fix it. Recovering again would just grind
            # through another full dev cycle for no new signal.
            _escalate("identical_failure_signature")
            return _park("identical_failure_signature")

    _redispatch_ci_fix(
        story=story,
        pr_number=pr_number,
        logs=logs,
        signature=signature,
        attempt=len(prior_redispatches) + 1,
        db=db,
        root=root,
    )
    return "redispatched"


def _attempt_pr_reconcile(*, app_config: AppConfig, pr_number: int) -> bool:
    """Try to make a stale PR mergeable by merging the base branch into it.

    Uses ``gh pr update-branch`` — a MERGE of the base into the PR head (never a
    force-push / history rewrite), so it's safe to run automatically on the
    factory's own story branches. This fixes the common auto-merge failure where
    the PR fell BEHIND a moved base (e.g. two docs PRs touching adjacent context
    files); it canNOT resolve true content conflicts (those return non-zero and
    fall through to the terminal-block path for regeneration/human handling).

    Returns True if the update command succeeded (branch advanced).
    """
    import subprocess  # pragma: no cover - real-run path

    try:  # pragma: no cover - real-run path
        subprocess.run(
            ["gh", "pr", "update-branch", str(pr_number), "--repo", app_config.repo],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
        return True
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
    ):  # pragma: no cover - real-run path
        return False


def _pr_is_conflicting(*, app_config: AppConfig, pr_number: int) -> bool:
    """True iff the PR is a GENUINE content conflict (``mergeable`` CONFLICTING
    / ``mergeStateStatus`` DIRTY) — as opposed to closed, merged, or merely
    BEHIND.

    Only a true conflict warrants a fresh-branch REBUILD: closed/merged PRs are
    parked, and a merely-behind branch is recovered by ``_attempt_pr_reconcile``
    (``gh pr update-branch``). Read-only. Fail-safe: any gh/parse error returns
    False so we never trigger a destructive rebuild on an ambiguous signal.
    """
    import json as _json  # pragma: no cover - real-run path
    import subprocess

    cmd = [
        "gh",
        "pr",
        "view",
        str(pr_number),
        "--repo",
        app_config.repo,
        "--json",
        "mergeable,mergeStateStatus",
    ]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=60).stdout
        data = _json.loads(out)
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
        ValueError,
        TypeError,
    ):
        return False
    if not isinstance(data, dict):
        return False
    mergeable = str(data.get("mergeable", "")).upper()
    merge_status = str(data.get("mergeStateStatus", "")).upper()
    return mergeable == "CONFLICTING" or merge_status == "DIRTY"


_CONFLICT_REBUILD_COMMENT = (
    "Auto-closing: this PR became un-mergeable — a real merge conflict with the "
    "base branch that could not be reconciled by updating the branch. Rather than "
    "silently auto-resolve the conflict, the factory is REBUILDING the change "
    "cleanly on a fresh branch cut from current main and will open a new PR. "
    "(If the conflict keeps recurring, the story parks for a human after a small "
    "number of rebuild attempts.)"
)


def _reset_branch_for_fresh_rebuild(
    *, story: StoryRecord, app_config: AppConfig, pr_number: int, root: Path
) -> bool:  # pragma: no cover - real-run path; drives gh/git side effects
    """Discard the conflicting PR's stale branch so the next dev run cuts a
    FRESH branch from current ``origin/main``.

    The per-story branch name is DETERMINISTIC (``feature_branch_name`` — issue
    number + slug), so merely clearing ``story.github_branch`` would recompute
    the same name and ``ensure_worktree_for_story`` would REUSE the stale local
    branch/worktree, carrying the conflicting commits forward. To truly rebuild
    on current main we must wipe all three stale surfaces:

      1. the remote branch + open PR  — ``gh pr close --delete-branch``;
      2. the per-story worktree       — ``remove_worktree_for_story`` (it is
         checked out on the stale branch, so it must go before step 3);
      3. the stale LOCAL branch       — ``git branch -D`` in the source repo, so
         ``ensure_worktree_for_story`` falls to its ``worktree add -b <branch>
         <origin/main>`` path and cuts the branch fresh.

    Best-effort per step (each wrapped) so a partial failure never wedges the
    tick; returns True when the reset ran. The caller clears
    ``story.github_pr_number`` / ``github_branch`` and re-dispatches dev.
    """
    import subprocess

    from factory.app_config import resolve_app_repo_path
    from factory.chain.branch import feature_branch_name
    from factory.chain.worktree import remove_worktree_for_story

    branch = story.github_branch or (
        feature_branch_name(story.github_issue_number, story.slug)
        if story.github_issue_number is not None
        else None
    )
    # 1. Close the PR + delete its remote head. A closed PR can never merge;
    #    --delete-branch removes the stale remote branch so the rebuilt push
    #    starts from a clean slate.
    if pr_number > 0:
        try:
            subprocess.run(
                [
                    "gh",
                    "pr",
                    "close",
                    str(pr_number),
                    "--repo",
                    app_config.repo,
                    "--delete-branch",
                    "--comment",
                    _CONFLICT_REBUILD_COMMENT,
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except (OSError, subprocess.SubprocessError):
            pass

    source_repo = resolve_app_repo_path(app_config, root)
    # 2. Remove the per-story worktree (checked out on the stale branch).
    try:
        remove_worktree_for_story(
            source_repo,
            software_factory_root=root,
            app=story.app,
            story_id=story.github_issue_number,
            slug=story.slug,
        )
    except Exception:  # noqa: BLE001 - best-effort cleanup
        pass
    # 3. Delete the stale local branch so the next worktree is cut from
    #    origin/main instead of reusing the conflicting commits.
    if branch:
        try:
            subprocess.run(
                ["git", "branch", "-D", str(branch)],
                cwd=str(source_repo),
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            pass
    return True


def _handle_pr_conflict_rebuild(
    *,
    story: StoryRecord,
    app_config: AppConfig,
    pr_number: int,
    db: Path,
    root: Path,
    reset_fn: Any = None,
) -> str:
    """Re-dispatch a genuinely-CONFLICTING PR's story to dev to REBUILD on a
    FRESH branch off current main, bounded by ``_MAX_CONFLICT_REBUILDS``.

    Returns:
      * ``"rebuild_redispatched"`` — the redispatch intent was durably PERSISTED
        (``github_pr_number``/``github_branch`` cleared, state flipped to
        REVIEWER_REQUESTED_CHANGES, merge-conflict finding fed to dev) and the
        destructive reset was then run best-effort. The caller must NOT park it.
      * ``"exhausted"`` — the rebuild cap is reached (a deduped
        ``conflict_rebuild_exhausted`` was logged). The caller should park the
        story to ``blocked_deploy_failed`` via the existing
        ``EVENT_PR_UNMERGEABLE`` sink so it never loops forever.
      * ``"failed"`` — the redispatch intent could NOT be persisted. FAIL-SAFE:
        NOTHING was destroyed (the PR + branch are still fully intact), so the
        caller parks and the next tick retries with no work lost. This function
        never raises.

    PERSIST-FIRST / destroy-last — this is the critical ordering. The reset
    (``_reset_branch_for_fresh_rebuild``) closes the PR and DELETES the remote +
    local branch: irreversible. So we commit the redispatch intent BEFORE any
    destruction. If the persist fails, the PR/branch are untouched and the tick
    parks a fully-recoverable story; only after a durable persist do we destroy,
    at which point a partial reset failure merely risks the next dev cut reusing
    a stale branch and re-conflicting — bounded by the cap, never irreversible
    loss. (This is why a failing/​raising ``reset_fn`` does NOT yield ``"failed"``
    — the work is already safely persisted.)

    Mirrors ``_handle_ci_failure``: caps via the event log (counts
    ``conflict_rebuild_redispatch`` events for THIS story) and re-dispatches to
    ``REVIEWER_REQUESTED_CHANGES`` (the state that dispatches to dev next tick
    and feeds ``story.reviewer_result_json`` into ``handle_dev``).

    ``reset_fn`` is a test seam (defaults to ``_reset_branch_for_fresh_rebuild``);
    it performs the external close/wipe side effects.
    """
    from factory.chain.event_log import log_story_event, read_story_events
    from factory.chain.handlers import persist_story

    if story.state not in _MERGEABLE_STATES:
        # Defensive: the caller already guards on this. Never rebuild a story
        # that isn't sitting in a mergeable state.
        return "failed"

    events = read_story_events(story.id, software_factory_root=root, slug_hint=story.slug)
    prior_rebuilds = [e for e in events if e.get("event") == "conflict_rebuild_redispatch"]

    if len(prior_rebuilds) >= _MAX_CONFLICT_REBUILDS:
        if not any(e.get("event") == "conflict_rebuild_exhausted" for e in events):
            try:
                log_story_event(
                    story.id,
                    "conflict_rebuild_exhausted",
                    {
                        "pr_number": pr_number,
                        "rebuilds": len(prior_rebuilds),
                        "cap": _MAX_CONFLICT_REBUILDS,
                    },
                    software_factory_root=root,
                    slug_hint=story.slug,
                )
            except Exception:  # noqa: BLE001
                pass
        return "exhausted"

    base = app_config.default_branch or "main"

    # STEP 1 — mutate the story in memory. Clear the PR + branch pointers so the
    # dev / PR-open flow cuts a NEW branch from origin/main and opens a NEW PR.
    # Clearing ``github_branch`` to None is safe: both the reset (STEP 3) and the
    # next dev cut recompute the SAME deterministic ``feature_branch_name`` from
    # the issue number + slug, so the reset still deletes the right stale branch.
    story.github_pr_number = None
    story.github_branch = None
    # Feed the conflict back as a reviewer finding so the dev run knows WHY it is
    # rebuilding (reuse the existing reviewer-findings plumbing, same shape as
    # the CI-failure re-dispatch — a well-formed dict, never a bare string).
    finding = {
        "severity": "high",
        "criterion": "merge_conflict",
        "location": f"PR #{pr_number} vs {base}",
        "what": (
            f"PR #{pr_number} became un-mergeable — a real merge conflict with "
            f"{base} that could not be reconciled by updating the branch. The "
            "stale branch has been discarded; rebuild the same change cleanly on "
            "top of current main so it merges without conflict. Do NOT attempt to "
            "resurrect the old branch."
        ),
    }
    story.reviewer_result_json = json.dumps(
        {
            "findings": [finding],
            "source": "merge_conflict",
            "summary": (
                "PR conflicted with main; rebuild the change on a fresh branch "
                "cut from current main."
            ),
        }
    )
    story.state = StoryState.REVIEWER_REQUESTED_CHANGES.value
    # Reset BOTH per-loop counters (mirror _handle_ci_failure): a rebuild hits an
    # already-approved story whose reviewer_cycles may be near the cap; without
    # resetting, the follow-up review pass could trip non-convergence on the
    # first pass and mislabel a conflict rebuild.
    story.dev_retries = 0
    story.reviewer_cycles = 0

    # STEP 2 — persist the intent BEFORE any destruction. On failure NOTHING has
    # been destroyed: the PR + branch are intact, so we park a recoverable story.
    try:
        persist_story(story, db)
    except Exception:  # noqa: BLE001 - could not persist → park; PR/branch intact
        return "failed"

    # STEP 3 — only now run the destructive reset (close PR + delete remote/local
    # branch + remove worktree). Best-effort: a partial failure here is bounded
    # by the rebuild cap (the next dev cut may reuse a stale branch and
    # re-conflict), NOT irreversible loss — the redispatch is already durable.
    reset = reset_fn or _reset_branch_for_fresh_rebuild
    try:
        reset(story=story, app_config=app_config, pr_number=pr_number, root=root)
    except Exception:  # noqa: BLE001 - reset is best-effort post-persist
        pass

    # STEP 4 — log the redispatch.
    try:
        log_story_event(
            story.id,
            "conflict_rebuild_redispatch",
            {
                "pr_number": pr_number,
                "attempt": len(prior_rebuilds) + 1,
                "cap": _MAX_CONFLICT_REBUILDS,
            },
            software_factory_root=root,
            slug_hint=story.slug,
        )
    except Exception:  # noqa: BLE001
        pass
    return "rebuild_redispatched"


#: Consecutive settle failures before the story parks for a human (SHOULD 4).
_MAX_SETTLE_FAILURES = 3


def _bound_settle_failures(story: StoryRecord, root: Path, db: Path, reason: str) -> str:
    """Count a failed settle; on the ``_MAX_SETTLE_FAILURES``-th park the story
    in ``BLOCKED_DEPLOY_FAILED`` so a broken settle cannot be retried (and
    silently swallowed) every tick forever. Never raises."""
    from factory.chain.event_log import log_story_event, read_story_events

    if story.id is None:
        return reason
    try:
        log_story_event(
            story.id,
            "delivery_settle_failed",
            {"reason": reason[:300]},
            software_factory_root=root,
            slug_hint=story.slug,
        )
        events = read_story_events(story.id, software_factory_root=root, slug_hint=story.slug)
        resume_idx = max(
            (i for i, e in enumerate(events) if e.get("event") == "story_resumed"), default=-1
        )
        n = sum(1 for e in events[resume_idx + 1 :] if e.get("event") == "delivery_settle_failed")
        if n >= _MAX_SETTLE_FAILURES and story.id is not None:
            msg = f"delivery_settle_failed x{n}: {reason[:200]}"
            if delivery_gate.cas_story_state(
                db,
                story.id,
                _MERGEABLE_STATES,
                StoryState.BLOCKED_DEPLOY_FAILED.value,
                last_rejection_reason=msg,
                error=msg,
            ):
                story.state = StoryState.BLOCKED_DEPLOY_FAILED.value
                return f"{reason}; parked after {n} failed settles"
    except Exception:  # noqa: BLE001 - bookkeeping only
        pass
    return reason


def _settle_non_merging_story(
    *,
    story: StoryRecord,
    level: DeliveryLevel,
    app_config: AppConfig,
    root: Path,
    db: Path,
    reason: str,
    ci_note: str | None = None,
) -> str:
    """Bring a merge-capable story whose level does NOT merge to its level's end.

    ``ci_note`` (set by ``_watch_ci_then_deliver``) says the PR is delivered
    WITHOUT a green CI — red after the CI-fix cap, or no verdict in time. It is
    recorded on the ``delivered`` event (``factory job status`` reads it as the
    story's ``delivery_note``) and in ``error``; never in
    ``last_rejection_reason`` (that would list the story in ``factory inbox``
    as stuck, and it is not: the PR is the deliverable).

    Reached when (a) a ``push_to_main`` fast-forward was refused and the story
    falls back to ``pr``, or (b) a story whose RECORDED level does not merge
    sits in a mergeable state (e.g. a factory self-edit's ``push_to_main``
    lowered to ``pr``, or a row whose level was changed by an operator). Never
    merges, never marks a draft ready, and DISARMS any GitHub auto-merge a
    previous tick armed with ``gh pr merge --auto`` (finding 2, 2026-11-02:
    that arm otherwise survives the settle and GitHub merges the PR anyway).
    A disarm failure is recorded on the story (``error`` + a
    ``auto_merge_disarm_failed`` event) — the story still settles, and if
    GitHub merges it regardless, ``reconcile_from_github`` routes that merge
    to deploy like any human merge. A story with no PR yet gets one opened (draft
    for ``draft_pr``); a failure is retried by the next tick, bounded by
    ``handlers._MAX_PR_CREATE_RETRIES`` and then parked at
    ``BLOCKED_DEPLOY_FAILED``. Returns a one-line description for the
    ``MergeAction``. Real-run only.
    """
    from factory.chain.event_log import log_story_event
    from factory.chain.handlers import (
        _MAX_PR_CREATE_RETRIES,
        _open_pr_for_story,
        persist_story,
    )
    from factory.chain.state_machine import (
        EVENT_DELIVERED_BRANCH,
        EVENT_DELIVERED_LOCAL,
        EVENT_DELIVERED_PR,
        advance,
    )

    has_pr = story.github_pr_number is not None and story.github_pr_number > 0
    disarm_err: str | None = None
    if has_pr:
        disarm_err = delivery_gate.disable_auto_merge(app_config, story.github_pr_number)
        if disarm_err is not None:
            log_story_event(
                story.id,
                "auto_merge_disarm_failed",
                {"pr_number": story.github_pr_number, "error": disarm_err},
                software_factory_root=root,
                slug_hint=story.slug,
            )
    if has_pr or level in (DeliveryLevel.DRAFT_PR, DeliveryLevel.PR):
        if not has_pr:
            opened = _open_pr_for_story(
                story,
                app_config,
                root,
                draft=level is DeliveryLevel.DRAFT_PR,
                will_auto_merge=False,
            )
            if opened is None:
                story.pr_create_retries += 1
                msg = (
                    f"delivery {level.value}: gh pr create failed "
                    f"(attempt {story.pr_create_retries}/{_MAX_PR_CREATE_RETRIES}) — {reason}"
                )
                if story.pr_create_retries >= _MAX_PR_CREATE_RETRIES:
                    story.state = StoryState.BLOCKED_DEPLOY_FAILED.value
                    msg += " — retries exhausted, parked for human action"
                story.error = msg
                story.last_rejection_reason = msg
                persist_story(story, db)
                return msg
            story.github_pr_number = opened
            story.pr_create_retries = 0
        event = EVENT_DELIVERED_PR
    elif level is DeliveryLevel.BRANCH:
        event = EVENT_DELIVERED_BRANCH
    else:
        event = EVENT_DELIVERED_LOCAL
    story.state = advance(story, event).value
    errors = []
    if disarm_err:
        errors.append(
            f"delivery {level.value}: could not disarm GitHub auto-merge on PR "
            f"#{story.github_pr_number} — {disarm_err}"
        )
    if ci_note:
        errors.append(ci_note)
    story.error = "; ".join(errors) or None
    persist_story(story, db)
    log_story_event(
        story.id,
        delivery_gate.EVENT_DELIVERED,
        {
            "level": level.value,
            "state": story.state,
            "pr_number": story.github_pr_number,
            "reason": reason,
            **({"ci_note": ci_note} if ci_note else {}),
        },
        software_factory_root=root,
        slug_hint=story.slug,
    )
    return f"delivery {level.value}: never merged by the factory — {reason}; story -> {story.state}"


# --------------------------------------------------------------------------- #
# draft_pr / pr: watch the PR's CI (and feed a red run back to dev) BEFORE
# the story is settled to DELIVERED_PR.
# --------------------------------------------------------------------------- #

#: How long a ``draft_pr`` / ``pr`` story waits for its PR's checks to finish
#: before it is delivered anyway, with a "CI did not finish" note. The same
#: window ``factory job status`` waits on a just-opened PR (``jobs.status.
#: CI_WAIT_S``), so the two never disagree about when "waiting" is over.
DELIVERY_CI_WAIT_S = 2 * 60 * 60

#: A PR with NO checks at all: GitHub registers workflow runs a few seconds to
#: a minute after a push, so "no checks" is only believed after this grace —
#: then the story is delivered with a "no CI reported" note (a repo with no CI
#: must not wait the full ``DELIVERY_CI_WAIT_S``).
DELIVERY_NO_CHECKS_GRACE_S = 10 * 60

#: A red verdict read within this long of the watch starting is not acted on:
#: right after a fix push GitHub can still report the PREVIOUS head's checks,
#: and acting on that stale red would burn a CI-fix cycle on a fixed failure
#: (and then trip the identical-signature guard). Ticks are minutes apart, so
#: this costs at most one tick.
DELIVERY_CI_RED_MIN_AGE_S = 90

#: Logged once per wait (per PR head the dev hands over): the watch's clock.
EVENT_CI_WATCH_STARTED = "delivery_ci_watch_started"


#: Re-exported: the level predicate lives in ``delivery_gate`` so ``handlers``
#: can use it without importing this module.
watches_ci_before_delivery = delivery_gate.watches_ci_before_delivery


#: Logged by ``handlers.handle_docs_enforcer`` when it opens a watched PR: the
#: commit the factory pushed (``head_sha``). ``fix_push`` carries the same
#: field for every later CI-fix push. The watch grades only THAT commit.
EVENT_PR_HEAD_PUSHED = "delivery_pr_head_pushed"

#: Events ``handle_docs_enforcer`` / ``_push_fix_to_existing_pr`` log when a
#: CI-fix cycle came back WITHOUT moving the PR head. After one of these the
#: PR still shows the old red commit, so re-grading it would only burn a cycle.
_FIX_NOT_PUSHED_EVENTS = frozenset(
    {"fix_push_failed", "fix_push_skipped_no_commits", "fix_push_refused_foreign_commits"}
)


def _query_pr_checks(*, app_config: AppConfig, pr_number: int) -> dict[str, Any] | None:
    """The PR's CI rollup over ALL its checks, or ``None`` when GitHub could
    not be read::

        {"state": "passing" | "failing" | "pending" | "none",
         "failing": [names], "pending": [names],
         "genuine": [failing names whose conclusion is a real FAILURE],
         "head_sha": "<the PR head commit the rollup describes>" | None}

    ALL checks, not just required ones (``_query_ci_state`` reads
    ``--required``): a ``draft_pr`` / ``pr`` repo often has no branch
    protection at all, and the human the PR is handed to reads every check.
    Same reducer ``factory job status`` uses (``jobs.github.summarize_checks``),
    so the watch and the status report agree on what "red" means. ``genuine``
    applies ``_GENUINE_FAILURE_CONCLUSIONS`` (the rule ``_ci_failure_is_genuine``
    uses) to every check, since there may be no required set to scope it to: a
    red made only of CANCELLED / TIMED_OUT / ERROR is infra, not the dev's to fix.
    """
    import subprocess

    from factory.jobs.github import summarize_checks

    if pr_number <= 0:
        return None
    try:
        proc = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                str(pr_number),
                "--repo",
                app_config.repo,
                "--json",
                "statusCheckRollup,headRefOid",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    try:
        data = json.loads(proc.stdout or "{}") or {}
        rows = data.get("statusCheckRollup") or []
    except (ValueError, AttributeError):
        return None
    if not isinstance(rows, list):
        return None
    summary = summarize_checks(rows)
    failing = set(summary.get("failing") or [])
    genuine: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        verdict = str(row.get("conclusion") or row.get("state") or "").upper()
        name = str(row.get("name") or row.get("context") or "?")
        if verdict in _GENUINE_FAILURE_CONCLUSIONS and name in failing:
            genuine.add(name)
    summary["genuine"] = sorted(genuine)
    head = data.get("headRefOid") if isinstance(data, dict) else None
    summary["head_sha"] = str(head) if head else None
    return summary


def _ci_watch_window(
    events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], float | None]:
    """``(prior ci_fix_redispatch events, start of the current wait)``.

    Both are scoped to events AFTER the latest ``story_resumed`` (the
    ``_handle_ci_failure`` precedent: an operator resume resets the CI-fix
    budget). The current wait is the first ``delivery_ci_watch_started`` after
    the latest redispatch — each fix the dev hands back gets a fresh clock.
    """
    prior, _since_fix, start = _ci_watch_scope(events)
    return prior, start


def _ci_watch_scope(
    events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], float | None]:
    """``(prior redispatches, events since the latest redispatch, wait start)``
    — all scoped after the latest ``story_resumed``."""
    resume_idx = max(
        (i for i, e in enumerate(events) if e.get("event") == "story_resumed"), default=-1
    )
    scoped = events[resume_idx + 1 :]
    redispatches = [e for e in scoped if e.get("event") == "ci_fix_redispatch"]
    last_fix_idx = max(
        (i for i, e in enumerate(scoped) if e.get("event") == "ci_fix_redispatch"), default=-1
    )
    since_fix = scoped[last_fix_idx + 1 :]
    start: float | None = None
    for e in since_fix:
        if e.get("event") == EVENT_CI_WATCH_STARTED:
            start = _parse_event_ts(e.get("ts"))
            if start is not None:
                break
    return redispatches, since_fix, start


def _expected_pr_head(since_fix: list[dict[str, Any]]) -> str | None:
    """The commit the factory itself last pushed to the PR in this cycle: the
    latest ``fix_push`` / ``delivery_pr_head_pushed`` ``head_sha``, or None."""
    for e in reversed(since_fix):
        if e.get("event") in ("fix_push", EVENT_PR_HEAD_PUSHED) and e.get("head_sha"):
            return str(e["head_sha"])
    return None


def deliver_watched_pr_with_note(
    *,
    story: StoryRecord,
    app_config: AppConfig,
    root: Path,
    db: Path,
    note: str,
    reason: str,
) -> bool:
    """Settle a ``draft_pr`` / ``pr`` story whose CI-fix cycle could not finish
    (dev exhausted / same-signature stall) straight to ``DELIVERED_PR``.

    The PR already exists and IS the deliverable; the fix that failed must not
    be pushed onto it and the story must not end in a human-blocked sink just
    because a FIX attempt failed. Called from ``handlers._handle_dev_once``
    instead of the dev-exhausted WIP push. Direct state write (there is no
    ``DEV_*`` → ``DELIVERED_PR`` edge; declared in the conformance model),
    under ``story_lock`` with the job-cancel marker re-checked. Returns whether
    it settled; on ``False`` the caller keeps its own exhausted path.
    """
    from factory.chain.event_log import log_story_event
    from factory.chain.handlers import persist_story

    sid = story.id
    if sid is None or not story.github_pr_number or story.github_pr_number <= 0:
        return False
    with delivery_gate.story_lock(root, sid) as held:
        if not held or delivery_gate.is_job_cancelled(db, story.app, story.direction_id):
            return False
        disarm_err = delivery_gate.disable_auto_merge(app_config, story.github_pr_number)
        story.state = StoryState.DELIVERED_PR.value
        story.error = note if not disarm_err else f"{note}; auto-merge disarm failed: {disarm_err}"
        persist_story(story, db)
        with contextlib.suppress(Exception):
            log_story_event(
                sid,
                delivery_gate.EVENT_DELIVERED,
                {
                    "level": story.delivery_level,
                    "state": story.state,
                    "pr_number": story.github_pr_number,
                    "reason": reason,
                    "ci_note": note,
                },
                software_factory_root=root,
                slug_hint=story.slug,
            )
    return True


def _watch_ci_then_deliver(
    *,
    story: StoryRecord,
    fixture: FixturePR,
    level: DeliveryLevel,
    cfg: AppConfig,
    app: str,
    root: Path,
    db: Path,
    checks_query: Any = None,
    log_fetch: Any = None,
    now_fn: Any = None,
) -> MergeAction:
    """``draft_pr`` / ``pr``: wait for the PR's CI, fix a red run, THEN deliver.

    The same loop ``auto_merge`` stories get (``_handle_ci_failure``), minus
    the merge and minus the give-up close-and-park:

    * green → ``_settle_non_merging_story`` → ``DELIVERED_PR`` (never merged,
      never marked ready — a draft stays a draft; any armed auto-merge is
      disarmed there).
    * red → the failing log goes to dev via ``_redispatch_ci_fix`` (story →
      ``REVIEWER_REQUESTED_CHANGES``); the fix is pushed to the SAME PR by
      ``handle_docs_enforcer`` (fast-forward only — never forced over a
      human's commits) and the story comes back here at PR_OPEN. At most
      ``_MAX_CI_FIX_CYCLES`` re-dispatches.
    * delivered WITH a ``ci_note`` (which ``factory job status`` reports), and
      never re-dispatched, when: the cap is reached; the last fix reproduced
      the identical failure; the last fix was NOT pushed (push failed, no new
      commit, or the PR has commits the factory did not write); the PR head is
      not the commit the factory pushed (a human pushed); the red is infra-only
      (cancelled / timed out / errored); no Actions log could be fetched; the
      story is a docs-chain story; no verdict within ``DELIVERY_CI_WAIT_S``; or
      no checks at all after ``DELIVERY_NO_CHECKS_GRACE_S``. The PR is never
      closed: a human asked for it.
    * pending → nothing is written; re-checked next tick.

    Every state write happens under ``delivery_gate.story_lock`` after a
    re-read of the committed state and of the durable job-cancel marker, so a
    ``factory job cancel`` landing mid-wait wins. Never raises.
    """
    from factory.chain.event_log import log_story_event, read_story_events

    pr = fixture.pr_number
    now = float((now_fn or time.time)())

    def _act(reason: str) -> MergeAction:
        return MergeAction(app=app, pr_number=pr, merged=False, reason=reason)

    sid = story.id
    if sid is None:
        return _act("story has no id; CI watch skipped")
    if delivery_gate.is_job_cancelled(db, story.app, story.direction_id):
        return _act("job was cancelled (factory job cancel) — CI watch stopped, not delivered")

    try:
        events = read_story_events(sid, software_factory_root=root, slug_hint=story.slug)
    except Exception:  # noqa: BLE001 - an unreadable stream starts a fresh wait
        events = []
    prior, since_fix, start = _ci_watch_scope(events)
    if start is None:
        try:
            log_story_event(
                sid,
                EVENT_CI_WATCH_STARTED,
                {"pr_number": pr, "level": level.value, "ci_fix_cycles": len(prior)},
                software_factory_root=root,
                slug_hint=story.slug,
            )
            start = now
        except Exception:  # noqa: BLE001
            # The clock could not be recorded. Fall back to a DURABLE one —
            # the row's updated_at, which nothing touches while it waits — so
            # the 2 h / 10 min / 90 s bounds still fire instead of restarting
            # every tick.
            start = _parse_event_ts(getattr(story, "updated_at", None)) or now
    age = max(0.0, now - start)
    expected_head = _expected_pr_head(since_fix)

    head_for_record = fixture.head_sha

    def _locked(write: Any) -> MergeAction:
        """Run ``write`` under the story lock, after re-checking cancel/state."""
        with delivery_gate.story_lock(root, sid) as held:
            if not held:
                return _act("story lock busy (job cancel in progress?) — re-checked next tick")
            if delivery_gate.is_job_cancelled(db, story.app, story.direction_id):
                return _act("job was cancelled (factory job cancel) — not delivered")
            live = delivery_gate.current_story_state(db, sid)
            if live is None or live not in _MERGEABLE_STATES:
                return _act(f"story state changed to {live!r} during the CI watch — left alone")
            story.state = live
            action: MergeAction = write()
            _record_merge_action(action, head_for_record, db)
            return action

    def _deliver(reason: str, note: str | None) -> MergeAction:
        def _write() -> MergeAction:
            try:
                detail = _settle_non_merging_story(
                    story=story,
                    level=level,
                    app_config=cfg,
                    root=root,
                    db=db,
                    reason=reason,
                    ci_note=note,
                )
            except Exception as exc:  # noqa: BLE001 - never merge on a settle error
                detail = _bound_settle_failures(
                    story, root, db, f"{reason}; settle failed: {exc!r}"
                )
            return _act(detail)

        return _locked(_write)

    # A CI-fix cycle that came back WITHOUT moving the PR head: the PR still
    # shows the commit that was red. Say exactly why, and stop (re-grading the
    # old head would only re-dispatch the same failure).
    if prior and not any(e.get("event") == "fix_push" for e in since_fix):
        not_pushed = [e for e in since_fix if e.get("event") in _FIX_NOT_PUSHED_EVENTS]
        if not_pushed:
            last = not_pushed[-1]
            why = str(last.get("error") or last.get("note") or last.get("event"))
            return _deliver(
                f"CI fix {len(prior)} was not pushed to PR #{pr}",
                f"CI fix {len(prior)} was NOT pushed to PR #{pr} ({last.get('event')}: "
                f"{why[:200]}); the PR head is still the commit whose CI was red — "
                "delivered for a human",
            )

    try:
        ci = (checks_query or _query_pr_checks)(app_config=cfg, pr_number=pr)
    except Exception:  # noqa: BLE001 - unreadable == unknown == keep waiting (bounded)
        ci = None
    if not isinstance(ci, dict):
        ci = {}
    ci_state = ci.get("state")
    failing = [str(n) for n in (ci.get("failing") or [])][:5]
    pending = [str(n) for n in (ci.get("pending") or [])][:5]
    pr_head = str(ci["head_sha"]) if ci.get("head_sha") else None
    if pr_head:
        head_for_record = pr_head
    if (
        ci_state == "failing"
        and failing
        and {n.lower() for n in failing} == {_MAIN_GREEN_CHECK_NAME}
    ):
        # E6 environment guard: ``main-green`` red ALONE means MAIN is red, not
        # this PR (the ``_CI_STATE_HOLD`` rule). Never send the dev after it —
        # wait like a pending run (bounded by ``DELIVERY_CI_WAIT_S``).
        ci_state = "pending"
        pending = [f"{_MAIN_GREEN_CHECK_NAME} (main is red)"]

    # The verdict is about the commit the factory pushed — or it is not ours
    # to act on. Right after a push GitHub's PR head can lag, so a mismatch is
    # believed only past the stale-head window.
    foreign_head = bool(
        expected_head and pr_head and pr_head != expected_head and age >= DELIVERY_CI_RED_MIN_AGE_S
    )
    foreign_note = (
        f"PR #{pr} head {pr_head[:12] if pr_head else '?'} is not the commit the factory "
        f"pushed ({(expected_head or '?')[:12]}) — someone else pushed to this PR"
    )

    if ci_state == "passing":
        return _deliver(
            f"CI green on PR #{pr}",
            f"{foreign_note}; its CI is green" if foreign_head else None,
        )

    if ci_state == "none":
        if age < DELIVERY_NO_CHECKS_GRACE_S:
            return _act(f"waiting for CI on PR #{pr}: no checks reported yet")
        return _deliver(
            f"no CI checks on PR #{pr}",
            f"CI: no checks reported on PR #{pr} within "
            f"{DELIVERY_NO_CHECKS_GRACE_S // 60} min — delivered without a CI verdict",
        )

    if ci_state == "failing":
        if age < DELIVERY_CI_RED_MIN_AGE_S:
            return _act(f"CI red on PR #{pr} but the watch just started; re-checked next tick")
        names = ", ".join(failing) or "unnamed check"
        red = f"CI is RED on PR #{pr} ({names})"
        if foreign_head:
            return _deliver(
                f"CI red on a PR head the factory did not push (PR #{pr})",
                f"{foreign_note}; {red} — not re-dispatched to the dev, delivered for a human",
            )
        if (getattr(story, "chain_kind", "tdd") or "tdd") == "docs":
            return _deliver(
                f"CI red on docs-chain PR #{pr}",
                f"{red} on a docs-chain story — not sent to the code dev; delivered for a human",
            )
        if len(prior) >= _MAX_CI_FIX_CYCLES:
            return _deliver(
                f"CI red on PR #{pr} after the CI-fix cap",
                f"{red} after {len(prior)} CI-fix cycle(s) (cap {_MAX_CI_FIX_CYCLES}) — "
                "delivered for a human to fix",
            )
        genuine = [str(n) for n in ci.get("genuine", failing)]
        if not genuine:
            return _deliver(
                f"CI red on PR #{pr} from infra only",
                f"{red}, but only from cancelled / timed-out / errored runs (infra, not "
                "the change) — not sent to the dev; re-run the checks",
            )
        try:
            logs = str((log_fetch or _fetch_ci_failure_logs)(app_config=cfg, pr_number=pr) or "")
        except Exception:  # noqa: BLE001
            logs = ""
        if not logs.strip():
            return _deliver(
                f"CI red on PR #{pr} with no fetchable log",
                f"{red}, but no GitHub Actions log could be fetched for it (a non-Actions "
                "check?) — not sent to the dev without the failure text",
            )
        signature = _ci_failure_signature(logs)
        last_sig = prior[-1].get("failure_signature") if prior else None
        if signature and last_sig is not None and signature == last_sig:
            return _deliver(
                f"CI red on PR #{pr}: the last fix reproduced the identical failure",
                f"{red}: the dev's last CI fix reproduced the identical failure "
                f"({len(prior)} CI-fix cycle(s)) — delivered for a human to fix",
            )

        def _redispatch() -> MergeAction:
            _redispatch_ci_fix(
                story=story,
                pr_number=pr,
                logs=logs,
                signature=signature,
                attempt=len(prior) + 1,
                db=db,
                root=root,
                extra={"level": level.value, "failing": failing, "head_sha": pr_head},
            )
            return _act(
                f"CI red on PR #{pr} ({names}); re-dispatched to dev with the CI log "
                f"(CI-fix {len(prior) + 1}/{_MAX_CI_FIX_CYCLES}) before delivery"
            )

        return _locked(_redispatch)

    # pending, or GitHub unreadable: wait, bounded.
    if age >= DELIVERY_CI_WAIT_S:
        what = f"still pending: {', '.join(pending)}" if pending else "CI state unreadable"
        return _deliver(
            f"CI did not finish on PR #{pr} in time",
            f"CI did not finish on PR #{pr} within {DELIVERY_CI_WAIT_S // 3600}h "
            f"({what}) — delivered without a CI verdict",
        )
    return _act(
        f"waiting for CI on PR #{pr}"
        + (f" ({', '.join(pending)})" if pending else " (state unknown)")
        + "; delivered once it reports"
    )


#: Prefix of the reason recorded when ``push_to_main`` falls back to a PR.
P2M_FALLBACK_REASON_PREFIX = "push_to_main_fell_back_to_pr:"
EVENT_P2M_FELL_BACK = "push_to_main_fell_back_to_pr"


def _fall_back_push_to_main_to_pr(
    *,
    story: StoryRecord,
    fixture: FixturePR,
    app: str,
    cfg: AppConfig,
    root: Path,
    db: Path,
    why: str,
) -> MergeAction:
    """Base branch requires status checks or a PR → deliver via ``auto_merge``.

    Operator decision 2026-11-02: a protected default branch is not a reason
    to stop; it is a reason to go through the door it guards. The story's
    branch is already pushed (``handle_docs_enforcer`` pushes it for
    ``push_to_main``), so this opens a READY PR and re-stamps the story at
    ``auto_merge``. From the next tick the story is an ordinary auto-merge
    story: the main-green hold, the repo's required checks and the full gate
    set all apply, and ``gh pr merge --auto`` is armed only when they pass.
    Nothing is ever pushed to the default branch directly and nothing is
    forced.

    Recorded as a ``push_to_main_fell_back_to_pr`` event (reason
    ``push_to_main_fell_back_to_pr:<why>``) plus ``delivery_level_lowered``;
    ``factory job status`` surfaces it as ``delivery_note``. Deliberately NOT
    written to ``last_rejection_reason`` — that would list a healthy story in
    ``factory inbox``.

    A ``gh pr create`` failure leaves the level at ``push_to_main`` (so the
    next tick retries this same path), bounded by
    ``handlers._MAX_PR_CREATE_RETRIES``; exhaustion parks the story in
    ``BLOCKED_DEPLOY_FAILED`` for a human.
    """
    from factory.chain.event_log import log_story_event
    from factory.chain.handlers import (
        _MAX_PR_CREATE_RETRIES,
        _open_pr_for_story,
        persist_story,
    )

    reason = f"{P2M_FALLBACK_REASON_PREFIX}{why}"
    opened = _open_pr_for_story(story, cfg, root, draft=False, will_auto_merge=True)
    if opened is None:
        story.pr_create_retries += 1
        msg = (
            f"delivery push_to_main -> PR fallback: gh pr create failed (attempt "
            f"{story.pr_create_retries}/{_MAX_PR_CREATE_RETRIES}) — {why}"
        )
        if story.pr_create_retries >= _MAX_PR_CREATE_RETRIES:
            story.state = StoryState.BLOCKED_DEPLOY_FAILED.value
            story.last_rejection_reason = msg + " — retries exhausted, parked for human action"
        story.error = msg
        persist_story(story, db)
        action = MergeAction(app=app, pr_number=fixture.pr_number, merged=False, reason=msg)
        _record_merge_action(action, fixture.head_sha, db)
        return action

    prev = story.delivery_level
    story.github_pr_number = opened
    story.pr_create_retries = 0
    story.delivery_level = DeliveryLevel.AUTO_MERGE.value
    story.error = None
    persist_story(story, db)
    for event, payload in (
        (
            EVENT_P2M_FELL_BACK,
            {
                "reason": reason,
                "pr_number": opened,
                "base": fixture.base_branch,
                "head_sha": fixture.head_sha,
            },
        ),
        (
            delivery_gate.EVENT_LOWERED,
            {"from": prev, "to": DeliveryLevel.AUTO_MERGE.value, "reason": reason},
        ),
    ):
        try:
            log_story_event(
                story.id, event, payload, software_factory_root=root, slug_hint=story.slug
            )
        except Exception:  # noqa: BLE001 - telemetry only
            pass
    action = MergeAction(
        app=app,
        pr_number=opened,
        merged=False,
        reason=f"{reason}; opened PR #{opened}, delivered via auto_merge from the next tick",
    )
    _record_merge_action(action, fixture.head_sha, db)
    return action


#: How long a ``push_to_main`` story may sit in the main-green hold before it
#: falls back to a ready PR for a human (nice 12, review 2026-11-02).
_P2M_HOLD_CAP_SECONDS = 24 * 3600
_P2M_HOLD_SINCE_RE = re.compile(r"push_to_main held since (\S+) —")


def _p2m_hold_since(reason: str | None) -> Any:
    """The hold episode's start parsed from the story's hold reason, or None."""
    from datetime import UTC, datetime

    if not reason or not reason.startswith(_HOLD_REASON_PREFIX):
        return None
    m = _P2M_HOLD_SINCE_RE.search(reason)
    if not m:
        return None
    try:
        dt = datetime.fromisoformat(m.group(1))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _p2m_hold_exhausted_to_pr(
    *,
    story: StoryRecord,
    fixture: FixturePR,
    app: str,
    cfg: AppConfig,
    root: Path,
    db: Path,
    since: Any,
    why: str,
) -> MergeAction:
    """Hold cap reached: re-stamp the story at ``pr`` and settle it to
    ``DELIVERED_PR`` (a ready PR, never merged by the factory)."""
    from factory.chain.event_log import log_story_event

    reason = (
        f"{P2M_FALLBACK_REASON_PREFIX}held since {since.isoformat()} "
        f"(over {_P2M_HOLD_CAP_SECONDS // 3600}h): {why}"
    )
    prev = story.delivery_level
    story.delivery_level = DeliveryLevel.PR.value
    _set_hold_reason(story, db, None)
    with contextlib.suppress(Exception):
        log_story_event(
            story.id, EVENT_P2M_FELL_BACK, {"reason": reason, "level": "pr"},
            software_factory_root=root, slug_hint=story.slug,
        )  # fmt: skip
        log_story_event(
            story.id, delivery_gate.EVENT_LOWERED,
            {"from": prev, "to": DeliveryLevel.PR.value, "reason": reason},
            software_factory_root=root, slug_hint=story.slug,
        )  # fmt: skip
    try:
        detail = _settle_non_merging_story(
            story=story, level=DeliveryLevel.PR, app_config=cfg, root=root, db=db, reason=reason
        )
    except Exception as exc:  # noqa: BLE001 - never merge on a settle error
        detail = _bound_settle_failures(story, root, db, f"{reason}; settle failed: {exc!r}")
    action = MergeAction(app=app, pr_number=fixture.pr_number, merged=False, reason=detail)
    _record_merge_action(action, fixture.head_sha, db)
    return action


def _push_to_main_preflight_gate(
    *,
    story: StoryRecord,
    fixture: FixturePR,
    app: str,
    cfg: AppConfig,
    root: Path,
    db: Path,
    preflight_fn: Any = None,
) -> MergeAction | None:
    """The main-green hold + branch-protection check for ``push_to_main``.

    PR merges get both for free from GitHub: ``main-green`` is a required PR
    check (E6 stage 2) and branch protection runs the required checks on the
    PR. A direct fast-forward has NO PR, so neither ran (adversarial review
    2026-11-02, finding 4). This puts them back, in front of the gate set:

    * HOLD (base is red / its checks are running / GitHub unreadable): nothing
      runs and nothing is counted toward ``_MAX_GATE_BLOCK_CYCLES``; the story
      stays put with a ``ci_hold_main_red:`` reason (so ``factory inbox`` shows
      why) and is re-checked next tick — identical semantics to the PR hold.
    * REFUSE (base requires status checks or a PR): the factory will not
      bypass them and will not force; it FALLS BACK to ``auto_merge`` via a
      ready PR (``_fall_back_push_to_main_to_pr``). Nothing is pushed to the
      default branch directly.
    * OK: clears a stale hold reason and returns ``None`` (evaluate normally).

    Never raises: an error in the check itself is a HOLD.
    """

    try:
        fn = preflight_fn or delivery_gate.push_to_main_preflight
        verdict, detail = fn(cfg, fixture.base_branch)
    except Exception as exc:  # noqa: BLE001 - fail safe
        verdict, detail = delivery_gate.PREFLIGHT_HOLD, f"preflight error: {exc!r}"[:300]

    if verdict == delivery_gate.PREFLIGHT_OK:
        if (story.last_rejection_reason or "").startswith(_HOLD_REASON_PREFIX):
            _set_hold_reason(story, db, None)
        return None

    if verdict == delivery_gate.PREFLIGHT_REFUSE:
        return _fall_back_push_to_main_to_pr(
            story=story, fixture=fixture, app=app, cfg=cfg, root=root, db=db, why=detail
        )

    # HOLD (anything not OK/REFUSE is a hold — fail safe). The episode start
    # is carried IN the reason ("held since <iso>") so it survives the detail
    # changing tick to tick, without a new column.
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    since = _p2m_hold_since(story.last_rejection_reason) or now
    if (now - since).total_seconds() >= _P2M_HOLD_CAP_SECONDS:
        # Nice 12 (review 2026-11-02): a hold that never ends is an invisible
        # stall. After the cap, hand the work to a human as a ready PR (level
        # pr) instead of waiting on main forever.
        return _p2m_hold_exhausted_to_pr(
            story=story,
            fixture=fixture,
            app=app,
            cfg=cfg,
            root=root,
            db=db,
            since=since,
            why=detail,
        )
    hold_reason = f"{_HOLD_REASON_PREFIX} push_to_main held since {since.isoformat()} — {detail}"
    if story.last_rejection_reason != hold_reason:
        _set_hold_reason(story, db, hold_reason)
        story.last_rejection_reason = hold_reason
    return MergeAction(
        app=app,
        pr_number=fixture.pr_number,
        merged=False,
        reason=f"held: {detail}; story untouched, re-checked next tick",
    )


def auto_merge_tick(
    software_factory_root: Path,
    app: str,
    *,
    dry_run: bool = True,
    fixture_prs: list[FixturePR] | None = None,
    github_client: Any = None,
    db_path: Path | None = None,
    merge_method: str = "squash",
    wait_for_ci: bool = True,
    delete_branch_after_merge: bool = True,
    self_edit_gate: Any = None,
    patch_provider: Any = None,
    escalate: Any = None,
    merge_fn: Any = None,
    pr_merged_query: Any = None,
    merge_commit_sha_provider: Any = None,
    fast_forward_fn: Any = None,
    push_to_main_preflight_fn: Any = None,
    pr_checks_query: Any = None,
    ci_log_fetch: Any = None,
    watch_only: bool = False,
) -> list[MergeAction]:
    """Single pass of the auto-merge worker against ``app``.

    ``draft_pr`` / ``pr`` stories with a PR are not settled on sight: their
    PR's CI is WATCHED first (``_watch_ci_then_deliver``) — a red run goes
    back to dev (≤ ``_MAX_CI_FIX_CYCLES``), green or exhausted settles to
    ``DELIVERED_PR``. ``pr_checks_query`` / ``ci_log_fetch`` are its test
    seams (default ``_query_pr_checks`` / ``_fetch_ci_failure_logs``).

    ``watch_only=True`` runs ONLY that watch and touches nothing else (no
    merge, no gate, no CI-fix for merging levels). The orchestrator uses it
    when ``auto_merge.enabled`` is false: the watch never merges, and without
    it a ``draft_pr`` / ``pr`` story would sit in ``pr_open`` forever.

    DELIVERY LEVELS (``factory/chain/delivery_gate.py``): a story is merged
    only when its recorded level is ``auto_merge`` (``gh pr merge``) or
    ``push_to_main`` (gates, then a fast-forward of the default branch via
    ``fast_forward_fn``). Any other level — and any DRAFT PR — is never merged
    and never marked ready; a mergeable-state story at such a level is settled
    to its ``DELIVERED_*`` end state instead. Before a ``push_to_main`` story is
    even evaluated, ``push_to_main_preflight_fn`` (default
    ``delivery_gate.push_to_main_preflight``) applies the main-green hold and
    refuses a base branch guarded by required checks / a required PR — see
    ``_push_to_main_preflight_gate``.

    ``self_edit_gate`` / ``patch_provider`` / ``escalate`` are injection seams
    for the chain-side factory self-edit staging gate (``_evaluate_self_edit_gate``);
    they default to the real ``staging.gate_self_edit`` / ``gh pr diff`` /
    ``escalation.notify_escalation`` implementations. Tests pass fakes to drive
    the healthy / unhealthy / infra-failure / forbidden branches without cloning
    the factory or touching GitHub.

    Returns a ``MergeAction`` per PR evaluated. Tests pass
    ``fixture_prs`` to drive the decision logic without GitHub.

    In real-run with ``github_client`` set, the worker enumerates open
    PRs via the GH API and converts them to ``FixturePR`` records. (The
    enumeration code path lives behind a ``# pragma: no cover`` guard —
    full integration tests need a live GH; out of scope for Phase 4.)
    """
    root = Path(software_factory_root)
    db = db_path or (root / "state" / "factory.db")
    cfg = load_app_config(app, root)

    fixtures: list[FixturePR] = list(fixture_prs or [])

    def _story_worktree(root: Path, app: str, db_story: StoryRecord | None) -> Path | None:
        """The story's chain worktree, RECREATED on demand — command gates
        (smoke-green boots the PR's OWN code) need a local tree to run in.
        Worktrees are keyed by GITHUB ISSUE NUMBER, not the db row id (see
        handlers._writing_worktree). Existence alone isn't enough: the
        pruner reaps worktrees of waiting-state stories, which left PR 226
        permanently unmergeable on 'missing smoke-green' (2026-07-18) —
        ensure_worktree_for_story is idempotent and checks the story's
        branch back out from origin when the tree is gone."""
        if db_story is None:
            return None
        try:
            import subprocess

            from factory.app_config import resolve_app_repo_path
            from factory.chain.worktree import ensure_worktree_for_story

            source_repo = resolve_app_repo_path(cfg, root)
            wt = ensure_worktree_for_story(
                source_repo,
                software_factory_root=root,
                app=app,
                story_id=db_story.github_issue_number,
                slug=db_story.slug,
                base_branch=cfg.default_branch or "main",
            )
            # Fetch-before-trust: the gate must evaluate the EXACT commit that
            # will be squash-merged — origin/<feature_branch> — not whatever
            # local ref the worktree reuse path happened to leave checked out.
            # gh pr update-branch (_attempt_pr_reconcile) writes a merge commit
            # straight to origin, and other worktrees/rebases can advance the
            # remote tip, leaving the local feature ref behind; without this
            # sync the smoke/tests gates boot STALE code while gh pr merge
            # merges the real tip (the 2026-07-18 stale-worktree gate bug).
            # Best-effort: only resets when origin/<feature> resolves.
            from factory.chain.branch import feature_branch_name

            feat = db_story.github_branch or (
                feature_branch_name(db_story.github_issue_number, db_story.slug)
                if db_story.github_issue_number is not None
                else None
            )
            if feat:
                fetched = subprocess.run(
                    ["git", "fetch", "origin", feat],
                    cwd=str(wt),
                    check=False,
                    capture_output=True,
                    timeout=60,
                )
                if fetched.returncode == 0:
                    subprocess.run(
                        ["git", "reset", "--hard", f"origin/{feat}"],
                        cwd=str(wt),
                        check=False,
                        capture_output=True,
                        timeout=60,
                    )
            # Refresh the branch with the CURRENT base before gates run. A
            # PR that lingered through review cycles goes stale as siblings
            # merge; its smoke gate then boots an old backend against the
            # advanced shared-db schema and fails with false 500s (PR 226,
            # 2026-07-18: register 500 pre-merge, full green after merging
            # main). Conflict → abort and evaluate as-is (the conflicting-PR
            # path handles those). Best-effort throughout.
            base = cfg.default_branch or "main"
            subprocess.run(
                ["git", "fetch", "origin", base],
                cwd=str(wt),
                check=False,
                capture_output=True,
                timeout=60,
            )
            merged = subprocess.run(
                ["git", "merge", "--no-edit", f"origin/{base}"],
                cwd=str(wt),
                capture_output=True,
                timeout=120,
            )
            if merged.returncode != 0:
                subprocess.run(
                    ["git", "merge", "--abort"],
                    cwd=str(wt),
                    check=False,
                    capture_output=True,
                    timeout=60,
                )
            return wt
        except Exception:
            return None

    if not fixtures and github_client is None:
        # No explicit fixtures and no GH client. Synthesize fixtures from
        # local StoryRecords that landed in a mergeable state — this is
        # the path the orchestrator's end-of-tick hook uses to surface
        # candidate merges from the chain itself.
        eng = _engine(db)
        with Session(eng) as session:
            mergeable_stories = session.exec(
                select(StoryRecord).where(
                    StoryRecord.app == app,
                    StoryRecord.state.in_(list(_MERGEABLE_STATES)),  # type: ignore[attr-defined]
                )
            ).all()
        for db_story in mergeable_stories:
            pr_no = db_story.github_pr_number
            if (
                pr_no is not None
                and pr_no > 0
                and watches_ci_before_delivery(
                    delivery_gate.story_level(db_story, cfg, root, db, persist=not dry_run)
                )
            ):
                # draft_pr / pr: only the CI watch acts on this story, and it
                # reads the PR's checks itself. Skip the gh head/files/draft
                # queries and, above all, ``_story_worktree`` — it merges the
                # base into the story worktree, a local merge commit the next
                # CI-fix push would then publish onto the human's PR.
                fixtures.append(
                    FixturePR(
                        pr_number=int(pr_no),
                        head_sha=f"local-{db_story.id}",
                        base_branch=cfg.default_branch or "main",
                        story=db_story,
                    )
                )
                continue
            if watch_only:
                continue
            if (pr_no is None or pr_no <= 0) and delivery_gate.story_level(
                db_story, cfg, root, db, persist=not dry_run
            ) is DeliveryLevel.PUSH_TO_MAIN:
                # push_to_main: NO PR by design. Provenance comes from the
                # story worktree itself — the exact commit the gates will run
                # against and the fast-forward will publish — never from gh
                # and never a synthetic ``local-N`` (which the oracle
                # provenance gate rightly refuses).
                p2m_root = _story_worktree(root, app, db_story)
                p2m_head, p2m_files = delivery_gate.worktree_head_and_files(
                    p2m_root, cfg.default_branch or "main"
                )
                fixtures.append(
                    FixturePR(
                        pr_number=-(db_story.id or 0),
                        head_sha=p2m_head or f"local-{db_story.id}",
                        base_branch=cfg.default_branch or "main",
                        labels=[],
                        files_changed=p2m_files or [],
                        ci_state=None,
                        story=db_story,
                        repo_root=p2m_root,
                    )
                )
                continue
            if pr_no is None:
                # Docs chain may reach PR_OPEN in dry-run without a real
                # PR number; synthesize a placeholder so the worker still
                # records a decision row the operator can audit.
                pr_no = -(db_story.id or 0)
            # Real provenance for a real PR: resolve the ACTUAL head sha and
            # changed-file list via gh, never a hardcoded/synthetic stand-in.
            # Found 2026-08-07: this loop always synthesized
            # ``head_sha=f"local-{id}"`` and ``files_changed=[]`` regardless of
            # whether a real PR existed, which (a) made the acceptance-oracle
            # provenance gate — deliberately never waivable — block every
            # real-run story FOREVER (``local-N`` can never match
            # ``red_green._SHA_RE``), and (b) made ``tests-meaningful`` /
            # ``canonical-paths-only`` pass VACUOUSLY (nothing in an empty file
            # list to scan). Both resolvers return ``None`` on any failure —
            # never a fabricated sha or a silently-empty file list — so the
            # placeholder-number path below (no real PR at all) and a genuine
            # gh failure both fall back identically, and are indistinguishable
            # from what dry-run/no-PR fixtures already looked like.
            resolved_head_sha: str | None = None
            resolved_files: list[str] | None = None
            # Draft guard on THIS path too (review 2026-11-02, nice 10): the
            # gh-list path reads ``pr.draft``, but DB-synthesized fixtures
            # defaulted to "not a draft". Unknown → not a draft: GitHub itself
            # refuses to merge (or arm auto-merge on) a draft PR, so this guard
            # is defense in depth and a gh hiccup must not freeze the queue.
            resolved_draft = False
            if pr_no > 0:
                resolved_draft = bool(_query_pr_is_draft(app_config=cfg, pr_number=int(pr_no)))
                resolved_head_sha = _query_pr_head_sha(app_config=cfg, pr_number=int(pr_no))
                resolved_files = _query_pr_files_changed(app_config=cfg, pr_number=int(pr_no))
            # Point command gates (smoke-green boots the PR's OWN code) at
            # the story's chain worktree when it still exists. Without this,
            # repo_root=None made the required smoke gate unevaluable and
            # every synthesized PR sat unmergeable on 'missing smoke-green'
            # (observed 2026-07-18).
            fixtures.append(
                FixturePR(
                    is_draft=resolved_draft,
                    pr_number=int(pr_no),
                    # The honest ``local-<id>`` placeholder — NEVER a
                    # fabricated hex string — when there is no real PR or gh
                    # could not resolve one; ``head_contains_sha`` reads that
                    # shape as "not a commit id", which is the truth.
                    head_sha=resolved_head_sha or f"local-{db_story.id}",
                    base_branch=cfg.default_branch or "main",
                    labels=[],
                    files_changed=resolved_files or [],
                    # Real CI conclusion via gh, never a hardcoded pass. Falls
                    # back to None (→ gate reads the recorded flag) for
                    # placeholder PR numbers or when no checks are configured.
                    ci_state=_query_ci_state(app_config=cfg, pr_number=int(pr_no)),
                    story=db_story,
                    repo_root=_story_worktree(root, app, db_story),
                )
            )
    if (
        not fixtures and not dry_run and github_client is not None and not watch_only
    ):  # pragma: no cover - real GH
        repo = github_client.get_repo(cfg.repo)
        for pr in repo.get_pulls(state="open"):
            # Resolve the StoryRecord for this PR, if any.
            eng = _engine(db)
            with Session(eng) as session:
                rows = session.exec(
                    select(StoryRecord).where(
                        StoryRecord.app == app, StoryRecord.github_pr_number == int(pr.number)
                    )
                ).all()
            story_row = rows[0] if rows else None
            fixtures.append(
                FixturePR(
                    is_draft=bool(getattr(pr, "draft", False)),
                    pr_number=int(pr.number),
                    head_sha=str(pr.head.sha),
                    base_branch=str(pr.base.ref),
                    labels=[lbl.name for lbl in pr.labels],
                    files_changed=[f.filename for f in pr.get_files()],
                    ci_state=_query_ci_state(app_config=cfg, pr_number=int(pr.number)),
                    story=story_row,
                    repo_root=_story_worktree(root, app, story_row),
                )
            )

    actions: list[MergeAction] = []
    for f in fixtures:
        # draft_pr / pr CI WATCH — before the draft guard below (a draft_pr
        # story's PR IS a draft, and its CI still has to be watched; the watch
        # never merges and never marks it ready). Real-run, real PRs, live
        # stories only; everything else keeps the paths below.
        if (
            not dry_run
            and f.story is not None
            and f.pr_number > 0
            and f.story.state in _MERGEABLE_STATES
        ):
            w_level = delivery_gate.story_level(f.story, cfg, root, db, persist=True)
            if w_level is not None and watches_ci_before_delivery(w_level):
                actions.append(
                    _watch_ci_then_deliver(
                        story=f.story,
                        fixture=f,
                        level=w_level,
                        cfg=cfg,
                        app=app,
                        root=root,
                        db=db,
                        checks_query=pr_checks_query,
                        log_fetch=ci_log_fetch,
                    )
                )
                continue
        if watch_only:
            continue
        # DELIVERY-LEVEL GUARD — before the hold, the CI-failure loop and the
        # gate evaluation, because every one of those can act on a PR (re-run
        # checks, re-dispatch dev, close it, merge it). A draft PR is never
        # touched; a story whose recorded level does not merge is settled to
        # its DELIVERED_* end state and never merged.
        if f.is_draft:
            actions.append(
                MergeAction(
                    app=app,
                    pr_number=f.pr_number,
                    merged=False,
                    reason="draft PR: never merged or marked ready by the factory",
                )
            )
            continue
        f_level = (
            delivery_gate.story_level(f.story, cfg, root, db, persist=not dry_run)
            if f.story is not None
            else None
        )
        if f_level is not None and not f_level.merges:
            reason = f"delivery level {f_level.value}: never merged by the factory"
            if not dry_run and f.story is not None and f.story.state in _MERGEABLE_STATES:
                try:
                    reason = _settle_non_merging_story(
                        story=f.story,
                        level=f_level,
                        app_config=cfg,
                        root=root,
                        db=db,
                        reason="recorded delivery level does not merge",
                    )
                except Exception as exc:  # noqa: BLE001 - never merge on a settle error
                    reason = f"{reason}; settle failed: {exc!r}"
                    reason = _bound_settle_failures(f.story, root, db, reason)
            actions.append(MergeAction(app=app, pr_number=f.pr_number, merged=False, reason=reason))
            continue
        is_p2m = f_level is DeliveryLevel.PUSH_TO_MAIN and f.pr_number <= 0
        if is_p2m and not dry_run and f.story is not None:
            p2m_action = _push_to_main_preflight_gate(
                story=f.story,
                fixture=f,
                app=app,
                cfg=cfg,
                root=root,
                db=db,
                preflight_fn=push_to_main_preflight_fn,
            )
            if p2m_action is not None:
                actions.append(p2m_action)
                continue
        # E6 STAGE 2 — ENVIRONMENT HOLD (main is red). Checked BEFORE the
        # CI-failure loop AND before ``_evaluate_one_pr``, because both of the
        # downstream sinks would destroy the queue on a red main:
        #   * ``_handle_ci_failure`` -> dev dispatch, then PR close + terminal
        #     park two ticks later (see ``_CI_STATE_HOLD``);
        #   * ``_evaluate_one_pr`` -> ``tests-green`` fails (ci_state != success)
        #     -> a ``merge_gates_failed`` event with missing_labels every tick ->
        #     ``_MAX_GATE_BLOCK_CYCLES`` -> ``_park_gate_block_exhausted``.
        # Skipping the whole evaluation is what makes "the story simply stays
        # where it is" true rather than merely intended. Real-run only, real PRs
        # only — dry-run previews and placeholder fixtures behave as before.
        # The (b) rerun puts a held PR's checks back in flight: ci_state reads
        # ``pending`` until they finish. That window must STAY inside the hold
        # (adversarial review 2026-08-10, blockers 1+2): evaluating it would
        # run the full gate set against a possibly-still-red main — for the
        # factory app that is `uv run pytest` in a worktree that just merged
        # red main, i.e. a guaranteed merge_gates_failed — and that event both
        # counts toward _MAX_GATE_BLOCK_CYCLES (the park the hold exists to
        # prevent) and breaks the episode boundary the (a) 30-min clock walks.
        # Write NOTHING: the episode's last event stays a hold event, and the
        # finished re-run resolves to success (normal evaluation) or hold
        # (episode continues) on a later tick. Ordinary pending PRs (not in a
        # hold episode) are untouched.
        if (
            not dry_run
            and f.pr_number > 0
            and f.ci_state == "pending"
            and _in_hold_episode(f.story, root)
        ):
            actions.append(
                MergeAction(
                    app=app,
                    pr_number=f.pr_number,
                    merged=False,
                    reason=(
                        "held: main-green checks re-running — still inside the "
                        "hold episode; story untouched"
                    ),
                    gates_passed=[],
                    blocking_labels=[],
                )
            )
            continue

        # A hold that has genuinely ENDED (checks resolved to success or
        # failure) must not leave its (a) escalation text behind: a merged
        # story would carry "main is red" into deploy_pending, and a later
        # blocked_deploy_failed would show the stale hold text instead of the
        # real deploy failure (adversarial review 2026-08-10, finding 5).
        # Clearing is prefix-guarded, so no other mechanism's reason is wiped.
        if (
            not dry_run
            and f.pr_number > 0
            and f.story is not None
            and f.ci_state in ("success", "failure")
            and (f.story.last_rejection_reason or "").startswith(_HOLD_REASON_PREFIX)
        ):
            _set_hold_reason(f.story, db, None)

        if not dry_run and f.pr_number > 0 and f.ci_state == _CI_STATE_HOLD:
            hold_is_new = _handle_main_green_hold(
                story=f.story,
                pr_number=f.pr_number,
                root=root,
                # base_branch is pinned to "main": the main-green job itself
                # hardcodes `repos/$REPO/commits/main`, so watching any other
                # base would rerun on the wrong trigger (finding 9).
                app_config=cfg,
                base_branch="main",
                db_path=db,
            )
            action = MergeAction(
                app=app,
                pr_number=f.pr_number,
                merged=False,
                reason=(
                    f"held: main is red (required `{_MAIN_GREEN_CHECK_NAME}` check "
                    "failing) — environment hold, not a PR defect; story untouched, "
                    "re-checked next tick"
                ),
                gates_passed=[],
                blocking_labels=[],
            )
            # PERSIST ON TRANSITION ONLY. The in-memory action is always
            # returned (the tick's own report must not lie about what it did
            # with this PR), but the ``merge_actions`` ROW is written once per
            # hold episode — see ``_handle_main_green_hold``. A per-tick row is
            # the PR-88 unbounded-row pathology at 1,440 rows/PR/day.
            if hold_is_new:
                _record_merge_action(action, f.head_sha, db)
            actions.append(action)
            continue

        # CI-failure -> dev re-fix loop. Real CI reporting "failure" used to
        # just make the merge gate decline; now the failure is fed back to
        # dev BEFORE the normal gate/merge decision runs, so a story with a
        # broken PR gets a chance to actually converge instead of sitting in
        # PR_OPEN forever waiting for a human to notice. Guarded to real,
        # non-placeholder PRs in real-run only — synthesized-fixture/dry-run
        # tests (negative ``pr_number``, ``dry_run=True``) are unaffected.
        if (
            not dry_run
            and f.pr_number > 0
            and f.ci_state == "failure"
            and f.story is not None
            and f.story.state in _MERGEABLE_STATES
        ):
            ci_outcome = _handle_ci_failure(
                story=f.story,
                app_config=cfg,
                pr_number=f.pr_number,
                db=db,
                root=root,
            )
            if ci_outcome in ("redispatched", "parked"):
                reason = (
                    "real CI failed; story re-dispatched to dev for a fix"
                    if ci_outcome == "redispatched"
                    else (
                        "CI-recovery exhausted; PR closed + story parked "
                        "(blocked_ci_unresolved) so it stops re-evaluating every tick"
                    )
                )
                action = MergeAction(
                    app=app,
                    pr_number=f.pr_number,
                    merged=False,
                    reason=reason,
                    gates_passed=[],
                    blocking_labels=[],
                )
                _record_merge_action(action, f.head_sha, db)
                actions.append(action)
                continue

        action = _evaluate_one_pr(
            app=app,
            fixture=f,
            app_config=cfg,
            dry_run=dry_run,
            github_client=github_client,
            merge_method=merge_method,
            wait_for_ci=wait_for_ci,
            delete_branch_after_merge=delete_branch_after_merge,
            software_factory_root=root,
            self_edit_gate=self_edit_gate,
            patch_provider=patch_provider,
            escalate=escalate,
            merge_fn=merge_fn,
            pr_merged_query=pr_merged_query,
            db_path=db,
            merge_commit_sha_provider=merge_commit_sha_provider,
            push_to_main=is_p2m,
            fast_forward_fn=fast_forward_fn,
        )
        _record_merge_action(action, f.head_sha, db)
        if action.push_to_main_refused and not dry_run and f.story is not None:
            # FAIL SAFE: a refused fast-forward behaves as level ``pr`` — the
            # work is offered as a ready PR and never merged by the factory.
            # The downgrade is recorded on the story so it cannot flip back.
            try:
                prev = f.story.delivery_level
                f.story.delivery_level = DeliveryLevel.PR.value
                from factory.chain.event_log import log_story_event

                log_story_event(
                    f.story.id,
                    delivery_gate.EVENT_LOWERED,
                    {"from": prev, "to": DeliveryLevel.PR.value, "reason": action.reason},
                    software_factory_root=root,
                    slug_hint=f.story.slug,
                )
                action.reason = _settle_non_merging_story(
                    story=f.story,
                    level=DeliveryLevel.PR,
                    app_config=cfg,
                    root=root,
                    db=db,
                    reason=action.reason,
                )
            except Exception as exc:  # noqa: BLE001 - the story stays unmerged either way
                action.reason = f"{action.reason}; pr fallback failed: {exc!r}"
        # A factory self-edit refused by the chain-side staging gate: the live
        # factory was never touched. Sink the story to a blocked/attention state
        # so the worker stops retrying it and an operator (or the FMS) picks it
        # up. The escalation was already emitted inside the gate.
        if action.staging_blocked and f.story is not None and f.story.state in _MERGEABLE_STATES:
            from factory.chain.state_machine import EVENT_PR_UNMERGEABLE, advance

            try:
                f.story.state = advance(f.story, EVENT_PR_UNMERGEABLE).value
                f.story.error = (
                    f"auto-merge refused a factory self-edit: PR #{action.pr_number} "
                    f"did not pass the chain-side staging gate "
                    f"({action.staging_status}). The live factory was NOT touched; "
                    f"escalated for human review."
                )
                eng = _engine(db)
                with Session(eng) as session:
                    session.add(f.story)
                    session.commit()
                    # Refresh while the session is open so the caller can still
                    # read ``f.story``'s attributes afterwards (commit() expires
                    # them → DetachedInstanceError once the session closes).
                    session.refresh(f.story)
            except Exception:  # noqa: BLE001 - state sink is best-effort
                pass
        # On a successful merge, enqueue a deploy candidate for the
        # post-merge deploy worker. The deploy itself runs in a separate
        # tick so the merge step stays focused.
        if action.merged:
            # Fire a context-refresh async — the BMAD context tree must
            # reflect the just-merged code, and we don't want the next
            # persona invocation reading stale ``context/project.md``.
            # The refresh runs in a background thread (or synchronously
            # in dry-run for deterministic tests) and is fully isolated
            # from the merge worker's return path.
            #
            # GATED OFF by default: the current refresh is a placeholder that
            # only appends a ``<!-- factory:context-refresh -->`` marker to
            # the same context/ files each merge, piling up as mutually
            # CONFLICTING orphan PRs with no merge path (they carry no
            # StoryRecord). Re-enable via AutoMergeConfig.context_refresh_enabled
            # once it's swapped for a real onboarder/tech_writer invocation.
            _refresh_on = False
            try:
                from factory.settings.loader import load_settings as _ls

                _refresh_on = _ls(root).auto_merge.context_refresh_enabled
            except Exception:
                _refresh_on = False
            if _refresh_on:
                try:
                    from factory.chain.context_refresh import schedule_post_merge_refresh

                    merged_scope = f.story.scope if f.story is not None else None
                    schedule_post_merge_refresh(
                        app=app,
                        merged_pr_number=action.pr_number,
                        merged_scope=merged_scope,
                        software_factory_root=root,
                        db_path=db,
                        sync=dry_run,
                        github_client=github_client,
                        # Dry-run uses synthetic fixtures with no real GH repo
                        # to push to; suppress PR open there so we exercise
                        # the worktree+commit path without network.
                        open_pr=not dry_run,
                    )
                except Exception:
                    # Never let a refresh failure poison the merge return.
                    # The refresh has its own event-log path; the merge worker
                    # cares about merging, not about context plumbing.
                    pass
            # Lazy import to avoid the auto-merge module importing the
            # deploy package at module load (the deploy package imports
            # back into the chain, which would risk a cycle).
            from factory.deploy.orchestrator import enqueue_deploy

            enqueue_deploy(
                app=app,
                sha=f.head_sha,
                merged_pr_number=action.pr_number,
                software_factory_root=root,
                db_path=db,
            )
            # Flip the story state to DEPLOY_PENDING so the orchestrator
            # tick picks up handle_deploy. Uses the state_machine's
            # advance() so an illegal transition surfaces loudly rather
            # than silently mis-updating the row.
            story = f.story
            if story is None:
                # Look up by PR number from the DB if the fixture didn't
                # carry one.
                eng = _engine(db)
                with Session(eng) as session:
                    rows = session.exec(
                        select(StoryRecord).where(
                            StoryRecord.app == app,
                            StoryRecord.github_pr_number == action.pr_number,
                        )
                    ).all()
                story = rows[0] if rows else None
            if story is not None and (action.state_committed or story.state in _MERGEABLE_STATES):
                from factory.chain.state_machine import EVENT_MERGED, advance

                try:
                    if not action.state_committed:
                        # Storyless-fixture / legacy path. Still a
                        # compare-and-set: never write over a state another
                        # process (job cancel) committed meanwhile.
                        new_state = advance(story, EVENT_MERGED)
                        if story.id is not None and not delivery_gate.cas_story_state(
                            db, story.id, _MERGEABLE_STATES, new_state.value
                        ):
                            raise RuntimeError("story left the mergeable states; not overwritten")
                        story.state = new_state.value
                except Exception:
                    # State-machine refusal is non-fatal here — the deploy
                    # queue entry still drives the work; the story will be
                    # reconciled by the orchestrator on a later tick.
                    pass
                else:
                    # Dual-draft cleanup: if ``story`` was one of two
                    # draft-alternative interpretations of the same
                    # direction, close the losing sibling's issue now that
                    # this one has won the merge (audit 2026-07-18, leak 4
                    # of 4 — the abandoned draft used to stay open
                    # forever). Best-effort/idempotent; never raises.
                    from factory.chain.dual_draft import close_abandoned_draft_sibling

                    close_abandoned_draft_sibling(story, cfg, root, db, github_client, dry_run)
        elif (
            not dry_run
            and not action.merged
            and action.reason.startswith("gh merge failed")
            and f.story is not None
            and f.story.state in _MERGEABLE_STATES
            and _pr_terminally_unmergeable(
                app_config=cfg, pr_number=action.pr_number, github_client=github_client
            )
        ):
            # The PR can never be merged AS-IS. Before sinking, make ONE safe
            # attempt to reconcile a merely-stale branch by merging the base in
            # (gh pr update-branch — no force-push). Many "un-mergeable" PRs are
            # only BEHIND a moved base, not truly conflicting; this recovers them
            # without human intervention. Gated to a single attempt per story via
            # the event log so a genuinely-conflicting PR can't loop forever.
            from factory.chain.event_log import log_story_event, read_story_events
            from factory.chain.state_machine import EVENT_PR_UNMERGEABLE, advance

            _already_tried = any(
                e.get("event") == "auto_merge_reconcile_attempt"
                for e in read_story_events(
                    f.story.id, software_factory_root=root, slug_hint=f.story.slug
                )
            )
            if (
                not _already_tried
                and not dry_run
                and _attempt_pr_reconcile(app_config=cfg, pr_number=action.pr_number)
            ):
                # Branch advanced — skip sinking; re-evaluate mergeability on the
                # next tick instead of blocking.
                try:
                    log_story_event(
                        f.story.id,
                        "auto_merge_reconcile_attempt",
                        {"pr_number": action.pr_number, "result": "branch_updated"},
                        software_factory_root=root,
                        slug_hint=f.story.slug,
                    )
                except Exception:  # noqa: BLE001
                    pass
            else:
                # Reconcile failed (or was already tried). Before PARKING, if
                # this is a GENUINE content conflict (not closed/merged, and not
                # merely BEHIND — update-branch above handles behind), try to
                # REBUILD the change on a FRESH branch cut from current main: a
                # branch cut from an older main re-conflicts at PR-open's
                # ``git merge origin/main`` forever otherwise. Bounded by
                # ``_MAX_CONFLICT_REBUILDS`` (event-log cap) so a genuinely
                # unresolvable conflict parks after N rebuilds and never loops.
                # FAIL-SAFE: any error here falls back to the park below.
                _rebuilt = False
                try:
                    if not dry_run and _pr_is_conflicting(
                        app_config=cfg, pr_number=action.pr_number
                    ):
                        _outcome = _handle_pr_conflict_rebuild(
                            story=f.story,
                            app_config=cfg,
                            pr_number=action.pr_number,
                            db=db,
                            root=root,
                        )
                        if _outcome == "rebuild_redispatched":
                            _rebuilt = True
                            try:
                                log_story_event(
                                    f.story.id,
                                    "auto_merge_reconcile_attempt",
                                    {
                                        "pr_number": action.pr_number,
                                        "result": "conflict_rebuild_redispatch",
                                    },
                                    software_factory_root=root,
                                    slug_hint=f.story.slug,
                                )
                            except Exception:  # noqa: BLE001
                                pass
                except Exception:  # noqa: BLE001 - never break the tick; park below
                    _rebuilt = False
                if not _rebuilt:
                    # Not a conflict, rebuild cap exhausted, or the reset failed.
                    # Sink so the worker stops retrying and drive_chain can drain
                    # to DONE.
                    try:
                        if not dry_run and not _already_tried:
                            log_story_event(
                                f.story.id,
                                "auto_merge_reconcile_attempt",
                                {"pr_number": action.pr_number, "result": "still_conflicting"},
                                software_factory_root=root,
                                slug_hint=f.story.slug,
                            )
                        f.story.state = advance(f.story, EVENT_PR_UNMERGEABLE).value
                        f.story.error = (
                            f"auto-merge gave up: PR #{action.pr_number} is terminally "
                            f"un-mergeable (closed/merged/conflicting) after a branch-"
                            f"update attempt. Needs regeneration or human resolution."
                        )
                        eng = _engine(db)
                        with Session(eng) as session:
                            session.add(f.story)
                            session.commit()
                    except Exception:
                        pass
        # Part 2 — the per-PR evaluation refused to merge this dual-draft
        # alternative because a SIBLING already shipped. Terminally supersede
        # this loser and close its PR so it can never merge a redundant second
        # interpretation. DIRECT state assignment (not an ``advance()`` edge): a
        # supersede can originate from ANY in-flight state, mirroring
        # ``close_abandoned_draft_sibling``'s own terminal park. Best-effort and
        # idempotent — never raises out of the merge worker.
        if action.superseded_by_sibling and f.story is not None:
            try:
                f.story.state = StoryState.SUPERSEDED_BY_SIBLING.value
                f.story.error = (
                    f"superseded: a dual-draft sibling already shipped; PR "
                    f"#{action.pr_number} refused to merge a redundant "
                    f"interpretation of the same direction."
                )
                f.story.updated_at = datetime.now(UTC).isoformat()
                eng = _engine(db)
                with Session(eng) as session:
                    session.add(f.story)
                    session.commit()
                    session.refresh(f.story)
            except Exception:  # noqa: BLE001 - state park is best-effort
                pass
            # Close this loser's open PR so it can never auto-merge. Reuses the
            # dual-draft PR-close helper (``gh pr close --delete-branch``); a
            # closed PR cannot merge. Skipped in dry-run / for a placeholder PR.
            if not dry_run and f.pr_number > 0:
                try:
                    import subprocess

                    from factory.chain.dual_draft import _close_loser_pr

                    _close_loser_pr(int(f.pr_number), cfg.repo, subprocess.run)
                except Exception:  # noqa: BLE001 - bookkeeping, never break merge
                    pass
        # Emit auto_merge_attempt signal — best-effort, never raises.
        try:
            from factory.manager.signals import write_git_event as _wge_am

            _story_id_am: int | None = f.story.id if f.story is not None else None
            # An auto-merge that was ENABLED but is still awaiting required
            # checks is NOT an error — the merge is pending, not failed.
            # Reporting it as an error every tick would spam the L1 watcher
            # (concern-spam) for a healthy in-flight PR.
            _ok = action.merged or action.auto_merge_enabled or action.superseded_by_sibling
            _wge_am(
                kind="auto_merge_attempt",
                story_id=_story_id_am,
                pr_number=action.pr_number,
                result="ok" if _ok else "error",
                error=None if _ok else action.reason,
                software_factory_root=root,
            )
        except Exception:  # noqa: BLE001
            pass
        # Emit a dedicated pr_merge signal when the merge succeeded so L1
        # agents can distinguish "merge happened" from the broader
        # "auto_merge_attempt" record (which covers both attempts and
        # no-ops). commit_sha is not known post-squash-merge without a
        # GH API call; omit it here — the sha is derivable from git log
        # against the base branch if needed.
        if action.merged:
            try:
                from factory.manager.signals import write_git_event as _wge_pm

                _story_id_pm: int | None = f.story.id if f.story is not None else None
                _wge_pm(
                    kind="pr_merge",
                    story_id=_story_id_pm,
                    pr_number=action.pr_number,
                    result="ok",
                    software_factory_root=root,
                )
            except Exception:  # noqa: BLE001
                pass
        actions.append(action)
    return actions
