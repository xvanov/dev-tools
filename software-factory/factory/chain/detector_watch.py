"""Detector -> direction trigger, deduped on signature (019 AC7 / Flow D).

The FMS L1 Watcher — deleted 2026-08-07 with the other three LLM tiers (see
``STATUS.md`` and the Exteroception v1 direction, P0) — was the *only*
production caller of ``factory.manager.detectors.DETECTORS``. This module is
their replacement caller: a plain chain-tick pass, no LLM in the loop, that
turns a detector firing into a machine-filed direction and stops the same
fault from being re-filed every tick (the "33x-re-file class" — the manager's
own measured 78% proposal redundancy).

Design, top to bottom
----------------------
1. **Adapters, not raw calls.** Each of the 11 registered detectors returns a
   different shape (a list of findings, or a metrics dict) and most of them
   describe the *whole app pipeline*, not the one app this tick happens to be
   driving. ``_ADAPTERS`` maps detector name -> a small function that (a)
   invokes the detector with this tick's ``since``/lookback, (b) filters its
   output down to the rows that belong to ``app`` (a story-id -> app lookup
   via ``state/factory.db`` where the detector itself has no ``app`` field),
   and (c) reduces each surviving row to a *firing*: ``(subject, evidence)``,
   where ``subject`` is a STABLE entity name (a story id, a
   ``(story, persona)`` pair, a path, a state-transition triple) — never a
   timestamp or free text, because the subject feeds the dedupe signature.

   Every adapter call is individually wrapped and its RETURN SHAPE is
   validated: a crashing detector, or one that returns something other than
   ``list[Firing]``, records an error and every OTHER detector still runs.
   ``_ADAPTERS`` is asserted (in tests) to cover exactly ``set(DETECTORS)`` —
   the failure this prevents is the deleted watcher's own: it hard-coded 9 of
   11 detectors and silently never called the other 2.

2. **Signature + dedupe.** ``f"{detector}:{normalize(subject)}"`` is embedded
   verbatim as ``<!-- detector-signature: {sig} -->`` in the filed direction's
   body (the ``ci_health`` pattern — see ``factory.chain.ci_health``).
   ``normalize`` maps internal whitespace to ``_`` (never a literal space —
   the marker-scan regex's capture group deliberately excludes whitespace, so
   a space inside a signature would make the marker permanently unreadable
   and re-file every tick forever; review round 2, S4). Before filing, this
   module scans the app's non-terminal directions for that marker. Unlike
   ``ci_health``, a scan FAILURE here refuses to file rather than falling
   through to "not open" — ``ci_health`` gates exactly one signature per app,
   so failing open there costs at most one duplicate; this module fans out
   across 11 detectors, and failing open on a broken scan is precisely the
   re-file storm this whole mechanism exists to prevent. Fail SAFE means
   blocking new filings, never re-filing on a dedupe blind spot. A direction
   directory with no readable ``direction.md`` (e.g. a partial write left
   behind by a disk-full ``create_direction`` call) makes the whole scan
   untrustworthy and is treated the same way (S3).

   Dedupe-terminal policy (S9): a direction status of ``closed`` is ALSO
   terminal for this scan (a superset of the shared
   ``factory.chain.scheduled_tasks._TERMINAL_DIRECTION_STATUSES``, kept LOCAL
   to this module rather than edited into that shared constant — see the
   docstring on ``_open_detector_signatures``). Once an operator explicitly
   closes a detector-filed direction, its signature is free to fire again:
   ``factory/manager/gc.py`` only reaps ``scheduled-`` sources, so a
   ``detector-*`` direction is never garbage-collected, and treating
   ``closed`` as non-terminal-forever would mean the ONLY way out of the
   inbox is permanent silence. This is safe only combined with the S1
   liveness/recency fix below — without it, a still-firing-on-stale-evidence
   direction that gets closed would immediately re-file (the exact
   abandoned<->refile ping-pong the first review round measured).

3. **A hard cap, priority-ordered.** At most ``_MAX_FILINGS_PER_TICK`` (3) new
   directions per tick, across every detector combined — CLAUDE.md's
   "nothing loops more than 3 times" applied to self-filed work. Firings
   beyond the cap are reported, not dropped: dedupe means they file on a
   LATER tick once the cap has headroom. Firings are round-robined across
   detectors by ``_DETECTOR_PRIORITY`` before the cap is applied (S7) — a
   detector with no floor (formerly ``runs_failed_since``) enumerating first
   and ALWAYS having something to report must never be able to monopolize
   the cap and starve a wedge-detecting signal like ``stalled_stories``
   indefinitely (measured: 4 consecutive ticks filed nothing else).

4. **Operator-gated filing.** Every filed direction carries
   ``source=f"detector-{name}"``. That source is not in
   ``factory.directions.approval._DETERMINISTIC_SOURCES`` (unlike
   ``ci-health``, which fires on an objective external fact — a required
   check went red), so ``requires_operator_approval`` parks every detector
   filing until ``factory approve-direction`` — spend on self-improvement
   stays operator-ratified (Flow D step 4).

5. **A built-in, category-shaped acceptance criterion (S5).** Every filed
   direction sets ``explore=True`` (S2) — the built-in criteria below ARE the
   spec, but ``factory.backpressure.validator.validate_direction``'s
   sufficiency check (``has_flow or has_api_spec or explore_tag``) never
   inspects criteria quality at all, so ``explore=False`` measured
   ``is_valid=False, severity=blocking`` for every real filing (no
   user_flow, no api_spec) and, end to end, ``pm_sync`` parked every one at
   ``needs-direction`` even after a real operator approval —
   detect-without-remediate at full filing volume. ``ci_health.py`` sets
   ``explore=True`` for exactly this shape of direction; the vacuity gate is
   the ONLY thing ``explore=True`` bypasses, and it still runs (see below).

   The criterion wording is DETECTOR-SHAPE-SPECIFIC, not one template,
   because a single "the detector goes quiet for N ticks" template is
   auto-satisfied by construction for the ``since``-windowed detectors:
   ``_mark_ran`` advances the per-app marker every tick regardless of
   outcome, so old evidence has already scrolled out of the window on the
   very next look, with nothing fixed. Three shapes:

   * **event-shaped** (``retry_storm``, ``placeholder_prompts``,
     ``conformance_breach``, ``tick_duration_outliers``, the inert
     ``runs_failed_since``): the evidence is a specific PAST event, so the
     criterion is anchored to a fixed point in time (the filing moment) —
     "no NEW finding with a timestamp after `fired_at`" — which a later scan
     merely advancing past the old evidence cannot satisfy.
   * **liveness-shaped** (``review_churn``, ``state_distribution_skew``,
     ``stalled_stories``, ``worktree_orphans``): the evidence describes an
     ONGOING condition on a still-live subject; the criterion is "the subject
     reaches a state where the detector no longer classifies it as
     live/anomalous" — satisfiable by actually fixing/advancing the subject,
     not by inaction, because the S1 liveness fix (below) means the detector
     keeps firing on unfixed, still-live evidence across repeated ticks.
   * **metric-shaped** (``cost_spike``, ``fms_yield``): the evidence is a
     factory-wide RATE; the criterion is "the rate returns to baseline".

   ``tests/test_detector_watch.py`` asserts the exact generated text
   classifies ``positive-observable`` against the real vacuity gate, that a
   real filed direction passes ``validate_direction`` (the check that would
   have caught S2), and that the liveness-shaped criterion is NOT
   auto-satisfied by calling the pass twice against unfixed state.

6. **Liveness + recency scoping (S1).** ``review_churn`` deliberately ignores
   its ``since`` argument for the cumulative cycle counts (see that
   detector's own docstring) and ``state_distribution_skew`` computes its
   skew fraction over EVERY state including ``deployed`` — a fully-shipped
   backlog reads as "74% skewed toward deployed". Against live state, this
   filed 46 directions: 44 ``review_churn`` firings on stories that had
   already shipped weeks ago, plus one ``state_distribution_skew`` firing per
   app for the same reason. Both adapters now require: (a) the subject is
   CURRENTLY live (``review_churn``'s ``active_in_window`` computed against a
   fixed ``_LIVENESS_LOOKBACK`` from *now* — deliberately NOT the pass-to-pass
   marker, which would let two consecutive ticks with nothing fixed flip a
   still-current signal to "not live" purely because the marker advanced),
   and (b) the story/skew is computed over NON-TERMINAL states only.
"""

