#!/usr/bin/env python3
"""The GEPA loop — NSGA-II-lite Pareto search over the pipeline genome.

    uv run python bench/gepa/evolve.py --backend mock --generations 12 \\
        --population 12 --seed 7 [--k 2]
    uv run python bench/gepa/evolve.py --backend replay

Deterministic under a seed: one ``random.Random(seed)`` instance is threaded
through every call that needs randomness (genome init, mutation, crossover,
tournament selection, and the mock backend's noise draws). Nothing here reads
the wall clock, a hash seed, or any other source of entropy — see
``tests/test_gepa_pilot.py``'s determinism test.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import random
from typing import Any

try:  # package import (tests, `python -m bench.gepa.evolve`)
    from . import fitness as F
    from . import genome as G
    from .fitness import (
        MOCK_TASK_IDS,
        REPLAY_TASK_IDS,
        SCREENING_TASK_IDS,
        FitnessResult,
        MockBackend,
        ReplayBackend,
    )
except ImportError:  # script import (`python bench/gepa/evolve.py`)
    import fitness as F
    import genome as G
    from fitness import (
        MOCK_TASK_IDS,
        REPLAY_TASK_IDS,
        SCREENING_TASK_IDS,
        FitnessResult,
        MockBackend,
        ReplayBackend,
    )

Genome = G.Genome

# ═══════════════════════════════════════════════════════════════════════
# NSGA-II-lite: dominance, fast non-dominated sort, crowding distance.
# ~100 lines, on purpose — this is the one piece of machinery the whole
# pilot exists to prove works, so it stays small enough to read in one pass.
# ═══════════════════════════════════════════════════════════════════════


def dominates(a: FitnessResult, b: FitnessResult) -> bool:
    """``a`` Pareto-dominates ``b``: at least as good on both objectives
    (maximize resolve_rate, minimize cost_usd), strictly better on one."""
    at_least_as_good = a.resolve_rate >= b.resolve_rate and a.cost_usd <= b.cost_usd
    strictly_better = a.resolve_rate > b.resolve_rate or a.cost_usd < b.cost_usd
    return at_least_as_good and strictly_better


def fast_nondominated_sort(fits: list[FitnessResult]) -> list[list[int]]:
    """Standard NSGA-II fast non-dominated sort. Returns fronts as lists of
    indices into ``fits``, front 0 first (the current Pareto front)."""
    n = len(fits)
    dominates_set: list[set[int]] = [set() for _ in range(n)]
    domination_count = [0] * n
    fronts: list[list[int]] = [[]]
    for p in range(n):
        for q in range(n):
            if p == q:
                continue
            if dominates(fits[p], fits[q]):
                dominates_set[p].add(q)
            elif dominates(fits[q], fits[p]):
                domination_count[p] += 1
        if domination_count[p] == 0:
            fronts[0].append(p)
    i = 0
    while fronts[i]:
        next_front = []
        for p in fronts[i]:
            for q in dominates_set[p]:
                domination_count[q] -= 1
                if domination_count[q] == 0:
                    next_front.append(q)
        i += 1
        fronts.append(next_front)
    fronts.pop()  # the final appended front is always empty
    return fronts


def crowding_distance(front: list[int], fits: list[FitnessResult]) -> dict[int, float]:
    """NSGA-II crowding distance within one front, over both objectives.
    Boundary points get ``inf`` so they are never crowded out."""
    dist = {i: 0.0 for i in front}
    if len(front) <= 2:
        return {i: float("inf") for i in front}
    for attr in ("resolve_rate", "cost_usd"):
        ordered = sorted(front, key=lambda i: getattr(fits[i], attr))
        dist[ordered[0]] = float("inf")
        dist[ordered[-1]] = float("inf")
        lo = getattr(fits[ordered[0]], attr)
        hi = getattr(fits[ordered[-1]], attr)
        span = hi - lo
        if span == 0:
            continue
        for j in range(1, len(ordered) - 1):
            prev_v = getattr(fits[ordered[j - 1]], attr)
            next_v = getattr(fits[ordered[j + 1]], attr)
            if dist[ordered[j]] != float("inf"):
                dist[ordered[j]] += (next_v - prev_v) / span
    return dist


def _ranks_from_fronts(fronts: list[list[int]], n: int) -> list[int]:
    ranks = [0] * n
    for rank, front in enumerate(fronts):
        for i in front:
            ranks[i] = rank
    return ranks


def tournament_select(pop_size: int, ranks: list[int], crowd: dict[int, float], rng: random.Random, size: int = 2) -> int:
    chosen = rng.sample(range(pop_size), min(size, pop_size))
    best = chosen[0]
    for c in chosen[1:]:
        if ranks[c] < ranks[best] or (ranks[c] == ranks[best] and crowd[c] > crowd[best]):
            best = c
    return best


def select_parent(
    parent_selection: str, pop_size: int, ranks: list[int], crowd: dict[int, float], rng: random.Random
) -> int:
    """``"tournament"`` -> `tournament_select`; ``"random"`` -> uniform over
    the population, ignoring rank/crowding entirely. See `run_evolution`'s
    `parent_selection` docstring for what this ablates."""
    if parent_selection == "random":
        return rng.randrange(pop_size)
    return tournament_select(pop_size, ranks, crowd, rng)


def front_hypervolume(fits: list[FitnessResult], cost_ref: float) -> float:
    """2D hypervolume of a (sub)front w.r.t. the reference point
    (resolve_rate=0, cost_usd=cost_ref), i.e. the dominated-area proxy the
    convergence test uses. Robust to duplicate/dominated points in ``fits``
    (a proper sweep, not an assumption that the input is already a clean
    front) — see the derivation in the module docstring of the test file.
    """
    pts = sorted({(f.resolve_rate, max(0.0, cost_ref - f.cost_usd)) for f in fits}, key=lambda t: -t[0])
    hv = 0.0
    running_max = 0.0
    prev_q: float | None = None
    for q, spare in pts:
        if prev_q is not None:
            hv += (prev_q - q) * running_max
        running_max = max(running_max, spare)
        prev_q = q
    if prev_q is not None:
        hv += prev_q * running_max
    return hv


# ═══════════════════════════════════════════════════════════════════════
# The reflective-mutation hook — rule-based, keyed on E5.5's taxonomy and
# E5.6's cost-concentrates-on-failures finding. No LLM calls.
#
# HONEST OUTCOME, not the original design: this hook originally BIASED
# mutation on two conditions (below). Review found the retrieval-bias
# branch never fired at all (a strict-plurality vote over ALL 12 tasks let
# two floor tasks -- which fail for every genome -- and the four
# non-retrieval discriminating tasks' failures outnumber or tie the
# retrieval-attributable ones every time). Fixed the vote (floor tasks
# excluded, "any wrong_place present" rather than "plurality"; the branch
# then fires on ~37% of `retrieval_prepass=False` evaluations, versus 0%
# before) and re-measured with a 5-seed ablation (reflective ON vs OFF,
# same seed/population/generations otherwise, `n_covered` = planted-front
# points dominated). Across three population/generation configurations the
# mean effect was -0.4, -0.8, and -2.0 points with the SIGN flipping
# seed-to-seed -- noise, not a real effect, even once the branch actually
# fires as intended. The cost-concentration branch measured the same
# (-0.4 mean, isolated from the retrieval branch). Per the fix-it-or-cut-it
# call: BOTH branches are removed below rather than kept making an implicit
# "this helps" claim the data doesn't support. `reflective_mutate` is now
# identical to `mutate` -- kept as a distinct, named, ablatable function
# (rather than folded away) so `reflective=True`/`False` stays a clearly
# labeled configuration for anyone who wants to re-run this measurement on
# a different landscape, where a real effect might exist.
# ═══════════════════════════════════════════════════════════════════════


def reflective_mutate(genome: Genome, fitness: FitnessResult, rng: random.Random) -> Genome:
    """Equivalent to `mutate` -- see the module comment above for why the
    taxonomy-biased branches this function used to have were measured,
    found to have no real effect, and removed rather than kept unproven."""
    return G.mutate(genome, rng)


# ═══════════════════════════════════════════════════════════════════════
# The evolution loop: racing, budgets, k-eval, NSGA-II survivor selection.
# ═══════════════════════════════════════════════════════════════════════


@dataclasses.dataclass
class GenerationRecord:
    generation: int
    population: list[tuple[Genome, FitnessResult]]
    front: list[tuple[Genome, FitnessResult]]  # rank-0 of `population`
    archive_front: list[tuple[Genome, FitnessResult]]  # rank-0 of every genome ever fully evaluated
    evals_spent_cumulative: int


@dataclasses.dataclass
class _ArchiveEntry:
    genome: Genome
    observations: list[FitnessResult]  # every full evaluation this genome has ever received

    @property
    def fitness(self) -> FitnessResult:
        """The RUNNING AVERAGE over every observation, not the latest one.

        A single k-eval draw at only 12 (mock) tasks is coarse — 8
        discriminating tasks means resolve_rate is quantized in 1/12 steps,
        and a genome that happens to solve an unlucky-good majority of them
        once is not rare (a ~55%-true-quality builder clears all 8 with
        several-percent probability). An archive that FROZE that single
        lucky sample forever would let one outlier block every real
        improvement permanently — measured while building this pilot: the
        very bug this averaging fixes collapsed a 40-generation run's
        archive to one Kimi-solo genome that had drawn an 8/8 fluke in
        generation 1 and was never challenged again. Averaging means a
        genome has to earn its spot on repeated visits, exactly the "n=8 is
        out of resolution" lesson EXPERIMENTS.md already drew from the real
        instrument, reproduced here as a mechanism instead of a warning.
        """
        n = len(self.observations)
        return FitnessResult(
            resolve_rate=sum(o.resolve_rate for o in self.observations) / n,
            cost_usd=sum(o.cost_usd for o in self.observations) / n,
            per_task=self.observations[-1].per_task,
            evals_spent=0,  # already counted when each observation was spent
            covered_tasks=self.observations[-1].covered_tasks,
            total_tasks=self.observations[-1].total_tasks,
        )


def _update_archive(
    archive: dict[tuple[Any, ...], _ArchiveEntry],
    new_items: list[tuple[Genome, FitnessResult]],
) -> dict[tuple[Any, ...], _ArchiveEntry]:
    """An elitist external archive (SPEA2-style), re-derived every call from
    (archive so far) union (this generation's fully-evaluated offspring),
    kept to its own non-dominated front (ranked on each entry's RUNNING
    AVERAGE fitness — see ``_ArchiveEntry.fitness``).

    WHY an archive on top of the population, not just the population's own
    front: NSGA-II's crowding-distance truncation preserves diversity within
    the CURRENT population, but a genome discarded when the population moved
    on is gone for good — a rare, hard-won extreme trade-off (e.g. the
    priciest, highest-quality builder) found once by a lucky mutation, then
    out-competed the very next generation by cheaper neighbors, would
    otherwise vanish before anyone reads the final report. The archive is
    the pilot's actual "what did the search ever find" answer; the
    per-generation population front is the diagnostic view of what current
    selection pressure favors.
    """
    for g, f in new_items:
        entry = archive.get(g.key())
        if entry is None:
            entry = _ArchiveEntry(genome=g, observations=[])
            archive[g.key()] = entry
        entry.observations.append(f)
    items = list(archive.items())
    fits = [entry.fitness for _, entry in items]
    fronts = fast_nondominated_sort(fits)
    keep = {items[i][0] for i in fronts[0]}
    return {k: v for k, v in archive.items() if k in keep}


@dataclasses.dataclass
class History:
    records: list[GenerationRecord]
    evals_spent_total: int
    budget_evals: int | None
    stopped_on_budget: bool


def history_hash(history: History) -> str:
    """A stable digest of the whole run: same seed -> identical hash.
    Rounds floats to avoid platform-level float-repr noise; everything fed
    in is otherwise plain, JSON-serializable data."""
    payload = []
    for rec in history.records:
        pop_repr = sorted(
            (
                json.dumps(
                    {
                        "genome": g.as_dict(),
                        "resolve_rate": round(f.resolve_rate, 9),
                        "cost_usd": round(f.cost_usd, 9),
                    },
                    sort_keys=True,
                    default=str,
                )
                for g, f in rec.population
            )
        )
        payload.append({"generation": rec.generation, "population": pop_repr})
    blob = json.dumps(payload, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()


def _front_of(population: list[tuple[Genome, FitnessResult]]) -> list[tuple[Genome, FitnessResult]]:
    fits = [f for _, f in population]
    fronts = fast_nondominated_sort(fits)
    return [population[i] for i in fronts[0]]


def run_evolution(
    backend: MockBackend,
    *,
    seed: int,
    population_size: int,
    generations: int,
    k: int = 1,
    task_ids: tuple[str, ...] = MOCK_TASK_IDS,
    screening_task_ids: tuple[str, ...] = SCREENING_TASK_IDS,
    budget_evals: int | None = None,
    racing: bool = True,
    mode: str = "nsga2",
    reflective: bool = True,
    crossover_rate: float = 0.3,
    immigration_rate: float = 0.15,
    parent_selection: str = "tournament",
) -> History:
    """Run the GA. ``mode="random_walk"`` is the control baseline: same eval
    budget, offspring chosen by mutating a uniformly-random parent, survivor
    selection is "keep the newest population_size individuals" rather than
    Pareto rank+crowding — no selection pressure anywhere.

    ``parent_selection`` (``mode="nsga2"`` only): ``"tournament"`` (default)
    picks parents via rank+crowding tournament; ``"random"`` picks parents
    UNIFORMLY at random from the current population instead, while leaving
    everything else about nsga2 mode intact -- racing, the reflective flag,
    crossover, immigration, and, crucially, the elitist Pareto-rank+crowding
    SURVIVOR truncation each generation. This isolates one question: given
    that elitist truncation already decides who SURVIVES, does WHO
    REPRODUCES (rank-biased vs uniform-random) add anything on top? See
    the control test in ``tests/test_gepa_pilot.py`` for the measured
    answer on this landscape -- the docstring there states it honestly
    either way, not the answer this docstring might suggest.

    ``immigration_rate`` (nsga2 mode only): the fraction of each generation's
    offspring that are FRESH uniform-random genomes instead of a
    mutation/crossover of the current population — the standard "random
    immigrants" diversity hedge (Grefenstette 1992) against premature
    convergence. Kept at a small default as a hedge, NOT because it has been
    shown to help on this landscape: a 5-seed ablation (imm=0 vs imm=0.15,
    same seed/population/generations otherwise) measured a difference of
    +-0.001 hypervolume with the SIGN flipping across seeds — noise, not a
    real effect, at these settings. An earlier draft of this file claimed
    immigration was "measured necessary" for reaching the landscape's best
    trade-offs; that claim did not survive an actual ablation and is
    withdrawn here rather than repeated.
    """
    if mode not in ("nsga2", "random_walk"):
        raise ValueError(f"unknown mode {mode!r}")
    if parent_selection not in ("tournament", "random"):
        raise ValueError(f"unknown parent_selection {parent_selection!r}")

    # `MockBackend`'s own cost per call: `len(task_ids) * k` when stochastic,
    # `len(task_ids)` (k ignored) in `deterministic=True` mode. Predicting it
    # exactly -- rather than checking `spent >= budget_evals` only AFTER a
    # call already landed -- is what makes "never exceed the budget" true
    # for every call site, not just the ones that happen to line up with a
    # generation boundary. Computed BEFORE the entry guard below: an earlier
    # version of this guard used `population_size * len(task_ids) * k`
    # unconditionally, which over-counted (and so sometimes wrongly
    # REJECTED a workable budget) in deterministic mode, where the real
    # cost does not scale with `k` at all.
    is_deterministic = getattr(backend, "deterministic", False)

    def _eval_cost(n_tasks: int) -> int:
        return n_tasks if is_deterministic else n_tasks * k

    # A budget that cannot even pay for evaluating the initial population
    # once is not a budget the loop can respect -- there is no smaller unit
    # of work than "look at generation 0". Failing loudly at entry, rather
    # than silently overshooting mid-seed, is the fix for a real bug found
    # by review: `budget_evals=10` with a population of 8 used to spend 96
    # evals before the first `over_budget()` check ever ran.
    initial_population_cost = population_size * _eval_cost(len(task_ids))
    if budget_evals is not None and budget_evals < initial_population_cost:
        raise ValueError(
            f"budget_evals={budget_evals} cannot pay for the initial population "
            f"({population_size} genomes x {len(task_ids)} tasks"
            f"{'' if is_deterministic else f' x k={k}'} = {initial_population_cost} evals). "
            "Shrink population_size or k, or raise budget_evals."
        )

    rng = random.Random(seed)
    spent = 0
    stopped_on_budget = False
    screen_cache: dict[tuple[Any, ...], FitnessResult] = {}

    def _fits_budget(additional: int) -> bool:
        return budget_evals is None or spent + additional <= budget_evals

    def full_eval(g: Genome) -> FitnessResult | None:
        """`None` means the budget will not cover this call -- it is NOT
        performed, so `spent` never moves and never overshoots."""
        nonlocal spent
        if not _fits_budget(_eval_cost(len(task_ids))):
            return None
        res = backend.evaluate(g, task_ids, k, rng)
        spent += res.evals_spent
        return res

    def screen_eval(g: Genome) -> FitnessResult | None:
        nonlocal spent
        key = g.key()
        if key in screen_cache:
            return screen_cache[key]
        if not _fits_budget(_eval_cost(len(screening_task_ids))):
            return None
        res = backend.evaluate(g, screening_task_ids, k, rng)
        spent += res.evals_spent
        screen_cache[key] = res
        return res

    # Checked before EACH seed genome, not just once before the loop entry:
    # this is the exact bug review found (`budget_evals=10` with population 8
    # used to spend 96 evals before any check ran) closed at its root, not
    # just guarded against at entry -- the entry guard above makes a
    # mid-seed stop unreachable for THIS backend's cost model, but the loop
    # no longer depends on that being true to stay correct.
    pop: list[Genome] = []
    pop_fit: list[FitnessResult] = []
    for g in G.seed_population(population_size, rng):
        fit = full_eval(g)
        if fit is None:
            stopped_on_budget = True
            break
        pop.append(g)
        pop_fit.append(fit)

    archive: dict[tuple[Any, ...], _ArchiveEntry] = {}
    archive = _update_archive(archive, list(zip(pop, pop_fit, strict=True)))

    records: list[GenerationRecord] = []

    def snapshot(gen: int) -> None:
        population = list(zip(pop, pop_fit, strict=True))
        records.append(
            GenerationRecord(
                generation=gen,
                population=population,
                front=_front_of(population),
                archive_front=[(e.genome, e.fitness) for e in archive.values()],
                evals_spent_cumulative=spent,
            )
        )

    snapshot(0)

    def over_budget() -> bool:
        """A cheap short-circuit for "definitely nothing left" -- the exact
        per-call guard lives in `full_eval`/`screen_eval` above; this just
        avoids spinning through RNG draws once there is provably no room."""
        return budget_evals is not None and spent >= budget_evals

    for gen in range(1, generations + 1):
        if over_budget():
            stopped_on_budget = True
            break

        fronts = fast_nondominated_sort(pop_fit)
        ranks = _ranks_from_fronts(fronts, len(pop))
        crowd: dict[int, float] = {}
        for f in fronts:
            crowd.update(crowding_distance(f, pop_fit))
        # `screen_eval` returns `None` when the budget won't cover it (a
        # cache hit is always free and always included); a filtered-out
        # entry here can only make the racing comparison LESS aggressive
        # (fewer things to be dominated by), never spend anything.
        #
        # GUARDED ON `racing`: this used to run unconditionally, which
        # billed the `racing=False` ("full") baseline for screening evals it
        # never reads (nothing downstream consults `screen_archive` unless
        # `racing` is True) -- a real accounting bug found by review that
        # inflated "full"'s eval count and understated racing's savings.
        screen_archive = [sf for g in pop if (sf := screen_eval(g)) is not None] if racing else []

        # A FIXED number of proposals per generation (population_size), not
        # "keep trying until population_size are ACCEPTED": that distinction
        # is the whole reason racing can save a budget. If racing instead
        # topped the population back up to a full population_size of newly
        # promoted offspring every generation, it would need to fully
        # evaluate exactly as many candidates as no-racing does — cheap
        # rejections would only ever be pure overhead on top, never a
        # saving. With a fixed proposal budget, a generation where racing
        # rejects half its proposals fully-evaluates half as many candidates
        # as no-racing would for the same proposal count; the survivors that
        # would have been "topped up" instead carry over from the existing
        # population via the elitist truncation below.
        offspring: list[Genome] = []
        offspring_fit: list[FitnessResult] = []
        for _ in range(population_size):
            if over_budget():
                stopped_on_budget = True
                break

            if mode == "random_walk":
                i = rng.randrange(len(pop))
                if rng.random() < crossover_rate:
                    j = rng.randrange(len(pop))
                    child = G.crossover(pop[i], pop[j], rng)
                else:
                    child = G.mutate(pop[i], rng)
                fit = full_eval(child)
                if fit is None:
                    stopped_on_budget = True
                    break
                offspring.append(child)
                offspring_fit.append(fit)
                continue

            if rng.random() < immigration_rate:
                child = G.random_genome(rng)  # random immigrant, bypasses parent selection entirely
            else:
                i = select_parent(parent_selection, len(pop), ranks, crowd, rng)
                if rng.random() < crossover_rate:
                    j = select_parent(parent_selection, len(pop), ranks, crowd, rng)
                    child = G.crossover(pop[i], pop[j], rng)
                elif reflective:
                    child = reflective_mutate(pop[i], pop_fit[i], rng)
                else:
                    child = G.mutate(pop[i], rng)

            if racing:
                s_fit = screen_eval(child)
                if s_fit is None:
                    stopped_on_budget = True
                    break
                if any(dominates(existing, s_fit) for existing in screen_archive):
                    continue  # rejected cheaply: no full-set eval spent

            fit = full_eval(child)
            if fit is None:
                stopped_on_budget = True
                break
            offspring.append(child)
            offspring_fit.append(fit)

        # Whatever partial `offspring`/`offspring_fit` accumulated before a
        # `stopped_on_budget` break above is still real, fully-paid-for
        # evidence -- it is folded into the population/archive below exactly
        # like a normal generation, then the outer loop's own `break`
        # (this function's tail) stops after recording the snapshot.
        if mode == "random_walk":
            combined = pop + offspring
            combined_fit = pop_fit + offspring_fit
            # no selection pressure: keep the most recently produced individuals
            pop = combined[-population_size:]
            pop_fit = combined_fit[-population_size:]
        else:
            combined = pop + offspring
            combined_fit = pop_fit + offspring_fit
            combined_fronts = fast_nondominated_sort(combined_fit)
            keep: list[int] = []
            for fr in combined_fronts:
                if len(keep) + len(fr) <= population_size:
                    keep.extend(fr)
                else:
                    cd = crowding_distance(fr, combined_fit)
                    keep.extend(sorted(fr, key=lambda i: -cd[i])[: population_size - len(keep)])
                if len(keep) >= population_size:
                    break
            pop = [combined[i] for i in keep]
            pop_fit = [combined_fit[i] for i in keep]

        # The archive is updated identically regardless of `mode`: it only
        # SUMMARIZES what was ever fully evaluated, it does not feed back
        # into who reproduces, so applying it to the random-walk control too
        # keeps the eventual evolution-vs-drift comparison apples-to-apples
        # (both get elitist reporting; only one gets selection pressure).
        archive = _update_archive(archive, list(zip(offspring, offspring_fit, strict=True)))
        snapshot(gen)
        if stopped_on_budget:
            break

    return History(
        records=records,
        evals_spent_total=spent,
        budget_evals=budget_evals,
        stopped_on_budget=stopped_on_budget,
    )


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════


def _fmt_genome(g: Genome) -> str:
    return (
        f"builder={g.builder_model.split('/')[-1]:<28} "
        f"reviewer={(g.reviewer_model or '-').split('/')[-1]:<20} "
        f"rev={g.revision_loops} jf={g.json_fix_attempts} "
        f"retr={'Y' if g.retrieval_prepass else 'n'} "
        f"ctx={g.context_cap_tokens or 'None'}"
    )


def _run_mock_demo(args: argparse.Namespace) -> None:
    backend = MockBackend(agg_rule=args.agg)
    history = run_evolution(
        backend,
        seed=args.seed,
        population_size=args.population,
        generations=args.generations,
        k=args.k,
        budget_evals=args.budget_evals,
        racing=not args.no_racing,
        reflective=not args.no_reflective,
    )
    # The SAME reference convention the tests use (`fitness.planted_cost_ref`),
    # not an ad hoc one derived from just this run's own archive -- a prior
    # version computed `max(observed costs) * 1.5 or 1.0`, which both moved
    # the reference (and thus every hv number) with whatever this particular
    # run happened to explore, and carried a dead `or 1.0` fallback that
    # could only ever fire if every observed cost were exactly 0.0.
    cost_ref = F.planted_cost_ref()

    print(f"GEPA mock demo — seed={args.seed} population={args.population} generations={args.generations} "
          f"k={args.k} racing={not args.no_racing} agg={args.agg}")
    print("(archive = elitist, non-dominated over every genome ever fully evaluated -- see "
          "`_update_archive`'s docstring for why this, not the live population, is the pilot's headline front)")
    print(f"{'gen':>3} {'arch_n':>6} {'best_q':>7} {'min_$':>7} {'hv':>8} {'evals':>8}  best-quality genome in archive")
    for rec in history.records:
        arch_fits = [f for _, f in rec.archive_front]
        best = max(rec.archive_front, key=lambda gf: gf[1].resolve_rate)
        hv = front_hypervolume(arch_fits, cost_ref)
        print(
            f"{rec.generation:>3} {len(rec.archive_front):>6} {best[1].resolve_rate:>7.3f} "
            f"{min(f.cost_usd for f in arch_fits):>7.3f} {hv:>8.4f} {rec.evals_spent_cumulative:>8}  "
            f"{_fmt_genome(best[0])}"
        )

    final = history.records[-1]
    print(f"\nfinal archive front ({len(final.archive_front)} genomes):")
    for g, f in sorted(final.archive_front, key=lambda gf: -gf[1].resolve_rate):
        print(f"  q={f.resolve_rate:.3f} $={f.cost_usd:.3f}  {_fmt_genome(g)}")
    print(f"\nevals_spent_total={history.evals_spent_total} "
          f"budget={history.budget_evals} stopped_on_budget={history.stopped_on_budget}")
    print(f"history_hash={history_hash(history)}")


def _run_replay_demo(args: argparse.Namespace) -> None:
    print("GEPA replay demo — genomes mapped onto recorded benchmarks.db arms")
    print(
        "(E5 and the Sail A/B ran on different engine commits and are NOT comparable -- "
        "PRE-REGISTRATION-SAIL-AB.md:74,:108. Every row below is labeled by campaign; "
        "ReplayBackend refuses to pick one for you when a genome has both.)"
    )
    print(f"{'campaign':<9} {'arm':<18} {'covered':>7} {'/':1}{'total':<5} {'resolve_rate':>12} {'cost_usd':>10}  genome")

    # Flatten (genome coordinate, campaign, arm) -- one row per REAL recorded
    # arm, never one row per genome coordinate (a coordinate can have two).
    for (builder, reviewer), by_campaign in F._ARM_BY_BUILDER_REVIEWER.items():
        g = Genome(
            builder_model=builder,
            reviewer_model=reviewer,
            revision_loops=2,
            json_fix_attempts=2,
            retrieval_prepass=False,
            context_cap_tokens=None,
        )
        for campaign, arm in sorted(by_campaign.items()):
            backend = ReplayBackend(campaign=campaign)
            result = backend.evaluate(g, REPLAY_TASK_IDS, k=1)
            if result is None or result.covered_tasks == 0:
                print(f"{campaign:<9} {arm:<18} {'0':>7} /{len(REPLAY_TASK_IDS):<5} {'—':>12} {'—':>10}  {_fmt_genome(g)}")
                continue
            print(
                f"{campaign:<9} {arm:<18} {result.covered_tasks:>7} /{result.total_tasks:<5} "
                f"{result.resolve_rate:>12.3f} {result.cost_usd:>10.4f}  {_fmt_genome(g)}"
            )

    # The one coordinate with two campaigns: calling evaluate() on a
    # campaign-less backend must refuse to guess, not silently pick one.
    ambiguous = Genome("azure/DeepSeek-V4-Flash", None, 2, 2, False, None)
    try:
        ReplayBackend().evaluate(ambiguous, REPLAY_TASK_IDS, k=1)
        print("\nERROR: ambiguous genome did not raise -- this is a bug")
    except F.AmbiguousCampaignError as exc:
        print(f"\nambiguous genome ({_fmt_genome(ambiguous)}) with no campaign chosen -> raised AmbiguousCampaignError:")
        print(f"  {exc}")

    # An unmapped genome, to demonstrate honest partial coverage.
    unmapped = Genome(
        builder_model="azure/DeepSeek-V4-Flash",
        reviewer_model=None,
        revision_loops=1,  # not the measured default (2) -> no recorded row
        json_fix_attempts=2,
        retrieval_prepass=False,
        context_cap_tokens=None,
    )
    result = ReplayBackend(campaign=F.CAMPAIGN_E5).evaluate(unmapped, REPLAY_TASK_IDS, k=1)
    print(f"\nunmapped genome ({_fmt_genome(unmapped)}) -> {result!r}")
    assert result is None, "an unmapped genome must return None, never a fabricated number"
    print("(unmapped genome correctly returned None -- no arm has ever run revision_loops=1)")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--backend", choices=["mock", "replay"], default="mock")
    p.add_argument("--generations", type=int, default=12)
    p.add_argument("--population", type=int, default=12)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--k", type=int, default=1)
    p.add_argument("--agg", choices=["majority", "any"], default="majority")
    p.add_argument("--budget-evals", type=int, default=None)
    p.add_argument("--no-racing", action="store_true")
    p.add_argument("--no-reflective", action="store_true")
    args = p.parse_args(argv)

    if args.backend == "mock":
        _run_mock_demo(args)
    else:
        _run_replay_demo(args)


if __name__ == "__main__":
    main()
