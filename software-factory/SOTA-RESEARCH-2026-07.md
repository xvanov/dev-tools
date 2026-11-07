# SOTA research notes — software-factory vs. harness engineering, July 2026

> **What this is.** The external-research portion of a nine-agent audit run
> 2026-07-24 (four agents audited this repo's internals, five swept the
> external state of the art). The internal-defect findings and the
> point-in-time production numbers from that audit have been removed from
> this file — they were fixed the same day (PR #113) and are summarized in
> memory at
> `/home/k/.claude/projects/-home-k-software-factory/memory/sota_audit_2026_07_24.md`.
> What remains here is the durable part: literature citations and
> cross-system comparisons that inform future architecture decisions. Treat
> specific internal claims below (e.g. "we are ahead/behind on X") as
> directional, not current-state-verified — re-check the code before acting.

---

## The thesis, restated with external evidence

> **Reframed by operator decision 2026-08-07:** the operative claim is now *"buy
> throughput the subscription can't sell"* — success is tasks/day at an acceptable
> defect rate, not $/task. The section below predates that reframing; its evidence
> stands, its framing is one step behind.

Our claim: *harness quality beats model size; cheap models plus loops and backpressure
beat frontier models plus a thin harness, far cheaper.*

**Confirmed — harness variance exceeds model variance**, but on a narrower
evidence base than this section originally claimed. Corrected 2026-08-04: the
Claw-SWE-Bench citation could not be verified to exist, so the load-bearing
verified datapoint is the LangChain one, plus the leaderboard-derived spreads
below.

- LangChain held gpt-5.2-codex fixed and changed only prompts/tools/middleware:
  **52.8% → 66.5% on Terminal-Bench 2.0**, rank ~30 → top-5. **This is the one
  verified fixed-model harness-swap datapoint in this file.**
- ~~Claw-SWE-Bench (arXiv 2606.12344), 350 real issues, 43 repos, model held
  fixed, five harnesses swapped: pass@1 spread 12.5 pp on GLM 5.1, 27.4 pp on
  Qwen 3.6-flash; model spread with harness fixed 29.4 pp.~~ **DOWNGRADED
  2026-08-04 — the arXiv id could not be verified to resolve.** Do not cite it.
- Independent replacement evidence, computed from the SWE-bench Verified
  leaderboard's own `results.json` (2026-08-04): **fixed-model scaffold spread
  scales inversely with model strength** — `claude-opus-4-5` **2.4–4.8 pts** (a
  100-line bash-only agent lands within 2.4 of SOTA), `claude-sonnet-4` 11.9,
  GLM-4.6 12.8, `Qwen3-Coder-480B` **14.2**, Kimi-K2 family **~21.6**, and at the
  cheap end the minimal scaffold is the *loser*. Same conclusion — harness matters
  more the weaker the model — from a source we can re-derive.
- Cheap+good beats strong+generic, directly: Qwen 3.6-flash + OpenClaw **66.0% at
  ~$0.20/task** beats GLM 5.1 + GenericAgent **63.1% at ~$0.25**.

**Confirmed — repeated sampling against an executable verifier beats frontier
single-pass.** DeepSeek-Coder-V2 on SWE-bench Lite: 15.9% @1 sample → **56% @250**,
vs 43% single-sample SOTA, at under a third the price (arXiv 2407.21787). Scoped by
its own authors to domains where automatic verification exists.

**Not confirmed — "cheaper model ⇒ cheaper end to end."** This is where our framing
needs correcting. From the only end-to-end $/merged-PR study found (12 models × 3
harnesses, frozen repo, constant frontier review gate,
`blog.insight-services-apac.dev/2026/07/06/cost-to-a-merged-feature`):

> As the coder gets cheaper, its output needs more review, so the gate pays more to
> bring it up to the bar.

Coding cost fell **340×** from the most to least expensive coder; **total merge cost
fell only ~1.8×**. Cheapest merge was a *mid*-tier model at 1 cycle ($5.56), not the
near-free model at 4 cycles ($17.03). **Cycle count, not token price, is the cost
driver.** Corollaries with numbers:

- Augment's break-even: if cheap output needs correction >20% of the time, a 3× price
  advantage is gone.
- Retries are quadratic in context, not linear in steps: 1.7–1.9× tokens at 3 steps,
  2.2–2.5× at 5 (tianpan.co retry-budget analysis).
- Across 1,127 real agent runs ($4,281): **context re-reads were 52.1% of spend**;
  retries only 3.4%. Cheap models don't touch that. Prefix-stable caching does.
- The LLM review gate is **fidelity-neutral**: in the study above, one implementation
  passed frontier review while failing 20 unit tests.

**The defensible formulation is therefore: cheap generator + *deterministic* verifier +
hard convergence caps.** That is what this factory actually implements — the
authoritative gate is `pytest` re-run by the harness plus a live smoke boot, with the
LLM reviewer layered on top rather than load-bearing. We built it the right way round.
The README's "harness quality beats model size" should keep its headline but stop
implying the saving comes from the model tier; it comes from gate discipline and cycle
caps.

**Wall clock is the honest cost we underweight.** Our own campaign: 40 min vs 14 min
(3×). The field's figure: open-weight models merged at $18–$29 but took 69–176 min vs
Opus 26 min. At any nonzero engineer-attention cost, cheap-and-slow loses.

---

## Where we were ahead of published practice (as of 2026-07-24 — re-verify before citing)

**1. The runtime smoke gate.** Nothing merges on green unit tests alone; `smoke-green`
boots the PR's own code on an isolated port and drives the core journey. The 2026 canon
converges on exactly this ("a feature is done when it runs live") but few systems
implement it as a merge blocker. It has caught real green-but-unbootable output, which
is why it exists.

**Correction 2026-08-04.** This section used to justify the gate with "Claude Code
failed t3 and t5 by declaring done with its own new tests red". **That claim is
falsified** — the recovered CLI transcripts show t3 ending on three consecutive
`460 passed` runs and t5 on `446 passed`. See `bench/CAMPAIGN-2026-07-17.md`'s
superseded-by header. Keep the gate on its own merits; do not justify it with a
Claude failure that did not happen.

**2. Parallel-agent conflict handling.** A study of 33,596 agent PRs across 2,807 repos
found **79.4% opened concurrently with another agent PR**, replayed conflict rates of
19.8% intra-agent and **41.7% cross-agent**, with the authors noting agents "operate
independently and in isolation, without knowledge that other agents are simultaneously
altering the same files." We have per-story git worktrees, `freshen_behind_prs`,
conflict-rebuild-on-fresh-branch, and per-app docs serialization. We solved a problem
the field has documented and not fixed.

**3. Reviewer drift control.** `handlers.py` implements a *finality drift
clamp*: from cycle 3, blocking findings at file locations not raised in the previous
cycle are clamped to non-blocking unless flagged `regression`, with the deterministic
slop detector explicitly exempt. Convergence is measured by findings-signature
stability, not raw cycle count. No published multi-agent review system instruments
goalpost-drift this way. Keep it.

**4. Independence invariants in routing.** `routes.yaml` enforces reviewer ≠ dev model
and acceptance_author ≠ dev family, deliberately, with rationale in comments. The
field's finding that **93.4% of flagged locations are caught by exactly one tool** (146
PRs, four AI reviewers) supports heterogeneity — though it also implies a *single*
reviewer should be treated as a sensor, not a verdict, which we do not do.