from __future__ import annotations

import json
import re
import sqlite3
import time as _time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Firing:
    """One detector observation reduced to a stable, dedupe-able shape."""

    subject: str
    evidence: dict[str, Any]


@dataclass(frozen=True)
class FiledFiring:
    """Record of one direction this pass actually wrote to disk."""

    detector: str
    subject: str
    signature: str
    direction_id: str


@dataclass
class DetectorWatchResult:
    """What ``detector_watch_tick`` did for one app on one cycle."""

    app: str
    ran: list[str] = field(default_factory=list)
    firings_total: int = 0
    filed: list[FiledFiring] = field(default_factory=list)
    # (detector, subject) pairs that already had a live direction.
    deduped: list[tuple[str, str]] = field(default_factory=list)
    # (detector, subject) pairs that hit the per-tick filing cap; they remain
    # un-deduped and will file on a later tick.
    capped: list[tuple[str, str]] = field(default_factory=list)
    # (detector-or-"dedupe_scan", error repr) pairs. A per-detector error
    # never stops the other detectors; a dedupe-scan error stops ALL filing
    # this tick (see ``dedupe_scan_failed``).
    errors: list[tuple[str, str]] = field(default_factory=list)
    # True when the dedupe scan itself raised. Every firing this tick was
    # then left unfiled (fail-safe), NOT deduped and NOT capped.
    dedupe_scan_failed: bool = False


# ---------------------------------------------------------------------------
# Adapter context + registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _AdapterCtx:
    root: Path
    app: str
    # Incremental, pass-to-pass lookback ("what's NEW since I last looked") —
    # correct for genuinely windowed finding detectors. See ``liveness_since``
    # for why this is NOT also used for "is this still current" checks.
    since: datetime
    # Fixed lookback from *now*, recomputed every call — correct for "is this
    # still live/current" checks (review_churn's active_in_window,
    # state_distribution_skew's snapshot recency). Deliberately independent of
    # the pass-to-pass marker: using the marker there let two consecutive
    # ticks with nothing fixed flip a still-valid signal to "not live" purely
    # because the marker advanced (S1/S5, review round 2).
    liveness_since: datetime


AdapterFn = Callable[[_AdapterCtx], list[Firing]]

# Detectors that read factory-wide streams with no way to attribute a finding
# to one app (cost_spike sums ALL spend; fms_yield watches the manager, not
# any app pipeline — see that detector's own module docstring: "deliberately
# the one detector pointed at the manager rather than at the app pipeline").
# Rather than arbitrarily filing a global fault under whichever app happens
# to tick first, both adapters below fire ONLY when this tick is driving the
# factory's own self-improvement app (loop 2) — the natural owner of a
# factory-wide operational fault. ``conformance_breach`` also routes its
# unattributable ``coverage_breach`` findings (``app is None``) here (S10)
# rather than dropping them.
_GLOBAL_DETECTOR_APP = "factory"


class _StoryLookupError(RuntimeError):
    """A genuine failure to query ``state/factory.db`` (locked, corrupt,
    unreadable) — distinct from "story not found", which is a normal,
    expected outcome (S10, review round 2). Left uncaught by every adapter
    that can raise it, so it propagates to ``detector_watch_tick``'s
    per-detector wrapper and is recorded as an error there: that detector is
    NOT marked as having cleanly run. Swallowing a lock-contention or
    corrupt-DB error as "story not found" would silently go dark on real
    data (CLAUDE.md failure class 3: silent detection failure) instead of
    surfacing it.
    """


