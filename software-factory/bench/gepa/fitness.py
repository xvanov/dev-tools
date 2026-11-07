"""Fitness backends — one common interface, three very different sources.

    evaluate(genome, task_ids, k) -> FitnessResult(
        resolve_rate, cost_usd, per_task=[TaskResult, ...], evals_spent,
    )

``mock`` is a SYNTHETIC landscape with a planted, documented structure — see
the constants below, every one of them a deliberate stand-in for a measured
finding in ``ai_docs/research/EXPERIMENTS.md`` or
``bench/swebench/frozen/RESULTS-SAIL-AB.md``. It exists so the evolutionary
machinery (``evolve.py``) can be proven to work — converge, beat a random
walk, respect a budget, tolerate noise — against ground truth that is known
exactly, before it is ever pointed at a real fitness source.

``replay`` reads REAL rows out of ``bench/swebench/benchmarks.db``. It never
invents a number: a genome with no recorded arm gets ``None``, not a guess.

``live`` is an interface stub. It cannot spend a cent because it contains no
HTTP client of any kind — see the module-level comment at the bottom and
``tests/test_gepa_pilot.py``'s import-scan test.
"""

from __future__ import annotations

import dataclasses
import random
import sqlite3
from pathlib import Path
from typing import Any

try:  # package import (tests, `python -m bench.gepa.evolve`)
    from .genome import (
        BUILDER_MODELS,
        CONTEXT_CAP_TOKENS,
        JSON_FIX_ATTEMPTS,
        RETRIEVAL_PREPASS,
        REVIEWER_MODELS,
        REVISION_LOOPS,
        Genome,
    )
except ImportError:  # script import (`python bench/gepa/evolve.py`)
    from genome import (  # type: ignore[no-redef]
        BUILDER_MODELS,
        CONTEXT_CAP_TOKENS,
        JSON_FIX_ATTEMPTS,
        RETRIEVAL_PREPASS,
        REVIEWER_MODELS,
        REVISION_LOOPS,
        Genome,
    )

# ═══════════════════════════════════════════════════════════════════════
# The shared result shape
# ═══════════════════════════════════════════════════════════════════════


@dataclasses.dataclass(frozen=True)
class TaskResult:
    task_id: str
    resolved: bool | None  # None => no data (replay backend, uncovered task)
    cost_usd: float
    failure_label: str | None = None  # mock only: wrong_place / right_place_wrong_fix / empty_patch
    verdicts: tuple[bool, ...] = ()  # the k raw draws, before aggregation (mock only)


@dataclasses.dataclass(frozen=True)
class FitnessResult:
    resolve_rate: float  # over COVERED tasks only — see `covered_tasks`
    cost_usd: float  # mean cost over covered tasks
    per_task: tuple[TaskResult, ...]
    evals_spent: int  # (task, k-draw) pairs actually evaluated by the backend
    covered_tasks: int  # tasks with a real (non-None) verdict
    total_tasks: int  # tasks asked for


def aggregate_verdicts(verdicts: tuple[bool, ...], rule: str) -> bool:
    """k-eval verdict aggregation. Declared here so both backends and tests
    use the identical rule.

    * ``"majority"`` — more than half of the k draws solved (ties, e.g. k=2
      1-1, count as NOT resolved — the conservative reading, matching the
      A/B verdict's own posture that a split cell is not a clean solve).
    * ``"any"`` — at least one draw solved. Optimistic; documented as such,
      never the default.
    """
    if rule not in ("majority", "any"):
        raise ValueError(f"unknown aggregation rule {rule!r}")
    if not verdicts:
        return False
    if rule == "any":
        return any(verdicts)
    return sum(verdicts) * 2 > len(verdicts)


# ═══════════════════════════════════════════════════════════════════════
# mock — a synthetic, EXACTLY-KNOWN landscape
# ═══════════════════════════════════════════════════════════════════════

SAIL_FLASH_ID = "sail/deepseek/deepseek-v4-flash-0731"


@dataclasses.dataclass(frozen=True)
class MockTask:
    task_id: str
    tier: str  # "floor" | "ceiling" | "discriminating" — mirrors E5.2's finding
    needs_retrieval: bool = False  # E5.5's wrong_place subset
    is_long: bool = False  # E5.7's context lever + R4's starvation-retry cells


