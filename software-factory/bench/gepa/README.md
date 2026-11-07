# GEPA pilot — Genetic-Pareto pipeline evolution

A PILOT. **It proves the evolutionary search machinery works — Pareto
ranking, selection, mutation, racing, budgets, k-eval aggregation — on a
controlled, zero-cost landscape.** It does **not** prove anything about the
real fitness landscape (which pipeline actually solves more SWE-bench
instances for less money): that needs a real instrument, and this pilot
makes zero paid model calls anywhere. See "the declared path to live" below
for what stands between this pilot and a real evolution campaign.

## Zero paid model calls, structurally enforced

- `mock` (`fitness.py`) is a synthetic landscape — arithmetic over declared
  constants, no I/O.
- `replay` reads real, already-recorded rows out of
  `bench/swebench/benchmarks.db` (sqlite, read-only). It never runs a model.
- `live` is `NotImplementedError` naming the three constraints below. There
  is no `import http` / `urllib` / `requests` / `socket` anywhere under this
  directory — `tests/test_gepa_pilot.py::test_no_network_imports_anywhere_under_gepa`
  scans every module's source text for that, so the check survives even if a
  future edit forgets to call the stub.

## The three Sail constraints this pilot inherits

From [`bench/swebench/frozen/RESULTS-SAIL-AB.md`](../swebench/frozen/RESULTS-SAIL-AB.md)'s
DECISION section (Sail is ADOPTED as the evolution-campaign substrate, with
three binding constraints):