def _story_row(root: Path, story_id: int | None) -> tuple[str, str] | None:
    """Return ``(app, state)`` for ``story_id``.

    ``None`` means "no such story" (or no DB file at all) — a normal outcome
    the caller should just skip. Raises :class:`_StoryLookupError` on any
    DB-level failure; callers must NOT treat that the same as "not found".
    """
    if story_id is None:
        return None
    db_path = root / "state" / "factory.db"
    if not db_path.exists():
        return None
    try:
        conn = sqlite3.connect(str(db_path))
        try:
            row = conn.execute(
                "SELECT app, state FROM stories WHERE id = ?", (story_id,)
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        raise _StoryLookupError(repr(exc)) from exc
    if row is None or row[0] is None:
        return None
    return (str(row[0]), str(row[1]))


# --- list-shaped finding detectors: one firing per surviving row -----------


# ============================================================================
# INTENTIONALLY INERT AS OF 2026-08-07 (S8, review round 2 — READ THIS BEFORE
# TOUCHING THIS FUNCTION). ``_adapter_runs_failed_since`` unconditionally
# returns ``[]``. This is NOT dead code, NOT an oversight, and NOT something
# to "fix" by quietly re-enabling it. It stays registered in ``_ADAPTERS``
# ONLY so the coverage-equals-registry invariant
# (``test_adapter_coverage_matches_registry``) holds — an adapter entry that
# looks wired but never fires is exactly the bookkeeping failure this
# direction exists to end (``fms_yield`` running for 59 days at zero yield
# while nothing noticed is the motivating incident — see that detector's own
# module docstring and STATUS.md). If you are reading this because the
# registry table or a status page implies this detector "fires", it does
# not, on purpose: see the function's own docstring below for why.
# ============================================================================
def _adapter_runs_failed_since(ctx: _AdapterCtx) -> list[Firing]:
    """INTENTIONALLY INERT as of 2026-08-07 (S8, review round 2) — always
    returns ``[]``. Do not read the registry table or the ``_ADAPTERS``
    entry above as evidence that this fires; it does not.

    ``runs_failed_since`` returns EVERY failed run row with no threshold at
    all, and ``retry_storm`` already owns the SAME ``runs.ndjson`` rows,
    grouped by ``(story_id, persona)``, with a real signal (a
    repeated-failure count) — a single transient provider 429 is not a
    direction. Filing from both double-counted the same underlying fault
    (one dev failure -> two directions) and, having no floor at all,
    accounted for the bulk of a measured 2-40 directions/day of pure noise
    from transient 429s alone in the live re-measurement (107 firings on
    sacrifice + 33 on factory in one read-only pass alone).

    Kept in ``_ADAPTERS`` (never removed) so the registry-coverage invariant
    still holds and a future re-enable — WITH a real threshold, if ever
    needed — is a one-line diff, not a re-wire.
    """
    return []


def _adapter_retry_storm(ctx: _AdapterCtx) -> list[Firing]:
    from factory.manager.detectors import retry_storm as _detector

    rows = _detector(root=ctx.root, since=ctx.since)
    firings: list[Firing] = []
    for rec in rows:
        story_id = rec.get("story_id")
        row = _story_row(ctx.root, story_id)
        if row is None or row[0] != ctx.app:
            continue
        persona = str(rec.get("persona") or "unknown")
        # Subject is the (story, persona) pair per the direction's own AC7
        # wording — a retry storm is scoped to one persona hammering one
        # story, not the story alone.
        firings.append(Firing(subject=f"{story_id}:{persona}", evidence=dict(rec)))
    return firings


# S1 (review round 2): a fixed lookback from *now*, not the pass-to-pass
# marker — see ``_AdapterCtx.liveness_since``.
_LIVENESS_LOOKBACK = timedelta(hours=6)


def _adapter_review_churn(ctx: _AdapterCtx) -> list[Firing]:
    from factory.manager.detectors import review_churn as _detector
    from factory.manager.detectors.stalled_stories import (
        _TERMINAL_STATES as _terminal_story_states,
    )

    rows = _detector(root=ctx.root, since=ctx.liveness_since)
    firings: list[Firing] = []
    for rec in rows:
        # review_churn's cycle COUNTS are cumulative by design (it ignores
        # ``since`` for them — see the detector's own docstring), but
        # ``active_in_window`` is not: it is True only when the most recent
        # reviewer run happened within ``liveness_since``. A story with 46
        # cycles from weeks ago that has since shipped is NOT active — this
        # is what filed 44 false directions against ``deployed`` stories in
        # the live measurement (S1).
        if not rec.get("active_in_window"):
            continue
        story_id = rec.get("story_id")
        row = _story_row(ctx.root, story_id)
        if row is None:
            continue
        app, state = row
        if app != ctx.app or state in _terminal_story_states:
            continue
        firings.append(Firing(subject=f"story-{story_id}", evidence=dict(rec)))
    return firings


def _adapter_conformance_breach(ctx: _AdapterCtx) -> list[Firing]:
    from factory.manager.detectors import conformance_breach as _detector

    rows = _detector(root=ctx.root, since=ctx.since)
    firings: list[Firing] = []
    for rec in rows:
        rec_app = rec.get("app")
        if rec_app:
            if str(rec_app) != ctx.app:
                continue
        else:
            # ``app`` is None exactly for the unattributable ``coverage_breach``
            # case the detector calls out as the LOAD-BEARING one (a write
            # nobody could attribute to any writer OR any app) — route it to
            # the global bucket instead of silently dropping it (S10).
            if ctx.app != _GLOBAL_DETECTOR_APP:
                continue
        subject = (
            f"{rec.get('story_id')}:{rec.get('from_state')}->"
            f"{rec.get('to_state')}:{rec.get('writer')}"
        )
        firings.append(Firing(subject=subject, evidence=dict(rec)))
    return firings


# Terminal DB states after which a lingering worktree directory serves no
# further purpose: the story finished normally (``deployed``), was closed by
# a human (``closed_by_operator``), lost a dual-draft race
# (``superseded_by_sibling``), or the DB has no row for it at all
# (``"missing"`` — the story was deleted/never existed). A worktree still
# tied to an ACTIVE story (in progress, blocked-pending-human, etc.) is not
# an orphan yet — the detector returns every naming-convention match; this
# adapter is what turns that raw candidate list into actual orphan firings.
_WORKTREE_ORPHAN_DB_STATES = frozenset(
    {
        "missing",
        "deployed",
        "closed_by_operator",
        "superseded_by_sibling",
        # Delivery-level end states: the worktree is no longer used (the
        # ``none`` level's work lives on the local branch, not the directory).
        "delivered_local",
        "delivered_branch",
        "delivered_pr",
    }
)


def _adapter_worktree_orphans(ctx: _AdapterCtx) -> list[Firing]:
    from factory.manager.detectors import worktree_orphans as _detector

    rows = _detector(root=ctx.root)
    firings: list[Firing] = []
    for rec in rows:
        if str(rec.get("app") or "") != ctx.app:
            continue
        if str(rec.get("db_state") or "") not in _WORKTREE_ORPHAN_DB_STATES:
            continue
        path = str(rec.get("path") or "")
        if not path:
            continue
        firings.append(Firing(subject=path, evidence=dict(rec)))
    return firings


def _adapter_placeholder_prompts(ctx: _AdapterCtx) -> list[Firing]:
    from factory.manager.detectors import placeholder_prompts as _detector

    rows = _detector(root=ctx.root, since=ctx.since)
    firings: list[Firing] = []
    for rec in rows:
        story_id = rec.get("story_id")
        row = _story_row(ctx.root, story_id)
        if row is None or row[0] != ctx.app:
            continue
        persona = str(rec.get("persona") or "unknown")
        firings.append(Firing(subject=f"{persona}:{story_id}", evidence=dict(rec)))
    return firings


# --- metrics-shaped detectors: an explicit, conservative fires-predicate ---

# cost_spike fires when recent spend is at least 3x the trailing baseline
# RATE *and* material in absolute terms — a 3x ratio on a few cents of
# baseline is noise, not a spike worth a self-filed direction.
_COST_SPIKE_RATIO_THRESHOLD = 3.0
_COST_SPIKE_MIN_RECENT_USD = 5.0


def _adapter_cost_spike(ctx: _AdapterCtx) -> list[Firing]:
    if ctx.app != _GLOBAL_DETECTOR_APP:
        return []
    from factory.manager.detectors import cost_spike as _detector

    metrics = _detector(root=ctx.root)
    ratio = float(metrics.get("ratio", 0.0) or 0.0)
    recent = float(metrics.get("recent_usd", 0.0) or 0.0)
    if ratio >= _COST_SPIKE_RATIO_THRESHOLD and recent >= _COST_SPIKE_MIN_RECENT_USD:
        return [Firing(subject="factory-wide-spend", evidence=metrics)]
    return []


# A tick with no ``tick_end`` for over an hour is almost certainly hung or
# crashed, not merely slow — the same order of magnitude ``stalled_stories``
# uses for its own tick-silence alarm.
_STILL_RUNNING_STUCK_THRESHOLD_S = 3600.0


def _adapter_tick_duration_outliers(ctx: _AdapterCtx) -> list[Firing]:
    """S12 (review round 2, documented rather than fixed): the p95-outlier
    branch below is structurally near-inert under ``ctx.since`` — a short,
    marker-based lookback rarely accumulates enough COMPLETED ticks for a
    95th-percentile threshold to have any statistical power (measured: 0
    outliers on a seeded 900s tick against a 1-2-tick window). Widening this
    detector's own window would need a THIRD lookback constant (beyond
    ``since`` and ``liveness_since``) and interacts with performance on the
    append-only, currently ~22MB ``ticks.ndjson`` stream — left for a
    follow-up rather than done here. In practice only the ``still_running``
    (stuck-tick) branch below is a live sensor; do not advertise the
    p95-outlier branch as one until this is revisited.
    """
    from factory.manager.detectors import tick_duration_outliers as _detector

    metrics = _detector(root=ctx.root, since=ctx.since)
    firings: list[Firing] = []
    for row in metrics.get("outliers") or []:
        if str(row.get("app") or "") != ctx.app:
            continue
        tick_id = str(row.get("tick_id") or "")
        if not tick_id:
            continue
        firings.append(Firing(subject=f"tick-outlier:{tick_id}", evidence=row))
    max_age = float(metrics.get("still_running_max_age_s", 0.0) or 0.0)
    if max_age >= _STILL_RUNNING_STUCK_THRESHOLD_S:
        stuck = [r for r in (metrics.get("still_running") or []) if str(r.get("app") or "") == ctx.app]
        if stuck:
            firings.append(
                Firing(
                    subject="still-running-stuck",
                    evidence={"still_running": stuck, "still_running_max_age_s": max_age},
                )
            )
    return firings


# S1 (review round 2): mirrors the detector's own default threshold, but
# recomputed HERE over non-terminal states only — see the adapter below.
_STATE_SKEW_THRESHOLD_FRACTION = 0.5

# Minimum-sample floor (review round 3): with the S1 fix landed, a live
# re-measurement still fired once on ``sacrifice`` — 2 non-terminal stories,
# BOTH in ``deploy_pending``, a fraction of 2/2 = 1.0. That is arithmetic, not
# a skew: below a handful of open stories, ANY single-state backlog trivially
# "exceeds" 0.5 with nothing anomalous behind it (1/1, 2/2, 2/3 all clear the
# threshold on pure chance). 5 is chosen because it is the smallest N at which
# the >0.5 fraction predicate first requires an ACTUAL majority (>=3 of 5)
# rather than being satisfiable by every story just happening to share one
# state — at N<5 (1,2,3,4) a fraction >0.5 is reachable with as few as 1-3
# stories in ONE state versus the rest split arbitrarily, which is exactly
# the "not enough data to call it a skew" case this floor exists to exclude.
_STATE_SKEW_MIN_NON_TERMINAL_SAMPLE = 5


def _adapter_state_distribution_skew(ctx: _AdapterCtx) -> list[Firing]:
    from factory.manager.detectors import state_distribution_skew as _detector
    from factory.manager.detectors.stalled_stories import (
        _TERMINAL_STATES as _terminal_story_states,
    )

    # ``liveness_since`` (not ``since``): the snapshot-recency filter asks
    # "is this snapshot still CURRENT", not "what's new since I last looked"
    # — using the pass-to-pass marker here risked excluding a still-valid,
    # still-most-recent snapshot purely because the marker outran its
    # timestamp between two ticks with nothing new written (S1/S5).
    metrics = _detector(root=ctx.root, since=ctx.liveness_since)
    snap = (metrics.get("app_snapshots") or {}).get(ctx.app)
    if not snap:
        return []
    counts: dict[str, int] = snap.get("counts_by_state") or {}
    # The detector's own ``exceeds_threshold``/``exceeds_state`` fields are
    # computed over ALL states including terminal ones — a backlog that is
    # 74% ``deployed`` (fully shipped) reads as "skewed" by that math. Ignore
    # those fields entirely and recompute over non-terminal states only.
    non_terminal = {s: c for s, c in counts.items() if s not in _terminal_story_states}
    total = sum(non_terminal.values())
    if total == 0:
        # Every open story is terminal (fully shipped or fully closed) —
        # nothing "skewed" about that.
        return []
    if total < _STATE_SKEW_MIN_NON_TERMINAL_SAMPLE:
        # Too few open stories for a fraction to mean anything — see the
        # constant's comment above (review round 3 fix for the residual
        # small-N firing the round-2 live re-measurement found).
        return []
    max_state = max(non_terminal, key=lambda s: non_terminal[s])
    max_fraction = non_terminal[max_state] / total
    if max_fraction <= _STATE_SKEW_THRESHOLD_FRACTION:
        return []
    evidence = {
        "ts": snap.get("ts"),
        "counts_by_state_non_terminal": non_terminal,
        "total_non_terminal": total,
        "max_state": max_state,
        "max_fraction": round(max_fraction, 4),
    }
    return [Firing(subject=f"state-skew:{max_state}", evidence=evidence)]


def _adapter_stalled_stories(ctx: _AdapterCtx) -> list[Firing]:
    from factory.manager.detectors import stalled_stories as _detector

    metrics = _detector(root=ctx.root)
    # healthy_drain is the detector's own EXPLICIT "do not escalate" signal
    # (see its module docstring) — an aged backlog while the factory drains
    # by design is not a fault to file a direction about.
    if metrics.get("healthy_drain"):
        return []
    firings: list[Firing] = []
    rows = list(metrics.get("stuck_in_progress") or []) + list(metrics.get("stalled") or [])
    for row in rows:
        if str(row.get("app") or "") != ctx.app:
            continue
        firings.append(Firing(subject=f"story-{row.get('story_id')}", evidence=row))
    return firings


# fms_yield's history file (``state/.manager_apply_history.json``) is written
# ONLY by the now-deleted L4 apply tier (``factory/manager/apply.py``,
# removed 2026-08-07) — nothing writes it anymore. Any file that exists today
# is therefore permanently frozen: an mtime older than this threshold means
# "historical data, not a live signal", and this adapter must never re-fire
# forever on numbers that can no longer change. (Out of scope for this PR:
# wiring fms_yield into whatever replaces the apply tier — tracked in the
# direction's "Out of scope" section.)
_FMS_YIELD_STALE_AFTER_HOURS = 1.0
_FMS_YIELD_MIN_SPEND_USD = 5.0


def _adapter_fms_yield(ctx: _AdapterCtx) -> list[Firing]:
    if ctx.app != _GLOBAL_DETECTOR_APP:
        return []
    hist_path = ctx.root / "state" / ".manager_apply_history.json"
    if not hist_path.is_file():
        return []
    try:
        mtime = datetime.fromtimestamp(hist_path.stat().st_mtime, tz=UTC)
    except OSError:
        return []
    if (datetime.now(UTC) - mtime) > timedelta(hours=_FMS_YIELD_STALE_AFTER_HOURS):
        return []
    from factory.manager.detectors import fms_yield as _detector

    metrics = _detector(root=ctx.root)
    spend = float(metrics.get("manager_spend_usd", 0.0) or 0.0)
    if metrics.get("attempts", 0) and not metrics.get("shipped", 0) and spend >= _FMS_YIELD_MIN_SPEND_USD:
        return [Firing(subject="fms-yield-zero", evidence=metrics)]
    return []


# Coverage MUST equal ``factory.manager.detectors.DETECTORS`` exactly — see
# ``tests/test_detector_watch.py::test_adapter_coverage_matches_registry``.
# A 12th detector added to that registry without a matching entry here fails
# that test, not a live tick (the deleted watcher's own failure mode: it
# hard-coded 9 of 11 detectors and silently never called the rest).
_ADAPTERS: dict[str, AdapterFn] = {
    "runs_failed_since": _adapter_runs_failed_since,
    "retry_storm": _adapter_retry_storm,
    "review_churn": _adapter_review_churn,
    "cost_spike": _adapter_cost_spike,
    "conformance_breach": _adapter_conformance_breach,
    "fms_yield": _adapter_fms_yield,
    "tick_duration_outliers": _adapter_tick_duration_outliers,
    "state_distribution_skew": _adapter_state_distribution_skew,
    "worktree_orphans": _adapter_worktree_orphans,
    "placeholder_prompts": _adapter_placeholder_prompts,
    "stalled_stories": _adapter_stalled_stories,
}

# Priority tier for the per-tick filing cap (S7) — LOWER fires first.
# Liveness/wedge signals (the factory doesn't work AT ALL, or a state-machine
# invariant was violated) outrank ordinary per-story findings, which outrank
# cosmetic/artifact findings. ``runs_failed_since`` is listed only for
# documentation — it is permanently inert (S8) and never produces a firing to
# prioritize. A detector not listed here defaults to ``_DEFAULT_DETECTOR_PRIORITY``.
_DETECTOR_PRIORITY: dict[str, int] = {
    "stalled_stories": 0,
    "conformance_breach": 0,
    "cost_spike": 1,
    "fms_yield": 1,
    "tick_duration_outliers": 1,
    "state_distribution_skew": 1,
    "review_churn": 2,
    "retry_storm": 2,
    "worktree_orphans": 3,
    "placeholder_prompts": 3,
    "runs_failed_since": 9,
}
_DEFAULT_DETECTOR_PRIORITY = 5


def _priority_ordered_firings(
    all_firings: list[tuple[str, Firing]],
) -> list[tuple[str, Firing]]:
    """Round-robin across detectors, highest-priority tier first (S7).

    With plain insertion order, whichever detector happens to enumerate
    first in ``_ADAPTERS`` — and ALWAYS has something to report — ate the
    entire per-tick filing cap every single tick, starving every other
    detector indefinitely (measured: 4 consecutive ticks filed nothing but
    ``runs_failed_since``, before that detector was made inert — S8). This
    round-robins one firing from each detector, ordered by
    ``_DETECTOR_PRIORITY`` (ties broken by name), so no single chatty source
    can ever monopolize the cap.
    """
    by_detector: dict[str, list[Firing]] = {}
    for name, firing in all_firings:
        by_detector.setdefault(name, []).append(firing)

    ordered_names = sorted(
        by_detector, key=lambda n: (_DETECTOR_PRIORITY.get(n, _DEFAULT_DETECTOR_PRIORITY), n)
    )
    queues = {n: list(v) for n, v in by_detector.items()}
    ordered: list[tuple[str, Firing]] = []
    while any(queues[n] for n in ordered_names):
        for n in ordered_names:
            if queues[n]:
                ordered.append((n, queues[n].pop(0)))
    return ordered


# ---------------------------------------------------------------------------
# since-marker (rate primitive, mirrors ``orchestrator._issue_hygiene_marker``)
# ---------------------------------------------------------------------------

_MARKER_DIRNAME = "detector_watch"
_DEFAULT_LOOKBACK = timedelta(hours=1)


def _marker_path(root: Path, app: str) -> Path:
    return root / "state" / _MARKER_DIRNAME / f"{app}.last"


def _last_since(root: Path, app: str, *, now: datetime) -> datetime:
    """The lower bound genuinely-incremental adapters should use this pass.

    The last time this pass ran for ``app``, or a fixed default lookback the
    first time (or on any read error) — never crashes, never blocks a pass.
    NOT used for "is this still current" liveness checks — see
    ``_AdapterCtx.liveness_since``.
    """
    try:
        raw = _marker_path(root, app).read_text(encoding="utf-8").strip()
        dt = datetime.fromisoformat(raw)
        return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)
    except (OSError, ValueError):
        return now - _DEFAULT_LOOKBACK