# The planted task set. 2 floor (nobody solves, like `alibaba__opensandbox-816`
# / `harumiweb__exstruct-113` in E5.2 — 0/9 arms), 2 ceiling (everybody solves,
# like `hkuds__openharness-217` / `zauberzeug__nicegui-5858` — 9/9), 8
# discriminating. Of the 8 discriminating tasks: 4 need retrieval, 3 are long
# (one is both). This is a FIXED, documented table, not generated from a
# formula, so a reader can check every planted fact against a single list.
MOCK_TASKS: tuple[MockTask, ...] = (
    MockTask("t00_floor_a", tier="floor"),
    MockTask("t01_floor_b", tier="floor"),
    MockTask("t02_ceiling_a", tier="ceiling"),
    MockTask("t03_ceiling_b", tier="ceiling"),
    MockTask("t04_disc", tier="discriminating"),
    MockTask("t05_disc_retrieval", tier="discriminating", needs_retrieval=True),
    MockTask("t06_disc_long", tier="discriminating", is_long=True),
    MockTask("t07_disc_retrieval_long", tier="discriminating", needs_retrieval=True, is_long=True),
    MockTask("t08_disc_retrieval", tier="discriminating", needs_retrieval=True),
    MockTask("t09_disc_long", tier="discriminating", is_long=True),
    MockTask("t10_disc_retrieval", tier="discriminating", needs_retrieval=True),
    MockTask("t11_disc", tier="discriminating"),
)
MOCK_TASK_IDS: tuple[str, ...] = tuple(t.task_id for t in MOCK_TASKS)
_MOCK_TASK_BY_ID: dict[str, MockTask] = {t.task_id: t for t in MOCK_TASKS}

# A floor task fails for EVERY genome (`expected_quality` returns 0.0
# unconditionally for `tier == "floor"`), so its failure label carries no
# information about the genome under evaluation -- it is noise the
# reflective-mutation hook (`evolve.py`) must not vote on. Exposed publicly
# (not `_`-prefixed) because that hook lives in a different module and needs
# to filter these out without reaching into `_MOCK_TASK_BY_ID`.
FLOOR_TASK_IDS: frozenset[str] = frozenset(t.task_id for t in MOCK_TASKS if t.tier == "floor")

# The cheap screening subset for racing (`evolve.py`). Fixed and declared, not
# random: 1 floor, 1 ceiling, 2 discriminating (one retrieval, one long) — a
# representative 1/3 slice, small enough to be cheap and shaped enough to be
# informative.
SCREENING_TASK_IDS: tuple[str, ...] = (
    "t00_floor_a",
    "t02_ceiling_a",
    "t05_disc_retrieval",
    "t06_disc_long",
)
SCREENING_FRACTION = len(SCREENING_TASK_IDS) / len(MOCK_TASK_IDS)  # 1/3

# ── planted quality/cost surface ─────────────────────────────────────────
#
# Base builder quality/cost. Same *underlying* model on Azure vs Sail
# (DeepSeek-V4-Flash) gets the SAME quality (R3(b): cross-provider agreement
# held on 3/4 discriminating cells -- same model family, not a different
# capability) but a DIFFERENT planted cost.
#
# The cost is planted at R6's COMPUTED ratio -- Sail 1.19x Azure -- because
# "computed dollars" is R6's number of record (the frozen DECISION's own
# phrase) and every other cost in this mock is a computed-dollar figure, not
# a billed one. An earlier version of this file planted Sail CHEAPER than
# Azure, citing the campaign's ~34%-of-computed billed observation -- that
# was a real number attached to the wrong column: R6 is explicit that the
# 1.19x computed ratio is what's ADOPTED ("per the frozen predicate the
# 1.19x computed ratio is the number of record, the billed advantage a
# labeled observation"), and silently swapping in the billed figure inverted
# which provider looks cheaper in the one column this mock actually has.
# This pilot does not model a separate billed-cost column (that needs its
# own reporting path, not a quiet substitution here); if a future revision
# adds one, the ~34% figure belongs there, multiplying this cost, not
# replacing it.
_BUILDER_QUALITY: dict[str, float] = {
    "azure/DeepSeek-V4-Flash": 0.45,
    SAIL_FLASH_ID: 0.45,
    "azure/Kimi-K2.7-Code": 0.52,
    "azure/DeepSeek-V3.2": 0.58,
}
_SAIL_VS_AZURE_COMPUTED_RATIO = 1.19  # R6: Sail $0.1050/task vs Azure $0.0881/task
_BUILDER_COST: dict[str, float] = {
    "azure/DeepSeek-V4-Flash": 0.08,
    SAIL_FLASH_ID: 0.08 * _SAIL_VS_AZURE_COMPUTED_RATIO,
    "azure/Kimi-K2.7-Code": 0.15,
    "azure/DeepSeek-V3.2": 0.45,  # E5.7: V3.2 never reports a cached token
}

