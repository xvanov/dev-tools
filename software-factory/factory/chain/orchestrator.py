"""Chain orchestrator — drive in-flight stories one tick at a time.

The orchestrator inspects every non-terminal StoryRecord for an app and
invokes the appropriate handler for its current state. One ``tick()`` call
advances each story by ONE handler (not the full chain). Phase 3+ will hook
``tick()`` to webhook events; for Phase 2 it's manual via ``factory tick``.

Phase 3 wires the **settings enforcer** in front of every handler dispatch.
``can_dispatch`` reads the current factory mode + caps from
``factory_settings.yaml`` and the local state.db, and may reject a job with
a structured ``rejected_reason`` (e.g. ``daily_spend_cap_exceeded``). When
rejected, the orchestrator records the reason on the StoryRecord and skips
the story for this tick; an operator can inspect via ``factory why``.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Session, create_engine, select

from factory.app_config import AppConfig, load_app_config
from factory.chain import handlers as H
from factory.chain.auto_merge import MergeAction, auto_merge_tick
from factory.chain.ci_health import CiHealthResult, main_ci_health_tick
from factory.chain.detector_watch import DetectorWatchResult, detector_watch_tick
from factory.chain.event_log import log_story_event
from factory.chain.state_machine import (
    DELIVERED_UNMERGED_STATES,
    DEP_DEFER_CAP_REASON_PREFIX,
    EVENT_BUDGET_EXCEEDED,
    StoryRecord,
    StoryState,
    advance,
    is_dependency_cap_parked,
)
from factory.chain.step_events import emit_chain_step
from factory.directions.parser import Direction
from factory.settings.enforcer import can_dispatch
from factory.settings.loader import load_settings
from factory.settings.modes import get_mode
from factory.settings.spend import hour_spend_usd, today_spend_usd

# Handler kinds that have a "bug-fix variant" recognized by the enforcer's
# ``fix-only`` mode. Kept in sync with
# ``factory/settings/enforcer.py:_BUG_FIX_JOB_KINDS``.
_BUG_AWARE_HANDLER_KINDS = {"sm", "dev", "review"}


def _resolve_job_kind(
    story: StoryRecord,
    direction: Direction | None,
    handler_kind: str,
) -> str:
    """Compute the ``job_kind`` to pass to ``can_dispatch``.

    Bug-typed work (``direction.type_tag == "bug"`` or ``story.scope ==
    "bug"``) is appended with a ``-bug`` suffix so the enforcer's
    ``fix-only`` mode permits the dispatch while still blocking feature
    work. The enforcer's ``_mode_blocks`` already understands the suffix;
    this helper is the single producer of the suffixed kinds.

    Returns ``handler_kind`` unchanged for kinds that have no bug variant.
    """
    if handler_kind not in _BUG_AWARE_HANDLER_KINDS:
        return handler_kind
    type_tag = (direction.type_tag if direction is not None else None) or ""
    is_bug = type_tag.lower() == "bug" or story.scope == "bug"
    return f"{handler_kind}-bug" if is_bug else handler_kind


@dataclass
class TickSummary:
    """What happened in this tick."""

    app: str
    dry_run: bool
    stories_advanced: int = 0
    blocked_by_caps: int = 0  # rejected by can_dispatch (mode, cap, rate-limit)
    stories_blocked: int = 0  # blocked mid-chain (BLOCKED state)
    handler_runs: list[tuple[str, str, str]] = field(default_factory=list)
    # ^ (story_slug, from_state, to_state)
    rejected: list[tuple[str, str]] = field(default_factory=list)
    # ^ (story_slug, rejected_reason)
    # Stories the dependency-ordering gate DEFERRED this tick (waiting on a
    # lower-id sibling in their own direction), plus the cap park when the wait
    # ran out. MUST be surfaced: a tick that defers stories and dispatches
    # nothing used to print "No in-flight stories", which reads as "queue empty"
    # while the queue silently rots behind a blocked foundation (2026-07-28,
    # D018 stories 168-171). ^ (story_slug, what it is waiting on)
    deferred: list[tuple[str, str]] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)
    # Rows deliberately quarantined this tick (e.g. an invalid-enum state from
    # a bad manual/manager write). NON-FATAL: they must NOT count toward the
    # failing exit code. A single poisoned row counted as an error crash-looped
    # the self-tick every cycle (2026-07-07, 2026-07-21); a stopped factory is
    # far worse than a quarantined row. Each skip is surfaced to stdout
    # (``skipped=N`` + a yellow line) and emitted once as an ``invalid_state_
    # skipped`` story event. NOTE: there is currently NO automatic reconciler
    # for invalid-enum rows and NO FMS escalation on the skip — a poisoned row
    # persists until an operator repairs it. Closing that gap (a reconcile
    # playbook + a watcher signal) is tracked as a follow-up; do not assume it
    # is handled elsewhere.
    skipped: list[tuple[str, str]] = field(default_factory=list)
    # End-of-tick auto-merge decisions (one entry per PR evaluated).
    # Empty when ``auto_merge.enabled=false`` or no PRs are eligible.
    merges: list[MergeAction] = field(default_factory=list)
    # Post-merge main-branch CI-health monitor result (D004). ``None`` when
    # ``ci_health.enabled=false`` or the factory mode suppresses it.
    ci_health: CiHealthResult | None = None
    # Detector -> direction trigger result (019 AC7 / Flow D). ``None`` when
    # ``detector_watch.enabled=false``, the mode suppresses it, or this was a
    # dry-run tick (the pass is skipped entirely, not merely non-mutating —
    # see the call site).
    detector_watch: DetectorWatchResult | None = None
    # Autonomous issue-hygiene reconcile result (counts of trackers/story issues
    # auto-closed this tick). ``None`` when the ~hourly gate didn't fire, the
    # mode suppressed it, or no GitHub client was available.
    issue_hygiene: dict[str, int] | None = None
    # 019 AC6 — idle-becomes-a-ping. Set whenever ``run_idle_ping_tick`` fired
    # a NEW operator_ping this tick (``{"idle_since", "last_delivered_unit"}``).
    # ``None`` on every other tick: not idle, already pinged this episode,
    # dry-run, a suppressed mode, or the module errored (see ``errors``).
    idle_ping: dict[str, Any] | None = None
    # Deterministic operational-recovery cycle (``factory.manager.recovery.
    # run_recovery_cycle``), reconnected after PR #247 deleted its only caller
    # (``factory/manager/apply.py``). ``None`` unless the cycle actually did
    # something this tick — recovered/escalated an anomaly, skipped one under
    # cooldown/cap, or errored. See ``settings.recovery.enabled``.
    recovery: dict[str, Any] | None = None
    # Poison-escalation (``factory.manager.poison_escalation.
    # escalate_poisoned_rows``), reconnected after the same PR #247 deletion
    # removed its only caller (the L1 watcher). ``None`` unless a persistent
    # poisoned/invalid-enum row was actually escalated (or a prior escalation
    # was suppressed by cooldown) this tick.
    poison_escalation: dict[str, Any] | None = None
    # Phase 7: set to True when tick exits early due to factory halt.
    halted: bool = False
    halt_reason: str | None = None


# Per-state handler dispatch — what to run when a story is in this state.
# Returns the (handler-callable, kwargs-builder). The orchestrator calls the
# handler; the kwargs-builder is responsible for translating per-state
# pre-conditions (e.g. dev_in_progress -> the dev handler is the one that
# transitioned into dev_in_progress, so we don't re-run; only DEV_RETRY and
# the entry states get a handler).
# Per-state handler dispatch — what to run when a story is in this state.
#
# STORY_CREATED is special: which handler runs depends on the story's
# ``chain_kind``. The actual dispatch decision lives in ``_dispatch_for_story``
# so the state machine stays pure. Stories with chain_kind="docs" route to
# ``docs_sm`` here; chain_kind="tdd" (default) routes to ``sm``.
_DISPATCH = {
    StoryState.STORY_CREATED: "sm",  # TDD default; overridden for docs chain
    # Loop-4 (dev-owns-tests): SM_DONE dispatches dev DIRECTLY. The dev persona
    # writes production code + its tests in one pass; there is no separate
    # test_design/test_impl/harness phase.
    StoryState.SM_DONE: "dev",
    StoryState.DEV_RETRY: "dev",
    # When the reviewer pushes back to REVIEWER_REQUESTED_CHANGES, the
    # state machine routes dev_started → DEV_IN_PROGRESS but the
    # dispatcher had no entry, leaving the story stuck. Same handler as
    # the dev-retry path.
    StoryState.REVIEWER_REQUESTED_CHANGES: "dev",
    StoryState.TESTS_GREEN: "review",
    # The speculative ``ux_designer`` persona (never dispatched from
    # anywhere — flow.md-ambiguity detection was never built) was deleted
    # 2026-08-07 as an orphan persona — 019 AC5. SM produces stories as-is.
    StoryState.REVIEWER_DONE: "tech_writer",
    StoryState.TECH_WRITER_DONE: "docs_enforcer",
    # Docs chain dispatch (skips the TDD red→green loop).
    StoryState.DOCS_SM_DONE: "docs_onboarder",
    StoryState.DOCS_ONBOARDER_DONE: "docs_enforcer",
    # S4 (019 fail-silent audit): a failed ``gh pr create`` leaves the story
    # HERE (not PR_OPEN) with ``pr_create_retries`` bumped — this entry is
    # what makes the next tick actually retry PR creation instead of the
    # story silently stranding (PR_OPEN has no dispatch entry at all).
    StoryState.DOCS_ENFORCER_CHECK: "docs_enforcer",
    # Phase 5 — post-merge deploy. The auto-merge worker (and the webhook
    # path) flips a story to DEPLOY_PENDING; from there the orchestrator
    # tick drives handle_deploy.
    StoryState.DEPLOY_PENDING: "deploy",
}


# WS1.1 per-story budget circuit breaker — the dispatch states that burn LLM
# spend. Membership gates the breaker: only a story ABOUT to enter one of these
# (via _dispatch_for_story) is checked. DERIVED from the single source of truth
# (``_DISPATCH``) rather than hand-listed, so a future dispatch state can't
# silently escape the breaker. DEPLOY_PENDING is the one deliberate exclusion:
# it is a dispatch state too, but a merged story must still be allowed to
# deploy — see the EVENT_BUDGET_EXCEEDED transition comment in state_machine.py
# (blocking deploy strands merged work without saving meaningful spend). Every
# state in this set MUST have an EVENT_BUDGET_EXCEEDED edge to
# BLOCKED_BUDGET_EXCEEDED in the transition table; both invariants (the derived
# set and full transition coverage) are asserted in
# tests/chain/test_per_story_budget.py so a new dispatch state fails a test
# rather than crashing a live tick.
_BUDGET_METERED_STATES: frozenset[StoryState] = frozenset(_DISPATCH) - {StoryState.DEPLOY_PENDING}


def _story_ledger_spend_usd(db_path: Path, story_id: int | None) -> float | None:
    """Total ``runs.cost_usd`` attributed to ``story_id`` (D003 per-run ledger).

    This is the authoritative per-story spend: the run rows already carry the
    real cost of every LLM round-trip, so the breaker's ``total_spend_usd``
    accumulator is *derived* from the ledger rather than re-summed by hand
    (no double-counting on retries, self-healing after a crash).

    Returns 0.0 for an unsaved story (no id yet, no runs). Returns ``None`` on
    a read failure — the caller then KEEPS the prior accumulator instead of
    overwriting it. The manager daemon reads this same sqlite file
    concurrently, so a transient "database is locked" is expected and must
    NOT poison ``total_spend_usd``: writing a sentinel (an earlier version
    wrote ``inf``) persisted and then tripped the terminal breaker on a
    perfectly healthy story the next tick — and serialised as non-standard
    ``Infinity`` in the evidence ndjson. We retry a few times to ride out a
    lock, then give up for this cycle; the attempts cap remains the backstop
    while spend is briefly unreadable, so the breaker never spends blind.
    """
    if story_id is None:
        return 0.0
    import time

    from factory.runner import Run

    for attempt in range(3):
        try:
            eng = create_engine(f"sqlite:///{db_path}", echo=False)
            total = 0.0
            with Session(eng) as session:
                for r in session.exec(select(Run).where(Run.story_id == story_id)).all():
                    total += float(r.cost_usd or 0.0)
            return total
        except Exception:  # noqa: BLE001 — transient lock/contention; retry then skip.
            time.sleep(0.05 * (attempt + 1))
    return None


# WS1.1 advance-decay: a canonical monotonic ranking of the happy-path states.
# "Genuine forward progress" == entering a state whose ordinal EXCEEDS the
# highest the story has ever reached (``story.max_progress_ordinal``). The
# ranking is deliberately COARSE around the dev<->review loop: DEV_IN_PROGRESS,
# DEV_RETRY, and REVIEWER_REQUESTED_CHANGES all sit at/below the reviewer tier,
# so a dev<->reviewer ping-pong (tests_green -> reviewer -> requested_changes ->
# dev -> tests_green -> ...) re-treads states already at the high-water mark and
# NEVER counts as progress — exactly the oscillation the breaker must still be
# able to trip. Only crossing a genuine NEW milestone (first tests_green, first
# reviewer pass, an APPROVED review, tech-writer, docs, PR, deploy) decays the
# attempt counter. Error/blocked/*_in_progress-only states are absent -> ordinal
# 0 (never progress). Stored as an int on the story, so the map's VALUES must
# stay stable across versions even if states are added.
_STATE_PROGRESS_ORDINAL: dict[StoryState, int] = {
    StoryState.STORY_CREATED: 1,
    StoryState.SM_IN_PROGRESS: 2,
    StoryState.DOCS_SM_IN_PROGRESS: 2,
    StoryState.SM_DONE: 3,
    StoryState.DOCS_SM_DONE: 3,
    StoryState.DEV_IN_PROGRESS: 4,
    StoryState.DEV_RETRY: 4,  # a retry is NOT progress — same tier as dev
    StoryState.DOCS_ONBOARDER_IN_PROGRESS: 4,
    StoryState.TESTS_GREEN: 5,
    StoryState.REVIEWER_IN_PROGRESS: 6,
    # request-changes bounces back to dev; keep it AT the reviewer tier so the
    # oscillation stays flat (never re-decays once the reviewer tier is reached).
    StoryState.REVIEWER_REQUESTED_CHANGES: 6,
    StoryState.REVIEWER_DONE: 7,  # approved — a genuine milestone
    StoryState.TECH_WRITER_IN_PROGRESS: 8,
    StoryState.TECH_WRITER_DONE: 9,
    StoryState.DOCS_ONBOARDER_DONE: 9,
    StoryState.DOCS_ENFORCER_CHECK: 10,
    StoryState.PR_OPEN: 11,
    StoryState.CI_PENDING: 12,
    StoryState.CI_GREEN: 13,
    StoryState.READY_FOR_MERGE: 14,
    StoryState.DEPLOY_PENDING: 15,
    StoryState.DEPLOYED: 16,
}


def _progress_ordinal(state_value: str) -> int:
    """Happy-path progress ordinal for a state value (0 for error/blocked/unknown)."""
    try:
        return _STATE_PROGRESS_ORDINAL.get(StoryState(state_value), 0)
    except ValueError:
        return 0


def _apply_advance_decay(story: StoryRecord) -> bool:
    """Reset ``total_attempts`` iff ``story`` just made genuine forward progress.

    Genuine progress == the story's CURRENT state ranks strictly higher than any
    state it has previously reached (``max_progress_ordinal``). This is
    monotonic, so each milestone decays the attempt counter AT MOST once and a
    dev<->review oscillation (which never exceeds the high-water mark) never
    decays — so an oscillating/stuck story still exhausts the attempt budget
    while an advancing one is never tripped on attempts. ``total_spend_usd`` is
    deliberately untouched: spend is the absolute cost ceiling.

    Returns True when a decay was applied (caller logs an evidence event).
    """
    ordinal = _progress_ordinal(story.state)
    if ordinal > story.max_progress_ordinal:
        story.max_progress_ordinal = ordinal
        story.total_attempts = 0
        return True
    return False


def _story_budget_breaker_reason(story: StoryRecord, caps: Any) -> str | None:
    """Return a human-readable reason iff the per-story breaker has tripped.

    Pure: reads only the accumulator fields on ``story`` and the caps. The
    caller is responsible for the state transition + evidence event. Only
    budget-metered states are checked so a story that reached DEPLOY_PENDING
    (or a terminal state) is never budget-blocked.
    """
    if StoryState(story.state) not in _BUDGET_METERED_STATES:
        return None
    per_story_attempts = int(getattr(caps, "per_story_attempts", 0) or 0)
    per_story_spend = float(getattr(caps, "per_story_spend_usd", 0.0) or 0.0)
    if per_story_attempts > 0 and story.total_attempts >= per_story_attempts:
        return f"total_attempts={story.total_attempts} >= per_story_attempts={per_story_attempts}"
    if per_story_spend > 0 and story.total_spend_usd >= per_story_spend:
        return (
            f"total_spend_usd={story.total_spend_usd:.4f} >= per_story_spend_usd={per_story_spend}"
        )
    return None


#: Wall-clock budget (seconds) of ONE tick process. Must match the systemd
#: unit's ``TimeoutStartSec`` (``factory-tick@.service``: 3h). Override with
#: env ``FACTORY_TICK_BUDGET_S``.
_DEFAULT_TICK_BUDGET_S = 3 * 3600
#: Headroom a sandbox dispatch needs on top of its own wall clock (+ grading
#: backstop for solo): worktree prep, commit, post-run bookkeeping.
_SANDBOX_TICK_MARGIN_S = 600
_SOLO_TICK_MARGIN_S = _SANDBOX_TICK_MARGIN_S  # back-compat name
#: Consecutive budget deferrals after which the story is surfaced in
#: ``factory inbox`` (``last_rejection_reason``). Still deferred, never parked:
#: the next fresh tick normally runs it.
_MAX_SILENT_BUDGET_DEFERRALS = 3
_BUDGET_DEFER_EVENT = "sandbox_deferred_tick_budget"
_BUDGET_DEFER_REASON_PREFIX = "deferred: "
#: Monotonic clock reading at import, the fallback for "process start".
_IMPORT_MONO = time.monotonic()
#: Handlers that run a long OpenHands sandbox inside the tick process.
_SANDBOX_HANDLERS = frozenset({"dev", "docs_onboarder"})


def _tick_budget_s() -> float:
    try:
        return float(os.environ.get("FACTORY_TICK_BUDGET_S") or _DEFAULT_TICK_BUDGET_S)
    except ValueError:
        return float(_DEFAULT_TICK_BUDGET_S)


def _process_started_mono() -> float:
    """Monotonic timestamp of THIS PROCESS's start (what systemd's
    ``TimeoutStartSec`` counts from), not of the ``tick()`` call: a CLI that
    did other work first, or ticks several apps in one process, has already
    spent some of the budget. Linux ``/proc``; falls back to module import time.
    """
    try:
        with open("/proc/self/stat", encoding="ascii") as fh:
            fields = fh.read().rsplit(")", 1)[1].split()
        start_ticks = float(fields[19])  # field 22 overall: starttime (clock ticks)
        hz = float(os.sysconf("SC_CLK_TCK"))
        with open("/proc/uptime", encoding="ascii") as fh:
            uptime = float(fh.read().split()[0])
        age = max(0.0, uptime - start_ticks / hz)
        return time.monotonic() - age
    except Exception:  # noqa: BLE001 - non-Linux / sandboxed: import time
        return _IMPORT_MONO


def _sandbox_seconds_needed(story: StoryRecord, handler_name: str, settings: Any) -> float:
    from factory.chain.solo import SOLO_DEV_WALL_CLOCK_S, is_solo
    from factory.runner import _GATE_GRADING_GRACE_S, _SANDBOX_WALL_CLOCK_TIMEOUT_S

    if handler_name == "dev" and is_solo(story):
        return SOLO_DEV_WALL_CLOCK_S + _GATE_GRADING_GRACE_S + _SANDBOX_TICK_MARGIN_S
    if handler_name == "dev":
        conv = getattr(settings, "dev_convergence", None)
        per = float(getattr(conv, "dev_sandbox_timeout_s", 0) or _SANDBOX_WALL_CLOCK_TIMEOUT_S)
        return per + _SANDBOX_TICK_MARGIN_S
    return float(_SANDBOX_WALL_CLOCK_TIMEOUT_S) + _SANDBOX_TICK_MARGIN_S


def _sandbox_tick_budget_shortfall(
    story: StoryRecord,
    handler_name: str,
    tick_started_mono: float,
    *,
    settings: Any = None,
    now_mono: float | None = None,
) -> str | None:
    """Why a sandbox dispatch must wait for the next tick, or None to go.

    Dispatch is serial and the systemd tick is killed at ``TimeoutStartSec``.
    A sandbox that cannot finish inside what is left of THIS process's budget
    would be killed mid-run, so it is deferred (no state change, nothing
    spent). Applies to solo dev (5400 s + backstop), chain dev
    (``dev_sandbox_timeout_s``) and the docs onboarder.
    """
    if handler_name not in _SANDBOX_HANDLERS:
        return None
    now = time.monotonic() if now_mono is None else now_mono
    remaining = _tick_budget_s() - (now - tick_started_mono)
    needed = _sandbox_seconds_needed(story, handler_name, settings)
    if remaining >= needed:
        return None
    return (
        f"{handler_name} sandbox needs {needed:.0f}s of tick wall clock, "
        f"{max(0.0, remaining):.0f}s left in this tick — deferred to the next tick"
    )


def _solo_tick_budget_shortfall(
    story: StoryRecord, tick_started_mono: float, *, now_mono: float | None = None
) -> str | None:
    """Solo-only view of :func:`_sandbox_tick_budget_shortfall` (dev handler)."""
    from factory.chain.solo import is_solo

    if not is_solo(story):
        return None
    return _sandbox_tick_budget_shortfall(story, "dev", tick_started_mono, now_mono=now_mono)


def _record_budget_deferral(story: StoryRecord, reason: str, *, db: Path, root: Path) -> int:
    """Log one deferral; after ``_MAX_SILENT_BUDGET_DEFERRALS`` CONSECUTIVE ones
    surface it in ``factory inbox`` via ``last_rejection_reason`` (cleared by the
    orchestrator the moment the story is dispatched). Returns the streak."""
    from factory.chain.event_log import read_story_events

    streak = 1
    if story.id is not None:
        try:
            events = read_story_events(story.id, software_factory_root=root, slug_hint=story.slug)
        except Exception:  # noqa: BLE001
            events = []
        for e in reversed(events):
            if e.get("event") != _BUDGET_DEFER_EVENT:
                break
            streak += 1
    log_story_event(
        story.id,
        _BUDGET_DEFER_EVENT,
        {"reason": reason, "consecutive": streak},
        software_factory_root=root,
        slug_hint=story.slug,
    )
    if streak >= _MAX_SILENT_BUDGET_DEFERRALS:
        note = f"{_BUDGET_DEFER_REASON_PREFIX}{streak}x in a row — {reason}"[:500]
        if story.last_rejection_reason != note:
            story.last_rejection_reason = note
            H.persist_story(story, db)
    return streak


def _solo_spend_precheck(
    story: StoryRecord, *, root: Path, db: Path
) -> tuple[str, str, dict[str, Any]] | None:
    """``None`` = dispatch. Otherwise ``("block"|"defer", reason, basis)``.

    A solo conversation is capped at the remaining per-story / daily / hourly
    budget (``solo.spend_cap_for``). At a cap of 0 it would pause before
    spending and burn a dev retry on an untouched tree, so it is never
    dispatched: per-story exhausted → ``block`` (the terminal budget sink, as
    the WS1.1 breaker does); daily / hourly / unreadable → ``defer`` (the
    window refills, and the streak surfaces in ``factory inbox``).
    """
    from factory.chain.solo import is_solo, spend_cap_for

    if not is_solo(story):
        return None
    cap, basis = spend_cap_for(story, root, db)
    if cap is None or cap > 0.0:
        return None
    limit = basis.get("binding_limit")
    if limit == "per_story":
        return ("block", "solo: per-story spend cap exhausted before dispatch", basis)
    return ("defer", f"solo spend cap is 0 ({limit} limit exhausted)", basis)


def _solo_first(stories: list[StoryRecord]) -> list[StoryRecord]:
    """Stable order with solo stories DUE for dev first, so a long solo
    conversation starts while the tick still has budget for it."""
    from factory.chain.solo import is_solo

    def _key(s: StoryRecord) -> int:
        try:
            due = is_solo(s) and _dispatch_for_story(s) == "dev"
        except Exception:  # noqa: BLE001 - a poisoned row sorts last-neutral
            due = False
        return 0 if due else 1

    return sorted(stories, key=_key)


def _dispatch_for_story(story: StoryRecord) -> str | None:
    """Pick the handler name for ``story`` given its current state.

    Pure wrapper around ``_DISPATCH`` plus two branches: ``STORY_CREATED``
    depends on ``story.chain_kind`` (tdd → sm, docs → docs_sm), and
    ``TESTS_GREEN`` depends on ``story.pipeline`` (chain → review, solo →
    tech_writer).
    """
    state = StoryState(story.state)
    if state == StoryState.STORY_CREATED:
        if story.chain_kind == "docs":
            return "docs_sm"
        return "sm"
    if state == StoryState.TESTS_GREEN:
        # SOLO pipeline: no reviewer round-trip. Read from the spawn stamp on
        # the row, never from live config (factory/chain/solo.py).
        from factory.chain.solo import is_solo

        if is_solo(story):
            return "tech_writer"
    return _DISPATCH.get(state)


def _invoke_handler(
    name: str,
    story: StoryRecord,
    app_config: AppConfig,
    software_factory_root: Path,
    *,
    dry_run: bool,
    db_path: Path,
) -> H.HandlerResult:
    if name == "sm":
        return H.handle_sm(
            story, app_config, software_factory_root, dry_run=dry_run, db_path=db_path
        )
    if name == "dev":
        return H.handle_dev(
            story, app_config, software_factory_root, dry_run=dry_run, db_path=db_path
        )
    if name == "review":
        return H.handle_review(
            story, app_config, software_factory_root, dry_run=dry_run, db_path=db_path
        )
    if name == "tech_writer":
        return H.handle_tech_writer(
            story, app_config, software_factory_root, dry_run=dry_run, db_path=db_path
        )
    if name == "docs_enforcer":
        return H.handle_docs_enforcer(
            story, app_config, software_factory_root, dry_run=dry_run, db_path=db_path
        )
    if name == "docs_sm":
        return H.handle_docs_sm(
            story, app_config, software_factory_root, dry_run=dry_run, db_path=db_path
        )
    if name == "docs_onboarder":
        return H.handle_docs_onboarder(
            story, app_config, software_factory_root, dry_run=dry_run, db_path=db_path
        )
    if name == "deploy":
        return H.handle_deploy(
            story, app_config, software_factory_root, dry_run=dry_run, db_path=db_path
        )
    raise RuntimeError(f"unknown handler name: {name}")


# States that don't count toward concurrency caps. ``STORY_CREATED`` is a
# pre-dispatch queue state — no agent is running yet, the story is just
# waiting for its first handler. PM-sync routinely spawns N children at
# once into STORY_CREATED; without this exclusion the cap deadlocks the
# whole batch (every story sees the other N-1 as competitors and is
# refused, so none ever advances). Terminal states are excluded for the
# usual reason: the work is done.
_NON_CAP_COUNTING_STATES = {
    # pre-dispatch
    StoryState.STORY_CREATED.value,
    # terminal / post-orchestrator
    StoryState.PR_OPEN.value,
    StoryState.CI_PENDING.value,
    StoryState.CI_GREEN.value,
    StoryState.READY_FOR_MERGE.value,
    StoryState.DEPLOYED.value,
    StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
    StoryState.BLOCKED_DEPLOY_FAILED.value,
    StoryState.BLOCKED_REVIEW_NONCONVERGENT.value,
    # Dev-declared underspecification (terminal, awaiting a human). Like every
    # other sink it must not hold a concurrency slot.
    StoryState.BLOCKED_UNDERSPECIFIED.value,
    # WS1.1 terminal budget sink — the story is done burning spend; it must
    # not count against concurrency caps.
    StoryState.BLOCKED_BUDGET_EXCEEDED.value,
    # Dual-draft loser sink (terminal). A superseded sibling is abandoned; it
    # must not consume a concurrency slot.
    StoryState.SUPERSEDED_BY_SIBLING.value,
    # CI-recovery-exhausted sink (terminal, PR closed). Like every sibling sink,
    # it must not count against concurrency caps — otherwise parked stories
    # accumulate and silently saturate the caps, stalling all new dispatch.
    StoryState.BLOCKED_CI_UNRESOLVED.value,
    # Dependency-deadlock sink (terminal). Same rationale — a story that can never
    # build must not consume a concurrency slot.
    StoryState.BLOCKED_DEPENDENCY_UNMET.value,
    # Operator-closed sink (terminal). The human ruled; it must not hold a slot.
    StoryState.CLOSED_BY_OPERATOR.value,
    # Delivery-level end states (terminal): the factory's part is done.
    StoryState.DELIVERED_LOCAL.value,
    StoryState.DELIVERED_BRANCH.value,
    StoryState.DELIVERED_PR.value,
    # Passive transition states — no agent is actively running; the story
    # is simply waiting for the orchestrator to dispatch the next handler
    # on the next tick. Counting these against the cap deadlocks any
    # operator-reset batch (e.g. 31 stories moved out of
    # blocked_tests_need_clarification back to tests_red), and more
    # generally inflates the "in-flight" count beyond the number of
    # actually-running agents. The cap exists to limit concurrent agents;
    # idle queue states should not consume slots. Same rationale as
    # STORY_CREATED above (PM-sync spawning N children at once).
    StoryState.SM_DONE.value,
    StoryState.TESTS_GREEN.value,
    StoryState.DEV_RETRY.value,
    StoryState.REVIEWER_DONE.value,
    StoryState.REVIEWER_REQUESTED_CHANGES.value,
    StoryState.DOCS_ONBOARDER_DONE.value,
    StoryState.DEPLOY_PENDING.value,
}


def _count_global_in_flight(db: Path, exclude_story_id: int | None = None) -> int:
    """Count actively-dispatched stories across all apps (for the global cap).

    ``exclude_story_id`` lets the orchestrator subtract the story it's
    currently inspecting so the cap measures "competitors", not "myself".

    Stories in ``STORY_CREATED`` are queued (no agent dispatched yet) and
    therefore do not count — see ``_NON_CAP_COUNTING_STATES``.
    """
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(StoryRecord)).all()
    return sum(
        1
        for r in rows
        if r.state not in _NON_CAP_COUNTING_STATES
        and (exclude_story_id is None or r.id != exclude_story_id)
    )


def _count_app_in_flight(db: Path, app: str, exclude_story_id: int | None = None) -> int:
    """Count actively-dispatched stories for ``app`` (for the per-repo cap).

    Same queued-vs-dispatched semantics as ``_count_global_in_flight``.
    """
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()
    return sum(
        1
        for r in rows
        if r.state not in _NON_CAP_COUNTING_STATES
        and (exclude_story_id is None or r.id != exclude_story_id)
    )


# Docs-chain serialization (loop-3 fix). Multiple docs stories for the same
# app rewrite an overlapping set of canonical ``context/*.md`` files
# (current-state.md, project.md, navigation.md, the shared module docs…). When
# two docs PRs are open at once, whichever auto-merges second goes DIRTY /
# CONFLICTING and dies in ``blocked_deploy_failed`` (observed: PRs #88/#89).
# The agent-concurrency cap can't prevent this because PR_OPEN and the CI/merge
# states are in ``_NON_CAP_COUNTING_STATES`` — two docs stories can both sit in
# PR_OPEN and conflict at merge time. So we serialize docs stories with a
# dedicated counter that DOES span the open-PR/merge window: a docs story is
# "active" from the moment its first handler is dispatched until it is DEPLOYED
# or terminal. While any docs story for an app is active, no *other* docs story
# for that app leaves STORY_CREATED — the next one waits, then regenerates its
# diff against the prior story's already-merged content (conflict-free).
_DOCS_ACTIVE_STATES = {
    StoryState.DOCS_SM_IN_PROGRESS.value,
    StoryState.DOCS_SM_DONE.value,
    StoryState.DOCS_ONBOARDER_IN_PROGRESS.value,
    StoryState.DOCS_ONBOARDER_DONE.value,
    StoryState.DOCS_ENFORCER_CHECK.value,
    StoryState.PR_OPEN.value,
    StoryState.CI_PENDING.value,
    StoryState.CI_GREEN.value,
    StoryState.READY_FOR_MERGE.value,
    StoryState.DEPLOY_PENDING.value,
}


def _count_app_docs_active(db: Path, app: str, exclude_story_id: int | None = None) -> int:
    """Count docs-chain stories for ``app`` with a live (or pending) PR.

    Spans the whole open-PR/merge window (see ``_DOCS_ACTIVE_STATES``) so the
    serialization gate holds two docs PRs from being open simultaneously.
    """
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()
    return sum(
        1
        for r in rows
        if r.chain_kind == "docs"
        and r.state in _DOCS_ACTIVE_STATES
        and (exclude_story_id is None or r.id != exclude_story_id)
    )


def _direction_deps_pending(db: Path, story: StoryRecord) -> list[int]:
    """Return lower-id stories in the same direction that are NOT yet deployed.

    Dependency ordering. Within a direction the SM emits stories
    foundational-first (model → service → endpoint → smoke → UI → docs), so the
    story-id order IS the build/dependency order. A dependent story (e.g. a
    smoke test, or a UI story) cannot build correctly until the foundations it
    relies on are merged to main — building it early surfaces "endpoint missing
    / test failing / no migration" defects that are really just out-of-order
    construction (the root cause that stranded the interdependent D008-D010
    batch). A story is dependency-ready only when every lower-id story in its
    own direction has reached ``deployed``. Empty list == ready.

    Pure read; no schema change. Cross-direction ordering is intentionally NOT
    enforced here (directions are treated as independent features).

    Dual-draft exemption (issue #100): ``…-alt-a`` / ``…-alt-b`` siblings are
    competing INTERPRETATIONS of the same work, not a serial dependency — alt-b
    does not build on alt-a's output. If THIS story is itself a dual-draft
    alternative, other same-direction dual-draft alternatives are NOT treated as
    dependencies, so the two race independently: alt-b neither waits on alt-a
    reaching ``deployed`` nor is deadlock-terminalized when alt-a dies in an
    alt-a-specific sink. A non-alt lower-id story is still a real foundation and
    stays in the dependency set unchanged.

    SUPERSEDED exemption (2026-08-09): a sibling in ``superseded_by_sibling`` is
    NOT a dependency at all — not a pending one, and not a dead-end one either.
    That state means "another story took this story's work over", so there is no
    foundation left un-built: whatever it was going to do is now some other
    story's job. Counting it as a pending dep made it a permanent dead end (it is
    in ``_DEAD_END_DEP_STATES``), which deadlocked every dependent behind it:

      * RE-TRIAGE became impossible. Close a direction's failed stories as
        superseded, re-file the work as a fresh higher-id story, and the new
        story instantly parked in ``blocked_dependency_unmet`` on the very
        siblings it was created to replace (observed 2026-08-09: sacrifice
        direction 120, story 182 deadlocked on 179/180/181 twice). A direction
        whose stories fail could never be cleanly rebuilt.
      * DUAL-DRAFT downstream stories deadlocked too. When alt-a wins and merges,
        ``close_abandoned_draft_sibling`` parks alt-b HERE. A later NON-alt story
        (which gets no dual-draft exemption) then saw alt-b as its only pending
        dep — deployed alt-a having dropped out of the set — and was terminalized
        the first time the gate ran. The whole dual-draft feature stranded
        everything filed after it.

    Excluding rather than dead-ending is also the FAIL-SAFE direction here: the
    worst case is a dependent building slightly early against a replacement that
    has not landed yet, which the merge gates catch and a retry fixes. The old
    behaviour's worst case was a terminal park no tick could ever undo.
    """
    if story.id is None:
        return []
    from factory.chain.dual_draft import _draft_alt_suffix

    story_is_alt = _draft_alt_suffix(story.slug or "") is not None
    # DELIVERY LEVELS (finding 10, 2026-11-02): a story whose own recorded level
    # does not merge (none / branch / draft_pr / pr) can never wait for a
    # sibling to DEPLOY — at those levels nothing deploys until a human acts, so
    # every multi-story job below auto_merge deadlocked on its first story. A
    # sibling that reached its DELIVERED_* end state has done all the factory
    # will do; for such a dependent it is not a pending dependency. Stories are
    # NOT stacked: the dependent builds from the default branch, not from the
    # sibling's unmerged branch. An unknown / merging level keeps the strict
    # rule (fail safe: wait).
    dependent_never_merges = False
    try:
        from factory.delivery import parse_level

        _lvl = parse_level(getattr(story, "delivery_level", None))
        dependent_never_merges = _lvl is not None and not _lvl.merges
    except ValueError:
        dependent_never_merges = False
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        siblings = session.exec(
            select(StoryRecord).where(
                StoryRecord.app == story.app,
                StoryRecord.direction_id == story.direction_id,
            )
        ).all()
    return sorted(
        s.id
        for s in siblings
        if s.id is not None
        and s.id < story.id
        and s.state != StoryState.DEPLOYED.value
        # A superseded sibling's work belongs to another story now — it is not an
        # un-built foundation, so it is not a dependency (see the docstring).
        and s.state != StoryState.SUPERSEDED_BY_SIBLING.value
        # A delivered sibling is done as far as a non-merging dependent goes.
        and not (dependent_never_merges and s.state in DELIVERED_UNMERGED_STATES)
        # Exempt same-direction dual-draft siblings from each other's deps.
        and not (story_is_alt and _draft_alt_suffix(s.slug or "") is not None)
    )


# Definitively-abandoned terminal sinks: a story here will NEVER reach
# ``deployed`` in the normal course (no factory-driven path back, no routine
# revival). Used to detect dependency-deadlock. Deliberately an EXPLICIT
# allowlist, NOT ``is_terminal`` — several ACTIVE states are "terminal-by-
# omission" (``ci_pending`` has no ``_TRANSITIONS`` edge because the auto-merge
# poller drives it by direct assignment, so ``is_terminal(ci_pending)`` is
# wrongly True). Using ``is_terminal`` here would falsely treat a sibling that is
# mid-CI/mid-merge as dead and destroy a live dependent — the same
# ``is_terminal`` trap the tracker-issue resolved-states allowlist calls out.
# The recoverable-pending-human sinks (``blocked_tests_need_clarification`` /
# ``blocked_deploy_failed`` / ``blocked_review_nonconvergent`` /
# ``blocked_budget_exceeded``) are EXCLUDED: a human may revive them, so a
# dependent behind one keeps deferring (the safe direction) rather than being
# abandoned.
_DEAD_END_DEP_STATES = frozenset(
    {
        # UNREACHABLE BY CONSTRUCTION since 2026-08-09: ``_direction_deps_pending``
        # now drops superseded siblings from the dependency set entirely (see its
        # docstring), so no caller can ever hand this value in. Retained
        # deliberately, not deleted: every consumer of this set reads it as "states
        # from which no story ever deploys", which is still TRUE of a superseded
        # story — so if a second producer of dep-id lists is ever added, it
        # inherits the safe classification rather than silently treating a
        # superseded row as live.
        StoryState.SUPERSEDED_BY_SIBLING.value,
        StoryState.BLOCKED_CI_UNRESOLVED.value,
        StoryState.BLOCKED_DEPENDENCY_UNMET.value,
        # An operator-closed foundation will never deploy — a dependent behind one
        # must be abandoned rather than deferring forever. This is the one
        # pending-human-derived state that IS a definitive dead end, because the
        # human has already ruled on it.
        StoryState.CLOSED_BY_OPERATOR.value,
    }
)


def _deps_permanently_dead(db: Path, dep_ids: list[int]) -> bool:
    """True iff EVERY pending dependency is in a definitively-abandoned sink
    (``_DEAD_END_DEP_STATES``) — none will ever deploy, so the dependent can never
    build (a dependency-deadlock).

    If ANY pending dep is in any other state — actively progressing
    (``story_created`` / ``*_in_progress`` / ``pr_open`` / ``ci_pending`` /
    ``ci_green`` / ``ready_for_merge`` / ``deploy_pending``) OR a
    recoverable-pending-human block — this returns False and the dependent keeps
    waiting (never terminalized on a still-live or possibly-revivable foundation).
    Empty ``dep_ids`` → False. Fail-safe: a missing row or an invalid-enum dep
    state is treated as NOT-dead (a dep not in the explicit allowlist is never
    dead), so a dependent is never terminalized on ambiguous evidence.
    """
    if not dep_ids:
        return False
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(
            # SQLModel columns are typed as their Python type but are Column
            # objects at runtime, so ``.in_()`` is real. The narrow ignore names the
            # code mypy actually emits (union-attr on ``int | None``); an
            # ``attr-defined`` ignore here silently covered nothing and would have
            # hidden a future real error.
            select(StoryRecord).where(StoryRecord.id.in_(dep_ids))  # type: ignore[union-attr]
        ).all()
    if len(rows) != len(set(dep_ids)):
        return False  # a dep row is missing → can't prove dead → treat as live
    return all(row.state in _DEAD_END_DEP_STATES for row in rows)


def _deps_none_permanently_dead(db: Path, dep_ids: list[int]) -> bool:
    """True iff NONE of the pending dependency IDs are in a definitively-abandoned
    sink (``_DEAD_END_DEP_STATES``).

    Used by dependent-revival logic: a dependent parked in
    ``blocked_dependency_unmet`` is only safe to revive when every former
    dead-end blocker has been revived — if ANY pending dep is still in a
    dead-end sink, the dependent stays parked.
    Empty ``dep_ids`` → True (no blockers to worry about).  Fail-safe: a missing
    row or invalid-enum dep state is treated as live (not dead), so revival is
    deferred on ambiguous evidence.
    """
    if not dep_ids:
        return True
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(
            # SQLModel columns are typed as their Python type but are Column
            # objects at runtime, so ``.in_()`` is real. The narrow ignore names the
            # code mypy actually emits (union-attr on ``int | None``); an
            # ``attr-defined`` ignore here silently covered nothing and would have
            # hidden a future real error.
            select(StoryRecord).where(StoryRecord.id.in_(dep_ids))  # type: ignore[union-attr]
        ).all()
    if len(rows) != len(set(dep_ids)):
        return False  # a dep row is missing → can't prove safe → don't revive
    return not any(row.state in _DEAD_END_DEP_STATES for row in rows)


# Recoverable-pending-human blocks. These are deliberately EXCLUDED from
# ``tracker_issue._RESOLVED_STORY_STATES`` because an operator may still revive
# them — which is exactly why a row whose operator has ALREADY ruled (by closing
# the tracker issue) has no way to settle. ``reconcile_closed_trackers`` is that
# way out.
_PENDING_HUMAN_STATES: frozenset[str] = frozenset(
    {
        StoryState.BLOCKED_DEPLOY_FAILED.value,
        StoryState.BLOCKED_BUDGET_EXCEEDED.value,
        StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
        StoryState.BLOCKED_REVIEW_NONCONVERGENT.value,
        # Dev declared the story unsatisfiable as written. Only a human can
        # rewrite the story (or reject the claim), so a dependent waiting
        # behind one is waiting on a human — and it must stay revivable rather
        # than be treated as a definitive dead end.
        StoryState.BLOCKED_UNDERSPECIFIED.value,
        # Delivery-level end states: the work is finished but NOT on the
        # default branch — a human merges (or discards) it. A dependent behind
        # one is waiting on that human, so it is capped-then-surfaced rather
        # than abandoned, and closing the story issue settles it to
        # closed_by_operator like any other pending-human row.
        StoryState.DELIVERED_LOCAL.value,
        StoryState.DELIVERED_BRANCH.value,
        StoryState.DELIVERED_PR.value,
    }
)

# Blocker states with NO tick-driven path forward: a dependent waiting behind one
# is waiting on a HUMAN (or on the operator-driven revival paths), not on the
# pipeline. Union of the definitive dead ends and the recoverable-pending-human
# blocks — the two sets the deferral gate must treat differently in OUTCOME
# (abandon vs. cap-then-surface) but identically in "will another tick help?".
#
# This is the substrate of the 2026-07-28 deadlock: ``blocked_deploy_failed`` is
# deliberately NOT a dead end (see ``_DEAD_END_DEP_STATES``; the FMS recovery
# playbook ``retry-mergeable-blocked-story`` really does revive it), so a
# dependent behind one deferred every tick forever with nothing surfaced.
# Deferring is right; deferring UNBOUNDEDLY is the bug.
_STALLED_DEP_STATES: frozenset[str] = (
    _DEAD_END_DEP_STATES
    | _PENDING_HUMAN_STATES
    # A poisoned row quarantined by the operational reconciler stays parked until
    # an operator repairs it — no tick moves it either, so a dependent behind one
    # must be capped and surfaced rather than deferring forever. Deliberately NOT
    # added to ``_DEAD_END_DEP_STATES``: the repair is routine, so the dependent
    # should be revivable, not abandoned.
    | {StoryState.QUARANTINED_INVALID_STATE.value}
)

# How many CONSECUTIVE ticks a dependent may be deferred while EVERY pending
# dependency sits in ``_STALLED_DEP_STATES`` before the dependent is parked in
# ``BLOCKED_DEPENDENCY_UNMET`` and surfaced to the operator.
#
# Three, matching every other loop bound in this repo ("nothing loops more than
# ~3 times"). The count is only ever incremented on a STALLED deferral — one
# where no blocker can move without human action — and is reset the moment any
# blocker becomes live again, so a normal dependent waiting out its foundation's
# real dev/review/merge work never counts a single deferral and is never parked
# by this cap, however long that work takes.
_MAX_DEPENDENCY_DEFERRALS = 3

# ...AND the blockers must have been stalled for at least this long. The tick
# cadence is an implementation detail (30 s in ``drive_chain.sh``, 5 min on the
# systemd timer), so a pure tick COUNT is not a human-response window: three
# 30-second ticks would park a dependent 90 seconds after its foundation blocked.
# The revival paths this cap defers to are all slower than that — the FMS
# ``retry-mergeable-blocked-story`` playbook runs on a 30-minute cooldown
# (``manager/recovery.py``) — so the cap must give them their shot first or the
# park becomes the normal path instead of the last resort. 45 minutes clears that
# cooldown with margin while still surfacing the wedge inside the hour.
#
# Measured against each blocker's ``updated_at``: any write to a blocker row (a
# state change, a reconcile, a recovery) restarts the clock, which is exactly the
# "something is still happening" signal we want to wait on.
_MIN_DEP_STALL_SECONDS = 45 * 60


def _deps_all_stalled(db: Path, dep_ids: list[int]) -> bool:
    """True iff EVERY pending dependency is in ``_STALLED_DEP_STATES`` — no
    blocker can advance without human action, so another tick cannot help.

    Fail-safe in the direction of NOT capping: an empty ``dep_ids``, a missing
    dep row, or an invalid-enum dep state all return False, so a dependent is
    never parked on ambiguous evidence.
    """
    if not dep_ids:
        return False
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(
            select(StoryRecord).where(StoryRecord.id.in_(dep_ids))  # type: ignore[union-attr]
        ).all()
    if len(rows) != len(set(dep_ids)):
        return False  # a dep row is missing → can't prove stalled → keep waiting
    return all(row.state in _STALLED_DEP_STATES for row in rows)


def _deps_stalled_long_enough(
    db: Path,
    dep_ids: list[int],
    *,
    min_seconds: int = _MIN_DEP_STALL_SECONDS,
    now: datetime | None = None,
) -> bool:
    """True iff EVERY pending dependency has been untouched for ``min_seconds``.

    The age half of the cap (see ``_MIN_DEP_STALL_SECONDS``): it is not enough for
    the blockers to be human-blocked *right now*, they must have been sitting
    still long enough that the automatic revival paths have already had their
    chance. Keyed on the most-recently-written blocker, so any activity on any
    blocker keeps the dependent waiting.

    Fail-safe in the direction of NOT capping: empty ids, a missing row, or an
    unparseable/absent timestamp all return False.
    """
    if not dep_ids:
        return False
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(
            select(StoryRecord).where(StoryRecord.id.in_(dep_ids))  # type: ignore[union-attr]
        ).all()
    if len(rows) != len(set(dep_ids)):
        return False
    now_ts = (now or datetime.now(UTC)).timestamp()
    for row in rows:
        stamp = row.updated_at or row.created_at
        if not stamp:
            return False  # no clock to reason about → don't cap
        try:
            age = now_ts - datetime.fromisoformat(stamp).timestamp()
        except (TypeError, ValueError):
            return False  # unparseable → don't cap
        if age < min_seconds:
            return False
    return True


def _bump_dependency_defer_count(db: Path, story_id: int | None, value: int) -> None:
    """Persist ``dependency_defer_count`` WITHOUT touching ``updated_at``.

    Deliberately not ``persist_story``: that stamps ``updated_at`` on every write,
    and a counter bumped on every tick would (a) make the deferred row look freshly
    worked-on to ``manager/detectors/stalled_stories.py`` — the one detector that
    would have alarmed on the original 2+ hour idle — and (b) pin that detector's
    ``minutes_since_any_story_update`` (a MINIMUM over all rows) near zero, which
    marks the whole factory as "draining" and suppresses the aged-backlog alarm for
    every other story too. The deferral must age like the stall it is.
    """
    if story_id is None:
        return
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with eng.begin() as conn:
        conn.exec_driver_sql(
            "UPDATE stories SET dependency_defer_count = ? WHERE id = ?",
            (int(value), int(story_id)),
        )


def _revive_capped_dependents(db: Path, app: str, *, root: Path) -> list[tuple[str, str, str]]:
    """Revive dependents parked by the deferral CAP once their blockers move again.

    The cap parks a dependent whose every blocker was stalled on a human. When a
    blocker leaves ``_STALLED_DEP_STATES`` — an operator revives it, the FMS
    ``retry-mergeable-blocked-story`` playbook resets it to ``pr_open``, reconcile
    finds it merged on GitHub — the dependent is buildable again and must
    re-enter the chain by itself; otherwise the fix that unblocked the foundation
    leaves its dependents rotting (detect-without-remediate, one level down).

    Deliberately narrow so it can neither churn nor resurrect abandoned work:

      * Only rows carrying the ``DEP_DEFER_CAP_REASON_PREFIX`` marker are
        candidates. A DEADLOCK-parked row (blocker definitively dead) keeps the
        existing operator-driven revival posture and is never touched here.
      * Revival requires NO pending dependency to be in ``_STALLED_DEP_STATES``.
        While the blocker sits in e.g. ``blocked_deploy_failed`` the dependent
        stays parked, so there is no park→revive→park ping-pong; each revival
        costs the blocker a real state change, and the blocker's own loops are
        capped.
      * The deferral counter is reset on revival, so the dependent gets a fresh
        (bounded) grace window if its blockers stall again.
      * The dependent resumes at the state it was parked FROM (recorded in the
        ``dependency_deferral_capped`` event), not at ``story_created``: a story
        capped out of ``reviewer_done`` must not re-run SM + dev + review from
        scratch, which would burn the spend again and discard a reviewer verdict
        the operator may still want.

    Pure DB rewrite, no LLM/git work, idempotent. Ordered by id so a cascade of
    dependents (each one's blocker being the previous one) unwinds in a single
    pass. Returns ``(slug, from_state, to_state)`` tuples for the TickSummary.
    """
    from factory.chain.event_log import log_story_event
    from factory.chain.handlers import persist_story

    revived: list[tuple[str, str, str]] = []
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(
            select(StoryRecord)
            .where(
                StoryRecord.app == app,
                StoryRecord.state == StoryState.BLOCKED_DEPENDENCY_UNMET.value,
            )
            .order_by(StoryRecord.id)  # type: ignore[arg-type]
        ).all()
    for story in rows:
        if not is_dependency_cap_parked(story.state, story.last_rejection_reason):
            continue
        pending = _direction_deps_pending(db, story)
        if _deps_all_stalled(db, pending) or not _deps_none_permanently_dead(db, pending):
            continue  # a blocker is still human-blocked (or dead) → stay parked
        from_state = story.state
        story.state = _dep_cap_resume_state(story, root=root)
        story.error = None
        story.last_rejection_reason = None
        story.dependency_defer_count = 0
        persist_story(story, db)
        revived.append((story.slug, from_state, story.state))
        log_story_event(
            story.id,
            "dependency_defer_revived",
            {
                "direction": story.direction_id,
                "from_state": from_state,
                "to_state": story.state,
                "waiting_on_story_ids": pending[:10],
                "reason": "every blocker left the human-blocked set",
            },
            software_factory_root=root,
            slug_hint=story.slug,
        )
    return revived


def _dep_cap_resume_state(story: StoryRecord, *, root: Path) -> str:
    """The state a cap-parked ``story`` should resume at.

    Reads the ``from_state`` recorded by the most recent
    ``dependency_deferral_capped`` event and accepts it only if it is still a
    DISPATCHABLE state (present in ``_DISPATCH``). Anything else — no event, an
    unknown/renamed state, a state the chain no longer drives, or an unreadable
    log — falls back to ``story_created``, which is always safe (the chain simply
    rebuilds the story) if wasteful. No new schema: the event log already holds
    the fact.
    """
    fallback = StoryState.STORY_CREATED.value
    if story.id is None:
        return fallback
    try:
        from factory.chain.event_log import read_story_events

        events = read_story_events(story.id, software_factory_root=root, slug_hint=story.slug)
    except Exception:  # noqa: BLE001 - a bad log must never block a revival
        return fallback
    for ev in reversed(events):
        if ev.get("event") != "dependency_deferral_capped":
            continue
        candidate = str(ev.get("from_state") or "")
        try:
            resume = StoryState(candidate)
        except ValueError:
            return fallback
        return resume.value if resume in _DISPATCH else fallback
    return fallback


# Mapping from a stranded ``*_in_progress`` state back to its
# dispatch-eligible predecessor. Used by ``_prune_stale_in_progress`` to
# recover rows that didn't reach the handler's normal exit (process kill,
# uncaught exception, dirty-tree race, retry-cap change mid-attempt).
_STALE_RECOVERY_MAP: dict[str, str] = {
    "sm_in_progress": "story_created",
    "dev_in_progress": "dev_retry",
    "reviewer_in_progress": "tests_green",
    "tech_writer_in_progress": "reviewer_done",
    "docs_sm_in_progress": "story_created",
    "docs_onboarder_in_progress": "docs_sm_done",
}


# How long an ``*_in_progress`` row can sit without a row-level update
# before the cleanup pass considers it stranded. Picked to be just above
# the worst-case legitimate sandbox run (dev iteration cap is 600 calls
# ≈ 8–12 min in real LLM timing) so we recover stuck rows quickly
# without racing a live in-progress sandbox. Operators wanting more
# aggressive recovery can lower this and accept the false-positive risk.
_STALE_THRESHOLD_SECONDS = 10 * 60


def _prune_stale_in_progress(
    db: Path,
    app: str,
    *,
    settings: Any,
    root: Path,
    now: datetime | None = None,
) -> list[tuple[str, str, str]]:
    """Recover stories stranded in ``*_in_progress`` from a crashed tick.

    A ``StoryRecord`` rolls into an ``_in_progress`` state when a handler
    starts; the handler exits normally by transitioning OUT of that state.
    Several failure modes can break that contract:

      * The tick process is killed mid-sandbox (SIGTERM, OOM).
      * A subtle inner-loop bug calls a handler twice and the second call
        raises ``IllegalTransitionError`` before the first has transitioned
        out.
      * ``_MAX_DEV_RETRIES`` (or another guarded threshold) is lowered
        between ticks while a row is mid-attempt — the in-flight handler
        completes under the old regime but the row's state is invalidated
        for the new regime.

    Once stranded, ``_dispatch_for_story`` returns ``None`` for
    ``*_in_progress`` (those slots are webhook-driven), so the chain has
    no way to nudge the row forward without operator intervention.

    This pass detects rows older than ``_STALE_THRESHOLD_SECONDS`` and
    rolls them back to the most-recent dispatch-eligible state per
    ``_STALE_RECOVERY_MAP``. For ``dev_in_progress`` we ALSO clamp
    ``dev_retries`` to ``MAX_DEV_RETRIES - 1`` so the next dispatch gives
    the story exactly one fresh attempt and then exhausts naturally —
    without that clamp, a row stranded under the old cap=10 regime would
    immediately exhaust on its first new dispatch under cap=3, which is
    surprising and wastes the diagnostic the operator might want from a
    single observed-under-new-cap run.

    Emits one ``stale_recovery`` event per recovered story to the
    per-story log so operators can see what was nudged and why. Returns
    the list of (slug, from_state, to_state) tuples; the orchestrator
    surfaces these in ``TickSummary.handler_runs`` as
    ``"<from_state>(stale)"``.
    """
    from datetime import UTC
    from datetime import datetime as _dt

    from factory.chain.event_log import log_story_event
    from factory.chain.handlers import _max_dev_retries, persist_story

    now_ts = (now or _dt.now(UTC)).timestamp()
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        candidates = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()

    recovered: list[tuple[str, str, str]] = []
    for story in candidates:
        target = _STALE_RECOVERY_MAP.get(story.state)
        if target is None:
            continue
        if story.state == "tech_writer_in_progress":
            from factory.chain.solo import is_solo

            if is_solo(story):
                # A solo story never had a reviewer verdict: re-enter where it
                # actually came from (TESTS_GREEN dispatches tech_writer for solo).
                target = "tests_green"
        try:
            updated_iso = story.updated_at or story.created_at
            updated_ts = _dt.fromisoformat(updated_iso).timestamp()
        except (TypeError, ValueError):
            updated_ts = 0  # treat unparseable timestamps as ancient
        if (now_ts - updated_ts) < _STALE_THRESHOLD_SECONDS:
            continue

        from_state = story.state
        story.state = target
        # Clamp dev_retries so the recovered row gets one fresh shot
        # under whatever the current cap is, instead of insta-exhausting
        # on a stale count from a previous cap regime.
        if from_state == "dev_in_progress":
            from factory.chain.solo import max_dev_attempts

            _cap = max_dev_attempts(story, _max_dev_retries(root))
            if story.dev_retries >= _cap:
                story.dev_retries = max(0, _cap - 1)
        story.error = (
            f"stale-state recovery: rolled back from {from_state!r} "
            f"(no row update for >{_STALE_THRESHOLD_SECONDS // 60} min)"
        )
        persist_story(story, db)
        recovered.append((story.slug, from_state, target))
        log_story_event(
            story.id,
            "stale_recovery",
            {
                "from_state": from_state,
                "to_state": target,
                "dev_retries_after_clamp": story.dev_retries,
                "age_seconds": int(now_ts - updated_ts),
            },
            software_factory_root=root,
            slug_hint=story.slug,
        )

    return recovered


# A blocked story is a factory defect, never a real outcome (operator rule:
# "there can only be 0 blocked stories"). When the orchestrator's chain code is
# fixed, stories already sitting in a terminal blocked state from the *old*
# (now-fixed) regime stay blocked forever — there is no transition out of a
# blocked state, so the only escape used to be a manual DB reset. This pass
# closes that gap: it re-dispatches blocked stories back into the chain so a
# since-shipped fix actually reaches them. Bounded per story so a genuinely
# unsatisfiable story (contradictory contract, etc.) surfaces to a human after
# a couple of honest re-attempts instead of being recycled forever.
_MAX_AUTO_RECOVERIES = 2
# Blocked states recovered by re-entering the chain at SM_DONE (re-runs
# dev -> review -> merge with current fixes; the dev writes code + tests).
# deploy_failed is intentionally excluded — it's handled at the merge layer by
# ``auto_merge._attempt_pr_reconcile`` (stale branches) and true content
# conflicts there need regeneration/human handling, not a dev re-run.
# ``BLOCKED_UNDERSPECIFIED`` is deliberately ABSENT: re-entering the chain at
# SM_DONE would re-dispatch dev against the same under-specified story and earn
# the same declaration — a retry loop wearing a different hat, and one that
# would make the escape hatch cost spend instead of saving it. The story needs a
# human to rewrite it or to reject the dev's claim.
_AUTO_RECOVERABLE_STATES: dict[str, str] = {
    StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value: StoryState.SM_DONE.value,
    StoryState.BLOCKED_REVIEW_NONCONVERGENT.value: StoryState.SM_DONE.value,
}


def _normalize_failure_text(raw: str) -> str:
    """Strip volatile bits (timestamps, paths, durations, addresses/ids) from
    ``raw`` failure text so a re-run that fails for the identical reason
    produces identical normalized text even though wall-clock/paths differ
    between attempts.

    Factored out of ``_story_failure_signature`` so ``auto_merge``'s real-CI
    failure signature (a different failure-text source: a ``gh run view
    --log-failed`` digest instead of a dev/review test-output tail) can reuse
    the exact same "is this the SAME failure" normalization rather than
    maintaining a parallel copy of the regex list.
    """
    normalized = re.sub(
        r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?",
        "<ts>",
        raw,
    )
    normalized = re.sub(r"(?:/[\w.\-]+){2,}", "<path>", normalized)
    normalized = re.sub(r"\b\d+(?:\.\d+)?s\b", "<dur>", normalized)
    normalized = re.sub(r"\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b", "<dur>", normalized)
    # Strip non-deterministic identifiers so the SAME logical failure hashes
    # identically across cycles: hex memory addresses / object ids
    # (0x7f..., id=140234..., "at 0x..."), and generic long hex/uuid runs that
    # appear in mock/object reprs and temp names. Without this the guard fails
    # OPEN on failures whose tail embeds an address and never detects the loop.
    normalized = re.sub(r"0x[0-9a-fA-F]+", "<addr>", normalized)
    normalized = re.sub(r"\bid=\d+", "id=<id>", normalized)
    normalized = re.sub(
        r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
        "<uuid>",
        normalized,
    )
    normalized = re.sub(r"\b[0-9a-fA-F]{12,}\b", "<hex>", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def _story_failure_signature(story: StoryRecord) -> str:
    """Return a normalized signature of ``story``'s most recent failure.

    Prefers the last ``dev_attempts_json`` entry's ``test_output_tail``
    (the freshest evidence of *why* dev/review failed — see
    ``handlers._fetch_latest_test_output`` for the same preference order),
    falling back to ``story.error`` when no attempts are on record.

    Volatile bits (timestamps, absolute paths, durations) are stripped so
    a re-run that fails for the identical reason produces an identical
    signature even though wall-clock/paths differ between attempts — that
    identity is what lets ``_recover_blocked_stories`` detect "no new
    signal" and stop hamster-wheeling a structurally unsatisfiable story.

    Returns ``""`` when no failure text is available (e.g. brand-new story).
    """
    raw = ""
    if story.dev_attempts_json:
        try:
            attempts = json.loads(story.dev_attempts_json)
        except (TypeError, ValueError):
            attempts = None
        if isinstance(attempts, list) and attempts:
            last = attempts[-1]
            if isinstance(last, dict):
                raw = (last.get("test_output_tail") or "").strip()
    if not raw:
        raw = (story.error or "").strip()
    return _failure_signature_from_tail(raw)


def _failure_signature_from_tail(raw: str) -> str:
    """Normalized failure signature for a raw failure/test-output tail.

    The tail→normalize→hash core of ``_story_failure_signature``, exposed so the
    dev loop can sign an attempt's own ``test_output_tail`` directly (it already
    has the tail in-memory and must not re-read the story's serialized state).
    Both callers therefore produce the IDENTICAL signature for the same failure.
    Returns ``""`` when there is no failure text.
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    normalized = _normalize_failure_text(raw)
    # The tail carries the actual assertion/error; the head is often
    # boilerplate pytest banner/collection noise that's identical across
    # unrelated failures.
    return hashlib.sha256(normalized[-500:].encode("utf-8")).hexdigest()


def _recover_blocked_stories(db: Path, app: str, *, root: Path) -> list[tuple[str, str, str]]:
    """Re-dispatch blocked stories so since-shipped chain fixes reach them.

    For each story in an auto-recoverable blocked state, reset it to the
    re-entry point (SM_DONE → dev) with retry/cycle counters cleared (the
    last reviewer findings are kept — see inline comment) so it flows through the current
    chain from scratch. Bounded to ``_MAX_AUTO_RECOVERIES``
    per story via ``auto_recovery`` events in the per-story log; once exhausted
    the story stays blocked and an ``auto_recovery_exhausted`` /
    ``factory_needs_redesign`` event fires so the FMS/operator sees a genuinely
    stuck story rather than an endless recycle.

    Pure DB rewrite — no LLM/git work — mirroring ``_prune_stale_in_progress``.
    Returns (slug, from_state, to_state) tuples for the TickSummary.

    Signal-changed guard: a recovery also requires that the story's current
    failure differs from the one recorded at its *most recent* prior
    recovery (see ``_story_failure_signature``). Recovering blindly on the
    identical failure just burns a full dev cycle (up to 6 retries) to
    rediscover the same dead end, so an unchanged signature escalates
    immediately instead of consuming another slot of ``_MAX_AUTO_RECOVERIES``.
    A story making genuine progress (a different failure each time) still
    gets its recoveries; the first recovery is always allowed.
    """
    from factory.chain.event_log import log_story_event, read_story_events
    from factory.chain.handlers import persist_story

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        candidates = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()

    recovered: list[tuple[str, str, str]] = []
    for story in candidates:
        target = _AUTO_RECOVERABLE_STATES.get(story.state)
        if target is None:
            continue

        events = read_story_events(story.id, software_factory_root=root, slug_hint=story.slug)

        # Only recoveries into the CURRENT re-entry point consume the budget.
        # When the chain is redesigned the re-entry target changes (e.g. the
        # old test-first regime re-entered at tests_red; Loop-4 re-enters at
        # sm_done), and attempts burnt under the old regime say nothing about
        # whether the new chain can converge the story — the budget resets.
        prior_recoveries = [
            e for e in events if e.get("event") == "auto_recovery" and e.get("to_state") == target
        ]
        prior = len(prior_recoveries)

        already_escalated = any(e.get("event") == "auto_recovery_exhausted" for e in events)

        if prior >= _MAX_AUTO_RECOVERIES:
            # Already re-attempted the allowed number of times and still
            # blocked → genuinely stuck. Emit a loud, deduped escalation once.
            if not already_escalated:
                log_story_event(
                    story.id,
                    "auto_recovery_exhausted",
                    {
                        "state": story.state,
                        "recoveries": prior,
                        "error": (story.error or "")[:300],
                    },
                    software_factory_root=root,
                    slug_hint=story.slug,
                )
            continue

        signature = _story_failure_signature(story)

        if prior_recoveries:
            last_signature = prior_recoveries[-1].get("failure_signature")
            if signature and last_signature is not None and signature == last_signature:
                # The last recovery attempt produced the EXACT same failure —
                # nothing changed. Recovering again would just grind through
                # another full dev cycle for no new signal; escalate instead
                # (deduped, same as the cap-exhausted path above).
                if not already_escalated:
                    log_story_event(
                        story.id,
                        "auto_recovery_exhausted",
                        {
                            "state": story.state,
                            "recoveries": prior,
                            "error": (story.error or "")[:300],
                            "reason": "identical_failure_signature",
                        },
                        software_factory_root=root,
                        slug_hint=story.slug,
                    )
                continue

        from_state = story.state
        story.state = target
        story.error = None
        story.dev_retries = 0
        story.reviewer_cycles = 0
        # Deliberately KEEP reviewer_result_json: the last reviewer verdict is
        # the record of why the story blocked, the worktree still contains the
        # rejected code, and handle_dev feeds findings into the prompt whenever
        # they exist — so the first post-recovery dev pass starts informed
        # instead of burning a cycle rediscovering the same objections.
        story.last_rejection_reason = None
        story.current_model_tier = "standard"
        story.harness_precheck_passed = False
        persist_story(story, db)
        recovered.append((story.slug, from_state, target))
        log_story_event(
            story.id,
            "auto_recovery",
            {
                "from_state": from_state,
                "to_state": target,
                "attempt": prior + 1,
                "cap": _MAX_AUTO_RECOVERIES,
                "failure_signature": signature,
            },
            software_factory_root=root,
            slug_hint=story.slug,
        )

    return recovered


# Bound on how many stories ``reconcile_from_github`` will query GitHub for in a
# single tick. Each candidate costs one read-only ``gh pr view`` shell-out;
# capping keeps a large PR backlog from turning every tick into a burst of API
# calls. Candidates beyond the cap are simply reconciled on a LATER tick (they
# are never lost — they stay in a mergeable state and remain candidates).
_MAX_RECONCILE_PER_TICK = 25


def _query_pr_state(*, app_config: AppConfig, pr_number: int) -> str | None:
    """Authoritative GitHub state for ``pr_number``.

    Returns ``"OPEN"``, ``"CLOSED"``, ``"MERGED"``, or ``None`` when the state
    cannot be determined. Read-only ``gh pr view --json state`` shell-out — the
    SAME plumbing ``auto_merge._pr_terminally_unmergeable`` uses (gh's ``state``
    field returns exactly those three literals; ``MERGED`` is distinct from a
    plain ``CLOSED``).

    ``None`` is the fail-safe sentinel: a non-positive placeholder PR number, gh
    missing, a timeout, a non-zero exit (PR deleted / wrong repo / auth), or an
    unparseable payload all map to ``None`` so the caller NEVER reconciles a
    story on an uncertain answer.
    """
    import subprocess

    if pr_number <= 0:  # synthesized placeholder — nothing to query
        return None
    cmd = [
        "gh",
        "pr",
        "view",
        str(pr_number),
        "--repo",
        app_config.repo,
        "--json",
        "state",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        # gh could not resolve the PR (deleted / wrong repo / auth). Unknown —
        # do not reconcile on uncertainty.
        return None
    try:
        data = json.loads(proc.stdout)
    except (ValueError, TypeError):
        return None
    state = str(data.get("state", "")).upper()
    if state in ("OPEN", "CLOSED", "MERGED"):
        return state
    return None


def _query_issue_state(*, app_config: AppConfig, issue_number: int) -> str | None:
    """Authoritative GitHub state for a tracker ISSUE: ``"OPEN"``/``"CLOSED"``/None.

    Read-only ``gh issue view --json state``, mirroring ``_query_pr_state``'s
    fail-safe contract exactly: a non-positive number, gh missing, a timeout, a
    non-zero exit, or an unparseable payload all map to ``None`` so the caller
    never reconciles on an uncertain answer.
    """
    import subprocess

    if issue_number <= 0:
        return None
    cmd = [
        "gh",
        "issue",
        "view",
        str(issue_number),
        "--repo",
        app_config.repo,
        "--json",
        "state",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    try:
        data = json.loads(proc.stdout)
    except (ValueError, TypeError):
        return None
    state = str(data.get("state", "")).upper()
    return state if state in ("OPEN", "CLOSED") else None


def _repark_cancelled_job_stories(
    stories: list[StoryRecord], *, db: Path, root: Path
) -> list[StoryRecord]:
    """Drop (and re-park as ``closed_by_operator``) stories of cancelled jobs.

    The durable marker is ``delivery_gate.is_job_cancelled`` (its own table,
    written only by ``factory job cancel``). The re-park is a compare-and-set
    under the story lock, so it never races the auto-merge pass. Finished work
    (``deploy_pending``) is left alone, like cancel itself does. Never raises.
    """
    from factory.chain import delivery_gate

    kept: list[StoryRecord] = []
    for s in stories:
        try:
            cancelled = delivery_gate.is_job_cancelled(db, s.app, s.direction_id)
        except Exception:  # noqa: BLE001
            cancelled = False
        if not cancelled or s.state == StoryState.DEPLOY_PENDING.value or s.id is None:
            kept.append(s)
            continue
        with delivery_gate.story_lock(root, s.id, timeout=5) as held:
            if held and delivery_gate.cas_story_state(
                db,
                s.id,
                {s.state},
                StoryState.CLOSED_BY_OPERATOR.value,
                error=f"job cancelled; re-parked a write-back to {s.state}",
            ):
                with contextlib.suppress(Exception):
                    log_story_event(
                        s.id,
                        "cancelled_job_story_reparked",
                        {"from_state": s.state},
                        software_factory_root=root,
                        slug_hint=s.slug or "",
                    )
    return kept


def reconcile_closed_trackers(
    db: Path,
    app: str,
    *,
    cfg: AppConfig,
    root: Path,
    max_reconcile: int = _MAX_RECONCILE_PER_TICK,
    query_issue_state: Callable[..., str | None] = _query_issue_state,
    query_pr_state: Callable[..., str | None] | None = None,
) -> list[tuple[str, str, str]]:
    """Settle pending-human stories whose tracker ISSUE the operator has closed.

    DELIVERED_PR exception (review 2026-11-02, SHOULD 6): a human merging a
    delivered PR usually closes its story issue too ("Closes #n"). Settling
    that row to CLOSED_BY_OPERATOR here would strand a MERGED change before
    ``reconcile_from_github`` routes it to deploy. So a ``delivered_pr`` row is
    only settled when GitHub says its PR is NOT merged (OPEN or CLOSED);
    MERGED or unknown → skipped, left for ``reconcile_from_github``.

    The companion to ``reconcile_from_github``. That pass makes the local DB agree
    with GitHub about **PR** state; this one makes it agree about whether the work
    is still *wanted*. GitHub is the system of record for both.

    The gap this closes: the four ``_PENDING_HUMAN_STATES`` are excluded from the
    resolved-states allowlist on purpose (a human might revive them), so when the
    human instead *closes the tracker issue* the two views disagree permanently —
    the factory keeps listing the story as awaiting a human who has already ruled.
    Observed 2026-07-24: stories 81 and 130 sat 5.1 days and 24.8h in the operator
    inbox with tracker issues #267/#337 closed days earlier and **zero** open PRs
    or issues on either repo, so the operator's own "queue is clean" signal and the
    DB flatly contradicted each other.

    Only ever moves a story TOWARD terminal (``CLOSED_BY_OPERATOR``), never back,
    which keeps it idempotent: a settled row leaves ``_PENDING_HUMAN_STATES`` and
    is not a candidate again, so a consistent DB produces zero mutations and zero
    events on re-run. Re-opening the issue does NOT resurrect the story — that is
    deliberately a manual operator action (same posture as
    ``BLOCKED_DEPENDENCY_UNMET``), because auto-resurrection would let a single
    issue re-open silently re-enter a story the chain had already stopped driving.

    Fail-safe: an ``OPEN`` or unknown (``None``) issue state is a no-op, so a gh
    outage or auth failure can never mass-close the backlog. Bounded at
    ``max_reconcile`` gh calls per tick. Pure DB rewrite + read-only gh queries —
    no LLM, no git writes.

    Returns ``(slug, from_state, to_state)`` tuples for the TickSummary.
    """
    from factory.chain.handlers import persist_story

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()

    def _awaits_human(story: StoryRecord) -> bool:
        """States this pass may settle: the four recoverable-pending-human blocks,
        plus a dependency-deferral CAP park.

        The cap park is here because it is routed into ``factory inbox`` on the
        grounds that it "awaits a human decision" — so it needs the same exit the
        other awaiting-a-human rows have. Without it the operator's documented
        lever (close the tracker issue) does nothing for a cap-parked row and the
        inbox entry can only be cleared by hand-editing the DB. A DEADLOCK park is
        excluded, unchanged: it is abandoned-for-good, not awaiting anyone.
        """
        return story.state in _PENDING_HUMAN_STATES or is_dependency_cap_parked(
            story.state, story.last_rejection_reason
        )

    candidates = [
        s for s in rows if _awaits_human(s) and s.github_issue_number and s.github_issue_number > 0
    ]
    # Delivered-unmerged rows can accumulate while they wait on a human; check
    # them LAST so they never starve the per-tick budget of genuine blocks.
    candidates.sort(key=lambda s: s.state in DELIVERED_UNMERGED_STATES)

    settled: list[tuple[str, str, str]] = []
    checked = 0
    for story in candidates:
        if checked >= max_reconcile:
            break
        issue_number = story.github_issue_number
        if issue_number is None or issue_number <= 0:
            continue

        # Re-read live state: an earlier pass in THIS tick (recovery, sibling
        # cleanup) may already have moved this row.
        live_state = _current_story_state(db, story.id)
        if live_state is not None:
            # Re-check against the SAME predicate the candidate list used, reading
            # the marker from the live row (the cap park is state+marker, not state
            # alone).
            live_row = H.get_story(story.id, db) if story.id is not None else None
            if not _awaits_human(live_row if live_row is not None else story):
                continue
            story.state = live_state

        checked += 1
        if (
            story.state == StoryState.DELIVERED_PR.value
            and story.github_pr_number
            and story.github_pr_number > 0
        ):
            pr_query = query_pr_state or _query_pr_state
            pr_state = pr_query(app_config=cfg, pr_number=story.github_pr_number)
            if pr_state not in ("OPEN", "CLOSED"):
                # MERGED → reconcile_from_github deploys it; None → unknown.
                continue
        issue_state = query_issue_state(app_config=cfg, issue_number=issue_number)
        if issue_state != "CLOSED":
            # OPEN → the work is still wanted; None → unknown. Never settle on
            # anything but an explicit CLOSED.
            continue

        from_state = story.state
        story.state = StoryState.CLOSED_BY_OPERATOR.value
        story.error = (
            f"tracker issue #{issue_number} closed on GitHub while the story was "
            f"in {from_state}; settled as operator-closed. Re-open the issue and "
            f"move the story to a live dispatch state to revive it."
        )
        persist_story(story, db_path=db)
        _write_drift_event(
            root=root,
            story=story,
            from_state=from_state,
            pr_state=f"ISSUE_CLOSED#{issue_number}",
            action=f"settled -> {StoryState.CLOSED_BY_OPERATOR.value}",
        )
        settled.append((story.slug, from_state, StoryState.CLOSED_BY_OPERATOR.value))

    return settled


def _query_pr_merge_state(*, app_config: AppConfig, pr_number: int) -> str | None:
    """GitHub ``mergeStateStatus`` for an OPEN PR (upper-cased), or ``None``.

    Used by ``freshen_behind_prs`` to decide whether a PR is merely BEHIND a
    moved base (safe to fast-forward via ``gh pr update-branch``) versus
    truly conflicting (``DIRTY`` / ``mergeable == CONFLICTING`` — left to the
    conflict-recovery path) or already clean (nothing to do). Read-only ``gh pr
    view`` shell-out mirroring ``_query_pr_state``.

    ``None`` is the fail-safe sentinel (placeholder PR number, gh missing,
    timeout, non-zero exit, unparseable payload) AND is deliberately returned
    for any PR that is not currently OPEN, so a closed/merged PR is never
    freshened.
    """
    import subprocess

    if pr_number <= 0:  # synthesized placeholder — nothing to query
        return None
    cmd = [
        "gh",
        "pr",
        "view",
        str(pr_number),
        "--repo",
        app_config.repo,
        "--json",
        "state,mergeStateStatus",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    try:
        data = json.loads(proc.stdout)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    if str(data.get("state", "")).upper() != "OPEN":
        return None  # only ever freshen OPEN PRs
    return str(data.get("mergeStateStatus", "")).upper() or None


def _write_drift_event(
    *,
    root: Path,
    story: StoryRecord,
    from_state: str,
    pr_state: str,
    action: str,
) -> None:
    """Emit a first-class ``state_drift_reconciled`` anomaly (best-effort).

    Written to the ``git`` signal stream (one of the L1 watcher's ``_RAW_STREAMS``
    — so drift is SEEN by the FMS, not silent) AND to the per-story event log for
    the story timeline. Telemetry only: never raises, so a logging failure cannot
    crash the tick.
    """
    try:
        from factory.manager.signals import write_event

        write_event(
            "git",
            {
                "event": "state_drift_reconciled",
                "app": story.app,
                "story_id": story.id,
                "slug": story.slug,
                "pr_number": story.github_pr_number,
                "local_state_before": from_state,
                "authoritative_pr_state": pr_state,
                "action": action,
            },
            software_factory_root=root,
        )
    except Exception:  # noqa: BLE001 - telemetry, never crash the tick
        pass
    try:
        from factory.chain.event_log import log_story_event

        log_story_event(
            story.id,
            "state_drift_reconciled",
            {
                "local_state_before": from_state,
                "authoritative_pr_state": pr_state,
                "action": action,
                "pr_number": story.github_pr_number,
            },
            software_factory_root=root,
            slug_hint=story.slug,
        )
    except Exception:  # noqa: BLE001
        pass


def _revive_dependents_of_revived_blocker(*, blocker: StoryRecord, db: Path, root: Path) -> None:
    """Re-evaluate dependents parked in ``blocked_dependency_unmet`` whose blocker
    has been revived out of a dead-end sink (e.g. ``blocked_ci_unresolved``).

    When a ``blocked_ci_unresolved`` story is revived by reconcile (PR merged
    out-of-band), dependents that were parked in ``blocked_dependency_unmet``
    because this blocker was in a ``_DEAD_END_DEP_STATES`` sink must be
    re-evaluated — the blocker is no longer dead, so the dependent may now be
    buildable. Move each such dependent back to ``story_created`` so the
    orchestrator re-dispatches it on the next tick (best-effort, idempotent).

    Only acts on dependents whose blocker set is no longer permanently dead;
    a dependent still blocked on another dead-end sibling stays parked.
    """
    if blocker.id is None or not blocker.direction_id:
        return
    try:
        from factory.chain.handlers import persist_story

        eng = create_engine(f"sqlite:///{db}", echo=False)
        with Session(eng) as session:
            dependents = session.exec(
                select(StoryRecord).where(
                    StoryRecord.app == blocker.app,
                    StoryRecord.direction_id == blocker.direction_id,
                    StoryRecord.state == StoryState.BLOCKED_DEPENDENCY_UNMET.value,
                )
            ).all()

        for dep in dependents:
            if dep.id is None or dep.id <= (blocker.id or 0):
                continue
            pending = _direction_deps_pending(db, dep)
            # Both revival paths must share ONE predicate. Requiring only "no dep
            # is DEAD" un-parked a dependent while another blocker was still
            # human-blocked: it re-deferred, hit the cap again, and its
            # operator-visible marker was deleted and re-created in between.
            if _deps_none_permanently_dead(db, pending) and not _deps_all_stalled(db, pending):
                dep.state = _dep_cap_resume_state(dep, root=root)
                dep.error = None
                # A revived dependent starts a FRESH deferral window, and any
                # cap-park marker it carried is now stale (it would otherwise keep
                # the row in ``factory inbox`` after the park was undone).
                dep.dependency_defer_count = 0
                if (dep.last_rejection_reason or "").startswith(DEP_DEFER_CAP_REASON_PREFIX):
                    dep.last_rejection_reason = None
                persist_story(dep, db)
                _write_drift_event(
                    root=root,
                    story=dep,
                    from_state=StoryState.BLOCKED_DEPENDENCY_UNMET.value,
                    pr_state="N/A",
                    action=f"dependent_revived:blocker_{blocker.id}_no_longer_dead",
                )
    except Exception:  # noqa: BLE001 - best-effort, never break reconcile
        pass


def _record_reconciled_merge_and_enqueue_deploy(
    *, app: str, story: StoryRecord, pr_number: int, db: Path, root: Path
) -> None:
    """Record a ``merged=True`` merge-action row + enqueue a deploy for a merge
    that ``reconcile_from_github`` detected on GitHub (best-effort, idempotent).

    Since the auto-merge worker now only claims ``merged=True`` on a REALLY
    merged PR (``--auto`` merely ENABLES async auto-merge — it does not merge
    now), ``reconcile_from_github`` becomes the PRIMARY detector of the real,
    asynchronous merge. So it must trigger the deploy exactly like auto-merge's
    own merged path does — otherwise a merge that lands between ticks advances
    the story to ``deploy_pending`` but nothing ever deploys it.

    ``head_sha`` uses the SAME ``local-<story.id>`` scheme the auto-merge
    worker's synthesized production path uses (StoryRecord carries no real head
    sha, and the deploy sha is only a dedup/label key — the deploy pulls the
    merged branch, it does not check out this sha). Sharing the scheme makes the
    two merge detectors DEDUPE against each other: at most one row per story.

    Idempotent + fail-safe: only records/enqueues when no ``merged=True`` row
    for this ``head_sha`` already exists, and never raises (a recorder/enqueue
    hiccup must not break reconcile). A story leaves ``_MERGEABLE_STATES`` the
    moment it is reconciled, so it is no longer a candidate on later ticks — the
    dedupe check is belt-and-suspenders against a same-tick race with the
    auto-merge worker.
    """
    from factory.chain.auto_merge import (
        MergeAction,
        MergeActionRecord,
        _record_merge_action,
    )

    head_sha = f"local-{story.id}"
    try:
        eng = create_engine(f"sqlite:///{db}", echo=False)
        with Session(eng) as session:
            existing = session.exec(
                select(MergeActionRecord).where(
                    MergeActionRecord.app == app,
                    MergeActionRecord.head_sha == head_sha,
                    MergeActionRecord.merged == True,  # noqa: E712
                )
            ).first()
        if existing is not None:
            return  # already recorded (and deploy already enqueued) — no-op
        action = MergeAction(
            app=app,
            pr_number=pr_number,
            merged=True,
            reason="reconcile: PR merged on GitHub",
        )
        _record_merge_action(action, head_sha, db)
    except Exception:  # noqa: BLE001 - fail-safe: never break reconcile
        return

    try:
        from factory.deploy.orchestrator import enqueue_deploy

        enqueue_deploy(
            app=app,
            sha=head_sha,
            merged_pr_number=pr_number,
            software_factory_root=root,
            db_path=db,
        )
    except Exception:  # noqa: BLE001 - deploy-enqueue hiccup must not break reconcile
        pass


def _current_story_state(db: Path, story_id: int | None) -> str | None:
    """Read a story's LIVE state from the DB (the reconcile ``candidates``
    snapshot goes stale as siblings are superseded mid-loop). Returns None on
    any failure or missing id — the caller treats None as "no fresh info, use
    the snapshot", which is fail-safe (never skips on uncertainty)."""
    if story_id is None:
        return None
    try:
        eng = create_engine(f"sqlite:///{db}", echo=False)
        with Session(eng) as session:
            row = session.exec(select(StoryRecord).where(StoryRecord.id == story_id)).first()
            return row.state if row is not None else None
    except Exception:  # noqa: BLE001 - a read hiccup must never break reconcile
        return None


def _close_dual_draft_sibling_on_reconcile(
    *,
    winner: StoryRecord,
    cfg: AppConfig,
    root: Path,
    db: Path,
    github_client_factory: Callable[[], Any] | None,
    runner: Any,
) -> None:
    """Retire the losing dual-draft sibling when RECONCILE detects the winner's
    merge — the reconcile-path analogue of the auto-merge worker's own
    ``close_abandoned_draft_sibling`` call (auto_merge_tick, ``if action.merged``).

    Why this exists: fix A routes the real, asynchronous ``gh pr merge --auto``
    merge through ``reconcile_from_github`` (auto-merge only ENABLES auto-merge,
    returning ``merged=False``). Reconcile is therefore the PRIMARY detector of
    the merge for ``--auto`` PRs — the now-common case — and the ONLY place the
    winner's merge is observed on that path. Without this call the losing
    sibling is never superseded and proceeds toward a redundant second merge
    (the dual-draft OVER-FIRE that #70 meant to fix but only closed for the rare
    synchronous auto-merge path).

    Best-effort + idempotent: skips a non-dual-draft winner before building any
    GitHub client; ``close_abandoned_draft_sibling`` skips an already-superseded
    sibling and never raises. Any error here is swallowed — sibling cleanup must
    never break reconcile. ``dry_run`` is False: reconcile only runs on the
    real-run (``not dry_run``) tick path.
    """
    try:
        from factory.chain.dual_draft import (
            _draft_alt_suffix,
            close_abandoned_draft_sibling,
        )

        # Short-circuit before constructing a client: the vast majority of
        # merges are NOT dual-draft, and we should not resolve a GitHub token /
        # build a client for them.
        if _draft_alt_suffix(getattr(winner, "slug", "") or "") is None:
            return

        factory = github_client_factory
        if factory is None:
            from factory.providers.github import build_github_client

            factory = build_github_client
        gh = factory()
        if gh is None:
            # No token / client available — cleanup is best-effort; the Part 2
            # self-check in auto-merge still blocks the loser from merging.
            return
        close_abandoned_draft_sibling(winner, cfg, root, db, gh, False, runner=runner)
    except Exception:  # noqa: BLE001 - cleanup must never break reconcile
        pass


def reconcile_from_github(
    db: Path,
    app: str,
    *,
    cfg: AppConfig,
    root: Path,
    max_reconcile: int = _MAX_RECONCILE_PER_TICK,
    query_pr_state: Callable[..., str | None] = _query_pr_state,
    github_client_factory: Callable[[], Any] | None = None,
    sibling_cleanup_runner: Any = None,
) -> list[tuple[str, str, str]]:
    """Pull authoritative GitHub PR state into the local DB at the top of a tick.

    Local ``factory.db`` state is a PROJECTION; GitHub is the system of record
    for whether a PR merged, closed, or is still open. That projection drifts: a
    PR merged (or completed out-of-band) while the local story still says
    ``pr_open``; a PR closed while the story keeps looping on a dead branch. This
    pass reconciles each non-settled story that has a real PR against GitHub
    BEFORE any dispatch decision, using the SAME state-machine transitions
    auto-merge uses, and logs every reconciliation as a first-class
    ``state_drift_reconciled`` anomaly so drift is never silent.

    Candidates are EVERY non-settled story with a positive ``github_pr_number``
    — NOT just ``auto_merge._MERGEABLE_STATES`` (``pr_open`` / ``ci_green`` /
    ``ready_for_merge``). This includes:

    * States bounced back after CI-failure re-dispatch (e.g.
      ``reviewer_requested_changes``, ``dev_in_progress``) whose PR merged
      out-of-band (G2: stories 132/136).
    * **``blocked_ci_unresolved``** (D013): the CI-exhaustion path closes the PR
      and parks the story here. An operator may re-open and merge the PR without
      touching the factory DB; reconcile must detect that merge and revive the
      story through the same reconciled-merge path as the normal mergeable
      states. A CLOSED-unmerged PR stays blocked (no time-based revival).

    Drift cases handled:

    * PR **MERGED** on GitHub, local state still pre-merge → ``advance(story,
      EVENT_MERGED)`` → ``DEPLOY_PENDING`` (identical to the auto-merge success
      path) so the missed merge flows into deploy instead of being re-attempted
      forever. Because auto-merge now only claims ``merged=True`` on a REAL
      merge (``--auto`` merely enables async auto-merge), reconcile is the
      PRIMARY detector of the async merge and ALSO records a ``merged=True``
      merge-action row + enqueues the deploy (see
      ``_record_reconciled_merge_and_enqueue_deploy``) so the app actually ships.
      When the revived story came from ``blocked_ci_unresolved``, reconcile also
      re-evaluates its dependents (``_revive_dependents_of_revived_blocker``) so
      stories parked in ``blocked_dependency_unmet`` become dispatchable again.
    * PR **CLOSED** (not merged) on GitHub, local state still in-flight →
      ``advance(story, EVENT_PR_UNMERGEABLE)`` → ``BLOCKED_DEPLOY_FAILED`` so the
      story stops looping on a dead PR and surfaces for attention. A story
      already in ``blocked_ci_unresolved`` whose PR stays closed is left as-is
      (no-op) — revival is driven by the real artifact, never by time.
    * PR **OPEN** → local projection already matches GitHub → no-op.
    * **Unknown** query result (``None``) → no-op. Fail-safe: never advance a
      story on an ambiguous or failed GitHub query.

    Idempotent: once reconciled the story leaves the candidate set and is no
    longer considered, so a consistent DB produces zero mutations and zero
    events on re-run. Bounded: at most ``max_reconcile`` GitHub calls per tick.
    Pure DB rewrite + read-only gh queries — no LLM / git-write work, mirroring
    ``_recover_blocked_stories``. Returns ``(slug, from_state, to_state)`` tuples
    for the TickSummary.
    """
    from factory.chain.auto_merge import _MERGEABLE_STATES
    from factory.chain.handlers import persist_story
    from factory.chain.state_machine import (
        EVENT_MERGED,
        EVENT_PR_UNMERGEABLE,
        IllegalTransitionError,
        StoryState,
        is_terminal,
    )

    def _ci_watched(s: StoryRecord) -> bool:
        from factory.chain.auto_merge import watches_ci_before_delivery
        from factory.delivery import parse_level

        try:
            return watches_ci_before_delivery(parse_level(s.delivery_level))
        except ValueError:
            return False

    def _terminal(state_value: str | None) -> bool:
        try:
            return is_terminal(StoryState(state_value))
        except ValueError:
            return False

    def _settled(state_value: str | None) -> bool:
        # A story reconcile should no longer act on: already TERMINAL, or already
        # at the post-merge DEPLOY_PENDING target (its merge is recorded and its
        # deploy enqueued — re-forcing it every tick would spam drift events and
        # re-run the sibling cleanup; this preserves reconcile's idempotency).
        # EXCEPTION: ``blocked_ci_unresolved`` is terminal (no outgoing
        # transitions) but it carries a CLOSED PR whose merge state can change
        # out-of-band — the operator who fixes the CI failure may re-open and
        # merge the PR without touching the factory DB. Reconcile must detect that
        # merge and revive the story, so do NOT treat blocked_ci_unresolved as
        # settled.
        if state_value == StoryState.BLOCKED_CI_UNRESOLVED.value:
            return False
        # SAME exception for ``delivered_pr``: the factory left the PR open for a
        # human (delivery level draft_pr / pr). When that human merges it, merge
        # reality must flow into DEPLOY_PENDING exactly like an auto-merge. A
        # CLOSED-unmerged delivered PR settles to CLOSED_BY_OPERATOR below: the
        # human discarded the work (finding 11, 2026-11-02).
        if state_value == StoryState.DELIVERED_PR.value:
            return False
        return _terminal(state_value) or state_value == StoryState.DEPLOY_PENDING.value

    # Candidates: EVERY non-settled story that carries a real PR — NOT just the
    # ``_MERGEABLE_STATES`` (pr_open / ci_green / ready_for_merge). A PR merged
    # out-of-band while the story had bounced back to REVIEWER_REQUESTED_CHANGES
    # or DEV_IN_PROGRESS (e.g. after a CI-failure re-dispatch) is invisible to a
    # mergeable-states-only query, so the merge is never detected, the story
    # loops forever on an already-merged branch, and its dual-draft sibling is
    # never superseded (G2: stories 132/136). Detecting ANY merged PR regardless
    # of the story's current state is exactly what closes that gap. This also
    # includes ``blocked_ci_unresolved`` stories (D013): a PR that was closed by
    # the CI-exhaustion path may be re-opened and merged by an operator; reconcile
    # must detect that merge and revive the story.
    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        all_rows = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()
    candidates = [
        s
        for s in all_rows
        if s.github_pr_number and s.github_pr_number > 0 and not _settled(s.state)
    ]
    # Delivered PRs wait on a human and can accumulate; query them LAST so they
    # never starve the per-tick ``max_reconcile`` budget of live stories.
    candidates.sort(key=lambda s: s.state == StoryState.DELIVERED_PR.value)

    reconciled: list[tuple[str, str, str]] = []
    checked = 0
    for story in candidates:
        pr_number = story.github_pr_number
        if pr_number is None or pr_number <= 0:
            continue
        if checked >= max_reconcile:
            break

        # The ``candidates`` snapshot is taken ONCE, but a winner processed
        # earlier in THIS same loop may have run the dual-draft cleanup, which
        # closes a losing sibling's PR and sets it to SUPERSEDED_BY_SIBLING.
        # Re-read the live state and skip any candidate that has already become
        # TERMINAL — otherwise we'd query its just-closed PR, see CLOSED, apply
        # EVENT_PR_UNMERGEABLE, and clobber the intended SUPERSEDED_BY_SIBLING
        # with a false BLOCKED_DEPLOY_FAILED "attention" signal (adversarial
        # review, 2026-07-21).
        live_state = _current_story_state(db, story.id)
        if live_state is not None and _settled(live_state):
            continue
        if live_state is not None:
            story.state = live_state

        checked += 1
        pr_state = query_pr_state(app_config=cfg, pr_number=pr_number)
        if pr_state is None or pr_state == "OPEN":
            # Unknown → fail-safe no-op (never advance on uncertainty).
            # OPEN → local projection already matches GitHub → no-op.
            continue

        from_state = story.state
        if pr_state == "MERGED":
            # A merged PR is GROUND TRUTH: the story shipped. Route it to
            # DEPLOY_PENDING from ANY non-terminal state. The ordinary edges
            # cover pr_open/ci_green/ready_for_merge; a story bounced back to
            # reviewer_requested_changes / dev_in_progress after its PR merged
            # (G2: 132/136) has NO EVENT_MERGED edge, so force the terminal-safe
            # DEPLOY_PENDING directly rather than leave it looping on an
            # already-merged branch forever.
            event = EVENT_MERGED
            try:
                new_state = advance(story, EVENT_MERGED)
            except IllegalTransitionError:
                new_state = StoryState.DEPLOY_PENDING
        elif from_state == StoryState.DELIVERED_PR.value or (
            from_state in _MERGEABLE_STATES and _ci_watched(story)
        ):
            # CLOSED-unmerged DELIVERED PR (level draft_pr / pr): the factory
            # finished and handed the PR to a human, who closed it without
            # merging — a ruling, like closing the story issue. Settle it to the
            # operator-closed terminal sink so it stops being polled every tick
            # and its job/direction can finish. Direct assignment (no
            # ``_TRANSITIONS`` edge — adding one would make DELIVERED_PR
            # non-terminal for ``is_terminal``); declared in the conformance model.
            # Same ruling for a draft_pr / pr story whose PR the human closed
            # while the factory was still watching its CI (it would have been
            # DELIVERED_PR a tick later): closed_by_operator, not the
            # blocked_deploy_failed attention sink.
            event = "delivered_pr_closed_unmerged"
            new_state = StoryState.CLOSED_BY_OPERATOR
        else:
            # CLOSED (not merged). Only sink to the attention state from a
            # MERGEABLE state (a story whose OPEN PR was closed). A CLOSED PR on
            # an in-dev / in-review story is NORMAL churn — the story will open a
            # fresh PR — so never sink those; leave them to the chain.
            event = EVENT_PR_UNMERGEABLE
            if from_state not in _MERGEABLE_STATES:
                continue
            try:
                new_state = advance(story, EVENT_PR_UNMERGEABLE)
            except IllegalTransitionError:
                # No transition for this (state, event) pair — surface the
                # observed drift but do NOT force an illegal mutation.
                _write_drift_event(
                    root=root,
                    story=story,
                    from_state=from_state,
                    pr_state=pr_state,
                    action="observed_no_transition",
                )
                continue

        story.state = new_state.value
        if event == "delivered_pr_closed_unmerged":
            story.error = None
            story.last_rejection_reason = (
                f"PR #{pr_number} (delivery level {story.delivery_level}, story was "
                f"{from_state}) was closed on GitHub without merging; "
                "settled to closed_by_operator"
            )
        if event == EVENT_PR_UNMERGEABLE:
            story.error = (
                f"reconcile: PR #{pr_number} is CLOSED on GitHub (not merged) "
                f"while local state was {from_state!r}; routed to "
                f"{new_state.value} for attention."
            )
        persist_story(story, db)
        if event == EVENT_MERGED:
            # Reconcile is the PRIMARY detector of the real (async) merge now
            # that auto-merge no longer claims merged=True on mere
            # auto-merge-enable. Trigger the deploy exactly like auto-merge's
            # merged path so ``_latest_undeployed_sha`` picks it up and the app
            # actually deploys. Best-effort + idempotent; never crashes reconcile.
            _record_reconciled_merge_and_enqueue_deploy(
                app=app, story=story, pr_number=pr_number, db=db, root=root
            )
            # Dual-draft cleanup on the RECONCILE path (Part 1). Because fix A
            # routes the async ``--auto`` merge through reconcile, this — not the
            # auto-merge worker — is where the winner's merge is observed for the
            # common case, so the losing sibling must be superseded HERE too, the
            # same way ``auto_merge_tick`` does on its own merged path. Best-
            # effort/idempotent; never raises out of reconcile.
            _close_dual_draft_sibling_on_reconcile(
                winner=story,
                cfg=cfg,
                root=root,
                db=db,
                github_client_factory=github_client_factory,
                runner=sibling_cleanup_runner,
            )
            # D013: When a ``blocked_ci_unresolved`` story is revived by a merged
            # PR, re-evaluate its dependents — stories parked in
            # ``blocked_dependency_unmet`` because this blocker was dead may now
            # be buildable. Best-effort; never raises out of reconcile.
            if from_state == StoryState.BLOCKED_CI_UNRESOLVED.value:
                _revive_dependents_of_revived_blocker(blocker=story, db=db, root=root)
        reconciled.append((story.slug, from_state, new_state.value))
        _write_drift_event(
            root=root,
            story=story,
            from_state=from_state,
            pr_state=pr_state,
            action=f"advanced_to:{new_state.value}",
        )

    return reconciled


# Bound on how many ``gh pr update-branch`` calls ``freshen_behind_prs`` will
# make in a single tick. Each is a write-side merge-base-in, so cap the burst;
# any PR left BEHIND is simply refreshed on a later tick (it never drifts far
# because it is caught while still only BEHIND, never CONFLICTING).
_MAX_BRANCH_FRESHEN_PER_TICK = 10


def freshen_behind_prs(
    db: Path,
    app: str,
    *,
    cfg: AppConfig,
    root: Path,
    max_freshen: int = _MAX_BRANCH_FRESHEN_PER_TICK,
    max_reads: int = _MAX_RECONCILE_PER_TICK,
    query_merge_state: Callable[..., str | None] = _query_pr_merge_state,
    update_branch: Callable[..., bool] | None = None,
) -> list[tuple[str, int]]:
    """Keep OPEN mergeable PRs fresh so they never drift far enough to conflict.

    A PR cut from an older ``main`` falls BEHIND as ``main`` advances and, left
    alone, eventually CONFLICTS. Prevent that: each tick, for every story in a
    mergeable state (``pr_open`` / ``ci_green`` / ``ready_for_merge``) whose PR
    is merely ``BEHIND`` (``mergeStateStatus == "BEHIND"``), merge the base
    branch back in via ``gh pr update-branch`` (a MERGE — never a force-push).

    ONLY ``BEHIND`` PRs are touched: ``CONFLICTING`` / ``DIRTY`` PRs are left to
    the conflict-recovery path (``_attempt_pr_reconcile`` + terminal-block), and
    already-clean PRs need nothing. Bounded at ``max_freshen`` update-branch
    WRITES and ``max_reads`` ``gh pr view`` READS per tick (the read cap mirrors
    reconcile's so a large PR backlog can't burst the gh API each tick).
    ``update_branch`` defaults to ``auto_merge._attempt_pr_reconcile``
    (the existing ``gh pr update-branch`` wrapper — no duplicate gh plumbing).
    Fully fail-safe and idempotent (a freshened PR reports CLEAN next tick and
    is no longer a candidate). Returns ``(slug, pr_number)`` for each PR whose
    branch was advanced, for the TickSummary.
    """
    from factory.chain.auto_merge import _MERGEABLE_STATES, _attempt_pr_reconcile

    if update_branch is None:
        update_branch = _attempt_pr_reconcile

    eng = create_engine(f"sqlite:///{db}", echo=False)
    with Session(eng) as session:
        rows = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()
    from factory.chain.auto_merge import watches_ci_before_delivery
    from factory.delivery import parse_level

    def _factory_may_update(s: StoryRecord) -> bool:
        # draft_pr / pr: the PR is the HUMAN's deliverable — the factory does
        # not write a base merge into it while it watches its CI (it never did
        # once the story was DELIVERED_PR either), and a merge-in would restart
        # the very CI run being watched.
        try:
            return not watches_ci_before_delivery(parse_level(s.delivery_level))
        except ValueError:
            return True

    candidates = [
        s
        for s in rows
        if s.github_pr_number
        and s.github_pr_number > 0
        and s.state in _MERGEABLE_STATES
        and _factory_may_update(s)
    ]

    refreshed: list[tuple[str, int]] = []
    attempts = 0
    reads = 0
    for story in candidates:
        if attempts >= max_freshen or reads >= max_reads:
            # Bound WRITES (update-branch) AND READS (gh pr view) per tick, the
            # latter mirroring reconcile's ``_MAX_RECONCILE_PER_TICK`` so a large
            # open-PR backlog can't turn every tick into a burst of gh queries.
            break
        pr_number = story.github_pr_number
        if pr_number is None or pr_number <= 0:
            continue
        reads += 1
        merge_state = query_merge_state(app_config=cfg, pr_number=pr_number)
        if merge_state != "BEHIND":
            # None (unknown / not open), CLEAN, BLOCKED, DIRTY, CONFLICTING,
            # UNSTABLE, … → not our job. Never touch a non-BEHIND PR.
            continue
        attempts += 1
        if update_branch(app_config=cfg, pr_number=pr_number):
            refreshed.append((story.slug, pr_number))

    return refreshed


def reconcile_dual_draft_winners(
    db: Path,
    app: str,
    *,
    cfg: AppConfig,
    root: Path,
    github_client_factory: Callable[[], Any] | None = None,
    sibling_cleanup_runner: Any = None,
) -> list[tuple[str, str, str]]:
    """Standing, idempotent supersede of dual-draft LOSERS whose sibling shipped.

    ``close_abandoned_draft_sibling`` only fires the SINGLE tick a winner's merge
    is first detected. If the losing sibling was mid-dispatch that exact tick (or
    the winner shipped via a path that skipped the cleanup), the loser is
    stranded — and once the winner is TERMINAL (``deployed``) it leaves
    ``reconcile_from_github``'s candidate set, so no later tick ever retries the
    supersede. Result (G2, stories 133/137): a redundant second interpretation
    keeps running toward its own merge.

    This pass re-derives the cleanup from GROUND TRUTH every tick: for each
    dual-draft group (same ``direction_id`` + app, ``-alt-*`` slug suffixes) that
    has a SHIPPED sibling (``DEPLOYED`` or ``DEPLOY_PENDING``), it supersedes
    every still-in-flight sibling via the same ``close_abandoned_draft_sibling``
    used by the merge/reconcile paths. Idempotent (that function skips any
    terminal sibling, so a settled group is a no-op) and fail-safe (never raises
    out of the tick). The DB supersede runs even without a GitHub token; the
    PR/issue close is best-effort. Returns ``(slug, from_state, to_state)`` for
    the TickSummary.
    """
    from factory.chain.dual_draft import _draft_alt_suffix, close_abandoned_draft_sibling
    from factory.chain.state_machine import StoryRecord, StoryState, is_terminal

    _SHIPPED = {StoryState.DEPLOYED.value, StoryState.DEPLOY_PENDING.value}

    def _terminal(state_value: str | None) -> bool:
        try:
            return is_terminal(StoryState(state_value))
        except ValueError:
            return False

    try:
        eng = create_engine(f"sqlite:///{db}", echo=False)
        with Session(eng) as session:
            rows = session.exec(select(StoryRecord).where(StoryRecord.app == app)).all()
    except Exception:  # noqa: BLE001 - a bad DB must never break the tick
        return []

    # Group dual-draft stories (those carrying an ``-alt-*`` suffix) by direction.
    groups: dict[str, list[StoryRecord]] = {}
    for r in rows:
        if _draft_alt_suffix(r.slug or "") is not None:
            groups.setdefault(r.direction_id, []).append(r)

    factory = github_client_factory
    if factory is None:
        from factory.providers.github import build_github_client

        factory = build_github_client

    superseded: list[tuple[str, str, str]] = []
    for members in groups.values():
        winner = next((m for m in members if (m.state or "") in _SHIPPED), None)
        if winner is None:
            continue
        losers = [
            m
            for m in members
            if m.id != winner.id
            and not _terminal(m.state)
            and (m.state or "") not in _SHIPPED
            and _draft_alt_suffix(m.slug or "") != _draft_alt_suffix(winner.slug or "")
        ]
        if not losers:
            continue
        # Build a client best-effort (supersede still runs if it is None). One
        # winner drives the shared cleanup, which retires ALL its in-flight
        # siblings; capture from-states first so the summary is accurate.
        loser_from = [(m.slug, m.state or "") for m in losers]
        try:
            gh = factory()
        except Exception:  # noqa: BLE001
            gh = None
        try:
            close_abandoned_draft_sibling(
                winner, cfg, root, db, gh, False, runner=sibling_cleanup_runner
            )
        except Exception:  # noqa: BLE001 - cleanup must never break the tick
            continue
        for slug, from_state in loser_from:
            superseded.append((slug, from_state, StoryState.SUPERSEDED_BY_SIBLING.value))

    return superseded


def _build_current_state(
    *,
    root: Path,
    db: Path,
    app: str,
    in_flight_app: int,
    exclude_story_id: int | None = None,
) -> dict[str, Any]:
    """Compose the dict passed to ``can_dispatch``.

    Spends are computed from the local ``runs`` table; PR counts and CI red
    counts are intentionally left ``None`` (unknown) when we can't reach
    GitHub. The enforcer treats ``None`` as "skip this check" so the dry-run
    path doesn't make network calls.
    """
    return {
        "mode": get_mode(root, db_path=db),
        "global_in_flight": _count_global_in_flight(db, exclude_story_id=exclude_story_id),
        "app_in_flight": in_flight_app,
        "today_spend_usd": today_spend_usd(root, db_path=db),
        "hour_spend_usd": hour_spend_usd(root, db_path=db),
        "open_prs_for_app": None,  # filled in by webhook-driven path
        "failing_ci_count": None,  # filled in by webhook-driven path
        "pm_invocations_last_hour": 0,
    }


_ISSUE_HYGIENE_INTERVAL_S = 3600  # autonomous issue-reconcile: at most once/hour/app


def _issue_hygiene_marker(root: Path, app: str) -> Path:
    return root / "state" / "issue_hygiene" / f"{app}.last"


def _should_run_issue_hygiene(root: Path, app: str, *, now: float | None = None) -> bool:
    """Rate-gate the autonomous issue-reconcile to at most once/hour/app.

    The reconcile scans stories + makes GH-API calls; running the idempotent
    sweep every 5-minute tick is wasteful, but skipping it entirely (today's
    state) leaks completed/abandoned trackers open until a human runs
    ``factory reconcile-issues``. FAIL-SAFE: any stat problem → True (err toward
    running the safe, idempotent sweep — a spurious extra run is harmless).
    """
    import time as _time

    marker = _issue_hygiene_marker(root, app)
    try:
        if not marker.exists():
            return True
        age = (now if now is not None else _time.time()) - marker.stat().st_mtime
        return age >= _ISSUE_HYGIENE_INTERVAL_S
    except OSError:
        return True


def _mark_issue_hygiene_ran(root: Path, app: str) -> None:
    """Stamp the hygiene marker (mtime = now). Best-effort."""
    try:
        marker = _issue_hygiene_marker(root, app)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("", encoding="utf-8")
    except OSError:
        pass


def tick(
    software_factory_root: Path,
    app: str,
    *,
    dry_run: bool = False,
    max_advances_per_story: int = 10,
    db_path: Path | None = None,
) -> TickSummary:
    """Advance every in-flight story for ``app`` toward PR_OPEN.

    Each story is driven through as many handlers as possible (up to
    ``max_advances_per_story``) so the dry-run dogfood completes in a single
    tick call. Real-run will typically only advance one handler per tick
    because webhooks gate progress (CI green, PR open, etc).

    Before each handler the settings enforcer is consulted. If a job is
    rejected, the story's ``last_rejection_reason`` is set and the
    orchestrator moves on to the next story.
    """
    root = Path(software_factory_root)
    db = db_path or (root / "state" / "factory.db")
    # The budget is the PROCESS's (systemd TimeoutStartSec counts from process
    # start), not this call's.
    _tick_started_mono = _process_started_mono()

    # Dry-run isolation: when the caller did not pass an explicit ``db_path``
    # (i.e. the CLI is hitting the production state DB), copy the live DB to
    # a temp file so dry-run handler state mutations (advance() +
    # persist_story) don't pollute the real DB. Without this, a single
    # dry-run tick can advance a story all the way to ``pr_open`` in the
    # real DB, causing the next real tick to treat the story as terminal
    # and skip it. Tests that pass an explicit ``db_path`` opt out of
    # isolation — they own the DB they hand in.
    _dry_run_db_temp: Path | None = None
    if dry_run and db_path is None and db.exists():
        import shutil
        import tempfile

        fd, tmp_name = tempfile.mkstemp(prefix="factory_dryrun_", suffix=".db")
        os.close(fd)
        _dry_run_db_temp = Path(tmp_name)
        shutil.copyfile(db, _dry_run_db_temp)
        db = _dry_run_db_temp

    # Unique ID for this tick invocation; threaded into runs.ndjson so
    # each run record can be linked back to the tick that spawned it.
    tick_id = str(uuid.uuid4())
    _tick_t0 = datetime.now(UTC).timestamp()

    try:
        cfg = load_app_config(app, root)
    except FileNotFoundError as exc:
        if _dry_run_db_temp is not None:
            _dry_run_db_temp.unlink(missing_ok=True)
        return TickSummary(app=app, dry_run=dry_run, errors=[(app, f"app config missing: {exc}")])

    # Phase 7 — halt check (double defence: also enforced in drive_chain.sh).
    # If the L3 Diagnostician has written a halt state file, skip all dispatch
    # and return a halted TickSummary so even direct ``factory tick`` calls
    # honour the halt without burning LLM credits.
    try:
        from factory.manager.halt import get_halt_state, is_halted

        if is_halted(root=root):
            halt_state = get_halt_state(root=root) or {}
            _halt_reason = halt_state.get("reason", "unknown")
            if _dry_run_db_temp is not None:
                _dry_run_db_temp.unlink(missing_ok=True)
            return TickSummary(
                app=app,
                dry_run=dry_run,
                halted=True,
                halt_reason=_halt_reason,
            )
    except Exception as _halt_exc:  # noqa: BLE001
        # The dangerous data path (a corrupt/unreadable halt FILE) now fails
        # SAFE inside halt.is_halted itself. This guard only fires when the halt
        # MODULE is broken (e.g. ImportError). We keep fail-open here — halting
        # all ticks on an import error would wedge the factory with no recovery
        # path — but we make it a CRITICAL, visible alert (not a stderr line the
        # FMS can't see) so the broken module gets fixed.
        try:
            from factory.manager.signals import write_alert_event

            write_alert_event(
                "halt_check_module_error",
                f"halt-check raised {_halt_exc!r}; continuing with tick "
                "(fail-open). Indicates a broken halt module, not a corrupt "
                "halt file (that path fails safe).",
                severity="critical",
                software_factory_root=root,
            )
        except Exception:  # noqa: BLE001 - alerting is best-effort
            import sys as _sys

            print(
                f"[orchestrator] CRITICAL: halt-check raised {_halt_exc!r} "
                "(fail-open) and alert emit failed.",
                file=_sys.stderr,
            )

    settings = load_settings(root)
    summary = TickSummary(app=app, dry_run=dry_run)

    # Open a MIGRATING engine before anything reads the ``stories`` table. Every
    # pass below this line except ``H.*`` uses a raw ``create_engine`` +
    # ``select(StoryRecord)``, and SQLModel emits an explicit column list — so on a
    # live DB that predates a new StoryRecord column, the reconcile passes would
    # each raise ``no such column`` into ``summary.errors`` (and ``factory tick``
    # exits 1 on any error) until something happened to call ``H._engine`` first.
    # ``_engine`` runs ``_ensure_story_columns`` and is idempotent.
    try:
        H._engine(db)
    except Exception as exc:  # noqa: BLE001 - never fail the tick on a migration probe
        summary.errors.append((app, f"schema migration probe failed (non-fatal): {exc!r}"))

    # Factory mode, read once per tick. The dependency-deferral cap consults it:
    # the dependency gate runs BEFORE ``can_dispatch`` (which is what implements
    # the modes), so without this the cap would keep abandoning dependents while
    # the operator had the factory paused to investigate their blocker.
    #
    # ``get_mode`` WRITES to the DB (first-touch default insert) and can raise
    # (e.g. ``database is locked``). This read sits BEFORE the tick's main try
    # block below — historically an exception here propagated straight out of
    # ``tick()`` with no summary at all, not even a partial one: the single
    # most severe instance of the get_mode-outside-try hazard fixed throughout
    # this function (019 safety-mechanism rewire). Fail OPEN to "normal" on
    # error rather than crash: ``can_dispatch`` (the PRIMARY mode gate for
    # per-story dispatch) re-reads mode independently inside its own guarded
    # path, so a transient failure here only affects the secondary
    # dependency-deferral cap check below, not the pause guarantee itself.
    try:
        _tick_mode = get_mode(root, db_path=db)
    except Exception as _mode_exc:  # noqa: BLE001 - never crash tick() outright
        _tick_mode = "normal"
        summary.errors.append(("mode-read", repr(_mode_exc)))

    # ---- Signal: tick_start ------------------------------------------------
    try:
        from factory.manager.signals import write_tick_event

        write_tick_event(
            "tick_start",
            tick_id=tick_id,
            app=app,
            dry_run=dry_run,
            software_factory_root=root,
        )
    except Exception:  # noqa: BLE001
        pass

    # Track outcome for the guaranteed tick_end signal in the finally block.
    _tick_succeeded = False
    _tick_exception: str | None = None

    try:
        # Recover stories stranded in ``*_in_progress`` from a crashed tick or
        # a prior config-change regime (e.g. retry-cap lowered while a row was
        # mid-attempt). Pure DB rewrite — no LLM / git work. See the function
        # docstring for the recovery mapping.
        if not dry_run:
            # Reconcile-from-authoritative FIRST: local factory.db state is a
            # PROJECTION; GitHub is the system of record for PR merge/close truth.
            # Pull authoritative PR state into the DB BEFORE any recovery or
            # dispatch decision, so a merge that happened out-of-band flows into
            # deploy (and a dead/closed PR sinks to attention) instead of the
            # recovery/dispatch logic acting on stale local state. Read-only gh
            # queries + pure DB rewrite; a gh failure is a fail-safe no-op.
            try:
                drifted = reconcile_from_github(db, app, cfg=cfg, root=root)
                for slug, from_state, to_state in drifted:
                    summary.handler_runs.append((slug, f"{from_state}(drift)", to_state))
            except Exception as exc:
                summary.errors.append((app, f"github reconcile failed (non-fatal): {exc!r}"))

            # Same authoritative-first rationale, applied to whether the work is
            # still WANTED rather than to PR state: a pending-human story whose
            # tracker issue the operator has already closed is settled as
            # operator-closed, so the DB stops contradicting GitHub (and the
            # operator's "no open issues/PRs = queue clean" signal). Only ever
            # advances toward terminal, so it is idempotent; an OPEN or unknown
            # issue state is a no-op.
            try:
                op_closed = reconcile_closed_trackers(db, app, cfg=cfg, root=root)
                for slug, from_state, to_state in op_closed:
                    summary.handler_runs.append((slug, f"{from_state}(operator-closed)", to_state))
            except Exception as exc:
                summary.errors.append(
                    (app, f"closed-tracker reconcile failed (non-fatal): {exc!r}")
                )

            # Standing dual-draft supersede: retire any loser whose sibling has
            # SHIPPED, re-derived from ground truth every tick so a loser that
            # was mid-dispatch when the winner merged (and is now unreachable by
            # reconcile_from_github because the winner is terminal) still gets
            # superseded instead of racing toward a redundant second merge (G2).
            try:
                dd_superseded = reconcile_dual_draft_winners(db, app, cfg=cfg, root=root)
                for slug, from_state, to_state in dd_superseded:
                    summary.handler_runs.append((slug, f"{from_state}(dual-draft)", to_state))
            except Exception as exc:
                summary.errors.append(
                    (app, f"dual-draft winner reconcile failed (non-fatal): {exc!r}")
                )

            # NOTE: GitHub issue-lifecycle hygiene (close trackers/story-issues
            # for completed/superseded work) is handled later in this tick by the
            # existing rate-gated, mode-guarded ``_should_run_issue_hygiene`` +
            # ``reconcile_completed_issues`` block — the dual-draft supersede
            # above just moves losers into the resolved state that sweep closes.

            # Fix B — branch-freshening: keep OPEN mergeable PRs that are merely
            # BEHIND a moved base fast-forwarded (``gh pr update-branch`` — a
            # merge, no force-push) so they never drift far enough to CONFLICT.
            # Only BEHIND PRs are touched; conflicting/clean ones are left alone.
            # Bounded per tick and fully fail-safe (never breaks the tick).
            #
            # ``update-branch`` is a WRITE (a server-side merge commit on each PR
            # branch that re-triggers CI), so it is GATED exactly like every other
            # forward-motion op: suppressed in ``paused`` / ``drain-reviews`` modes
            # (an operator who paused — often BECAUSE a bad merge hit main — must
            # not have us merge that main into every open PR) and only when
            # auto-merge is enabled (freshening branches for merges that will
            # never happen is pointless churn).
            try:
                _fresh_mode = get_mode(root, db_path=db)
            except Exception as _fresh_mode_exc:  # noqa: BLE001 - fail-safe: skip the write
                _fresh_mode = "paused"
                summary.errors.append(("branch-freshening-mode-read", repr(_fresh_mode_exc)))
            if _fresh_mode not in {"paused", "drain-reviews"} and settings.auto_merge.enabled:
                try:
                    freshened = freshen_behind_prs(db, app, cfg=cfg, root=root)
                    for slug, pr_number in freshened:
                        summary.handler_runs.append(
                            (slug, f"pr#{pr_number}(behind)", "branch-freshened")
                        )
                except Exception as exc:
                    summary.errors.append((app, f"branch-freshening failed (non-fatal): {exc!r}"))

            try:
                recovered = _prune_stale_in_progress(db, app, settings=settings, root=root)
                for slug, from_state, to_state in recovered:
                    summary.handler_runs.append((slug, f"{from_state}(stale)", to_state))
            except Exception as exc:
                summary.errors.append((app, f"stale-state recovery failed (non-fatal): {exc!r}"))

            # A blocked story is a factory defect — re-dispatch blocked stories
            # so since-shipped chain fixes reach them, instead of requiring a
            # manual DB reset. Bounded per story (see _recover_blocked_stories).
            try:
                re_dispatched = _recover_blocked_stories(db, app, root=root)
                for slug, from_state, to_state in re_dispatched:
                    summary.handler_runs.append((slug, f"{from_state}(recovered)", to_state))
            except Exception as exc:
                summary.errors.append((app, f"blocked-story recovery failed (non-fatal): {exc!r}"))

            # Dependents parked by the deferral CAP re-enter the chain once every
            # blocker has left the human-blocked set (operator revival, the FMS
            # retry-mergeable playbook, or a reconciled merge). Runs AFTER the
            # reconcile/recovery passes above so it sees this tick's revivals.
            try:
                dep_revived = _revive_capped_dependents(db, app, root=root)
                for slug, from_state, to_state in dep_revived:
                    summary.handler_runs.append((slug, f"{from_state}(dep-revived)", to_state))
            except Exception as exc:
                summary.errors.append(
                    (app, f"dependency-defer revival failed (non-fatal): {exc!r}")
                )

        stories = H.stories_in_flight(app, db)
        # N2 (review 2026-11-02): never dispatch a story whose JOB was
        # cancelled. A handler that held a stale row can have written it back
        # to a live state after the cancel parked it; re-park it instead.
        if not dry_run:
            stories = _repark_cancelled_job_stories(stories, db=db, root=root)

        # Optional shard partitioning for safe multi-loop parallelism. Several
        # concurrent ``drive_chain`` loops each take the SAME ordered in-flight
        # snapshot and, as the queue drains, converge on the same front story —
        # racing to dispatch it into the same per-story worktree (observed:
        # three loops all running dev on story 16). There is no atomic claim at
        # dispatch, so the only safe way to run N loops is to give each a
        # DISJOINT slice of the story space. ``FACTORY_SHARD="k/n"`` keeps only
        # stories whose id ≡ k (mod n); run one loop per k with the same n and
        # the loops can never touch the same story. Unset → process everything
        # (single-loop default, unchanged behaviour).
        _shard = os.environ.get("FACTORY_SHARD", "").strip()
        if _shard:
            try:
                _k, _n = (int(x) for x in _shard.split("/"))
                if _n > 0:
                    stories = [s for s in stories if s.id is not None and s.id % _n == _k]
            except (ValueError, ZeroDivisionError):
                pass  # malformed shard spec → no filtering (fail-open)

        # ---- Signal: queue snapshot + spend snapshot ---------------------------
        try:
            from factory.manager.signals import write_queue_snapshot, write_spend_snapshot
            from factory.settings.spend import projected_end_of_day

            # Count stories by state for queue snapshot.
            _all_stories_for_app: list[StoryRecord] = []
            try:
                _eng_q = create_engine(f"sqlite:///{db}", echo=False)
                with Session(_eng_q) as _sess_q:
                    _all_stories_for_app = list(
                        _sess_q.exec(select(StoryRecord).where(StoryRecord.app == app)).all()
                    )
            except Exception:
                pass
            _counts: dict[str, int] = {}
            for _s in _all_stories_for_app:
                _counts[_s.state] = _counts.get(_s.state, 0) + 1
            write_queue_snapshot(app=app, counts_by_state=_counts, software_factory_root=root)

            # Spend snapshot — query by persona for by_persona breakdown.
            _today_usd = today_spend_usd(root, db_path=db)
            _hour_usd = hour_spend_usd(root, db_path=db)
            _proj_usd = projected_end_of_day(root, db_path=db)
            _daily_cap = float(getattr(settings.caps, "daily_spend_usd", 0) or 0)
            _hourly_cap = float(getattr(settings.caps, "hourly_spend_usd", 0) or 0)
            _by_persona: dict[str, float] = {}
            try:
                from factory.runner import Run as _Run

                _today_str = datetime.now(UTC).date().isoformat()
                _eng_sp = create_engine(f"sqlite:///{db}", echo=False)
                with Session(_eng_sp) as _sess_sp:
                    _run_rows = list(_sess_sp.exec(select(_Run)).all())
                for _r in _run_rows:
                    if (_r.ts or "").startswith(_today_str):
                        _by_persona[_r.persona] = _by_persona.get(_r.persona, 0.0) + float(
                            _r.cost_usd or 0.0
                        )
            except Exception:
                pass
            write_spend_snapshot(
                today_usd=_today_usd,
                last_hour_usd=_hour_usd,
                projected_eod_usd=_proj_usd,
                daily_cap_usd=_daily_cap,
                hourly_cap_usd=_hourly_cap,
                by_persona=_by_persona,
                software_factory_root=root,
            )
        except Exception:  # noqa: BLE001
            pass

        # Prune worktrees for stories that no longer need them (terminal
        # states, missing rows). Idempotent and best-effort — a failure here
        # mustn't take the tick down.
        if not dry_run:
            try:
                from factory.app_config import resolve_app_repo_path
                from factory.chain.worktree import prune_stale_worktrees

                active_ids: set[int] = {s.id for s in stories if s.id is not None}
                # KEEP worktrees of blocked stories: blocked states mean
                # "awaiting operator resolution or auto-recovery", and both
                # use the worktree — the operator resolves merge conflicts in
                # it, and recovery re-dispatches dev into it. Pruning them
                # destroyed in-progress operator conflict resolutions three
                # times on 2026-06-11/12. Only DEPLOYED (and rows gone from
                # the DB) are truly done with their worktree.
                eng_keep = create_engine(f"sqlite:///{db}", echo=False)
                with Session(eng_keep) as _ks:
                    blocked_rows = _ks.exec(
                        select(StoryRecord).where(
                            StoryRecord.app == app,
                            StoryRecord.state.in_(  # type: ignore[attr-defined]
                                [
                                    StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value,
                                    StoryState.BLOCKED_DEPLOY_FAILED.value,
                                    StoryState.BLOCKED_REVIEW_NONCONVERGENT.value,
                                    # Keep the worktree: the operator reading a
                                    # dev's underspecification claim needs the
                                    # partial work that prompted it.
                                    StoryState.BLOCKED_UNDERSPECIFIED.value,
                                ]
                            ),
                        )
                    ).all()
                active_ids |= {r.id for r in blocked_rows if r.id is not None}
                source_repo = resolve_app_repo_path(cfg, root)
                if source_repo.exists():
                    prune_stale_worktrees(
                        source_repo,
                        software_factory_root=root,
                        app=app,
                        active_story_ids=active_ids,
                    )
            except Exception as exc:
                summary.errors.append((app, f"worktree prune failed (non-fatal): {exc!r}"))

        # START-of-tick auto-merge pass. With in-tick dev convergence, a tick
        # can run for hours; PRs that reached PR_OPEN on a PREVIOUS tick must
        # not wait for this tick's story loop to finish before merging
        # (observed 2026-07-18: two mergeable PRs sat >2h behind a long tick).
        # The end-of-tick hook below still runs for PRs that open THIS tick.
        # auto_merge.enabled=false still runs the draft_pr / pr CI WATCH
        # (watch_only): it never merges, and without it those stories would
        # sit in pr_open forever (review of PR #335, MUST 1).
        _am_watch_only = not settings.auto_merge.enabled
        try:
            _pre_mode = get_mode(root, db_path=db)
        except Exception as _pre_mode_exc:  # noqa: BLE001 - fail-safe: skip the write
            _pre_mode = "paused"
            summary.errors.append(("auto-merge-pre-mode-read", repr(_pre_mode_exc)))
        if _pre_mode not in {"paused", "drain-reviews"}:
            try:
                summary.merges = auto_merge_tick(
                    root,
                    app,
                    dry_run=dry_run,
                    db_path=db,
                    merge_method=settings.auto_merge.merge_method,
                    wait_for_ci=settings.auto_merge.wait_for_ci,
                    delete_branch_after_merge=settings.auto_merge.delete_branch_after_merge,
                    watch_only=_am_watch_only,
                )
            except Exception as exc:
                summary.errors.append(("auto-merge-pre", repr(exc)))

        # Even when no in-flight stories exist, we still want the
        # end-of-tick auto-merge hook to fire so PRs that landed in
        # PR_OPEN on a previous tick (and are therefore terminal here) get
        # a fresh merge attempt.
        stories = _solo_first(list(stories))
        for story in stories:
            # Poisoned-row guard: a state value outside the StoryState enum
            # (e.g. a bad manual/manager write) must quarantine THAT story,
            # not abort the whole tick — one invalid row halted the factory
            # for days on 2026-07-07. Skip it, surface it, keep ticking.
            try:
                StoryState(story.state)
            except ValueError:
                summary.skipped.append(
                    (story.slug, f"invalid state {story.state!r}; story skipped (non-fatal)")
                )
                # Emit the anomaly ONCE per (story, bad-state), not every tick:
                # a poisoned row persists until an operator repairs it, and the
                # 5-min timer would otherwise append this event ~288x/day/row
                # forever (unbounded per-story-log growth). Dedup mirrors
                # _handle_ci_failure's already-escalated guard.
                if story.id is not None:
                    from factory.chain.event_log import read_story_events as _rse

                    _prior = _rse(story.id, software_factory_root=root, slug_hint=story.slug)
                    _already = any(
                        e.get("event") == "invalid_state_skipped" and e.get("state") == story.state
                        for e in _prior
                    )
                    if not _already:
                        log_story_event(
                            story.id,
                            "invalid_state_skipped",
                            {"state": story.state},
                            software_factory_root=root,
                            slug_hint=story.slug,
                        )
                continue
            # Advance up to ``max_advances_per_story`` steps for this story.
            for _ in range(max_advances_per_story):
                handler_name = _dispatch_for_story(story)
                if handler_name is None:
                    # No handler for this state — either in-progress (waiting on
                    # webhook) or terminal. Stop driving.
                    break

                # ---- WS1.1 GLOBAL per-story budget circuit breaker ----------
                # BEFORE dispatching the handler, check the aggregate per-story
                # ceiling. The composed loops (dev retries, reviewer cycles,
                # auto-recovery re-dispatch, CI-fix) each have their own counter
                # but no shared ceiling; a pathological story can burn the
                # product of all of them. If the story's total attempts or total
                # spend has crossed the per-story cap, route it to the terminal
                # BLOCKED_BUDGET_EXCEEDED sink and emit an EVIDENCE event — never
                # silently drop. Terminal (no auto-recovery back into the loop)
                # so a broken story stops burning spend.
                _budget_reason = _story_budget_breaker_reason(story, settings.caps)
                if _budget_reason is not None:
                    from_state = story.state
                    story.state = advance(story, EVENT_BUDGET_EXCEEDED).value
                    story.last_rejection_reason = _budget_reason
                    H.persist_story(story, db)
                    _last_signature = story.error or story.last_rejection_reason
                    log_story_event(
                        story.id,
                        "budget_exceeded",
                        {
                            "story_id": story.id,
                            "slug": story.slug,
                            "handler": handler_name,
                            "from_state": from_state,
                            "to_state": story.state,
                            "reason": _budget_reason,
                            "total_attempts": story.total_attempts,
                            "total_spend_usd": round(story.total_spend_usd, 4),
                            "per_story_attempts": getattr(
                                settings.caps, "per_story_attempts", None
                            ),
                            "per_story_spend_usd": getattr(
                                settings.caps, "per_story_spend_usd", None
                            ),
                            "dev_retries": story.dev_retries,
                            "reviewer_cycles": story.reviewer_cycles,
                            "last_failure_signature": _last_signature,
                        },
                        software_factory_root=root,
                        slug_hint=story.slug,
                    )
                    summary.handler_runs.append((story.slug, from_state, story.state))
                    summary.stories_blocked += 1
                    break

                # Tick-budget guard (solo AND chain sandboxes). Dispatch is serial
                # and the systemd tick is killed at ``TimeoutStartSec``; never
                # start a sandbox that cannot finish inside what is left of this
                # process's budget. Defer to the next tick (no state change).
                if handler_name in _SANDBOX_HANDLERS and not dry_run:
                    _budget_defer = _sandbox_tick_budget_shortfall(
                        story, handler_name, _tick_started_mono, settings=settings
                    )
                    if _budget_defer is not None:
                        summary.deferred.append((story.slug, _budget_defer))
                        _record_budget_deferral(story, _budget_defer, db=db, root=root)
                        break

                # SOLO spend precondition: a solo conversation is capped at the
                # remaining per-story / daily / hourly budget. With nothing left
                # it would pause before spending and burn a dev retry on an
                # untouched tree — so never dispatch it. Per-story exhausted →
                # the terminal budget sink (same as the WS1.1 breaker); daily /
                # hourly / unreadable → defer (the window refills).
                if handler_name == "dev" and not dry_run:
                    _pre = _solo_spend_precheck(story, root=root, db=db)
                    if _pre is not None:
                        _action, _why, _basis = _pre
                        if _action == "block":
                            _from = story.state
                            story.state = advance(story, EVENT_BUDGET_EXCEEDED).value
                            story.last_rejection_reason = _why
                            H.persist_story(story, db)
                            log_story_event(
                                story.id,
                                "budget_exceeded",
                                {
                                    "from_state": _from,
                                    "to_state": story.state,
                                    "reason": "solo_spend_cap_exhausted",
                                    **_basis,
                                },
                                software_factory_root=root,
                                slug_hint=story.slug,
                            )
                            summary.handler_runs.append((story.slug, _from, story.state))
                            summary.stories_blocked += 1
                        else:
                            summary.deferred.append((story.slug, _why))
                            _record_budget_deferral(story, _why, db=db, root=root)
                        break

                # Dependency-ordering gate. A story does not build until every
                # lower-id story in its own direction is deployed (id order ==
                # SM build order: foundations first). This stops a dependent
                # story (smoke test / UI / endpoint) from being constructed
                # before the model/service/endpoint it relies on exists on
                # main — the out-of-order construction that stranded the
                # interdependent D008-D010 batch. Defer (not block): the story
                # waits in its current state until its foundations deploy.
                _deps_pending = _direction_deps_pending(db, story)
                if _deps_pending:
                    # Dependency-deadlock guard: if EVERY pending dependency is
                    # terminally parked (a never-to-deploy sink), this story can
                    # never build — deferring it forever silently strands it (and
                    # blocks its direction from ever completing / its tracker
                    # issue from ever closing). Park it to the terminal
                    # BLOCKED_DEPENDENCY_UNMET sink instead. Recoverable: reviving
                    # the blocking sibling + this story re-enters the chain.
                    if _deps_permanently_dead(db, _deps_pending):
                        _dl_from = story.state
                        story.state = StoryState.BLOCKED_DEPENDENCY_UNMET.value
                        H.persist_story(story, db)
                        log_story_event(
                            story.id,
                            "dependency_deadlocked",
                            {
                                "direction": story.direction_id,
                                "dead_dependency_story_ids": _deps_pending[:10],
                                "from_state": _dl_from,
                            },
                            software_factory_root=root,
                            slug_hint=story.slug,
                        )
                        summary.handler_runs.append((story.slug, _dl_from, story.state))
                        break

                    # Deferral CAP. The deadlock guard above only fires when every
                    # blocker is a DEFINITIVE dead end. A blocker in a
                    # recoverable-pending-human sink (``blocked_deploy_failed`` &
                    # co.) is deliberately NOT a dead end — a human may revive it —
                    # but nothing in the pipeline will move it either, so the
                    # dependent used to defer every tick FOREVER with no cap and no
                    # signal: 2026-07-28, D018 stories 168-171 idled behind story
                    # 167 (``blocked_deploy_failed``) for hours while every tick
                    # printed "No in-flight stories". Uncapped wait +
                    # detect-without-remediate.
                    #
                    # So: count consecutive STALLED deferrals (all blockers
                    # human-blocked) and, once the count AND the stall age are both
                    # past their bounds, park the dependent in the existing
                    # BLOCKED_DEPENDENCY_UNMET sink with a marker reason that puts it
                    # in ``factory inbox``. Waiting on a LIVE blocker is normal and
                    # resets the counter, so ordinary foundation-waiting is never
                    # capped however long it takes.
                    #
                    # EVERY write below is best-effort: this path used to be
                    # read-only, and a locked-DB write must not abort a whole tick
                    # (the queue behind this story would go undispatched, and a
                    # non-zero exit crash-loops the systemd unit). On any failure we
                    # fall through to the plain deferral, exactly as before.
                    _deps_stalled = _deps_all_stalled(db, _deps_pending)
                    _cap_park = False
                    try:
                        if _deps_stalled:
                            # Clamp at the cap: once the ceiling is reached the count
                            # carries no more information, and for a story the cap
                            # deliberately never parks (DEPLOY_PENDING below) an
                            # unclamped counter would write on every tick forever.
                            if story.dependency_defer_count < _MAX_DEPENDENCY_DEFERRALS:
                                story.dependency_defer_count += 1
                                # NOT persist_story: see _bump_dependency_defer_count
                                # (stamping updated_at here would hide this very
                                # stall from the stalled-story detector).
                                _bump_dependency_defer_count(
                                    db, story.id, story.dependency_defer_count
                                )
                        elif story.dependency_defer_count or is_dependency_cap_parked(
                            StoryState.BLOCKED_DEPENDENCY_UNMET.value,
                            story.last_rejection_reason,
                        ):
                            # A blocker is live again: fresh window, and drop any stale
                            # cap marker so the operator's inbox doesn't keep showing a
                            # park that has already been undone.
                            story.dependency_defer_count = 0
                            if (story.last_rejection_reason or "").startswith(
                                DEP_DEFER_CAP_REASON_PREFIX
                            ):
                                story.last_rejection_reason = None
                            H.persist_story(story, db)

                        _cap_park = (
                            _deps_stalled
                            and story.dependency_defer_count >= _MAX_DEPENDENCY_DEFERRALS
                            # NEVER cap-park a story whose code is already MERGED. The
                            # ordering gate exists to stop code being CONSTRUCTED before
                            # its foundations are on main; a story at DEPLOY_PENDING is
                            # past that — abandoning it would strand merged work
                            # undeployed AND (since the sink counts as resolved) let its
                            # tracker close over it. Such a row keeps the pre-existing
                            # defer behaviour, now at least visible in the tick summary
                            # and in ``factory why``.
                            and story.state != StoryState.DEPLOY_PENDING.value
                            # A dry run must not assert a transition (nor write the
                            # event that claims one) — it previews, it does not park.
                            and not dry_run
                            # An operator who PAUSED the factory is usually
                            # investigating exactly this kind of blocker. Abandoning
                            # its dependents while paused would make "pause to look at
                            # it" the cause of the abandonment.
                            and _tick_mode not in {"paused", "drain-reviews"}
                            # ...and the blockers must have been sitting still long
                            # enough that the automatic revival paths (FMS recovery on
                            # its 30-minute cooldown, reconcile) have had their shot.
                            and _deps_stalled_long_enough(db, _deps_pending)
                        )
                        if _cap_park:
                            _cap_from = story.state
                            _cap_reason = (
                                f"{DEP_DEFER_CAP_REASON_PREFIX}: deferred "
                                f"{story.dependency_defer_count}x behind human-blocked "
                                f"story_ids={_deps_pending[:10]} in direction "
                                f"{story.direction_id}"
                            )
                            story.state = StoryState.BLOCKED_DEPENDENCY_UNMET.value
                            story.last_rejection_reason = _cap_reason
                            H.persist_story(story, db)
                    except Exception as _cap_exc:  # noqa: BLE001
                        _cap_park = False
                        log_story_event(
                            story.id,
                            "dependency_deferral_cap_error",
                            {
                                "direction": story.direction_id,
                                "error": repr(_cap_exc)[:300],
                                "note": "cap bookkeeping failed; story stays deferred",
                            },
                            software_factory_root=root,
                            slug_hint=story.slug,
                        )
                    if _cap_park:
                        log_story_event(
                            story.id,
                            "dependency_deferral_capped",
                            {
                                "direction": story.direction_id,
                                "waiting_on_story_ids": _deps_pending[:10],
                                "from_state": _cap_from,
                                "to_state": story.state,
                                "deferrals": story.dependency_defer_count,
                                "cap": _MAX_DEPENDENCY_DEFERRALS,
                                "min_stall_seconds": _MIN_DEP_STALL_SECONDS,
                                "reason": _cap_reason,
                            },
                            software_factory_root=root,
                            slug_hint=story.slug,
                        )
                        summary.handler_runs.append((story.slug, _cap_from, story.state))
                        summary.stories_blocked += 1
                        summary.deferred.append((story.slug, _cap_reason))
                        break
                    log_story_event(
                        story.id,
                        "dependency_deferred",
                        {
                            "direction": story.direction_id,
                            "waiting_on_story_ids": _deps_pending[:10],
                            "state": story.state,
                            "blockers_all_human_blocked": _deps_stalled,
                            "deferrals": story.dependency_defer_count,
                            "cap": _MAX_DEPENDENCY_DEFERRALS,
                        },
                        software_factory_root=root,
                        slug_hint=story.slug,
                    )
                    # Surface the deferral in the TickSummary. Without this a tick
                    # that deferred N stories and dispatched nothing printed "No
                    # in-flight stories", telling the operator the queue was empty
                    # while it silently rotted.
                    summary.deferred.append(
                        (
                            story.slug,
                            f"waiting_on={_deps_pending[:10]} "
                            f"({'human-blocked' if _deps_stalled else 'in progress'}, "
                            f"deferrals {story.dependency_defer_count}/"
                            f"{_MAX_DEPENDENCY_DEFERRALS}"
                            + (
                                f", holding for the {_MIN_DEP_STALL_SECONDS // 60}m stall window"
                                if _deps_stalled
                                and story.dependency_defer_count >= _MAX_DEPENDENCY_DEFERRALS
                                else ""
                            )
                            + ")",
                        )
                    )
                    break

                # Docs-chain serialization gate. A docs story may only LEAVE
                # STORY_CREATED when no other docs story for this app is already
                # active (open PR / mid-merge). This prevents two docs PRs —
                # which rewrite an overlapping set of canonical context files —
                # from being open at once and conflicting at merge time
                # (root cause of the blocked_deploy_failed docs backlog). The
                # gate fires only at the start state, so an already-running docs
                # story is never blocked by itself, and STORY_CREATED siblings
                # don't count as active → exactly one wins per tick, no deadlock.
                if (
                    story.chain_kind == "docs"
                    and story.state == StoryState.STORY_CREATED.value
                    and _count_app_docs_active(db, app, exclude_story_id=story.id) > 0
                ):
                    log_story_event(
                        story.id,
                        "docs_serialized",
                        {
                            "reason": "another docs story for this app has an "
                            "active PR; deferring to avoid context-file conflict",
                        },
                        software_factory_root=root,
                        slug_hint=story.slug,
                    )
                    break

                # Backpressure check before dispatch. The current_state dict is
                # recomputed each iteration so the in-flight counts reflect any
                # newly-completed stories. Use the cap-aware counter
                # (``_count_app_in_flight``) so queued ``STORY_CREATED`` siblings
                # spawned in the same PM-sync batch don't self-block the entire
                # batch — only stories with an active agent count.
                in_flight_app = _count_app_in_flight(db, app, exclude_story_id=story.id)
                state_dict = _build_current_state(
                    root=root,
                    db=db,
                    app=app,
                    in_flight_app=in_flight_app,
                    exclude_story_id=story.id,
                )
                # Resolve the actual job_kind to dispatch — bug-typed directions
                # get a "-bug" suffix so ``fix-only`` mode lets the work
                # proceed while still blocking feature stories.
                direction = H.find_direction_for_story(story, root)
                job_kind = _resolve_job_kind(story, direction, handler_name)
                decision = can_dispatch(job_kind, app, state_dict, settings)
                if not decision.allowed:
                    story.last_rejection_reason = decision.rejected_reason
                    H.persist_story(story, db)
                    summary.blocked_by_caps += 1
                    summary.rejected.append((story.slug, decision.rejected_reason or "unknown"))
                    log_story_event(
                        story.id,
                        "dispatch_rejected",
                        {
                            "handler": handler_name,
                            "job_kind": job_kind,
                            "reason": decision.rejected_reason,
                            "global_in_flight": state_dict.get("global_in_flight"),
                            "app_in_flight": state_dict.get("app_in_flight"),
                            "today_spend_usd": state_dict.get("today_spend_usd"),
                            "hour_spend_usd": state_dict.get("hour_spend_usd"),
                        },
                        software_factory_root=root,
                        slug_hint=story.slug,
                    )
                    break
                # Job is allowed — clear any stale rejection reason.
                if story.last_rejection_reason is not None:
                    story.last_rejection_reason = None
                    H.persist_story(story, db)

                from_state = story.state
                log_story_event(
                    story.id,
                    "handler_start",
                    {
                        "handler": handler_name,
                        "from_state": from_state,
                        "model_tier": story.current_model_tier,
                        "dev_retries_so_far": story.dev_retries,
                    },
                    software_factory_root=root,
                    slug_hint=story.slug,
                )
                # WS1.1 breaker accumulator: count this dispatch. Bumped BEFORE
                # invoking so a handler that crashes still counts as a burned
                # attempt (the pre-dispatch check above reads this next tick).
                story.total_attempts += 1
                try:
                    result = _invoke_handler(
                        handler_name,
                        story,
                        cfg,
                        root,
                        dry_run=dry_run,
                        db_path=db,
                    )
                except Exception as exc:
                    # Roll the story back to its pre-handler state and stash the
                    # error on the StoryRecord. Handlers typically advance the
                    # story into a foo_in_progress state and persist it BEFORE
                    # invoking the LLM, so an exception leaves the row stuck —
                    # ``_dispatch_for_story`` returns None for *_in_progress
                    # states (those are webhook-driven), and the next tick can't
                    # retry. Rolling back makes handler crashes recoverable: the
                    # next tick will dispatch the same handler again.
                    story.state = from_state
                    story.error = repr(exc)
                    # Refresh the breaker's spend accumulator from the ledger:
                    # a crashed handler may still have recorded partial run cost.
                    # None == transient read failure → keep the prior value
                    # (never poison the accumulator with a sentinel).
                    _spend = _story_ledger_spend_usd(db, story.id)
                    if _spend is not None:
                        story.total_spend_usd = _spend
                    H.persist_story(story, db)
                    summary.errors.append((story.slug, repr(exc)))
                    log_story_event(
                        story.id,
                        "handler_exception",
                        {
                            "handler": handler_name,
                            "rolled_back_to": from_state,
                            "exception": repr(exc),
                        },
                        software_factory_root=root,
                        slug_hint=story.slug,
                    )
                    # WS4.2: record the failed dispatch as a chain_step too, so
                    # the replayable stream captures crashes, not just advances.
                    emit_chain_step(
                        story,
                        handler=handler_name,
                        from_state=from_state,
                        to_state=story.state,
                        outcome="exception",
                        software_factory_root=root,
                        extra={"exception": repr(exc)},
                    )
                    break
                # WS1.1 breaker accumulator: refresh this story's aggregate
                # spend from the D003 per-run ledger (authoritative — no
                # double-count on retries). None == a transient read failure
                # (e.g. sqlite lock from the concurrent manager daemon): keep
                # the prior accumulator rather than overwriting it, so a glitch
                # can't trip the terminal breaker on a healthy story. The
                # handler persisted its own state transition; persist again so
                # total_attempts/total_spend_usd survive to the next tick's
                # pre-dispatch breaker check.
                _spend = _story_ledger_spend_usd(db, story.id)
                if _spend is not None:
                    story.total_spend_usd = _spend
                # WS1.1 advance-decay: if this dispatch moved the story to a NEW
                # happy-path milestone (strictly beyond its high-water mark, so
                # NOT a dev<->review oscillation), reset the attempt counter so a
                # poisoned historical count (e.g. attempts burned by an earlier
                # infra bug) can't false-trip the breaker on a story that IS
                # progressing. Spend stays the hard ceiling. Persist happens
                # below so the decayed counter survives to the next tick.
                if _apply_advance_decay(story):
                    log_story_event(
                        story.id,
                        "budget_attempts_decayed",
                        {
                            "to_state": story.state,
                            "progress_ordinal": story.max_progress_ordinal,
                            "total_spend_usd": round(story.total_spend_usd, 4),
                        },
                        software_factory_root=root,
                        slug_hint=story.slug,
                    )
                H.persist_story(story, db)
                summary.handler_runs.append((story.slug, from_state, story.state))
                summary.stories_advanced += 1
                log_story_event(
                    story.id,
                    "handler_end",
                    {
                        "handler": handler_name,
                        "from_state": from_state,
                        "to_state": story.state,
                        "had_error": bool(result.error),
                        "error": result.error,
                    },
                    software_factory_root=root,
                    slug_hint=story.slug,
                )
                # WS4.2: append a typed, replayable chain_step record for this
                # dispatch (append-only per-app stream; content hash/ref of the
                # step's persisted artifact). Best-effort — never crashes a tick.
                emit_chain_step(
                    story,
                    handler=handler_name,
                    from_state=from_state,
                    to_state=story.state,
                    outcome="error" if result.error else "advanced",
                    software_factory_root=root,
                )
                if result.error or story.state == StoryState.BLOCKED_TESTS_NEED_CLARIFICATION.value:
                    summary.stories_blocked += 1
                    break
                if story.state == StoryState.PR_OPEN.value:
                    break

        # End-of-tick auto-merge hook. Runs after every story handler has had
        # its turn so a story that JUST advanced into PR_OPEN this tick gets
        # a merge attempt on the same tick. Gated by
        # ``factory_settings.auto_merge.enabled`` and skipped in modes where
        # forward motion is suppressed (``paused``, ``drain-reviews``).
        # auto_merge.enabled=false still runs the draft_pr / pr CI WATCH
        # (watch_only): it never merges, and without it those stories would
        # sit in pr_open forever (review of PR #335, MUST 1).
        _am_watch_only = not settings.auto_merge.enabled
        try:
            # ``get_mode`` WRITES to the DB (first-touch default insert),
            # so a `database is locked` error is possible here. It MUST be
            # inside this try: previously it sat between the ``enabled``
            # check and the try block, so a locked-DB exception propagated
            # straight out of ``tick()``, killing the whole tick and
            # discarding ``summary`` before the caller ever saw it (a
            # reviewer-flagged hazard shared by every hook below — fixed
            # in all of them together, 019 safety-mechanism rewire).
            current_mode = get_mode(root, db_path=db)
            if current_mode not in {"paused", "drain-reviews"}:
                merge_actions = auto_merge_tick(
                    root,
                    app,
                    dry_run=dry_run,
                    db_path=db,
                    merge_method=settings.auto_merge.merge_method,
                    wait_for_ci=settings.auto_merge.wait_for_ci,
                    delete_branch_after_merge=settings.auto_merge.delete_branch_after_merge,
                    watch_only=_am_watch_only,
                )
                # EXTEND, never overwrite: the start-of-tick pass may have
                # already recorded decisions (and advanced those stories),
                # so a quiet end-of-tick pass would otherwise erase them.
                # Dedup by pr_number: in dry-run a "merged" fixture isn't
                # actually removed, so both passes report the same PR —
                # keep the first decision per PR.
                _seen_prs = {m.pr_number for m in (summary.merges or [])}
                summary.merges = list(summary.merges or []) + [
                    m for m in merge_actions if m.pr_number not in _seen_prs
                ]
        except Exception as exc:
            # Auto-merge (and the mode lookup guarding it) failures must
            # not break the tick — the operator can still inspect the
            # chain via ``factory story`` and re-run auto-merge by hand.
            summary.errors.append(("auto-merge", repr(exc)))

        # Post-merge main-branch CI-health monitor (D004). Cheap (1-2 ``gh``
        # calls) — runs once per app per tick regardless of in-flight story
        # count, since it isn't watching any particular story: it's watching
        # main itself for a required check that went red AFTER merge (flaky
        # test, merge-interaction failure, infra/runner change). Gated the
        # same way as auto-merge: an explicit settings flag, and suppressed
        # in modes where forward motion (here: filing a new direction) is
        # deliberately paused.
        if settings.ci_health.enabled:
            try:
                # get_mode INSIDE the try — see the auto-merge hook above for
                # why (a locked-DB read must never kill the tick).
                current_mode = get_mode(root, db_path=db)
                if current_mode not in {"paused", "drain-reviews"}:
                    summary.ci_health = main_ci_health_tick(root, app, dry_run=dry_run)
            except Exception as exc:
                # Best-effort: a CI-health monitor (or its mode lookup)
                # failure must never break the tick.
                summary.errors.append(("ci-health", repr(exc)))

        # Detector -> direction trigger (019 AC7 / Flow D). Same gating
        # discipline as ci-health above (explicit settings flag + suppressed
        # in modes where forward motion — here: filing a new direction — is
        # deliberately paused), PLUS an extra condition ci-health doesn't
        # need: skipped ENTIRELY in dry_run, not just non-mutating. Every
        # detector reads real on-disk state (runs.ndjson, factory.db, …) and
        # a dry-run tick already runs against a throwaway DB copy — running
        # the pass there would file directions against a temp DB's story ids
        # that don't exist in the real one.
        if settings.detector_watch.enabled and not dry_run:
            try:
                # get_mode INSIDE the try — see the auto-merge hook above.
                current_mode = get_mode(root, db_path=db)
                if current_mode not in {"paused", "drain-reviews"}:
                    summary.detector_watch = detector_watch_tick(root, app)
            except Exception as exc:
                # Best-effort: a detector-watch (or its mode lookup) failure
                # must never break the tick.
                summary.errors.append(("detector-watch", repr(exc)))

        # 019 AC6 — idle becomes a ping (Flow C). Runs where the deleted
        # ``idle.py`` block used to (see cli.py's tick_cmd history): once per
        # tick, per app, AFTER dispatch/auto-merge/ci-health so "zero
        # dispatchable stories" reflects what actually happened THIS tick, not
        # a pre-dispatch snapshot. Skipped in dry_run (no state write, no
        # event — a dry-run preview must never consume the one-ping-per-
        # episode dedup) and in modes where forward-motion signals are
        # deliberately suppressed. Fully fail-safe: any exception lands in
        # ``summary.errors`` (never breaks the tick), and the module's own
        # internal fail-safe (see ``idle_ping.py``) suppresses rather than
        # spams on a corrupt marker.
        if not dry_run:
            try:
                # get_mode INSIDE the try — see the auto-merge hook above.
                current_mode = get_mode(root, db_path=db)
                if current_mode not in {"paused", "drain-reviews"}:
                    from factory.chain.idle_ping import run_idle_ping_tick

                    _ping = run_idle_ping_tick(root, app, db)
                    if _ping.error:
                        summary.errors.append(("idle-ping", _ping.error))
                    elif _ping.fired:
                        summary.idle_ping = {
                            "idle_since": _ping.idle_since,
                            "last_delivered_unit": _ping.last_delivered_unit,
                        }
            except Exception as exc:  # noqa: BLE001 - never break the tick
                summary.errors.append(("idle-ping", repr(exc)))

        # Autonomous issue hygiene. Close GitHub trackers/story-issues for
        # directions/stories that are COMPLETE or terminally ABANDONED, so the
        # repo's issues stay clean WITHOUT a manual ``factory reconcile-issues``.
        # The event-driven close fires only on DEPLOY; a direction abandoned
        # without a deploy (all children in terminal sinks) would otherwise leak
        # its tracker open forever. Rate-gated (~hourly/app), suppressed in
        # paused/drain modes, and FULLY FAIL-SAFE: reconcile never raises and a
        # hygiene hiccup must never fail the tick, so it is NOT recorded in
        # ``summary.errors`` — only surfaced (counts) in ``summary.issue_hygiene``.
        if not dry_run and _should_run_issue_hygiene(root, app):
            try:
                # get_mode INSIDE the try — see the auto-merge hook above.
                _hyg_mode = get_mode(root, db_path=db)
                if _hyg_mode not in {"paused", "drain-reviews"}:
                    from factory.directions.tracker_issue import reconcile_completed_issues
                    from factory.providers.github import build_github_client

                    _gh = build_github_client()
                    if _gh is not None:
                        _rep = reconcile_completed_issues(
                            cfg, _gh, software_factory_root=root, db_path=db
                        )
                        _mark_issue_hygiene_ran(root, app)
                        summary.issue_hygiene = {
                            "trackers_closed": len(_rep.get("trackers_closed", [])),
                            "stories_closed": len(_rep.get("stories_closed", [])),
                            "errors": len(_rep.get("errors", [])),
                        }
            except Exception:  # noqa: BLE001 - hygiene must NEVER break the tick
                pass

        # Deterministic operational-recovery cycle
        # (``factory.manager.recovery.run_recovery_cycle``). PR #247 deleted
        # ``factory/manager/apply.py`` — the ONLY production caller of every
        # one of the six recovery playbooks, including
        # ``recover-stuck-fixonly-mode`` and ``quarantine-invalid-enum-story``,
        # each of which corresponds to a RECORDED live wedge in this repo's
        # history (a stuck non-normal mode blocked all dispatch; invalid-enum
        # rows failed every tick forever). CLAUDE.md documents ``recovery`` as
        # a surviving safety mechanism; without this hook it was orphaned and
        # failing silently. Gated by ``settings.recovery.enabled`` (default
        # True — every playbook fixes a recorded wedge and the module is
        # itself internally fail-safe: it forces dry-run while the factory is
        # halted and bounds itself with a per-cycle action cap + per-target
        # cooldown), skipped in ``dry_run`` (it can mutate real story/mode
        # state) and in ``paused``/``drain-reviews`` (forward motion
        # deliberately suppressed). ``get_mode`` INSIDE the try — see the
        # auto-merge hook above for why. Surfaced on ``summary.recovery`` only
        # when the cycle actually did something (recovered/escalated/skipped/
        # errored); an all-quiet cycle stays ``None`` so a healthy soak's tick
        # output doesn't get noisy.
        if settings.recovery.enabled and not dry_run:
            try:
                current_mode = get_mode(root, db_path=db)
                if current_mode not in {"paused", "drain-reviews"}:
                    from factory.manager.recovery import run_recovery_cycle

                    _recovery_result = run_recovery_cycle(root, apps=[app], db_path=db)
                    if any(
                        _recovery_result.get(_k)
                        for _k in (
                            "recovered",
                            "escalated",
                            "skipped_cooldown",
                            "skipped_cap",
                            "errors",
                        )
                    ):
                        summary.recovery = _recovery_result
            except Exception as exc:  # noqa: BLE001 - recovery must never break the tick
                summary.errors.append(("recovery", repr(exc)))

        # Poison-escalation (``factory.manager.poison_escalation.
        # escalate_poisoned_rows``). Orphaned by the SAME PR #247 deletion —
        # its only caller was the deleted L1 watcher, so a persistent
        # poisoned/invalid-enum row (the reconciler above quarantines the
        # SYMPTOM every cycle) never surfaced the underlying data-integrity
        # anomaly to a human. Fully self-gated internally (only escalates
        # when a recent ``tick_end`` reported ``skipped > 0``, and dedups on a
        # stable signature within a cooldown), so this call is cheap and
        # inert on a normal healthy tick. Same discipline as every hook above:
        # skipped in ``dry_run``, skipped in ``paused``/``drain-reviews``,
        # ``get_mode`` INSIDE the try, and any failure lands in
        # ``summary.errors`` without ever breaking the tick.
        if not dry_run:
            try:
                current_mode = get_mode(root, db_path=db)
                if current_mode not in {"paused", "drain-reviews"}:
                    from factory.manager.poison_escalation import escalate_poisoned_rows

                    _poison_result = escalate_poisoned_rows(root, db_path=db, apps=[app])
                    if _poison_result.get("status") not in (
                        "no_skip_signal",
                        "no_poisoned_rows",
                    ):
                        summary.poison_escalation = _poison_result
            except Exception as exc:  # noqa: BLE001 - never break the tick
                summary.errors.append(("poison-escalation", repr(exc)))

        _tick_succeeded = True
    except Exception as _exc:  # noqa: BLE001
        _tick_exception = repr(_exc)
        raise
    finally:
        # ---- Signal: tick_end (guaranteed even on unhandled exceptions) ----
        try:
            from factory.manager.signals import write_tick_event as _wte

            _wte(
                "tick_end",
                tick_id=tick_id,
                app=app,
                dry_run=dry_run,
                duration_s=round(datetime.now(UTC).timestamp() - _tick_t0, 3),
                stories_advanced=summary.stories_advanced,
                stories_blocked=summary.stories_blocked,
                errors=len(summary.errors),
                skipped=len(summary.skipped),
                merges_attempted=len(summary.merges),
                success=_tick_succeeded,
                exception=_tick_exception,
                software_factory_root=root,
            )
        except Exception:  # noqa: BLE001
            pass
        # Clean up the dry-run temp DB regardless of success or failure.
        if _dry_run_db_temp is not None:
            _dry_run_db_temp.unlink(missing_ok=True)

    return summary


def tick_summary_as_dict(summary: TickSummary) -> dict[str, Any]:
    return {
        "app": summary.app,
        "dry_run": summary.dry_run,
        "halted": summary.halted,
        "halt_reason": summary.halt_reason,
        "stories_advanced": summary.stories_advanced,
        "blocked_by_caps": summary.blocked_by_caps,
        "stories_blocked": summary.stories_blocked,
        "handler_runs": summary.handler_runs,
        "rejected": summary.rejected,
        "deferred": summary.deferred,
        "errors": summary.errors,
        "skipped": summary.skipped,
        "merges": [
            {
                "pr_number": m.pr_number,
                "merged": m.merged,
                "reason": m.reason,
                "gates_passed": list(m.gates_passed),
                "blocking_labels": list(m.blocking_labels),
            }
            for m in summary.merges
        ],
        "ci_health": (
            None
            if summary.ci_health is None
            else {
                "state": summary.ci_health.state,
                "filed": summary.ci_health.filed,
                "filed_direction_id": summary.ci_health.filed_direction_id,
                "reason": summary.ci_health.reason,
                "required_failing": list(summary.ci_health.required_failing),
                "advisory_failing": list(summary.ci_health.advisory_failing),
            }
        ),
        "detector_watch": (
            None
            if summary.detector_watch is None
            else {
                "app": summary.detector_watch.app,
                "ran": list(summary.detector_watch.ran),
                "firings_total": summary.detector_watch.firings_total,
                "filed": [
                    {
                        "detector": f.detector,
                        "subject": f.subject,
                        "signature": f.signature,
                        "direction_id": f.direction_id,
                    }
                    for f in summary.detector_watch.filed
                ],
                "deduped": list(summary.detector_watch.deduped),
                "capped": list(summary.detector_watch.capped),
                "errors": list(summary.detector_watch.errors),
                "dedupe_scan_failed": summary.detector_watch.dedupe_scan_failed,
            }
        ),
        "issue_hygiene": summary.issue_hygiene,
        "idle_ping": summary.idle_ping,
        "recovery": summary.recovery,
        "poison_escalation": summary.poison_escalation,
    }