**5. Anti-gaming fences invented independently.** `bench/**` and `factory/manager/**`
are on the forbidden-self-edit list. Weng's rule — keep "the runs directory, tracer,
verifier, and LLM configuration read-only" to the self-improving agent — is the same
insight. We got there first.

---

## Honest limits of this audit

- Throughput, revert and reliability figures from the 2026-07-24 pass were re-derived by
  a measurement agent and spot-verified by the author, but are now stale — see memory
  for current numbers before citing anything time-bound from that pass.
- Long-range systemd journal history for `factory-tick@sacrifice` rotates out;
  `ticks.ndjson` is the only durable record for that kind of retrospective.
- **External numbers above 80% on any SWE-bench-FAMILY corpus should be treated as
  contaminated or unverifiable** — narrowed 2026-08-04 from "any benchmark".
  OpenAI's 2026-07-08 audit found ~30% of SWE-bench Pro's public tasks broken and
  retracted its recommendation; Cursor found Pro scores collapse when agents lose
  internet and git history, with some agents retrieving gold patches; and Pro
  additionally leaks post-`base_commit` git objects reachable via `git log -p`.
  swebench.com's own leaderboards are JS-rendered and could not be fetched;
  verified figures come from aggregators or from papers reporting their own runs.
  **The rule does not generalize past that family.** Terminal-Bench 2.1 has Opus 5
  at **89.1%, container-verified**, and our own container-graded SWE-rebench row
  put `claude-opus-5` at 79% with a **clean contamination probe** (`claude-opus-4-8`,
  cutoff Jan 2026, scored 74% on the same harness, p=1.000). A high number on a
  corpus with a working oracle and a passed contamination control is a high number.