# Reviewer quality bonus, monotonic in capability -- E5b's main results
# table ("each rung solves a strict superset of the one below"), NOT E5b.2
# (a citation this file previously got wrong: E5b.2 is the MARGINAL-cost
# finding below, not the monotonic ordering). Self-review at exactly 0.0
# (E5b.1: "self-review is worth exactly nothing"). Reviewer cost add, also
# monotonic (E5b's $/task column) -- and its SHAPE reproduces E5b.2's own
# finding ("the frontier reviewer is slightly cheaper at the margin than
# the mid-tier one"): the marginal $/quality-point of moving Kimi->gpt-5.4
# ($0.06/+0.06 quality = $1.00/point) is planted CHEAPER than None->Kimi
# ($0.10/+0.07 quality = $1.43/point), the same inversion E5b.2 measured.
_REVIEWER_QUALITY_BONUS: dict[str | None, float] = {
    None: 0.0,
    "azure/DeepSeek-V4-Flash": 0.0,  # self-review, E5b.1
    "azure/Kimi-K2.7-Code": 0.07,
    "azure/gpt-5.4": 0.13,
}
_REVIEWER_COST: dict[str | None, float] = {
    None: 0.0,
    "azure/DeepSeek-V4-Flash": 0.05,
    "azure/Kimi-K2.7-Code": 0.10,
    "azure/gpt-5.4": 0.16,
}

# revision_loops: helps up to 1 loop, ZERO further quality past that (E5.6:
# "a revise cap tied to observed progress would cut cost with no quality
# loss" — the pilot plants that as a hard fact rather than a hope). Cost
# keeps climbing per loop, and climbs FASTER when a reviewer exists (E5.6:
# cost concentrates on failures "only with a reviewer").
_REVISION_QUALITY_STEP = 0.05  # loop 1 only
_REVISION_COST_PER_LOOP = 0.03
_REVISION_COST_REVIEWER_MULT = 1.8

# json_fix_attempts: a small, quickly-saturating repair budget for malformed
# tool output. Helps close `empty_patch`-shaped failures (see failure_label
# below), saturates after 1 attempt.
_JSONFIX_QUALITY_STEP = 0.03
_JSONFIX_COST_PER_ATTEMPT = 0.01

# retrieval_prepass: a flat scout-step cost, and a quality bonus ONLY on
# tasks that actually need retrieval (E5.5's wrong_place subset) — it does
# nothing for a task whose failure mode was never "never found the code".
_RETRIEVAL_QUALITY_BONUS = 0.30
_RETRIEVAL_COST = 0.04

# context_cap_tokens: quality penalty and cost multiplier, LONG TASKS ONLY.
# Uncapped preserves quality (nothing is truncated) but is the most
# expensive (E5.7: input tokens spanned 170x, and re-sent context was the
# bill). Progressively smaller caps trade a growing truncation-quality risk
# for a shrinking cost multiplier; 1M is "uncapped in practice" for these
# tasks so it lands close to None on both axes.
_CONTEXT_QUALITY_PENALTY_LONG: dict[int | None, float] = {
    None: 0.00,
    100_000: 0.22,
    300_000: 0.08,
    1_000_000: 0.02,
}
_CONTEXT_COST_MULT_LONG: dict[int | None, float] = {
    None: 3.00,
    100_000: 1.00,
    300_000: 1.60,
    1_000_000: 2.40,
}

# R4: "expect ~20% row-retry overhead on long tasks" — modeled as a
# probability that a long task's attempt gets billed twice (one wasted
# retry, same price, before the real attempt). Cost-only; does not touch
# the solve draw, because R4's incidents were transport (provider-starved),
# not a capability signal.
STARVATION_RETRY_RATE = 0.20

# R3(a): "Sail-served Flash flips on marginal (discriminating) cells" — the
# frozen verdict measured 2 flips of 4 evaluable discriminating pairs, i.e. a
# 50% DISAGREEMENT rate between two repeat draws of the same cell.
#
# That 50% is NOT the corruption probability planted below — a corruption
# probability of 0.5 would make a draw a pure coin flip independent of the
# genome's true quality (a capacity-zero channel: k=2 majority would still
# report a coin flip, since two independent 50/50 draws agree only half the
# time regardless of k). Discovered while calibrating this: two INDEPENDENT
# draws of a channel that is merely noisy (not zeroed) already disagree with
# probability 2p(1-p), which is 50% exactly when the true probability p is
# itself at the 0.5 boundary -- which is what "marginal/discriminating"
# MEANS. So the observed 50% is compatible with a much smaller corruption
# rate riding on top of a genuinely near-50% true quality; the corruption
# rate below (0.30) is the part attributable to Sail's serving specifically,
# calibrated to be meaningfully less than 0.5 so k>=2 majority provably
# recovers signal a k=1 single draw does not (see the noise-robustness
# tests in tests/test_gepa_pilot.py).
#
# Mechanism: with this probability, a discriminating-tier draw for a
# Sail-Flash genome is REPLACED by an independent 50/50 coin flip instead of
# the genome's real solve probability -- corrupted, not inverted.
SAIL_CORRUPTION_RATE = 0.30


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _revision_quality_bonus(loops: int) -> float:
    return _REVISION_QUALITY_STEP if loops >= 1 else 0.0