def _mark_ran(root: Path, app: str, when: datetime) -> None:
    try:
        path = _marker_path(root, app)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(when.isoformat(), encoding="utf-8")
    except OSError:  # noqa: BLE001 - a marker write failure must never break the tick
        pass


# ---------------------------------------------------------------------------
# Signature + dedupe scan
# ---------------------------------------------------------------------------

_MAX_SUBJECT_LEN = 200
# Collapse anything that would otherwise let a subject break out of the
# HTML-comment marker syntax (a literal "-->" or ">" inside a path/subject
# string), or vary between whitespace-only ticks.
_VOLATILE_WS_RE = re.compile(r"\s+")
_COMMENT_UNSAFE_RE = re.compile(r"-{2,}|>")


def _normalize_subject(subject: str) -> str:
    # S4 (review round 2): internal whitespace maps to "_", NEVER a literal
    # space. ``_SIGNATURE_MARKER_RE``'s capture group is ``[^\s>]+``
    # (whitespace is deliberately excluded — the marker syntax itself has
    # significant surrounding whitespace), so a signature containing an
    # internal space could never be read back out of its own marker: the
    # scan would always see "not open" and re-file every tick, forever. A
    # worktree path with a space, or any non-str value that stringifies with
    # one, reaches this. Underscore has no such collision.
    s = _VOLATILE_WS_RE.sub("_", subject.strip().lower())
    s = _COMMENT_UNSAFE_RE.sub("_", s)
    return s[:_MAX_SUBJECT_LEN]