1. **k ≥ 2 fitness evals on Sail-served Flash, or noise-tolerant selection.**
   R3(a): two of four evaluable k=2 discriminating-cell pairs flipped —
   Sail's serving is not unanimous on marginal cells the way Azure's was.
   Modeled here as `fitness.SAIL_CORRUPTION_RATE` (see "the k=2 tie-bias
   finding" below for a real nuance this pilot found while calibrating it).
2. **~20% starvation-retry overhead on long rows; no fan-out beyond width 2
   without a new probe.** R4: four genuine provider-starved events, all on
   long/heavy instances. Modeled here as `fitness.STARVATION_RETRY_RATE`
   (cost-only — it doesn't touch the solve draw, because the real incidents
   were transport failures, not capability signal).
3. **Computed dollars are an UPPER BOUND.** R6/R2: Sail's streaming usage
   omits cached-token detail, so computed cost overstates; billed ran ≈34%
   of computed on cache-warm work at the campaign's close. Modeled here as
   the Sail builder's lower planted `_BUILDER_COST` relative to the
   identical-quality Azure-served model.

A live implementation additionally needs its own pre-registration (the
`frozen/PRE-REGISTRATION-*.md` pattern this repo already uses) before any
model call — `fitness.LiveBackend.evaluate` names all four requirements in
its `NotImplementedError` message.

## The genome (`genome.py`)

A pipeline configuration over a DECLARED, finite search space (every value
listed in `genome.py`, nowhere else):

| knob | space | why it's in the space |
|---|---|---|
| `builder_model` | 4 ids (Azure Flash, Sail Flash, Kimi, DeepSeek-V3.2) | which model writes the patch |
| `reviewer_model` | `None`, gpt-5.4, Kimi, or the builder's own model (self-review) | E5b's reviewer ladder, including E5b.1's self-review null result |
| `revision_loops` | 0–3 | E5.6: cost concentrates on failures through the revise loop |
| `json_fix_attempts` | 0–3 | the engine's other retry bound (`_SSSF_LIMITS` in `swebench_adapter.py`) |
| `retrieval_prepass` | bool | E5.5's `wrong_place` failure mode (7/21 unresolved cells never located the code) |
| `context_cap_tokens` | `None`, 100k, 300k, 1M | E5.7: input tokens spanned 170x across arms; re-sent context was the bill |

`genome.validate` is the one gate: every mutation, crossover, and
replay-mapped genome passes through it, and an out-of-space value is a
raised `InvalidGenomeError`, never silently clamped.

## Fitness backends (`fitness.py`)

One interface: `evaluate(genome, task_ids, k, rng) -> FitnessResult(resolve_rate, cost_usd, per_task, evals_spent, covered_tasks, total_tasks)`.

- **`mock`** — a synthetic landscape with a fully documented planted
  structure (quality/cost constants at the top of `fitness.py`, each
  annotated with the E5/E5b/R-finding it stands in for): 12 tasks (2 floor —
  nobody solves, like `alibaba__opensandbox-816`; 2 ceiling — everybody
  solves, like `hkuds__openharness-217`; 8 discriminating), a reviewer
  ladder with diminishing returns and a zero-gain self-review cell, a
  revision loop that helps once and then only adds cost, a retrieval bonus
  scoped to the tasks that need it, and a context-cap tradeoff scoped to
  long tasks. `MockBackend(deterministic=True)` additionally exposes the
  planted structure's exact mean (no Bernoulli sampling) — see "the
  deterministic mode" below for why the pilot's tests use it for the
  convergence claim specifically.

  Two disclosed simplifications, found by review, kept rather than hidden:
  * The mock's builder cost RATIOS are compressed roughly 4x versus the
    store's real ones (Kimi/Flash: store 7.3x, mock 1.9x; V3.2/Flash: store
    23.6x, mock 5.6x — both ≈4.2x compression). A pilot testing search
    machinery needs a searchable landscape at a scale that finishes in
    milliseconds, not the store's actual dollar spread.
  * The mock plants `DeepSeek-V3.2` (quality 0.58) strictly ABOVE
    `Kimi-K2.7-Code` (0.52); the real store has them TIED at 6/8 resolved
    each (E5's headline table). A genuine tie would collapse two of the
    four builder options into one indistinguishable point, which is less
    useful for a pilot whose job is to demonstrate a search finding
    trade-offs, not to reproduce E5's exact ranking.
  * The task mix is 8/12 = 67% discriminating; the real 8-instance E5 set
    is 4/8 = 50% (2 floor, 2 ceiling, 4 discriminating). The mock's ratio
    was chosen for a richer search surface, not fit to the instrument.

  None of these change what the mock is FOR (testing search machinery
  against known ground truth) — they mean its specific numbers should never
  be read as a capability or cost forecast, only the store's own numbers
  (via `replay`) can be.

- **`replay`** — real rows from `benchmarks.db`. Two campaigns exist and are
  NOT interchangeable — E5 (`ai_docs/research/EXPERIMENTS.md`, 2026-08-14/15)
  and the Sail A/B (`frozen/RESULTS-SAIL-AB.md`, 2026-08-27/28) ran on
  different engine commits, and `PRE-REGISTRATION-SAIL-AB.md:74,:108` are
  explicit that mixing their rows into one comparison is wrong even though
  both are real measurements. `map_genome_to_arm(genome, campaign=...)` maps
  (builder, reviewer) pairs onto the 9 measured arms across both:

  | campaign | genome (builder / reviewer) | arm |
  |---|---|---|
  | `e5` | Azure Flash / — | `flash-solo` |
  | `e5` | Azure Flash / gpt-5.4 | `flash-chain` |
  | `e5` | Kimi / — | `kimi-solo` |
  | `e5` | Azure Flash / Kimi | `flash-kimichain` |
  | `e5` | Azure Flash / Azure Flash (self) | `flash-selfchain` |
  | `e5` | DeepSeek-V3.2 / — | `v32-solo` |
  | `e5` | DeepSeek-V3.2 / gpt-5.4 | `chain` (†) |
  | `sail-ab` | Azure Flash / — | `flash-solo-az-r2` (‡) |
  | `sail-ab` | Sail Flash / — | `flash-solo-sail` (§) |

  (†) `chain`'s real arm also runs a planner role the genome cannot
  express; the mapping collapses that into "not modeled" rather than "off"
  — documented in `fitness.py` next to `_ARM_BY_BUILDER_REVIEWER`, since
  `chain` is the only measured row at that cell today, the collapse costs
  nothing, but a future genome meaning "no planner" would collide with it.

  (‡) **One genome coordinate, TWO campaigns.** Azure Flash / no reviewer
  was measured in both E5 (`flash-solo`) and re-measured as the Sail A/B's
  engine-matched control (`flash-solo-az-r2`) — that pairing is the whole
  reason `flash-solo-az-r2` exists. `map_genome_to_arm` with no `campaign`
  given RAISES `AmbiguousCampaignError` for this one coordinate rather than
  picking one silently; `ReplayBackend(campaign="e5"|"sail-ab")` fixes it.
  The demo CLI (`--backend replay`) prints a `campaign` column and
  demonstrates the raise explicitly.

  (§) `flash-solo-sail`'s first-valid-by-`ran_at` rows for
  `alibaba__opensandbox-816` and `keras-team__keras-22316` inherit a
  provenance caveat straight from the frozen record: for exactly those two
  cells the paired-pass Sail attempt was missing/invalid, so the row this
  query selects is actually the SECOND-PASS attempt — RESULTS-SAIL-AB.md
  flags this itself as "mixes pass provenance... Not adjudicated here."
  The numbers are real and correctly re-derived by the same query the
  frozen doc used; the caveat is about which PASS they came from, carried
  here unadjudicated exactly as the source left it.

  The mapping only fires when every other knob equals what every recorded
  row actually ran under (`revision_loops=2, json_fix_attempts=2,
  retrieval_prepass=False, context_cap_tokens=None` — the engine's own
  defaults). Any other genome — including all of retrieval, context caps,
  and non-default loop counts, none of which the real engine has ever been
  run with a `--arm` sweep at — returns `None`. `k` is accepted for
  interface parity but not resampled: a stored row is one real measurement,
  not a distribution.

- **`live`** — `NotImplementedError` naming the three Sail constraints and
  the pre-registration requirement. No HTTP client anywhere in the module.

### The k=2 tie-bias finding

Calibrating the noise model surfaced a genuine, disclosed nuance: this
pilot's `aggregate_verdicts("majority", ...)` breaks ties toward failure
(declared, matching a cautious reading of a split verdict). That makes
**even k a conservative estimator, not a noise-reduced one** — k=2 needs
*both* draws to agree "solved", so on a genome whose true quality sits
comfortably above 0.5 it under-reports relative to k=1. Odd k (k=3) has no
tie to break and does what "more evaluations reduce noise" naively
promises. Both properties are measured and asserted in
`tests/test_gepa_pilot.py` rather than assumed — RESULTS-SAIL-AB's "k≥2"
recommendation is correct about needing repeat evals, but a real
implementation needs to also choose a tie-breaking convention deliberately
(odd k, or an `any`/quorum rule) rather than default to "majority of 2".

### The deterministic mode

`MockBackend(deterministic=True)` returns the literal mean of
`expected_quality`/`expected_cost` over the requested tasks — no Bernoulli
sampling, no Sail corruption, no starvation retry, `k` ignored. It exists so
the **convergence** test can check the search machinery (NSGA-II ranking,
mutation, crossover, racing, the reflective hook) in isolation from
evaluation noise; the dedicated **noise-robustness** tests then switch back
to the stochastic path. Discovered while building this: majority-of-k with
a *large* k is not "a cleaner reading of the same landscape" — it converges
per task to a hard threshold on which side of 0.5 the true probability
falls, which is a different landscape than the planted continuous mean, not
a less noisy sample of it. The deterministic mode is the correct fix, not
"just crank up k".

## The loop (`evolve.py`)

- **NSGA-II-lite** (`dominates`, `fast_nondominated_sort`,
  `crowding_distance` — about 100 lines total): standard fast non-dominated
  sort plus crowding-distance tiebreak, maximizing `resolve_rate` and
  minimizing `cost_usd`.
- **Selection + variation**: tournament on rank (crowding-distance
  tiebreak); mutation is a one-knob neighborhood move (adjacent index for
  ordinal knobs, any-other-value for categorical ones); crossover is
  uniform, per-knob; a small **random-immigrants** stream
  (`immigration_rate`) injects fresh uniform-random genomes every
  generation — a standard diversity hedge (Grefenstette 1992) against
  premature convergence, kept at a small default. Measured, not assumed: a
  5-seed ablation (imm=0 vs imm=0.15) found a ±0.001 hypervolume difference
  with the sign flipping across seeds — noise at these settings, not a
  demonstrated necessity. Kept as a hedge against a mechanism that plausibly
  matters on a harder landscape, not claimed as proven on this one.
- **Reflective mutation hook** (`reflective_mutate`) — **REMOVED after
  measurement, not shipped as originally designed.** It was built to bias
  mutation on two E5.5/E5.6-keyed conditions (dominant `wrong_place`
  failures -> flip `retrieval_prepass` on; cost concentrating on failures ->
  lower `revision_loops`). Review found the retrieval branch never fired at
  all in 40 generations (a strict-plurality vote over all 12 tasks let two
  floor tasks that fail for every genome, plus the four non-retrieval
  discriminating tasks' own failures, permanently outvote the four
  retrieval-attributable ones). Fixing the vote (exclude floor tasks; fire
  on "any `wrong_place` present", not plurality) raised the firing rate from
  0% to ~37% of `retrieval_prepass=False` evaluations — but a 5-seed
  ablation (reflective ON vs OFF, `n_covered` = planted-front points
  dominated) across three population/generation configurations measured a
  mean effect of **-0.4, -0.8, and -2.0** points, sign flipping seed to
  seed: noise, not a real effect, even with the branch firing correctly.
  The cost-concentration branch measured the same in isolation (-0.4 mean).
  Both branches are deleted; `reflective_mutate` is now identical to
  `mutate`, kept as a named, ablatable function rather than folded away.
  Plausible reading: immigration + crossover + the elitist archive already
  push this landscape's coverage close to a ceiling, leaving no headroom
  for an additional bias to show up in the aggregate outcome — a different,
  harder landscape might still show a real effect from this mechanism.
- **Elitist archive** (`_update_archive`): a SPEA2-style non-dominated
  archive over every genome ever fully evaluated, using each genome's
  RUNNING AVERAGE fitness across all its observations — not its latest
  noisy draw. Necessary fix, not a nicety: an archive that froze a single
  lucky k=5 sample forever collapsed a 40-generation run down to one
  genome that drew an 8-of-8 fluke in generation 1. This archive, not the
  live population, is the pilot's reported "final front".
- **Racing**: a fixed number of proposals per generation
  (`population_size`), each screened on `SCREENING_TASK_IDS` (a declared
  1/3 subset) before a full evaluation is spent on it — only genomes
  non-dominated against the current screening archive get the full-set
  eval. Measured: at equal generation count this spends ~35% fewer evals
  for a front within ~0.2% of full evaluation's hypervolume; it does *not*
  reliably beat full evaluation's front at *strictly less* total budget on
  this landscape (a small, disclosed trade — see the test for the exact
  numbers), so the claim here is "far cheaper for an equivalent front", not
  "strictly dominates at any budget".
- **Budget**: a hard `--budget-evals` cap; the loop always reports how much
  it spent and whether it stopped on the budget.
- **k-eval**: `majority` (default) or `any` aggregation, declared in
  `fitness.aggregate_verdicts`.
- **Deterministic**: one `random.Random(seed)` threaded through every call
  that needs randomness; nothing reads the wall clock.

## Running it

```bash
# the mock landscape: population, generations, seed, k are all yours
uv run python bench/gepa/evolve.py --backend mock --generations 12 --population 12 --seed 7 [--k 2]

# the recorded arms, read-only, $0
uv run python bench/gepa/evolve.py --backend replay

# the tests ARE the "does it evolve" deliverable
uv run pytest tests/test_gepa_pilot.py -v
```

## The declared path to live

1. **Pre-register** (the `frozen/PRE-REGISTRATION-*.md` pattern): fixed
   genome space, fixed task set, fixed budget cap, fixed decision rule —
   before any model call, same discipline as the Sail A/B.
2. **n ≥ 30 fetch with holdout.** EXPERIMENTS.md's own warning: "the
   instrument is out of resolution at n=8" — only 4 of 8 E5 instances
   discriminate at all. A live evolution campaign needs a wider, harder
   instance set with a held-out slice never used for search, or the search
   will overfit to eight (or fewer) coin flips.
3. **Replay-calibrate the mock.** Fit `fitness.py`'s planted constants
   against the n≥30 instrument's real numbers before trusting the mock's
   shape for anything beyond machinery testing — right now every constant
   in this file is a documented, reasoned *guess* keyed to a real finding,
   not a fit.
4. **Live pilot inside credits**, k≥2 (odd, or a declared tie rule), width
   ≤2, retry budget sized for ~20% starvation on long rows, dollars
   reconciled against billed at the campaign's close — exactly
   RESULTS-SAIL-AB's own posture, carried forward.