def _revision_cost(loops: int, has_reviewer: bool) -> float:
    mult = _REVISION_COST_REVIEWER_MULT if has_reviewer else 1.0
    return loops * _REVISION_COST_PER_LOOP * mult


def _jsonfix_quality_bonus(attempts: int) -> float:
    return _JSONFIX_QUALITY_STEP if attempts >= 1 else 0.0


def _jsonfix_cost(attempts: int) -> float:
    return attempts * _JSONFIX_COST_PER_ATTEMPT


def expected_quality(genome: Genome, task: MockTask) -> float:
    """The TRUE (pre-noise) solve probability the mock plants for this
    (genome, task) pair. Pure and deterministic — this is what
    ``tests/test_gepa_pilot.py`` brute-forces over the whole (small, finite)
    genome space to compute the planted Pareto-optimal set.
    """
    if task.tier == "floor":
        return 0.0
    if task.tier == "ceiling":
        return 1.0
    q = _BUILDER_QUALITY[genome.builder_model]
    q += _REVIEWER_QUALITY_BONUS[genome.reviewer_model]
    q += _revision_quality_bonus(genome.revision_loops)
    q += _jsonfix_quality_bonus(genome.json_fix_attempts)
    if genome.retrieval_prepass and task.needs_retrieval:
        q += _RETRIEVAL_QUALITY_BONUS
    if task.is_long:
        q -= _CONTEXT_QUALITY_PENALTY_LONG[genome.context_cap_tokens]
    return _clamp01(q)


def _base_cost(genome: Genome, task: MockTask) -> float:
    c = _BUILDER_COST[genome.builder_model]
    c += _REVIEWER_COST[genome.reviewer_model]
    c += _revision_cost(genome.revision_loops, genome.reviewer_model is not None)
    c += _jsonfix_cost(genome.json_fix_attempts)
    if genome.retrieval_prepass:
        c += _RETRIEVAL_COST
    if task.is_long:
        c *= _CONTEXT_COST_MULT_LONG[genome.context_cap_tokens]
    return c


def expected_cost(genome: Genome, task: MockTask) -> float:
    """Mean cost the mock plants, INCLUDING the expected starvation-retry
    addition on long tasks (linearity of expectation over the Bernoulli
    retry draw `_sample_task` actually makes)."""
    base = _base_cost(genome, task)
    if task.is_long:
        return base * (1.0 + STARVATION_RETRY_RATE)
    return base


_PLANTED_COST_REF_MARGIN = 1.05


def planted_cost_ref() -> float:
    """The ONE hypervolume reference point convention shared by the CLI
    (`evolve.py`'s mock demo) and every test that computes a hypervolume:
    1.05x the most expensive genome anywhere in the DECLARED search space,
    evaluated on the full deterministic mock task set. A function, not a
    module-level constant, so it is derived from `genome.py`'s space and
    this module's `expected_cost` rather than hand-copied in two places and
    left to drift when either changes.

    NOTE on what this reference point is (and is not) good for: with the
    landscape's whole cost range as the reference, generation-0's own
    hypervolume already sits close to the planted optimum's (~89-92% in
    practice), which makes a raw or gen0-normalized hypervolume THRESHOLD a
    weak pass/fail gate -- a poor search and a good one can look similar on
    this metric. The tests use COVERAGE (how many planted Pareto-optimal
    points the found front dominates) as the primary convergence signal for
    exactly this reason; hypervolume computed against this reference is
    kept for the CLI's diagnostic display and for the archive's own
    monotonicity invariant, not as a gate.
    """
    import itertools

    combos = itertools.product(BUILDER_MODELS, REVIEWER_MODELS, REVISION_LOOPS, JSON_FIX_ATTEMPTS, RETRIEVAL_PREPASS, CONTEXT_CAP_TOKENS)
    max_cost = max(
        sum(expected_cost(Genome(*combo), t) for t in MOCK_TASKS) / len(MOCK_TASKS) for combo in combos
    )
    return max_cost * _PLANTED_COST_REF_MARGIN