def signature_for(detector: str, subject: str) -> str:
    """Stable dedupe key for one detector firing. Exported for tests."""
    return f"{detector}:{_normalize_subject(subject)}"


def _signature_marker(signature: str) -> str:
    return f"<!-- detector-signature: {signature} -->"


_SIGNATURE_MARKER_RE = re.compile(r"<!--\s*detector-signature:\s*([^\s>]+)\s*-->")


def _open_detector_signatures(app: str, root: Path) -> set[str]:
    """Signatures already carried by a non-terminal direction for ``app``.

    Mirrors ``factory.chain.ci_health._has_open_ci_health_direction``'s scan
    shape, with two deliberate divergences:

    * **Dedupe-terminal policy (S9).** A direction status of ``closed`` is
      ALSO terminal here — a LOCAL superset of the shared
      ``factory.chain.scheduled_tasks._TERMINAL_DIRECTION_STATUSES``, not an
      edit to that shared constant (CLAUDE.md: "fixes to shared control flow
      do not compose for free" — every OTHER duplicate-detection scan in the
      chain reads that constant too). Once an operator explicitly closes a
      detector-filed direction, its signature is free to fire again:
      ``factory/manager/gc.py`` only reaps ``scheduled-`` sources, so a
      ``detector-*`` direction is never garbage-collected, and without this,
      "closed" would be the only way out of the inbox and it would mean
      "silenced forever". Safe only combined with the S1 liveness fix — see
      the module docstring.
    * **Orphan dirs are a scan failure, not an absence (S3).** A direction
      directory with NO ``direction.md`` at all (e.g. a partial write left
      behind by a disk-full ``create_direction`` call before this review
      round's cleanup fix, or any other cause) makes the WHOLE scan
      untrustworthy — we cannot tell whether it once carried an open
      signature — so this RAISES rather than silently skipping it. The
      caller treats any exception here as a dedupe-scan failure and refuses
      to file (never a storm of invisible orphan dirs). A single malformed
      but PRESENT ``direction.md`` (bad frontmatter, corrupt YAML) is still
      swallowed per-directory — one bad sibling must not blind the scan to
      every other one.
    """
    import frontmatter as _frontmatter
    import yaml as _yaml

    from factory.chain.scheduled_tasks import _TERMINAL_DIRECTION_STATUSES

    terminal = _TERMINAL_DIRECTION_STATUSES | {"closed"}

    directions_dir = Path(root) / "apps" / app / "directions"
    found: set[str] = set()
    if not directions_dir.is_dir():
        return found
    for d in directions_dir.iterdir():
        if not d.is_dir():
            continue
        md = d / "direction.md"
        if not md.is_file():
            raise RuntimeError(
                f"direction dir has no direction.md (scan untrustworthy): {d}"
            )
        try:
            post = _frontmatter.load(str(md))
            status = "created"
            state_path = d / "state.yaml"
            if state_path.is_file():
                state = _yaml.safe_load(state_path.read_text(encoding="utf-8")) or {}
                status = str(state.get("status", "created"))
            if status in terminal:
                continue
            content = str(getattr(post, "content", "") or "")
            found.update(_SIGNATURE_MARKER_RE.findall(content))
        except Exception:  # noqa: BLE001 - one bad-but-PRESENT sibling must not blind the scan
            continue
    return found


