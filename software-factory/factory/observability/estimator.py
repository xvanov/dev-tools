"""Evidence-Based Scheduling estimator for the factory.

Adapts Joel Spolsky's EBS to an agent-driven pipeline:

* **Task unit** — a single handler invocation (one row in ``runs``).
* **Velocity unit** — ``(persona, model_tier)``.  Joel's "developer" is our
  persona; opus-tier vs sonnet-tier velocities are tracked separately
  because the same persona behaves very differently at different model tiers.
* **Estimate** — derived from ``(persona, points)`` history: the median
  observed wall-clock seconds for that persona on stories of that size.
  Cold start: ``None`` until N >= 5 samples exist for that cell.
* **Velocity** — ``estimate / actual`` per completed handler run.
* **Monte Carlo** — for each remaining handler in a direction, sample a
  velocity from the relevant (persona, model_tier) history (last 30 days),
  compute ``predicted = estimate / sample``, sum across all remaining
  handlers and stories.  Run N iterations -> distribution -> P50/P75/P95.

The simulator gates ETA output on having >= N_VELOCITY_MIN samples per
relevant cell.  Below that floor, it returns ``insufficient_data=True`` so
the TUI can show "no ETA yet" honestly instead of inventing one.
"""

from __future__ import annotations

import math
import random
import statistics
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, NamedTuple

from sqlmodel import Session, create_engine, select

from factory.observability.schema import HandlerBaseline, migrate

# Minimum samples per (persona, model_tier) cell before the simulator
# trusts a velocity distribution. Below this, the simulator falls back
# to an "insufficient data" mode that returns no ETA.
N_VELOCITY_MIN = 5

# Cold-start fallback baseline per chain step. Used ONLY when:
#  (a) the estimator has zero historical samples for that (persona, points)
#      bucket — i.e. literally the first time a story is spawned, AND
#  (b) the caller requested a point estimate via ``estimate_story_seconds``.
# Picked from rough operator experience; the simulator does NOT use these
# values (it gates on N_VELOCITY_MIN and returns ``insufficient_data``).
_COLD_START_HANDLER_SECONDS: dict[str, dict[int, float]] = {
    # TDD chain
    "sm":              {1: 30, 2: 45, 3: 60, 5: 90, 8: 150, 13: 240},
    "test_designer":   {1: 30, 2: 45, 3: 75, 5: 120, 8: 180, 13: 300},
    "test_implementer":{1: 60, 2: 120, 3: 240, 5: 480, 8: 900, 13: 1500},
    "dev":             {1: 90, 2: 180, 3: 360, 5: 720, 8: 1440, 13: 2400},
    "reviewer":        {1: 30, 2: 45, 3: 60, 5: 90, 8: 150, 13: 240},
    "tech_writer":     {1: 30, 2: 45, 3: 60, 5: 90, 8: 150, 13: 240},
    # Docs chain
    "docs_sm":         {1: 30, 2: 45, 3: 60, 5: 90, 8: 150, 13: 240},
    "onboarder":       {1: 120, 2: 240, 3: 480, 5: 900, 8: 1500, 13: 2400},
}

# Handlers a story must still traverse from a given state. Mirrors the
# ``_DISPATCH`` table in orchestrator.py but expanded to give the
# remaining-work view per-story. Keyed on (chain_kind, current_state) -> list
# of personas the story still needs to invoke.
#
# This is intentionally hand-maintained alongside the orchestrator's dispatch
# map. If chain shape changes, update both. Tests pin the expected coverage.
_TDD_FULL_CHAIN = [
    "sm",
    "test_designer",
    "test_implementer",
    "dev",
    "reviewer",
    "tech_writer",
]
_DOCS_FULL_CHAIN = ["docs_sm", "onboarder"]
# SOLO pipeline (factory/chain/solo.py): the tdd chain with no reviewer step.
_SOLO_SKIPPED = frozenset({"reviewer"})


def _drop_solo(personas: list[str], pipeline: str | None) -> list[str]:
    if (pipeline or "chain") != "solo":
        return list(personas)
    return [p for p in personas if p not in _SOLO_SKIPPED]