def failure_label(genome: Genome, task: MockTask) -> str:
    """E5.5's three-way taxonomy, deterministic given (genome, task). Only
    meaningful when the task was NOT solved; the reflective-mutation hook in
    ``evolve.py`` reads this off failed draws to bias mutation.

    Priority order, documented: a retrieval-shaped gap is checked first (a
    genome missing `retrieval_prepass` on a task that needs it is
    `wrong_place` regardless of its fix budget), then an empty repair budget
    (`json_fix_attempts == 0`) reads as `empty_patch` (E5.5: the harness
    never got a well-formed diff out), and everything else is a capability
    shortfall (`right_place_wrong_fix`).
    """
    if task.needs_retrieval and not genome.retrieval_prepass:
        return "wrong_place"
    if genome.json_fix_attempts == 0:
        return "empty_patch"
    return "right_place_wrong_fix"


def _sample_task(genome: Genome, task: MockTask, rng: random.Random) -> TaskResult:
    if genome.builder_model == SAIL_FLASH_ID and task.tier == "discriminating" and rng.random() < SAIL_CORRUPTION_RATE:
        solved = rng.random() < 0.5  # corrupted: an independent coin flip, not the genome's real signal
    else:
        p = expected_quality(genome, task)
        solved = rng.random() < p
    cost = _base_cost(genome, task)
    if task.is_long and rng.random() < STARVATION_RETRY_RATE:
        cost += _base_cost(genome, task)
    label = None if solved else failure_label(genome, task)
    return TaskResult(task_id=task.task_id, resolved=solved, cost_usd=cost, failure_label=label, verdicts=(solved,))


class MockBackend:
    """The synthetic landscape. ``evaluate`` draws k independent samples per
    task and aggregates by ``agg_rule`` (see ``aggregate_verdicts``).

    ``deterministic=True`` switches to a NOISE-FREE reading of the exact
    same planted structure: no Bernoulli sampling, no Sail-flip, no
    starvation retry, ``k`` ignored. ``resolve_rate``/``cost_usd`` are then
    the literal mean of ``expected_quality``/``expected_cost`` over the
    requested tasks — i.e. this mode's ground truth IS the "planted
    Pareto-optimal set" the tests brute-force. It exists to test the search
    machinery (NSGA-II ranking, mutation, crossover, racing, the reflective
    hook) in isolation from evaluation noise; ``tests/test_gepa_pilot.py``'s
    convergence test uses it for exactly that reason, and its own
    noise-robustness test then switches back to the stochastic path
    (``deterministic=False``, the default, and what every CLI run uses) to
    check the search still converges once Sail-style flip noise is real.

    (Discovered empirically while building this pilot: majority-of-k with a
    LARGE k is not "less noisy" in the way it first appears — it converges
    per task to a hard threshold on which side of 0.5 the true probability
    falls, which is a DIFFERENT landscape than the planted continuous mean,
    not a cleaner reading of the same one. Small k stays an unbiased
    estimator of the mean; this deterministic mode is the cleaner fix.)
    """

    def __init__(self, agg_rule: str = "majority", deterministic: bool = False) -> None:
        self.agg_rule = agg_rule
        self.deterministic = deterministic

    def evaluate(
        self, genome: Genome, task_ids: tuple[str, ...], k: int, rng: random.Random
    ) -> FitnessResult:
        if k < 1:
            raise ValueError("k must be >= 1")
        if self.deterministic:
            return self._evaluate_deterministic(genome, task_ids)
        per_task: list[TaskResult] = []
        for tid in task_ids:
            task = _MOCK_TASK_BY_ID[tid]
            draws = [_sample_task(genome, task, rng) for _ in range(k)]
            verdicts = tuple(bool(d.resolved) for d in draws)  # `_sample_task` always sets a bool, never None
            resolved = aggregate_verdicts(verdicts, self.agg_rule)
            cost = sum(d.cost_usd for d in draws) / k
            label = None if resolved else failure_label(genome, task)
            per_task.append(
                TaskResult(task_id=tid, resolved=resolved, cost_usd=cost, failure_label=label, verdicts=verdicts)
            )
        resolve_rate = sum(1 for t in per_task if t.resolved) / len(per_task)
        cost_usd = sum(t.cost_usd for t in per_task) / len(per_task)
        return FitnessResult(
            resolve_rate=resolve_rate,
            cost_usd=cost_usd,
            per_task=tuple(per_task),
            evals_spent=len(task_ids) * k,
            covered_tasks=len(per_task),
            total_tasks=len(task_ids),
        )

    def _evaluate_deterministic(self, genome: Genome, task_ids: tuple[str, ...]) -> FitnessResult:
        per_task = []
        for tid in task_ids:
            task = _MOCK_TASK_BY_ID[tid]
            p = expected_quality(genome, task)
            resolved = p >= 0.5  # informational only -- see the class docstring
            label = None if resolved else failure_label(genome, task)
            # `expected_cost`, NOT `_base_cost`: a real bug found by review had
            # per-task cost skip the starvation-retry multiplier that the
            # AGGREGATE cost_usd below includes, so a long task's own
            # `per_task[i].cost_usd` under-reported by the same ~1.20x factor
            # the mean was already accounting for -- any caller reading
            # per-task costs (the reflective-mutation hook used to be one)
            # was seeing numbers that didn't sum to the total.
            per_task.append(
                TaskResult(task_id=tid, resolved=resolved, cost_usd=expected_cost(genome, task), failure_label=label)
            )
        resolve_rate = sum(expected_quality(genome, _MOCK_TASK_BY_ID[tid]) for tid in task_ids) / len(task_ids)
        cost_usd = sum(expected_cost(genome, _MOCK_TASK_BY_ID[tid]) for tid in task_ids) / len(task_ids)
        return FitnessResult(
            resolve_rate=resolve_rate,
            cost_usd=cost_usd,
            per_task=tuple(per_task),
            evals_spent=len(task_ids),
            covered_tasks=len(per_task),
            total_tasks=len(task_ids),
        )