# ---------------------------------------------------------------------------
# Filing
# ---------------------------------------------------------------------------

_EVIDENCE_MAX_CHARS = 2000
_TITLE_SUBJECT_MAX_CHARS = 60


def _pretty_evidence(evidence: dict[str, Any]) -> str:
    try:
        text = json.dumps(evidence, indent=2, default=str, sort_keys=True)
    except (TypeError, ValueError):
        text = str(evidence)
    if len(text) > _EVIDENCE_MAX_CHARS:
        text = text[:_EVIDENCE_MAX_CHARS] + "\n... (truncated)"
    return text


def _short_subject(subject: str) -> str:
    s = subject.strip()
    if len(s) > _TITLE_SUBJECT_MAX_CHARS:
        s = s[: _TITLE_SUBJECT_MAX_CHARS - 1] + "…"
    return s


# Detector-shape categories driving the built-in acceptance criterion (S5,
# review round 2) — see the module docstring, point 5, for the full
# rationale. Any detector NOT listed in either set falls through to the
# metric-shaped default (currently: cost_spike, fms_yield).
_EVENT_SHAPED_DETECTORS = frozenset(
    {
        "runs_failed_since",
        "retry_storm",
        "placeholder_prompts",
        "conformance_breach",
        "tick_duration_outliers",
    }
)
_LIVENESS_SHAPED_DETECTORS = frozenset(
    {"review_churn", "state_distribution_skew", "stalled_stories", "worktree_orphans"}
)