# Map from a story's current state to its remaining persona list.
# "current state" here means the value of ``StoryRecord.state``; the
# remaining list is the personas that will fire from this state to
# PR_OPEN (terminal-for-estimator-purposes).
_REMAINING_BY_STATE_TDD: dict[str, list[str]] = {
    "story_created":                          _TDD_FULL_CHAIN,
    "sm_in_progress":                         _TDD_FULL_CHAIN[1:],
    "sm_done":                                _TDD_FULL_CHAIN[1:],
    "test_design_in_progress":                _TDD_FULL_CHAIN[2:],
    "test_design_done":                       _TDD_FULL_CHAIN[2:],
    "test_implementation_in_progress":        _TDD_FULL_CHAIN[3:],
    "tests_red":                              _TDD_FULL_CHAIN[3:],
    "harness_precheck_in_progress":           _TDD_FULL_CHAIN[3:],
    "dev_in_progress":                        _TDD_FULL_CHAIN[4:],
    "dev_retry":                              _TDD_FULL_CHAIN[3:],
    "tests_green":                            _TDD_FULL_CHAIN[4:],
    "reviewer_in_progress":                   _TDD_FULL_CHAIN[5:],
    "reviewer_done":                          _TDD_FULL_CHAIN[5:],
    "reviewer_requested_changes":             _TDD_FULL_CHAIN[3:],
    "tech_writer_in_progress":                [],
    "tech_writer_done":                       [],
    "docs_enforcer_check":                    [],
    "pr_open":                                [],
    "ci_pending":                             [],
    "ci_green":                               [],
    "ready_for_merge":                        [],
    "deploy_pending":                         [],
    "deployed":                               [],
    "blocked_tests_need_clarification":       [],
    "blocked_deploy_failed":                  [],
}

_REMAINING_BY_STATE_DOCS: dict[str, list[str]] = {
    "story_created":                          _DOCS_FULL_CHAIN,
    "docs_sm_in_progress":                    _DOCS_FULL_CHAIN[1:],
    "docs_sm_done":                           _DOCS_FULL_CHAIN[1:],
    "docs_onboarder_in_progress":             [],
    "docs_onboarder_done":                    [],
    "docs_enforcer_check":                    [],
    "pr_open":                                [],
    "deployed":                               [],
    "blocked_tests_need_clarification":       [],
}


class ETAResult(NamedTuple):
    """Output of a Monte Carlo ETA run."""

    p50_seconds: float
    p75_seconds: float
    p95_seconds: float
    mean_seconds: float
    sample_count: int
    insufficient_data: bool
    reason: str  # human-readable explainer when insufficient_data=True
    iterations: int


def _engine(db_path: Path):
    migrate(db_path)
    return create_engine(f"sqlite:///{db_path}", echo=False)


def remaining_handlers_for_story(
    state: str, chain_kind: str = "tdd", pipeline: str | None = None
) -> list[str]:
    """Return the ordered list of personas a story still needs to run.

    ``pipeline="solo"`` drops the reviewer (a solo story never runs one)."""
    if chain_kind == "docs":
        return list(_REMAINING_BY_STATE_DOCS.get(state, []))
    return _drop_solo(_REMAINING_BY_STATE_TDD.get(state, []), pipeline)


def total_handlers_for_chain(chain_kind: str = "tdd", pipeline: str | None = None) -> int:
    """Total handler steps in the chain from story-creation to PR-open."""
    if chain_kind == "docs":
        return len(_DOCS_FULL_CHAIN)
    return len(_drop_solo(_TDD_FULL_CHAIN, pipeline))


def completed_handlers_for_story(
    state: str, chain_kind: str = "tdd", pipeline: str | None = None
) -> int:
    """How many handlers have already completed for a story in ``state``."""
    return max(
        0,
        total_handlers_for_chain(chain_kind, pipeline)
        - len(remaining_handlers_for_story(state, chain_kind, pipeline)),
    )


# --------------------------------------------------------------------------- #
# Baseline computation — median seconds per (persona, points) bucket
# --------------------------------------------------------------------------- #


def _model_tier_of(model: str) -> str:
    """Coarse model-tier bucketing from a LiteLLM model id."""
    m = (model or "").lower()
    if "opus" in m:
        return "opus"
    if "sonnet" in m:
        return "sonnet"
    if "haiku" in m:
        return "haiku"
    if "deepseek" in m:
        return "deepseek"
    if "gpt-5" in m or "gpt5" in m:
        return "gpt5"
    if "gpt-4" in m or "gpt4" in m:
        return "gpt4"
    if "gpt" in m:
        return "gpt"
    return m.split("/")[-1][:24]


def _raw_sql_iter(db_path: Path, sql: str, params: tuple = ()) -> list[tuple]:
    """Tiny raw-sqlite read helper. Used so we don't fight SQLModel's typing
    for read-only joins between ``runs`` and ``stories``."""
    import sqlite3

    conn = sqlite3.connect(str(db_path))
    try:
        return list(conn.execute(sql, params).fetchall())
    finally:
        conn.close()