# ═══════════════════════════════════════════════════════════════════════
# replay — REAL rows from benchmarks.db
# ═══════════════════════════════════════════════════════════════════════

DEFAULT_DB_PATH = Path(__file__).resolve().parents[1] / "swebench" / "benchmarks.db"

# The E5 8-instance set (ai_docs/research/EXPERIMENTS.md, E5's headline
# table). These are the "task_ids" the replay backend understands.
REPLAY_TASK_IDS: tuple[str, ...] = (
    "alibaba__opensandbox-816",
    "getmoto__moto-9841",
    "harumiweb__exstruct-113",
    "hkuds__openharness-217",
    "idaholab__montepy-933_interface",
    "keras-team__keras-22316",
    "pyinfra-dev__pyinfra-1665",
    "zauberzeug__nicegui-5858",
)

# The only knob settings any recorded E5/A-B row actually ran under: every
# sssf arm in the store used the engine's default limits
# (`_SSSF_LIMITS` in swebench_adapter.py: revision_loops=2,
# json_fix_attempts=2) with no retrieval pre-pass (doesn't exist in the
# engine) and no context cap (the engine sends the full context every
# call). A genome that differs on ANY of these knobs has no recorded row —
# not because the mapping is incomplete, but because nobody has RUN that
# cell. That absence is exactly what `evaluate` returning `None` records.
_REPLAY_MEASURED_KNOBS: dict[str, Any] = {
    "revision_loops": 2,
    "json_fix_attempts": 2,
    "retrieval_prepass": False,
    "context_cap_tokens": None,
}

# CAMPAIGNS — E5 and the Sail A/B ran on DIFFERENT ENGINE COMMITS, and both
# frozen docs are explicit that this makes their rows non-comparable:
# PRE-REGISTRATION-SAIL-AB.md:74 ("E5 rows ... are priors, not comparators:
# the engine changed since [stderr-drain deadlock fix, EmptyResponse
# handling, gate fixes] ... every comparison row in this campaign is run
# fresh on one frozen commit pair") and :108 ("fresh control rows under the
# old flash-solo id would ... mix engine builds inside one arm;
# flash-solo-az-r2 is a new registry entry with its own cells"). A Pareto
# front is a comparison; mixing an E5 row and a Sail-AB row into ONE front
# is exactly the mixing both documents forbid, even though nothing here
# invents a number — the numbers are real, the COMPARISON is not.
CAMPAIGN_E5 = "e5"
CAMPAIGN_SAIL_AB = "sail-ab"
CAMPAIGNS: tuple[str, ...] = (CAMPAIGN_E5, CAMPAIGN_SAIL_AB)


class AmbiguousCampaignError(ValueError):
    """Raised when a genome coordinate has a recorded row in MORE THAN ONE
    campaign and the caller did not say which one it wants. There is no
    correct default here — silently picking one would be exactly the
    unlabeled mixing this type exists to prevent."""