- **Fetched content is lower-confidence than fetched numbers.** Several research
  agents reported that their fetch pipeline silently substituted proper nouns —
  abstracts came back reading "software ENGINEERING" where the source says
  "software design". The mundane cause is this org's global `DESIGN → ENGINEERING`
  text-rewrite rule being applied to *retrieved* text and not only to authored
  prose. Consequence: **anything quoting a fetched benchmark or paper NAME is
  lower-confidence than anything quoting a NUMBER from the same fetch.** Sources
  here are cited by **URL and arXiv id**, never by rendered title, and any name
  taken from a fetch must be re-verified against the source before it is quoted
  outside this repo.
- Model names post-dating May 2026 (Claude Mythos 5, GPT-5.6 Sol, Kimi K3, Muse Spark,
  Inkling) are reported as sourced, not independently confirmed.
- **The "we beat Claude Code cheaply" caveat is now moot — it has been measured, and we
  do not.** `bench/CAMPAIGN-2026-07-17.md` is superseded. Externally graded on
  SWE-rebench with a hidden oracle (2026-08-04, n=19, k=1): Claude Code on
  `claude-opus-5` resolves **79%** [54%, 94%], the factory chain **37%** [16%, 62%],
  paired McNemar exact **p=0.008**. Worse for the thesis, a single OpenHands agent on
  the factory's *own* model resolves **44%** [20%, 70%] — the chain shows **no
  measurable lift** over it (p=0.625) at 2.3× the cost per resolved instance. What
  produced the apparent lift was tooling, not orchestration (44% vs 6% for a no-tools
  loop, p=0.031). Full result: `bench/swebench/results.md`.
  **Update 2026-08-04:** those `openhands` figures are from the archive committed to
  `origin/main` (`results-archive/2026-08-04T04-18-05.349995Z/`), where the arm lost
  3 rows to Azure 429s. A later report re-ran those rows and puts `openhands` at
  **10/19 = 53%**, p=0.375, $1.82 per resolved instance — a **2.8×** cost ratio, and
  `openhands` vs `bare` at **p=0.004**. The conclusion is unchanged and the gap is
  wider. See `STATUS.md` for the provenance rule (the retired plan's Corrections #14 is archived at `docs/archive/PLAN-2026-08-07-retired.md`).
- **Contamination is not the explanation for Claude's lead.** `claude-opus-4-8`
  (published cutoff Jan 2026) scores 74% against `claude-opus-5`'s 79% on the same
  harness, p=1.000, even though all 19 instances predate opus-5's cutoff. The relevant
  caveat is the opposite one: `factory` vs any `claude-*` varies harness **and** model,
  so it is a reference point, not a scaffold deficit.

## What the field says is unsolved — i.e. don't expect to fix these

- **Verification, not generation, is the frontier.** No fixed reward function survives
  continued capability growth; verification must co-evolve. Adding a quality judge plus
  trajectory monitor moved hacked-resolved **28.57% → 0.56%** and clean-resolved
  **40.22% → 60.53%** — ~30% of unmonitored "successes" were exploits (arXiv 2606.26300).
- **Ultra-long-horizon autonomy is under 30%.** SWE-Marathon, 20 tasks of 40–400 human
  hours, 1,300 trials: no configuration passed 30%. Failure mix: 41.6% implementation,
  31.4% timeout, 15.4% reward hacking, 7.6% premature termination.
- **Auto-designed multi-agent systems are retired.** MAS-Zero GPT-5 scored 45.52% at
  $998 vs plain CoT-SC GPT-5 at 57.09% for $286. Don't let the FMS search topologies.
  **Narrowed 2026-08-04 — this bullet used to end "*Expert*-architected role splits
  still win — which is what our persona pipeline is." That is now scoped:**
  - **Supported** for CAID (arXiv 2603.21489) on **Commit0** (+14.7 pp over a
    single agent, building 54 libraries from scratch) and **PaperBench**
    (+25.6 pp), using centralized delegation with isolated git worktrees and
    branch-and-merge.
  - **NOT supported for this repo's chain on single-issue patching.** No entry in
    the SWE-bench Verified top 20 decomposes by SDLC role, there is no sequential
    critic anywhere in it, and EPAM *removed* its unit-testing stage and
    multi-iteration loop moving to Sonnet 4 and scored 76.8% — joint-highest for
    that model. Our own measurement agrees: 37% for the chain vs 53% for one
    OpenHands agent on the same weights (`bench/swebench/results.md`).
  - The reading that survives both: role decomposition wins where the task is
    *composed of many separable units*, and loses where the task is one patch.
    See the archived plan's Phase C.3 (`docs/archive/PLAN-2026-08-07-retired.md`) — deferred by operator decision 2026-08-07 to run LAST, after Exteroception v1.
- **Harnesses may be depreciating assets.** The strongest dissent holds that harness
  components encode expiring assumptions and should be deletable within hours, with
  ~90-day replacement cycles; O'Reilly's "Kirby effect" describes frontier models
  swallowing scaffolding wholesale. Weng takes the opposite view. Unresolved — but it
  argues for keeping the *gates* (durable) and holding the *prompt scaffolding* loosely.
- **Self-evolution is model-specific.** GSME: "evolved harnesses are model-specific;
  the loop is what transfers." Harness-*updating* ability is roughly flat across model
  scale, while harness-*benefit* is non-monotonic and peaks at **mid-tier** models — so
  cheap proposers are fine, but don't assume a patch tuned on deepseek helps codex.
- **What a real self-improvement loop needs, per the literature** (relevant if
  `factory/manager/`'s self-improvement layer is revisited): an outcome archive keyed on
  **(where × why)**, not per-node score (HGM: selecting on clade-aggregate descendant
  performance beat DGM's per-node selection, 56.7% vs 53.3%, at 42% of the CPU cost);
  three gates in order of transferability — **validity** (re-run infra failures, keep in
  denominator), **activation** (credit a patch only if its instrumentation beacon
  actually fired), **significance** (paired significance test on a sealed split never
  consulted during search); and file-state patch collection over model-emitted unified
  diffs (~~Claw-SWE-Bench: 69.1% → <1.5% apply failures switching transport~~ —
  **DOWNGRADED 2026-08-04, the citation could not be verified; the design intuition
  stands, the number does not**. the archived plan's deferred patch-apply item (`docs/archive/PLAN-2026-08-07-retired.md`) is costed on
  our own 21 historical failures instead).

---

## Benchmark reality — measured and re-scoped 2026-08-04

What our own product claim needs, versus what the field publishes. This section
replaces the assumption that a bigger SWE-bench run is the next measurement.

**The axes our claim turns on are unmeasured by anyone.** **B** concurrent
stories, **D** CI-failure recovery, **E** docs and context maintenance, **F**
dollars per delivered unit over days — **nothing published covers them**. Axis A
(does decomposition help) is covered only weakly, and only on single-issue
patching, where the answer is no (see the MAS-Zero bullet above).

**Corpus status, verified:**

- **SWE-rebench (Nebius) is the suite of record and it is healthy** — 860
  execution-validated Python instances, docker image and oracle shipped in-row,
  monthly splits through 2026-05-12. Supply by `created_at`: `>2026-02-01` = 167,
  `>2026-04-24` = 30, `>2026-06-01` = 0.
- **SWE-bench Pro — frozen.** ~30% of public tasks broken per OpenAI's 2026-07-08
  audit, and it **leaks post-`base_commit` git objects reachable via `git log -p`**.
- **SWE-bench-Live — dead.** Last modified 2025-09-18, newest instance
  2025-09-02, **0 rows after 2025-10-01**. It cannot serve as a freshness control.
- **SWE-Marathon — public, but not yet useful to us.** Frontier ceiling under 30%
  at ~27.2 M tokens per attempt.
- **Publicly runnable and worth adapting:** **SWE Atlas** (arXiv 2605.08366 —
  released harness *and* judge prompts, 284 expert tasks, **test-writing graded by
  mutation score**, frontier ~42–43% Pass@1 with Pass^3 dropping 30–50%) and
  **Commit0** (the suite where CAID measured +14.7 pp for role decomposition).
- **Best axis fit, availability UNCONFIRMED — probe before budgeting:**
  **RoadmapBench** (2605.15846 — 115 tasks, median 5 weighted subtasks, hidden
  target-version tests, git tags pruned, OpenHands baselines published),
  **ChainSWE** (2607.02606 — sequential dependent fixes, up to 70% degradation
  with chain length), **SlopCodeBench** (2603.24755 — erosion and verbosity over
  196 checkpoints; best agent passes 14.8%). **These names came through the fetch
  pipeline described in "Honest limits" above — verify each id resolves before
  spending anything against them.**

**Statistical reality of widening.** SWE-rebench at n=60, k=3 costs **$513 Azure +
~$550 subscription** and moves the MDE from ±38 pp to ~±12–15 pp. Our measured
effect is −7 pp (−16 pp on the later report), so *detecting* it needs high
hundreds of instances, $4–6k. **Widening can bound the negative; it can never
show the chain works.** The measurement that can is a corpus of multi-unit tasks
with human-authored oracles — SacrificeBench, archived plan Phase D (`docs/archive/PLAN-2026-08-07-retired.md`), sequenced after Exteroception v1.