def recompute_baselines(db_path: Path) -> int:
    """Walk ``runs`` ⨝ ``stories``; recompute per-(persona, points) medians.

    Returns the number of (persona, points) cells written.
    """
    migrate(db_path)
    samples: dict[tuple[str, int], list[float]] = {}
    rows = _raw_sql_iter(
        db_path,
        """
        SELECT runs.persona, COALESCE(stories.points, 3), runs.duration_s, runs.success
        FROM runs
        JOIN stories ON runs.story_id = stories.id
        WHERE runs.duration_s IS NOT NULL
          AND runs.duration_s > 0
        """,
    )
    for persona, points, duration_s, success in rows:
        if not success:
            continue
        samples.setdefault((persona, int(points)), []).append(float(duration_s))

    eng = _engine(db_path)
    with Session(eng) as session:
        now = datetime.now(UTC).isoformat()
        existing = {
            (b.persona, b.points): b
            for b in session.exec(select(HandlerBaseline)).all()
        }
        for (persona, points), vals in samples.items():
            median = float(statistics.median(vals))
            row = existing.get((persona, points))
            if row is None:
                row = HandlerBaseline(
                    persona=persona,
                    points=points,
                    median_seconds=median,
                    sample_count=len(vals),
                    updated_at=now,
                )
                session.add(row)
            else:
                row.median_seconds = median
                row.sample_count = len(vals)
                row.updated_at = now
        session.commit()
    return len(samples)


def baseline_seconds(
    db_path: Path, *, persona: str, points: int
) -> tuple[float | None, int]:
    """Return (median_seconds, sample_count) for a (persona, points) bucket."""
    eng = _engine(db_path)
    with Session(eng) as session:
        rows = session.exec(
            select(HandlerBaseline).where(
                HandlerBaseline.persona == persona,
                HandlerBaseline.points == points,
            )
        ).all()
    if not rows:
        return (None, 0)
    return (float(rows[0].median_seconds), int(rows[0].sample_count))


def estimate_story_seconds(
    *, db_path: Path, points: int, chain_kind: str = "tdd", pipeline: str | None = None
) -> float | None:
    """Sum baseline seconds across every handler in the chain at ``points``.

    Uses live ``handler_baselines`` rows when available, else falls back to
    ``_COLD_START_HANDLER_SECONDS`` so the first stories still get a useful
    estimate. Returns ``None`` only if neither source has data.
    """
    chain = (
        _DOCS_FULL_CHAIN if chain_kind == "docs" else _drop_solo(_TDD_FULL_CHAIN, pipeline)
    )
    total = 0.0
    any_source = False
    for persona in chain:
        median, n = baseline_seconds(db_path, persona=persona, points=points)
        if median is not None and n >= 1:
            total += median
            any_source = True
            continue
        cold = _COLD_START_HANDLER_SECONDS.get(persona, {}).get(points)
        if cold is not None:
            total += cold
            any_source = True
    return total if any_source else None


# --------------------------------------------------------------------------- #
# Velocity samples (per persona × model_tier, lookback window)
# --------------------------------------------------------------------------- #


def velocity_samples(
    db_path: Path,
    *,
    persona: str,
    model_tier: str | None = None,
    lookback_days: int = 30,
) -> list[float]:
    """Return historical velocity samples (estimate/actual) for a cell.

    "Estimate" here is the ``baseline_seconds(persona, points)`` value at
    the time of the sample; we recompute against the *current* baseline
    snapshot to avoid persisting historical estimates. This means velocity
    samples track how the current baseline performs against historical
    actuals — which is exactly what the simulator wants.
    """
    migrate(db_path)
    cutoff = (datetime.now(UTC) - timedelta(days=lookback_days)).isoformat()
    rows = _raw_sql_iter(
        db_path,
        """
        SELECT runs.duration_s, COALESCE(stories.points, 3), runs.model, runs.success
        FROM runs
        JOIN stories ON runs.story_id = stories.id
        WHERE runs.persona = ?
          AND runs.duration_s IS NOT NULL
          AND runs.duration_s > 0
          AND runs.ts >= ?
        """,
        (persona, cutoff),
    )
    samples: list[float] = []
    for duration_s, points, model, success in rows:
        if not success:
            continue
        if model_tier is not None and _model_tier_of(model) != model_tier:
            continue
        # Use the current baseline snapshot as the estimate (cheap query).
        est, _n = baseline_seconds(db_path, persona=persona, points=int(points))
        if est is None or est <= 0:
            continue
        v = est / float(duration_s)
        # Clamp velocities to a sane range so a single 10ms outlier doesn't
        # poison the distribution. Joel's range in practice was ~0.3..2.0;
        # we widen a bit because agent runs are noisier.
        if 0.05 <= v <= 20.0:
            samples.append(v)
    return samples


# --------------------------------------------------------------------------- #
# Monte Carlo per direction
# --------------------------------------------------------------------------- #