def acceptance_for_firing(detector: str, subject: str, *, fired_at: datetime) -> list[str]:
    """The filed direction's built-in acceptance criteria (S5 redesign).

    ``fired_at`` anchors event-shaped wording to a fixed point in time (the
    moment of filing) rather than to a re-scanned tick window, so the
    criterion cannot be satisfied merely by the per-app ``since`` marker
    advancing past the evidence. See the module docstring, point 5, for the
    three shapes. Exported so ``tests/test_detector_watch.py`` can assert the
    exact generated text (a) classifies ``positive-observable`` against the
    real vacuity gate, (b) is not auto-satisfied by calling the pass twice
    against unfixed state, and (c) survives a real ``validate_direction``
    call end to end.
    """
    fault_criterion = (
        f"the fault named in the evidence for `{detector}` (subject `{subject}`) is fixed."
    )

    if detector in _EVENT_SHAPED_DETECTORS:
        return [
            (
                f"No NEW `{detector}` finding is recorded for subject `{subject}` "
                f"with a timestamp after `{fired_at.isoformat()}` (the moment this "
                "direction was filed) — the evidence below names a specific past "
                "event, not an ongoing state, so a later `factory tick` scanning "
                "past that old evidence does not itself satisfy this criterion; "
                "only the absence of a genuinely NEW, later event does."
            ),
            fault_criterion,
        ]
    if detector in _LIVENESS_SHAPED_DETECTORS:
        return [
            (
                f"`{subject}` reaches a state where the `{detector}` detector no "
                "longer classifies it as live/anomalous (the story converges to "
                "a terminal state, the skewed state fraction normalizes, or the "
                "stale artifact is removed) — not merely a quiet period with the "
                "underlying condition left unchanged."
            ),
            fault_criterion,
        ]
    # Metric-shaped (cost_spike, fms_yield): the fault is a factory-wide
    # RATE, not a single story.
    return [
        (
            f"the factory-wide rate `{detector}` alerted on for `{subject}` "
            "returns to baseline (recent spend falls back under the alert "
            "ratio, or the FMS ships something / its spend stops accruing)."
        ),
        fault_criterion,
    ]