# builder/reviewer -> {campaign: arm id}. Every entry re-derives a real row
# in one of the two campaigns (`bench/swebench/frozen/RESULTS-SAIL-AB.md` for
# `sail-ab`, `ai_docs/research/EXPERIMENTS.md`'s E5 table for `e5`); none of
# these numbers are copied into this file, only the QUERY that gets them
# (see `ReplayBackend.evaluate`).
#
# CAVEAT on "chain": the real `chain` arm is planner=V3.2, builder=V3.2,
# reviewer=gpt-5.4 (E5.4) — a THREE-role graph the genome cannot express
# (there is no planner knob). Mapping it to
# (builder=V3.2, reviewer=gpt-5.4) collapses the planner into "not modeled"
# rather than "off"; `chain` is the only measured row at that genome cell,
# so the collapse costs nothing today, but a future genome that legitimately
# means "no planner" would collide with it. Documented, not hidden.
#
# ONE coordinate has TWO campaigns: (Azure Flash, no reviewer) was measured
# both in E5 (`flash-solo`, 2026-08-14/15, old engine) and re-measured in the
# Sail A/B as the engine-matched control (`flash-solo-az-r2`, 2026-08-27/28,
# new engine, paired against `flash-solo-sail`) — that pairing is the WHOLE
# REASON `flash-solo-az-r2` exists (PRE-REGISTRATION-SAIL-AB.md's treatment
# table). `map_genome_to_arm` refuses to guess between them.
_ARM_BY_BUILDER_REVIEWER: dict[tuple[str, str | None], dict[str, str]] = {
    ("azure/DeepSeek-V4-Flash", None): {CAMPAIGN_E5: "flash-solo", CAMPAIGN_SAIL_AB: "flash-solo-az-r2"},
    ("azure/DeepSeek-V4-Flash", "azure/gpt-5.4"): {CAMPAIGN_E5: "flash-chain"},
    ("azure/Kimi-K2.7-Code", None): {CAMPAIGN_E5: "kimi-solo"},
    ("azure/DeepSeek-V4-Flash", "azure/Kimi-K2.7-Code"): {CAMPAIGN_E5: "flash-kimichain"},
    ("azure/DeepSeek-V4-Flash", "azure/DeepSeek-V4-Flash"): {CAMPAIGN_E5: "flash-selfchain"},
    ("azure/DeepSeek-V3.2", None): {CAMPAIGN_E5: "v32-solo"},
    ("azure/DeepSeek-V3.2", "azure/gpt-5.4"): {CAMPAIGN_E5: "chain"},  # see CAVEAT above
    (SAIL_FLASH_ID, None): {CAMPAIGN_SAIL_AB: "flash-solo-sail"},
}


def arms_for_genome(genome: Genome) -> dict[str, str]:
    """``{campaign: arm}`` for every campaign this genome coordinate has a
    recorded row in — empty if the knobs aren't the measured defaults or the
    (builder, reviewer) pair was never run."""
    for field, measured_value in _REPLAY_MEASURED_KNOBS.items():
        if getattr(genome, field) != measured_value:
            return {}
    return dict(_ARM_BY_BUILDER_REVIEWER.get((genome.builder_model, genome.reviewer_model), {}))


def map_genome_to_arm(genome: Genome, campaign: str | None = None) -> str | None:
    """The genome -> arm mapping. `None` means "no recorded arm in this
    campaign" — the caller must not invent a number for it.

    Raises `AmbiguousCampaignError` if `campaign` is not given AND the
    genome coordinate has rows in more than one campaign — see the
    `_ARM_BY_BUILDER_REVIEWER` comment for the one coordinate this applies
    to today (Azure Flash, no reviewer).
    """
    arms = arms_for_genome(genome)
    if not arms:
        return None
    if campaign is not None:
        return arms.get(campaign)
    if len(arms) > 1:
        raise AmbiguousCampaignError(
            f"genome (builder={genome.builder_model!r}, reviewer={genome.reviewer_model!r}) has recorded rows "
            f"in multiple campaigns {sorted(arms)} ({arms}) -- pass campaign= to ReplayBackend (or to this "
            "call) to choose ONE. Aggregating them into one Pareto front is exactly what "
            "PRE-REGISTRATION-SAIL-AB.md:74 and :108 forbid: E5 and the Sail A/B ran on different engine "
            "commits, so their rows are not comparable even though both are real."
        )
    return next(iter(arms.values()))


# The re-derivation query: first REPORTABLE attempt per (arm, instance) by
# `ran_at`, exactly E5's "Row selection rule" (EXPERIMENTS.md, E5's intro).
_FIRST_VALID_SQL = """
WITH fv AS (
    SELECT instance_id, oracle_resolved, cost_usd,
           ROW_NUMBER() OVER (
               PARTITION BY instance_id ORDER BY ran_at
           ) AS rn
    FROM run_attempt
    WHERE reportable = 1 AND arm = ? AND instance_id IN ({placeholders})
)
SELECT instance_id, oracle_resolved, cost_usd FROM fv WHERE rn = 1
"""