def monte_carlo_eta(
    db_path: Path,
    *,
    direction_id: str,
    app: str | None = None,
    iterations: int = 500,
    lookback_days: int = 30,
    seed: int | None = None,
) -> ETAResult:
    """Project a direction's remaining wall-clock seconds via EBS.

    For each remaining handler on each non-terminal story in the direction,
    sample a velocity from that (persona, model_tier) history and divide
    the baseline-seconds estimate by it. Sum across all remaining work.
    Repeat ``iterations`` times -> distribution -> P50/P75/P95.

    Gates on ``N_VELOCITY_MIN`` samples per (persona) cell. The cell key
    intentionally ignores model_tier in the gate check (any tier counts)
    because the early-life factory may have switched tiers between runs.
    """
    rng = random.Random(seed)

    eng = _engine(db_path)
    with Session(eng) as session:
        from factory.chain.state_machine import StoryRecord

        stmt = select(StoryRecord).where(StoryRecord.direction_id == direction_id)
        if app is not None:
            stmt = stmt.where(StoryRecord.app == app)
        stories = list(session.exec(stmt).all())

    if not stories:
        return ETAResult(
            p50_seconds=0.0,
            p75_seconds=0.0,
            p95_seconds=0.0,
            mean_seconds=0.0,
            sample_count=0,
            insufficient_data=True,
            reason="no stories spawned yet for this direction",
            iterations=0,
        )

    # Pre-fetch per-persona velocity samples (no model_tier filter) so we
    # call the DB once per persona, not once per (story * persona).
    persona_velocities: dict[str, list[float]] = {}
    insufficient_personas: list[str] = []
    needed_personas: set[str] = set()
    remaining_by_story: list[tuple[Any, list[str], int]] = []
    for s in stories:
        rem = remaining_handlers_for_story(s.state, s.chain_kind)
        remaining_by_story.append((s, rem, int(s.points or 3)))
        for p in rem:
            needed_personas.add(p)

    for persona in needed_personas:
        samples = velocity_samples(
            db_path, persona=persona, lookback_days=lookback_days
        )
        persona_velocities[persona] = samples
        if len(samples) < N_VELOCITY_MIN:
            insufficient_personas.append(f"{persona}({len(samples)})")

    total_remaining = sum(len(rem) for _s, rem, _p in remaining_by_story)
    if total_remaining == 0:
        return ETAResult(
            p50_seconds=0.0,
            p75_seconds=0.0,
            p95_seconds=0.0,
            mean_seconds=0.0,
            sample_count=0,
            insufficient_data=False,
            reason="all stories already past the estimator window (pr_open or later)",
            iterations=0,
        )

    if insufficient_personas:
        return ETAResult(
            p50_seconds=0.0,
            p75_seconds=0.0,
            p95_seconds=0.0,
            mean_seconds=0.0,
            sample_count=min(len(v) for v in persona_velocities.values()),
            insufficient_data=True,
            reason="need >= "
            + str(N_VELOCITY_MIN)
            + " samples per persona; short: "
            + ", ".join(sorted(insufficient_personas)),
            iterations=0,
        )

    # Build per-handler estimates upfront. Falls back to cold-start tables
    # if a baseline cell is empty.
    per_handler_estimates: list[float] = []
    for _s, rem, points in remaining_by_story:
        for persona in rem:
            est, _n = baseline_seconds(db_path, persona=persona, points=points)
            if est is None:
                est = _COLD_START_HANDLER_SECONDS.get(persona, {}).get(
                    points, 60.0
                )
            per_handler_estimates.append(est)
            # Track which persona this entry maps to so we sample from the
            # right velocity vector.
    # Parallel persona vector aligned with per_handler_estimates.
    per_handler_personas: list[str] = []
    for _s, rem, _p in remaining_by_story:
        per_handler_personas.extend(rem)

    totals: list[float] = []
    for _ in range(iterations):
        run_total = 0.0
        for est, persona in zip(
            per_handler_estimates, per_handler_personas, strict=True
        ):
            samples = persona_velocities[persona]
            v = rng.choice(samples) if samples else 1.0
            if v <= 0:
                v = 0.5
            run_total += est / v
        totals.append(run_total)

    totals.sort()
    return ETAResult(
        p50_seconds=_percentile(totals, 50),
        p75_seconds=_percentile(totals, 75),
        p95_seconds=_percentile(totals, 95),
        mean_seconds=sum(totals) / len(totals),
        sample_count=min(len(v) for v in persona_velocities.values()),
        insufficient_data=False,
        reason="",
        iterations=iterations,
    )


def _percentile(sorted_vals: list[float], pct: int) -> float:
    if not sorted_vals:
        return 0.0
    if pct <= 0:
        return sorted_vals[0]
    if pct >= 100:
        return sorted_vals[-1]
    k = (len(sorted_vals) - 1) * (pct / 100.0)
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return float(sorted_vals[int(k)])
    return float(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo))


# Note: no SQLModel handles are exported here — read-side queries use raw
# SQLite via ``_raw_sql_iter`` to keep the typing simple and avoid pulling
# the runner module at import time (which would create a circular path
# through factory.runner -> factory.observability.heartbeat -> schema).