def _file_detector_direction(
    *,
    app: str,
    detector: str,
    firing: Firing,
    signature: str,
    fired_at: datetime,
    software_factory_root: Path,
) -> str:
    from factory.directions.creator import create_direction

    why = (
        f"Detector `{detector}` fired for subject `{firing.subject}` "
        "(chain-tick detector wiring, direction 019 AC7 / Flow D — the "
        "deleted FMS L1 Watcher used to be the only caller of this "
        "detector; nothing else currently observes it). This direction is "
        f"machine-filed (source=detector-{detector}) and stays parked at "
        "the operator-approval gate until a human runs `factory "
        "approve-direction`.\n\n"
        f"Evidence:\n```\n{_pretty_evidence(firing.evidence)}\n```\n\n"
        f"{_signature_marker(signature)}"
    )
    created = create_direction(
        app,
        title=f"{detector}: {_short_subject(firing.subject)}",
        type_tag="infra",
        why=why,
        has_ui=False,
        flow_steps=None,
        has_api=False,
        api_spec_lines=None,
        acceptance=acceptance_for_firing(detector, firing.subject, fired_at=fired_at),
        # explore=True (S2, review round 2): see the module docstring, point
        # 5. explore=False measured is_valid=False/severity=blocking for
        # EVERY real filing (no user_flow, no api_spec) and, end to end,
        # pm_sync parked every one at needs-direction even after a real
        # operator approval — detect-without-remediate at full filing
        # volume. The vacuity gate (the only thing explore=True bypasses)
        # still runs, and the criteria above are independently verified
        # positive-observable regardless.
        explore=True,
        attach_files=None,
        software_factory_root=software_factory_root,
        source=f"detector-{detector}",
    )
    return created.direction.id


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

#: Hard cap on new directions filed per tick, across every detector combined.
#: CLAUDE.md: "Nothing loops more than 3 times" — applied to self-filed work.
_MAX_FILINGS_PER_TICK = 3

#: Soft deadline (S11, review round 2): NOT a hard timeout. A real cap would
#: need thread/signal-based preemption, which complicates this module's
#: fail-safety story (a shared sqlite connection, cross-platform signal
#: availability) for a condition that, measured live, doesn't occur (a full
#: 11-detector sweep against the live ~22MB append-only ``runs.ndjson`` +
#: ``ticks.ndjson`` took 0.650s). This is a documented POST-HOC measurement:
#: a detector that finishes slower than this is recorded as an error (so a
#: regression is visible) but is never interrupted mid-call.
_SOFT_DEADLINE_S = 30.0


def detector_watch_tick(
    software_factory_root: Path,
    app: str,
    *,
    now: datetime | None = None,
) -> DetectorWatchResult:
    """Run every registered detector once for ``app`` and file/dedupe firings.

    Never raises: every detector call (including a wrong-shaped return — S6),
    the dedupe scan, and every direction write are individually wrapped so a
    single failure degrades this pass (recorded in
    ``DetectorWatchResult.errors``) without ever breaking the caller's tick.
    Callers (``factory.chain.orchestrator.tick``) are expected to
    additionally skip calling this entirely in ``dry_run`` and in modes that
    suppress forward motion (``paused``, ``drain-reviews``) — this function
    does not gate on either itself.
    """
    root = Path(software_factory_root)
    now = now or datetime.now(UTC)
    since = _last_since(root, app, now=now)
    liveness_since = now - _LIVENESS_LOOKBACK
    result = DetectorWatchResult(app=app)

    ctx = _AdapterCtx(root=root, app=app, since=since, liveness_since=liveness_since)
    all_firings: list[tuple[str, Firing]] = []
    for name, adapter in _ADAPTERS.items():
        t0 = _time.monotonic()
        try:
            raw = adapter(ctx)
        except Exception as exc:  # noqa: BLE001 - one crashing detector must never break the pass
            result.errors.append((name, repr(exc)))
            continue
        elapsed = _time.monotonic() - t0
        if elapsed > _SOFT_DEADLINE_S:
            result.errors.append((name, f"soft_deadline_exceeded: {elapsed:.1f}s"))
        # S6 (review round 2): validate the return SHAPE before trusting it —
        # a wrong-shaped return (None, a str, a list of non-Firing elements)
        # used to raise past this point and discard the WHOLE pass, including
        # every other, healthy detector.
        if not isinstance(raw, list):
            result.errors.append(
                (name, f"non-list return from adapter: {type(raw).__name__}")
            )
            continue
        bad_types = sorted({type(x).__name__ for x in raw if not isinstance(x, Firing)})
        if bad_types:
            result.errors.append(
                (name, f"non-Firing element(s) in adapter return: {bad_types}")
            )
            continue
        result.ran.append(name)
        all_firings.extend((name, f) for f in raw)

    result.firings_total = len(all_firings)
    # Advance the window regardless of outcome — a detector error or an empty
    # result this tick should not re-scan the same (growing) window forever.
    _mark_ran(root, app, now)

    if not all_firings:
        return result

    try:
        open_signatures = _open_detector_signatures(app, root)
    except Exception as exc:  # noqa: BLE001 - fail SAFE: refuse to file, never file blind
        result.dedupe_scan_failed = True
        result.errors.append(("dedupe_scan", repr(exc)))
        return result

    filed_count = 0
    seen_this_tick: set[str] = set()
    for detector_name, firing in _priority_ordered_firings(all_firings):
        sig = signature_for(detector_name, firing.subject)
        if sig in open_signatures or sig in seen_this_tick:
            result.deduped.append((detector_name, firing.subject))
            continue
        if filed_count >= _MAX_FILINGS_PER_TICK:
            result.capped.append((detector_name, firing.subject))
            continue
        try:
            direction_id = _file_detector_direction(
                app=app,
                detector=detector_name,
                firing=firing,
                signature=sig,
                fired_at=now,
                software_factory_root=root,
            )
        except Exception as exc:  # noqa: BLE001 - a filing failure must never break the pass
            result.errors.append((f"{detector_name}:file", repr(exc)))
            continue
        result.filed.append(
            FiledFiring(
                detector=detector_name,
                subject=firing.subject,
                signature=sig,
                direction_id=direction_id,
            )
        )
        seen_this_tick.add(sig)
        filed_count += 1

    return result


__all__ = [
    "DetectorWatchResult",
    "Firing",
    "FiledFiring",
    "acceptance_for_firing",
    "detector_watch_tick",
    "signature_for",
]