class ReplayBackend:
    """Reads real graded rows out of ``benchmarks.db``. Never fabricates a
    number: a genome with no mapped arm, or a task the mapped arm never ran,
    comes back as ``None`` in ``per_task`` — see ``covered_tasks`` /
    ``total_tasks`` on the result for how much of the request that was.

    ``campaign`` (``None``, ``"e5"``, or ``"sail-ab"``) fixes which
    campaign's arm this backend instance reads, for genome coordinates that
    have a row in more than one (today: only Azure Flash / no reviewer —
    see the module-level comment above ``_ARM_BY_BUILDER_REVIEWER``). Leave
    it ``None`` to have unambiguous genomes resolve automatically and
    ambiguous ones raise ``AmbiguousCampaignError`` — the backend refuses to
    guess which campaign's evidence a caller wants rather than silently
    picking one.
    """

    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH, campaign: str | None = None) -> None:
        self.db_path = Path(db_path)
        if campaign is not None and campaign not in CAMPAIGNS:
            raise ValueError(f"unknown campaign {campaign!r}; expected one of {CAMPAIGNS}")
        self.campaign = campaign

    def evaluate(
        self,
        genome: Genome,
        task_ids: tuple[str, ...],
        k: int = 1,
        rng: random.Random | None = None,
    ) -> FitnessResult | None:
        """``k`` is accepted for interface parity but NOT resampled — a
        stored row is one real measurement, not a distribution to redraw
        from. Passing k>1 here evaluates identically to k=1; this is
        deliberate, not a bug, and is asserted in the tests.

        Raises ``AmbiguousCampaignError`` (not a return value — this is a
        caller-must-fix-the-call condition, not a "no data" condition) if
        this backend has no fixed ``campaign`` and the genome resolves to
        more than one.
        """
        arm = map_genome_to_arm(genome, campaign=self.campaign)
        if arm is None:
            return None
        if not self.db_path.exists():
            return None
        placeholders = ",".join("?" for _ in task_ids)
        sql = _FIRST_VALID_SQL.format(placeholders=placeholders)
        with sqlite3.connect(str(self.db_path)) as conn:
            rows = conn.execute(sql, (arm, *task_ids)).fetchall()
        found: dict[str, tuple[int, float]] = {r[0]: (r[1], r[2]) for r in rows}
        per_task = []
        for tid in task_ids:
            if tid not in found:
                per_task.append(TaskResult(task_id=tid, resolved=None, cost_usd=0.0))
                continue
            resolved_int, cost = found[tid]
            per_task.append(TaskResult(task_id=tid, resolved=bool(resolved_int), cost_usd=float(cost)))
        covered = [t for t in per_task if t.resolved is not None]
        if not covered:
            return FitnessResult(
                resolve_rate=0.0,
                cost_usd=0.0,
                per_task=tuple(per_task),
                evals_spent=0,
                covered_tasks=0,
                total_tasks=len(task_ids),
            )
        resolve_rate = sum(1 for t in covered if t.resolved) / len(covered)
        cost_usd = sum(t.cost_usd for t in covered) / len(covered)
        return FitnessResult(
            resolve_rate=resolve_rate,
            cost_usd=cost_usd,
            per_task=tuple(per_task),
            evals_spent=len(covered),
            covered_tasks=len(covered),
            total_tasks=len(task_ids),
        )


# ═══════════════════════════════════════════════════════════════════════
# live — INTERFACE ONLY. No HTTP client anywhere in this module or package.
# ═══════════════════════════════════════════════════════════════════════


class LiveBackend:
    """Not implemented, ON PURPOSE, for this pilot.

    Nothing under `bench/gepa/` pulls in the stdlib or third-party HTTP
    client families (enforced by `tests/test_gepa_pilot.py`'s source scan),
    so this class cannot spend money by accident even if something called it.
    """

    def evaluate(
        self,
        genome: Genome,
        task_ids: tuple[str, ...],
        k: int = 1,
        rng: random.Random | None = None,
    ) -> FitnessResult:
        raise NotImplementedError(
            "live fitness evaluation is out of scope for the GEPA pilot. Three "
            "binding constraints from bench/swebench/frozen/RESULTS-SAIL-AB.md's "
            "DECISION apply to any future live implementation: "
            "(1) fitness evals on Sail-served Flash need k>=2 or noise-tolerant "
            "selection -- its verdicts flip on marginal cells where Azure's "
            "serving was unanimous; "
            "(2) budget ~20% starvation-retry overhead on long rows, and do not "
            "fan out beyond width 2 without a new width probe; "
            "(3) treat computed dollars as an UPPER BOUND and reconcile against "
            "billed, which ran ~34% of computed on cache-warm Sail work. "
            "A live run additionally needs its own pre-registration (the "
            "frozen/PRE-REGISTRATION-*.md pattern) before any model call -- "
            "see bench/gepa/README.md, 'the declared path to live'."
        )
