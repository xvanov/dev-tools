> **RETIRED 2026-08-07 by operator decision.** This file was the working plan
> and de-facto PRD through Phase A/B.1. It is superseded by the **Exteroception
> v1 direction** (`apps/factory/directions/` — newest direction) and the
> rewritten `STATUS.md`. It is archived, not deleted, because its correction
> log (36 corrections, 16 costed refutations) is part of the project's failure
> ledger. Do not execute phases from this file; forward work lives in the
> direction. One pre-registration is explicitly retired with it: E.5's "one
> honest L1→L4 cycle before deleting the manager LLM tiers".

# PLAN.md — reordered around the measured result

**Reconciled with measured reality 2026-08-05** — A.2/A.3/A.8 done (#233), C.1 done
(#235), A.1's chain half done but the flag deliberately not flipped (#236), A.4 done
and **negative** (#237), A.7 blocked, A.5's premise falsified, Phase C reordered.
The correction log at the end carries the details as entries 20–29.

**Reconciled again 2026-08-05, after five further merges.** A.5 done — but as a
**deletion** from the required gate, not the rewrite this plan specified (#239).
A.1's bench half done (#238). A.1c and A.6 done together, and the flag is still
deliberately off (#242). **B.1 Phase 1a done, and it produced a number**: a new
`solo-noreview` arm, the chain with the reviewer round-trip removed, **9/18 = 50%
at $2.83 per resolved** against the archived `factory` arm's 7/19 = 37% at $5.13
(#243). The headline number set unified across `CLAUDE.md`, `STATUS.md` and the
bench README (#241). Details as corrections 30–36.

**Rewritten 2026-08-04, after the five-arm benchmark.** The chain shows no
measurable lift over a single agent on the same model. Every phase below is
ordered by the evidence for it, cheapest first, and the old ordering
(measurement → bigger benchmark → structural wins) is gone: we already have the
measurement, and the next dollar does not belong to a bigger version of it.

Read order for a fresh agent: `CLAUDE.md` (short, authoritative) → §1 here (the
baseline, do not re-derive it) → §2 (the research premises the phases follow) →
§3 (what is NOT broken) → Phase A. Phases A–E are ordered; do not start B before
A ships, and the reason is in Phase B's warning.

---

## 0. Environment and guardrails (read before touching anything)

```bash
uv sync --all-extras          # dev extras are OPTIONAL; bare `uv sync` has no pytest
uv run pytest -q              # 2,368 tests, ~5 min
uv run ruff check . && uv run mypy factory
git fetch origin && git status -sb    # live tree MUST equal origin/main
```

`ModuleNotFoundError` for `frontmatter` / `sqlmodel` / `pytest` means the env,
not the code — re-sync before debugging.

**Hard guardrails (from `CLAUDE.md`, non-negotiable):**

- **Gate on the real artifact.** Never a recorded flag, an `--auto` *enable*, a
  dry-run's intent, or a green test run without a commit. `proxy ≠ real` is the
  single most common bug class in this repo.
- **The live tree must equal `origin/main`.** It has silently run ~60 commits
  behind before.
- **Never `git add -A`** here (`state/**` is runtime churn). Deploy surgically
  with `scripts/deploy-factory-from-main.sh` (`--dry-run` first).
- **`factory/manager/**` and `bench/**` are forbidden to self-edit** — operator
  PR only (DGM anti-gaming). Enforced in code at
  `factory/manager/apply.py:67-71`. Steps below that touch those trees are
  flagged **[OPERATOR-PR-ONLY]**.
- **Chain code is picked up next tick; manager code needs a service restart**
  (`systemctl --user restart factory-manager.service`).
- Daily spend cap **$300** (`factory_settings.yaml`); notify the operator at
  $50 / $75 / $100.
- `factory resume` / `factory pause` are operator decisions. Never automate.
- Nothing loops more than 3 times, and an early-escalation guard stays strictly
  below the hard cap. Current: `_MAX_DEV_RETRIES = 3`
  (`factory/chain/handlers.py:1244`), `_MAX_REVIEW_CYCLES = 3` (`:1305`), inner
  guards `_MAX_DEV_SAME_SIGNATURE = 2` (`:1259`) and `_MAX_REVIEW_STUCK = 2`
  (`:1304`).

**Operational state, verified 2026-08-05.** Factory units **OFF** — all six
systemd units inactive and disabled. Mode `normal`. Today's factory-tracked spend
**$0.00** against the $300 daily cap. Live tree equals `origin/main`.

The units stay off **deliberately**. A.1's four named blockers closed in #242, but
`gates.acceptance_oracle` is still absent from every app config for a *different*
reason — an in-process hole no file rollback closes (see A.1). Flipping it is an
operator decision. When it is flipped, the units come up **with the acceptance
oracle enabled on one app**, so E.5's soak and A.1's soak are one cycle and a live
tick cannot race an agent's test runs.

**The bench-side queue** (all four touch `bench/swebench_adapter.py`, so they
serialize behind any bench PR in flight; #238 and #243 have both landed): the
§1.6 G aggregate recompute (~1 h), the §1.6 G 429-retry (~4 h), C.3's Commit0-Lite
plumbing probe, and A.7's `model_selectable` change.

---

## 1. The measured baseline — published, do not re-derive

Suite: SWE-rebench (Nebius), pinned manifest `923aef05add32124`, 19
working-oracle instances, **k = 1**, one sweep, tables pre-registered in
`bench/swebench/PRE-REGISTRATION-1.6.md` before the data existed.

> **Provenance, read before quoting a number.** Two `report` runs exist for this
> sweep and they disagree on one arm.
> `results-archive/2026-08-04T04-18-05.349995Z/` reports `openhands`
> **7/16 = 44%**, `$15.37`, McNemar p=0.625 — three rows lost to Azure 429s. A
> later run, `results-archive/2026-08-04T23-19-24.998844Z/`, re-ran those three
> rows as `attempt: 2` and reports `openhands` **10/19 = 53%**, `$18.20`,
> p=0.375. **Both archives are committed to `origin/main`** as of `664bcd7d`
> (PR #232): `git ls-files` shows all seven archive roots, the later one carrying
> 293 tracked files. The protocol question is closed too —
> `PRE-REGISTRATION-1.6.md:220-221` now addresses the `attempt > 1`
> contradiction, which the report's own "Discarded runs" section had called "a
> protocol violation, not a data point" while the headline counted three such
> rows.
>
> **The conclusion is the same under either report**, which is why this plan
> uses the later one. Both put the chain below one agent on the same model, both
> at p > 0.3, and the cost ratio moves further against the chain in the later
> one.

| arm | harness × model(s) the ledger says ran | resolved / valid | rate | 95% CI | $ | $ / resolved |
|---|---|---:|---:|---|---:|---:|
| claude-5 | Claude Code CLI × `claude-opus-5` | 15/19 | 79% | [54%, 94%] | 34.36 † | 2.29 † |
| claude-4.8 | the SAME CLI × `claude-opus-4-8` | 14/19 | 74% | [49%, 91%] | 23.56 † | 1.68 † |
| **openhands** | **one OpenHands agent, no chain × `azure/deepseek-v4-pro`** | **10/19** | **53%** | [29%, 76%] | 18.20 | **1.82** |
| **factory** | **the chain on OpenHands × deepseek-v4-pro (33 calls) + gpt-5.3-codex (6) + gpt-5.4 (31)** | **7/19** | **37%** | [16%, 62%] | 35.94 | **5.13** |
| bare | hand-rolled text loop, no tool calls × deepseek-v4-pro (727 calls) | 1/18 | 6% | [0%, 27%] | 7.94 | 7.94 |

† CLI-reported against a subscription; the Azure rows are price-table estimates
over measured tokens. Different accounting bases — never summed, and the
cross-family `$ / resolved` is indicative only. **`factory` vs `openhands` is one
basis and exact.**

Paired McNemar exact, over instances where both arms have an audited-valid row:

| comparison | isolates | paired n | only-A / only-B | p |
|---|---|---:|---:|---:|
| **factory vs openhands** | **the chain** | 19 | 1 / 4 | **0.375** |
| **bare vs openhands** | **the tooling** | 18 | 0 / 9 | **0.004** |
| bare vs factory | chain + tooling, entangled | 18 | 1 / 7 | 0.070 |
| claude-5 vs factory | nothing attributable — reference only | 19 | 8 / 0 | 0.008 |
| claude-4.8 vs factory | nothing attributable — reference only | 19 | 8 / 1 | 0.039 |
| **claude-4.8 vs claude-5** | **contamination** (same harness, older cutoff) | 19 | 1 / 2 | **1.000** |

Pair order is `results.md`'s, not rearranged: **A is the arm named first**, so
`bare vs openhands` at 0 / 9 means bare resolved nothing openhands missed and
openhands resolved nine bare missed. Never reorder a pair's name without
swapping its two counts — the old `STATUS.md` needed a footnote for exactly
that.

What this establishes, in the pre-registration's own pre-committed words: **our
lift comes from using a competent agent loop, not from the chain.**

1. **No measurable chain lift.** 37% vs 53% on identical weights, prompt and
   tools, p=0.375. At MDE ≈ ±38 pp this is **"no measurable lift", not "the
   chain hurts"** — nothing here measured harm, and no doc may imply it did.
2. **The lift is TOOLING, not orchestration.** `openhands` 53% vs `bare` 6%,
   p=0.004 — the only significant result among the three DeepSeek arms. The
   retracted "+58 pp scaffold lift" was measuring having an editor and a
   tool-calling API versus not having one.
3. **Cost moves the wrong way.** $5.13 per resolved instance vs $1.82 — **2.8×
   for no measurable gain** — plus 1.8× the fresh input tokens (14.3 M vs 7.8 M)
   and 2.6× the median wall clock (995 s vs 385 s).
4. **The chain's own verdict is barely better than a coin flip.** Chain-verdict
   precision **6/15 = 40%** [16%, 68%], recall 6/7 = 86% [42%, 100%].
5. **One row went green on a zero-byte production patch.**
   `harumiweb__exstruct-113 / factory`: the chain said green, the reviewer
   approved, and the graded patch was empty —
   `prediction_sha256: e3b0c442…7852b855` (the sha256 of the empty string) with
   `stripped_test_paths: ["tests/cli/test_cli_lazy_imports.py"]` in
   `results-archive/2026-08-04T04-18-05.349995Z/harumiweb__exstruct-113/factory/audit.json`.
   The dev's entire diff was one test file. This single row is the plan's
   cheapest, hardest evidence for Phase A.
6. **The review loop is no longer inert, and it does not help.** Reviewer cycles
   `0×7, 1×9, 2×2, 3×1` across the 19 factory rows, versus 0 on every row in the
   n=6 sweeps. It engages; the resolve rate does not move.
7. **Claude Code is ~2× the factory** (79% vs 37%, p=0.008) but varies harness
   **and** model at once. Reference point, never a scaffold deficit — that
   caveat travels with the number. The factory's 7 passes are a **strict subset**
   of `claude-opus-5`'s 15 (only-B = 0). Against `claude-opus-4-8` it wins
   exactly one instance, `hkuds__openharness-217`.
8. **The contamination probe came back CLEAN.** `claude-opus-4-8` (published
   cutoff Jan 2026) 74% vs `claude-opus-5` (May 2026) 79%, same harness,
   p=1.000, on a manifest where 19/19 instances predate opus-5's cutoff.
   Memorization is not carrying Claude's score. The DeepSeek arms still carry the
   confound: `deepseek-v4-pro` publishes no cutoff and 15 of 19 instances sit
   inside its release-date bound.
9. **Integrity held.** One genuine violation, published invalid and excluded:
   `bare` on `hiero-ledger__hiero-sdk-python-1914_interface` ran
   `curl -s https://raw.githubusercontent.com/…/account_info.py`, the upstream
   source of the exact file under test. Zero path-based oracle probes anywhere.

### 1a. A sixth arm, measured 2026-08-05 — the reviewer ablation (B.1 Phase 1a)

**Do not fold this into the five-arm table above.** That table re-derives
byte-for-byte from a committed archive and `report --check` must stay green, so the
ablation is published separately: `bench/swebench/RESULTS-B1-PHASE1A.md`, with its
own evidence directory `bench/swebench/results-b1-phase1a/`. `results.md` and every
`results-archive/` root are byte-identical to before the run, and `report --check`
still prints `CHECK OK`. Pre-registered in `bench/swebench/PRE-REGISTRATION-B1.md`
**before any paid call**. Same 19 pinned instances, same manifest, k=1,
`attempt: 1` on every row. **Actual spend $25.49.**

| arm | resolved / audited-valid | rate | 95% CI | $ | $ / resolved |
|---|---:|---:|---|---:|---:|
| `factory` (archived — the row above) | 7/19 | 37% | [16%, 62%] | 35.94 | 5.13 |
| **`solo-noreview`** — the chain with the reviewer round-trip removed | **9/18** | **50%** | [26%, 74%] | 25.49 | **2.83** |

Paired McNemar exact, n=18: only-factory **2**, only-solo **4**, **p = 0.688** —
reported as a descriptive discordance statistic only. `reviewer_cycles` = 0 on all
19 rows, so the ablation applied everywhere. The pre-committed stop signal
(only-factory ≥ 5 of 19) **did not fire**, so B.1's premise survives.

**The interpretation limits are as load-bearing as the number.**

1. **The cost win is real; the quality claim is not established.** Δ = +13 pp sits
   well inside the ±38 pp MDE at this n, and p = 0.688.
2. **It is not a clean single-variable ablation, and that was recorded in the
   pre-registration before the data existed** (with 1 of 19 outcomes known). The
   baseline rows ran 2026-08-03 and the ablation ran on `6662d062`, so **three
   things differ, not one**: the reviewer, 35 new lines in the dev persona (A.3's
   underspecified escape hatch), and the acceptance-oracle authoring layer. A.2 and
   A.5 provably do **not** reach this driver — both sit behind the merge-time gate
   evaluator, which this driver never calls. Empirical bound on the persona delta:
   no row in either arm ended in `blocked_underspecified`. **Phase 1b must run both
   arms in ONE sweep on ONE commit (~$62).**
3. **`solo-noreview` at $2.83 per resolved is still 1.6× one OpenHands agent's
   $1.82.** The ablation narrows the chain's deficit against a single agent without
   closing it.
4. **The cost mechanism was mispredicted, and the correction is the useful part.**
   The reviewer's own tokens are **$0.65 of $35.94 = 1.8%** of spend. The 29%
   saving comes from **9 fewer dev calls (30 vs 39)** and a median story of **1 tick
   instead of 4** — the reviewer was not expensive, it was causing rework. Optimise
   for round-trips eliminated, not tokens per persona.
5. **Both arms certified green on the same zero-byte production diff.** So the
   reviewer was never what caught that class (§1 #5); the gate that catches it is a
   merge gate this driver never runs.
6. One row was published **invalid and not re-run** — its dev fetched a
   dependency's upstream source over the network. Counting it raw gives 9/19 = 47%,
   so the exclusion did not manufacture the 50%.

Building the arm surfaced three latent harness bugs that would have corrupted or
refused any second chain arm: the factory driver hard-coded the arm name in **nine**
places, `audit` keyed the state root off the arm id, and `main()` asserted the run
key equalled the base arm.

---

## 2. The research premises this plan follows

Four external research reports, condensed. Each phase names the premises it
rests on. Citations live in `SOTA-RESEARCH-2026-07.md`.

**P1 — Role decomposition has never won at single-issue patching, and that is
not a bug in our implementation.** No entry in the SWE-bench Verified top 20
decomposes by SDLC role. "Multi-agent" at the top means either
subagent-as-a-tool for context isolation (decision authority stays in one agent)
or generate-k-then-select. There is **no sequential-critic persona anywhere in
the top 20**. EPAM *removed* its unit-testing stage and its multi-iteration loop
moving to Sonnet 4 and scored 76.8%, joint-highest for that model.

**P2 — Harness contribution scales INVERSELY with model strength, and we are in
the regime where it is worth 10–22 points.** Fixed-model scaffold spreads
computed from the leaderboard's own `results.json`: `claude-opus-4-5` **2.4–4.8
pts** (a 100-line bash-only agent within 2.4 of SOTA); `claude-sonnet-4` 11.9;
`Qwen3-Coder-480B` **14.2**; GLM-4.6 12.8; Kimi-K2 family **~21.6** — and at
cheap models the minimal scaffold is the *loser*. The points come from tools,
context management and long horizons **inside one agent**, plus parallel sampling
with selection. Public anchor: `deepseek-v4-pro` scores **41.4%** in a plain
single-agent tools harness on SWE-rebench. Our chain got 37%; our own
`openhands` arm got 53%.

**P3 — Generate-k → select is the one multi-agent pattern with clean same-model
gains.** TRAE 70.6% single-attempt → **78.8%** with 30 candidates + an
LLM-identified regression-test filter + a selector (**+8.2 pts, identical
model**). Skywork-SWE-32B 38.0% → **47.0%** with best-of-8 (**+9.0 pts,
identical model**). Winners' order: execute existing repo tests to kill
regressions **first**, *then* a jury or a vote. Selection at k ≤ 3 is
near-worthless — CodeMonkeys: random-of-10 45.8% vs selected 57.4%, i.e. most of
the value is in *having* 10 candidates.

**P4 — Role decomposition DOES win somewhere, and it is not single-issue
patching.** CAID — arXiv 2603.21489, *"Effective Strategies for Asynchronous
Software Engineering Agents"* (Geng & Neubig), a **method, not a benchmark** —
uses centralized delegation with **isolated git worktrees and branch-and-merge**,
architecturally our chain, including primitives we already have
(`factory/chain/worktree.py`, per-story worktrees). It reports **+25.6 pp on
PaperBench**, and on Commit0 a lift that is **per-model, not one effect size**.
Verified 2026-08-05 against Appendix C: on Commit0-**Lite**, one-sided paired
t-test, Claude Sonnet 4.5 **+6.0 pp** (t=2.87, p=0.006); GLM 4.7 **+3.6 pp**
(t=1.37, p=0.095, not significant); MiniMax 2.5 **+14.7 pp** (t=2.81, p=0.007).
So the widely-quoted +14.7 pp is the **MiniMax 2.5** row — the weakest of the
three models — and the frontier effect is **+6.0 pp**. Both arms' code is public
at `JiayiGeng/CAID` (`run_single.sh`, `run_multi.sh`), and CAID scored Commit0 as
a **continuous mean with a paired t-test**, not binary resolve. **This is the
most important finding for the product: we measured our chain on the one task
shape where the literature predicts it cannot help.** Two consequences: (a) the
gradient *strengthens* C.3's rationale for our cheap-model regime, because the
gain is largest at the weakest model; (b) **do not power C.3 against 14.7 pp** —
at n=16 paired, a 6-pp effect is far below resolution, so pre-register the effect
you are actually powered for.

**P5 — Our verification architecture is a known anti-pattern, three ways.**
(a) SpecBench (2605.21384): every model saturates its visible suite while
diverging on held-out tests; the gap grows ~28 pp per 10× code size; **weaker
models diverge much further** — and enriching the visible suite helped one task
and *hurt* another by 25 pp. (b) ImpossibleBench (ICLR 2026): GPT-5 exploits
contradictory tests **76%** of the time in repo-scale agentic settings vs
**2.9%** in a single-function scaffold — exploitation explodes in exactly our
setting; and **multiple submissions with feedback raised cheating 33% → 38%**, so
more review cycles mean more gaming. (c) AXIOM (2512.20159): LLM judges score
MCC **below 15** on code quality (near chance), and **complex agentic judge
systems scored α 37–49.5 versus 62.5–63.0 for a single simple prompt** — more
pipeline, less validity.

**P6 — "Different model" is not independence; relative capability is.** arXiv
2607.21656: a **weaker** reviewer on a stronger writer scored **−8.6 pp, fixing 3
and breaking 13**; a **stronger** reviewer on a weaker writer **+18.1 pp**;
self-review **+0.0 pp**. Our 8-of-13 byte-identical reviewed rows match the inert
self-review case — *that figure is carried from the synthesis and was not
re-derived against the archive in this pass; re-derive it before quoting it.* The
`routes.yaml` reviewer ≠ dev rule is necessary and not sufficient.

**P7 — Cheap, measured countermeasures.** Test files **read-only to the dev**
("significantly reduces cheating while maintaining performance", ImpossibleBench
ablation; cost: a sandbox setting). An **"underspecified / impossible" terminal
state** (GPT-5 cheating **54% → 9%**, o3 **49% → 12%**). Give the reviewer
**execution output instead of diff text** (judge agreement with ground truth
**42% → 72%**). Replace `test_quality_score` with a **diff-scoped mutation
score** (LLM test suites average ~40% mutation score, one documented case at 100%
coverage / 4% mutation; with mutation feedback, test strength 53% → 89.5%).
Require **red→green** — the test fails at base and passes at HEAD — which doubles
patch-stream precision at k=1 and trivially kills the zero-byte-patch class.
**Caveat that must travel with red→green wherever it appears:** only the "fails
at base" half is oracle-free. Agentless measured 213/300 tests reproducing the
bug but only 94/300 also flipping green under the gold patch, so a hard
both-halves gate rejects good patches; the fail-safe fallback is regression-only
selection, **never "approve"**.

**P8 — Benchmark reality.** Axes **B (concurrent stories), E (docs/context
maintenance), F ($ per delivered unit over days)** are covered by **nothing
published**; A (decomposition) only weakly. **Axis D is covered — the earlier
claim that it was not is wrong.** **DevOps-Gym** (arXiv **2601.20882**) ships
**66 build/CI-failure tasks** plus **17 end-to-end** pipeline tasks; it is
**Java/Go only, zero Python**, and 3–4 weeks of integration for us. Widening
SWE-rebench to n=60, k=3 costs **$513 Azure + ~$550 subscription** and moves the
MDE from ±38 pp to ~±12–15 pp — our effect is −7 pp (−16 pp on the later
report), so detecting it needs *high hundreds* of instances ($4–6k). **Widening
can bound the negative; it can never show the chain works.** Publicly runnable
alternatives: **SWE Atlas** (2605.08366 — released harness and judge prompts, 284
expert tasks, test-writing graded by **mutation score**, frontier ~42–43% Pass@1,
Pass^3 drops 30–50%) and **Commit0** (where CAID's +14.7 pp was measured).
Also existing, and the best axis fit: **RoadmapBench** (2605.15846),
**ChainSWE** (2607.02606), **SlopCodeBench** (2603.24755), **SWE-EVO**
(**2512.18470**). **All seven candidates probed in C.1 EXIST** — every arXiv id
resolved to a real paper with a real public artifact, and no name was a phantom,
which given the fetch-rewrite hazard below was not the expected outcome. Details
in `bench/benchmark-availability-2026-08.md`. SWE-bench Pro leaks
post-`base_commit` git objects via `git log -p`. SWE-bench-Live is confirmed dead
(0 test rows after 2025-10-01). SWE-Marathon is public but its frontier ceiling
is <30% at 27.2 M tokens per attempt — not yet.

**P9 — SacrificeBench is the only design that can measure the real product
claim.** See Phase D.

> **Confidence rule for everything in P8.** These benchmark *names* reached us
> through a fetch pipeline that silently rewrites proper nouns (see
> `SOTA-RESEARCH-2026-07.md`, "Fetched content is lower-confidence than fetched
> numbers"). Verify every name and arXiv id against the source before quoting it
> outside this repo. A number from a fetched source is more trustworthy than the
> name attached to it.

---

## 3. What is NOT broken — do not go fix these

A fresh agent's biggest risk here is re-diagnosing something already solved.
Items 1–4 were checked 2026-08-01 and re-checked 2026-08-04.

1. **Chain self-edit works.** 122 stories carry a PR number, 118 PRs are merged,
   24 factory stories reached `deployed`, and the staging gate has a real
   17-validated / 3-rejected record. Loop 1 is proven zero-touch. Nothing to fix.
   **This is a delivery fact, not a correctness fact** — §1 is the correctness
   measurement and it is the one that came back flat.

2. **CI-failure recovery works.** `factory/chain/auto_merge.py:1640-1830`
   (`_handle_ci_failure`) fetches the CI log digest, emits a well-formed finding
   *dict*, re-enters at `REVIEWER_REQUESTED_CHANGES` (deliberately not
   `DEV_IN_PROGRESS`, which has no dispatch-table entry), and resets both
   counters. Capped at `_MAX_CI_FIX_CYCLES = 3` (`auto_merge.py:72`) plus an
   identical-failure-signature bail (`:1759-1766`). A previous session already
   misdiagnosed this as broken — the `ci_fix` events live in `state/logs/*.log`,
   **not** `state/events/*.ndjson`.

3. **Reviewer non-convergence is fixed.** Last 14 days (122 stories):
   `reviewer_cycles` = {0: 101, 1: 18, 4: 2, 5: 1} — zero stories at 6+, max 5.
   The convergence guard holds. Note that "converges" and "helps" are different
   claims: §1 #6 shows it converging and not helping.

4. **The GitHub loop is clean.** 0 open PRs, 1 open issue (#122, a real backlog
   direction), 0 blocked stories.

5. **The benchmark harness itself is sound, and it took four retractions to get
   there.** Per-node grading, arm isolation under a flat `SWEBENCH_WORK_ROOT`,
   fail-closed `_DIFF_HEADER`, test-edit stripping asserted in code on every arm,
   a manifest frozen before the first run, a gold-patch selftest control at
   19/20, an `audit` subcommand that fails closed on a missing artifact, and
   `report --check` re-deriving the published table byte-for-byte from a
   committed archive. **Do not "improve" the harness without a failing case.**
   Its two open debts are reporting only — see `1.6 G`.

Also already fixed, so do not re-fix:

- **`dirty_working_tree` in both apply paths.** Both
  `factory/manager/apply.py:882-897` and
  `factory/chain/factory_improver_apply.py:418-436` are now **path-scoped**
  (`git diff --quiet HEAD -- <patch target paths>`, falling back to repo-wide
  only when the patch is unparseable). The 158 historical failures in the
  improver log all predate this — see Corrections #10, which is why patch-apply
  fuzzing is deferred in Phase E.
- **`db_path` threading in `runner._record`** — done.
- **Reviewer/dev model collision** — `reviewer` moved to `azure/gpt-5.4` in both
  provider blocks and the check is enforced at router load
  (`model_router.check_review_independence`). Different-model now holds; whether
  it is the *right* difference is Phase A.7.

---

## 4. Done — the measurement substrate (Phase 0, Phase 1, 1.6 A–F)

Kept short. These phases are closed; their value now is the file references and
the corrections they produced.

### Phase 0 — make measurement possible — **DONE 2026-08-01, $0**

| Shipped | PR |
|---|---|
| `sandbox_run` logs prompt metadata; new `prompt_bodies.ndjson` keeps full text + full sha256, hash-chained. Bodies are captured for **chain personas only** — storing `manager_watcher` too would have been 1.58 GB and would have evicted the dev/reviewer bodies the stream exists for | #193 |
| `retried` / `review_cycle` rows emitted from inside the handlers, reconciling with the DB counters. Used `retry_attempt`/`retry_cap`, because `emit_chain_step`'s payload already carries `attempt` | #194 |
| `gates_failed` on `MergeAction`, a `gates_failed_json` column, a `merge_gates_failed` story event; the write-never `smoke_passed` reader deleted so the smoke gate is fail-closed *structurally* rather than by accident | #195 |
| `reviewer` → `azure/gpt-5.4` in both blocks, enforced at router load; loop caps 6 → 3 with inner guards 3 → 2 so early escalation stays reachable | #196 |
| `bench/bench.py` pinned: literal `base_sha` and an empty one refused, `claude --model` pinned, `clean()` no longer deletes `bench/runs/`, every `result.json` records base/routes/price-table provenance, tokens reported as the primary metric | #197 **[OPERATOR-PR]** |

**Behavioural consequence to remember:** at `_MAX_DEV_RETRIES = 3` the dev inner
loop gets at most **two** sandbox attempts per invocation, so `red → red → green`
no longer converges in one tick. Phase B.1 argues this chopped horizon is part of
the problem.

### Phase 1 — first real number — **1.1–1.5 DONE 2026-08-02**

`bench/swebench_adapter.py` exists, grades against a hidden oracle with test
edits stripped and asserted, and `report` archives every artifact it consumed
into `results-archive/<generated-at>/` and refuses any row whose artifacts are
missing (#199, #200, #202, #204, #205, #206, #210, #211). The 2026-08-01 batches
were retracted for three harness bugs (fail-open blind reviewer diff,
uninitialised submodules, 1.62× cost under-report); the 2026-08-02 n=6 pair is a
plumbing record only, superseded by §1.

### 1.6 — Arm parity and integrity repair, then one clean n=19 re-run — **A–F DONE 2026-08-04** **[OPERATOR-PR-ONLY]**

Actual cost of the sweep: **$59.25** Azure price-table estimate (factory $35.94 +
openhands $15.37 + bare $7.94, on the committed report) plus $57.92
CLI-reported against the Anthropic subscription. Estimate was ~$50 Azure.

- [x] **A — integrity hardening.** Every arm's live tree moved under a flat
      `SWEBENCH_WORK_ROOT` keyed by (instance, arm, model), so no arm is a `..`
      away from `oracle.json.z` or a sibling's `grade.log`; only finished
      artifacts are copied back. Per-node `PASSED` grading replaced exit-code
      grading: `-rpfEsxX` (that is `-rA` minus `P`, so arm-authored code cannot
      echo a forged `PASSED <id>` into the region the parser reads), and every
      declared `FAIL_TO_PASS` / `PASS_TO_PASS` id must have a `PASSED` node and
      no `FAILED`/`ERROR` node. `_DIFF_HEADER` fails CLOSED. `audit.json` carries
      `prediction_sha256`, `base_commit`, `stripped_test_paths`, `refused_paths`,
      `trajectories_scanned`, `trails_scanned`. **Produced: zero path-based
      oracle probes in the sweep**, versus 4 audit-invalidated factory rows
      before.
- [x] **B — arm parity.** One `_BASE_TESTS_NOTE`, byte-identical, reaches
      `_STORY_TEMPLATE` (factory/openhands/claude) and `_BARE_TASK` (bare), so
      "matched prompt" is true rather than asserted. Bare got the test-writing
      instruction, an empty-diff DONE guard, a real message list, the parsed
      command echoed into history, bash-fence tolerance, `TimeoutExpired`
      handling and persisted observations. **Produced: the `openhands` arm, and
      with it the sweep's only interpretable headline.** Every arm records
      `model`, `models_used`, `model_calls`, `model_escalated_calls`, which is
      how the factory's 6 hard-tier `gpt-5.3-codex` calls are visible in Table 1
      instead of hidden.
- [x] **C — reporting honesty, mostly.** `--from-archive` prints and never
      overwrites; `--check` diffs and exits non-zero on drift;
      `report-meta.json` persists `foreign`/`refused`; one budget rule for every
      arm (a cap hit is a counted, flagged attempt); `fresh in` and `cache read`
      split (a blended column had made the published "34× tokens" claim wrong by
      4.5×); cost source labelled per arm; an `attempt` column and a "Discarded
      runs" section; `n/a (arm has no chain verdict)` instead of a division
      artifact; `pass_to_pass_count == 0` flagged; `estimate_instance_cost`
      filtered by `manifest_sha256`. **Not closed — see G.**
- [x] **D0 — probe before you sweep.** `--probe-plumbing` with a stubbed model
      for every non-factory arm, plus one paid single-instance run per new arm.
      **Produced:** the probes are why the sweep did not re-discover a
      six-step-giveup arm for $50.
- [x] **D — one clean re-run, n=19, k=1, five arms**, one sweep. `attempt` is 1
      on all 95 rows of the committed report.
- [x] **E — caveats are structural, not prose.** Per-arm Clopper-Pearson CIs,
      paired McNemar exact per pair with `harness varies?` / `model varies?`
      columns, the ±38 pp MDE stated, the per-row model mix, and the subset
      relation printed.
- [x] **F — contamination margin per arm, printed.** Table 2 carries
      `margin_days` per model bound; Table 4 names the bound TYPE.
      `deepseek-v4-pro` remains `release-date-proxy`. **The Claude half of the
      question is answered** — see §1 #8.
- [ ] **G — two of the three debts D–F did not close.** All reporting, not
      measurement. Neither moves a published number; both would mislead the next
      reader. **[OPERATOR-PR-ONLY]**
      - **No retry on a provider 429.** `openhands` lost 3 of 19 rows to Azure
        `DeepSeek-V4-Pro` `RateLimitError` under `--workers 4`, and a lost row
        records `cost_usd: 0.0`, which reads as free rather than as missing.
        Retry with backoff, or fail the sweep loudly — never both silently. The
        23:19Z report re-ran those three rows as `attempt: 2`, which is that fix
        applied by hand. **The protocol half is now written down** —
        `PRE-REGISTRATION-1.6.md` Rule 5 was amended (`:220-221`, PR #232) to
        distinguish *repairing an infrastructure loss* from *re-rolling an
        outcome*. The code half is still open, and §1 still cites both numbers.
      - **`sweep-<arm>.json` aggregates contradict their own rows, in four of
        five files — worse than previously recorded.** The `resolved` /
        `audited_valid` / `audit_failed` counters are in-flight snapshots taken
        before grading and before the #227 detector fix. In
        `2026-08-04T23-19-24.998844Z`, header `resolved` versus its own `results`
        list: `sweep-factory.json` 2 vs 7; `sweep-openhands.json` 3 vs 9 (the
        per-row files say 10); `sweep-claude-5.json` 5 vs 15;
        `sweep-claude-4.8.json` 8 vs 14; `sweep-bare.json` 1 vs 1 — the only
        consistent one. `sweep-factory.json` also claims
        `audited_valid: 6, audit_failed: 13` while all 19 `audit.json` files read
        `"ok": true`. **And `2026-08-04T04-18-05.349995Z/sweep-factory.json` is a
        stale file from an entirely different sweep** (`instances: 4`,
        `finished_at: 2026-08-03T02:47:45Z`) archived alongside 19 per-instance
        rows. **Published numbers are unaffected** — they derive from
        `<instance>/<arm>/result.json`. **Rule: trust only the per-row
        artifacts.** Recompute the aggregates from the rows at write time, or
        delete them.
      - **CLOSED.** The 04-18 archive carries only `sweep-bare.json` and
        `sweep-factory.json`; the 23:19Z archive carries all five, and committing
        it (`664bcd7d`, PR #232) closed this one for free.
      - **Effort:** ~4 h for the 429 retry, ~1 h for the aggregates. **Cost $0** —
        no new sweep required. Both touch `bench/swebench_adapter.py`, so they
        queue behind the in-flight bench PR (see §0).

---

## Phase A — stop the self-confirmation

**Rests on P5, P6, P7. Effort ~1.5–2 weeks. Cost ~$60** (A.1's re-measure ~$40 +
A.7's reviewer-ranking arm ~$18; everything else is cents — A.4 came in at
**$1.2693** and A.1's chain half at **$0.02**). This phase comes first
because it is the cheapest, because every later measurement is uninterpretable
without it, and because P5 says our failure mode gets *worse* with model weakness
and with repo scale — which is our exact operating point.

The chain's own verdict is right 40% of the time (§1 #4) and it once certified a
zero-byte patch (§1 #5). Nothing in Phase B is worth buying until a green verdict
means something.

**Replay before you ship.** Most of A is testable against archived reviewer
prompts for cents rather than by re-running a sweep — A.4 did exactly that for
$1.27. **But the corpus is not where this plan said it was.** Corrected
2026-08-05:

- `state/events/prompt_bodies.ndjson` **has never existed.** Production
  `state/events/prompts.ndjson` (2,028 rows) and `prompts.ndjson.1` (43,840 rows)
  carry **metadata only** — no prompt text, no response — and `prompt_hash` is a
  truncated 16-char digest whose own docstring
  (`factory/runner.py:205-215`) says it cannot be replayed.
- Production has **zero rows after 2026-07-31**: the body writers landed
  2026-08-01/02 (#193, #208) and the units stopped 2026-07-30, so the writer
  shipped after the last run.
- The **real** corpus is
  `bench/swebench/runs/<instance>/factory/root/state/events/{prompt_bodies,response_bodies}.ndjson`
  — full verbatim text, sha256-joinable on `prompt_hash`.
- **It is gitignored, and `_reset_run_artifacts` (`bench/swebench_adapter.py:1556`)
  `rmtree`s it at the top of every run function**; `_ROW_ARTIFACTS` (`:7197`)
  excludes it from the committed archives. **So: copy the run-dir body files out
  BEFORE any sweep.** An operator backup was taken 2026-08-05 at
  `/home/k/sf-reviewer-corpus-2026-08-05/` — 25 instance dirs, 38 reviewer prompts
  + 38 responses, 47 trajectory files, 25 run logs, 36 MB.

E.5 remains the only way to generate a *production* body corpus.

### A.1 — Turn the independent acceptance oracle ON, and put it in the measured path

**Chain half DONE — PR #236, merged `69b75d1e`. Blockers closed — PR #242
("A.1c + A.6"). Bench half DONE — PR #238. `gates.acceptance_oracle` is still
absent from every app config, deliberately** — not because the listed blockers are
open, but because one hole survives them all: see "Why the flag is still off"
below. The flip is an operator decision.

- [x] **The countermeasure P7 recommends first is already built here, in a
      stronger form than the paper's.** `factory/chain/acceptance.py:1-22`
      documents it: authored from the **spec only** (direction ACs + `flow.md` /
      `api_spec.md`), authored **early** (at story spawn, `handlers.py:504` and
      `:589`, long before the dev handler runs on a later tick), stored in
      `state/acceptance/<app>/<story_id>/` — outside the app repo and outside the
      per-story dev worktree — and never handed to the dev sandbox, which
      receives only `repo_path`. The path is recorded on
      `StoryRecord.acceptance_test_ref` (`factory/chain/state_machine.py:344`)
      and enforced by `factory/chain/gates/acceptance_verified.py`, which becomes
      merge-required when the app opts in
      (`factory/chain/gates/evaluator.py:79-87`).
- [x] **It had never run. Verified 2026-08-04, re-verified before PR #236.**
      `gates.acceptance_oracle` defaults `False` (`factory/app_config.py:113`) and
      is set in **no** app config — `apps/factory/config.yaml`,
      `apps/sacrifice/config.yaml` and `apps/template-probe/config.yaml` all omit
      it. In `state/factory.db`, `acceptance_expected` is 0 for **all 165 stories**
      and `acceptance_test_ref` is null for **all 165**; `state/acceptance/` did
      not exist. This is the write-never pattern one level up: a whole
      independence layer, built, tested, wired, and switched off. **So every
      published factory number — including the externally-graded 37% and the 40%
      chain-verdict precision — was measured with the chain's only independent
      correctness signal absent.**
- [x] **The benchmark could not see it — fixed, PR #238 (A.1b).** The published
      37% and 40% chain-verdict precision in §1 were measured **with the chain's
      only independent oracle absent**: the adapter ran `{"dev", "review"}` against
      a story seeded at `SM_DONE`, downstream of where the oracle is authored, so
      the arm labelled "the product" was not the whole product. The `factory` arm
      now authors the oracle from the instance's problem statement **before the
      dev's first model call**, through the chain's own authoring code, and
      `result.json` records an `acceptance.ordering` fact a reader **re-derives from
      the run's own event stream** rather than a boolean the code asserts about
      itself. Four integrity properties are enforced in code: the hidden grading
      oracle cannot reach the author, the dev or the reviewer; the authored oracle
      is not visible to the dev **and the store is not discoverable**; the authored
      test is stripped from the graded prediction diff, asserted before the author
      is called; and an authoring failure makes the row **invalid** rather than
      proceeding with the layer silently absent. Only the `factory` arm changed —
      the other four arms are asserted byte-identical and the story template is
      pinned by sha256.
- [x] **Building it caught a real independence exposure on live data.** With the
      oracle stored inside the factory root, the dev on a real run ran a filesystem
      search from one level above its worktree and **the listing named the
      acceptance store**. The detector fired and **refused the row**. The store is
      now relocated outside the factory root, the in-root copy is deleted with the
      deletion asserted, and any acceptance-named leftover refuses the row. This is
      a measured finding, not a design note.
- [x] **Made executable — PR #236.** The **first execution ever produced a 100%
      false block**: the author is blind to the implementation *and* the repo
      layout, guessed `sacrifice.main` / `main` / `app.main`, and the gate ran at
      the repo root with the factory's interpreter →
      `No module named 'app'`. Every AC-carrying story would have false-blocked,
      then been re-dispatched to dev with an identical failure signature until it
      sank to `blocked_tests_need_clarification`. **Nine defects fixed**, three of
      them fail-opens: an all-skipped oracle exited 0 while the persona is *told*
      to skip untestable criteria → vacuous green; a PR **label** could satisfy
      the gate; and required-ness rode `story.acceptance_expected`, written by a
      best-effort DB write that swallows its errors — while `auto_merge` computes
      `missing_labels` only over the *required* set, so a lost write produced an
      **un-gated merge**. Required-ness now keys off app opt-in, a config fact
      that cannot be lost at runtime. Also fixed: **the gate copied the hidden
      oracle into the story's own dev worktree** (`PRContext.repo_root` *is* that
      worktree), which `handlers._commit_green_dev_work` later `git add -A`s, and
      it left the compiled `.pyc` behind — evidenced by the second run sweeping
      the first run's leftovers.
- [x] **Real product finding on the way past.** sacrifice direction 002's
      `api_spec.md` specifies `POST /healthz`; the shipped code serves GET. The
      oracle failed authoritatively on `assert 405 == 200`. **No existing gate
      catches spec-vs-implementation divergence.** Direction 078 passed 4/4. Total
      cost **$0.02**.
- **What is left:** opt **`sacrifice`** in and watch one story end to end — once
  the operator decides the surviving hole below is acceptable.

**The blockers are CLOSED — PR #242 (A.1c, built together with A.6).** Three named
blockers: **oracle failability**, **dev-controlled collection config**, and
**merge-candidate provenance** — the last via **ancestry, not SHA equality**,
because a plain equality check would false-block, since the story worktree merges
`main` in first. Also closed: the forgeable first-`N passed` match (it now takes the
**last** summary and refuses to grade on conflicting summaries); the leak sweep that
**deleted git-tracked files when git could not answer** (it now deletes nothing in
that case); the unresolvable-direction permanent wedge whose message claimed it
self-heals; authoring exhaustion being invisible in `factory inbox`; and
`.pytest_cache` retaining the oracle's test names. Gate ordering is no longer a
comment: `acceptance_verified` running last is pinned by a test
(`tests/test_gates_evaluation.py:700`, PR #239).

**Two adversarial passes over two fully-green PRs found 13 defects between them.**
Three generalise:

1. **An errors-only red at the base laundered a tautology into an authoritative
   green.** For a story that *adds* a module, an oracle whose only link to the
   criterion is an import errors at base **whatever it asserts** — and "red" was
   definitive, so it bypassed the ablation check entirely. That is the **common**
   story shape, not an edge case. Fixed: errors-only ⇒ `unknown` ⇒ falls through to
   ablation. A mixed `1 failed, 1 error` stays red.
2. **`pyproject.toml` is both a pytest collection channel and the dependency
   manifest.** Rolling it back wholesale authoritatively false-blocked every
   dependency-adding story. The operator decision was "dependencies from HEAD,
   pytest config from the factory". The operator's proposed mechanism — run pytest
   with an empty factory-owned config — was **measured wrong**: it kills
   `asyncio_mode = auto`, so every `async def` oracle false-blocks on a FastAPI app.
   Shipped instead: splice out only the `[tool.pytest.*]` tables, re-verified with a
   TOML parse (which also catches a dotted-key evasion). **`pyproject.toml` is now a
   documented special case, not the clean complement of the production-path
   classifier.**
3. **Standing rule:** an import or collection error at HEAD must be
   **non-authoritative** whenever the environment rollback set is non-empty. If we
   perturbed the environment and got an error rather than a failure, we cannot
   distinguish "the dev's code is wrong" from "we broke it", and a gate must never
   authoritatively blame the dev for something it may have caused.

**⚠ Why `gates.acceptance_oracle` remains absent from every app config.** An
in-process hole survives. **Three lines of production code** — reassigning pytest's
test-runner function to a no-op — forge a genuine-looking red→green, and **no file
rollback closes it**; it needs an out-of-process behavioural oracle. It is carried
as an `xfail(strict=True)` whose stated reason is that it is why the flag stays off,
so a silent "fix" fails the suite. Same class: a HEAD dependency registering a
pytest plugin entry point via a local-path dependency.

- **⚠ Fail-safe check before flipping the flag.** Required-ness now keys off app
  opt-in rather than `acceptance_expected` (PR #236), so a story whose authoring
  flaked still **blocks** rather than shipping un-gated. Flipping the flag
  therefore blocks every AC-carrying story until authoring works. Do it on one
  app, with the units up, and watch the first story.
- **⚠ And do not claim independence you do not have.** `acceptance_author` is
  `azure/gpt-5.4` (`factory/routes.yaml:94`), the same model as `reviewer`
  (`:124`) — acceptable, because what matters is that it is not the dev's model
  (`:130`, `azure/deepseek-v4-pro`). P6 says rank them; A.7 does.
- **Flip prerequisites, unchanged:** `sacrifice` **only**; all apps currently have
  **0 non-terminal stories**, so a flip authors nothing retroactively; the
  `sacrifice-db` container must be up or the gate false-blocks; `hypothesis` is
  missing from sacrifice's backend dev extra, so EARS-form criteria would fail
  collection; and **never flip `template-probe`**, whose app is TypeScript while the
  oracle is pytest-only.
- **Done looks like:** the bench half is done — one benchmark row whose
  `result.json` shows an oracle authored before the dev's first call (#238). What
  remains is one story with a non-null `acceptance_test_ref` that the
  `acceptance-verified` gate actually ran.
- **Effort:** ~2 h to flip and soak one story. **Cost:** ~$1 of extra authoring per
  story; ~$40 to re-measure 19 instances.

### A.2 — A production-tree-changed precondition before any green verdict — **DONE**

**Shipped in `7a2d7a68`, PR #233, 2026-08-04.** Artifacts on `main`:
`factory/diff_paths.py` (the lifted classifier) and
`factory/chain/gates/production_tree_changed.py`.

- [x] **Evidence is one artifact-backed row on `origin/main`** — §1 #5. The chain
      said green on a zero-byte production patch.
- [x] **The existing guard cannot catch it.** `_dev_produced_empty_diff`
      (`factory/chain/handlers.py:2484`, short-circuited at `:2997`) tests the
      **whole** diff, so a diff containing only test files reads as non-empty, the
      story proceeds to review, and the reviewer approves a change to the tests
      with no implementation behind it.
- **What:** partition the post-dev diff into production paths and test paths, and
  refuse a green verdict when the production half is empty. The classifier
  already exists on the bench side (the test-strip list and `_DIFF_HEADER`); lift
  it into `factory/chain/` so one implementation serves both. Route the refusal
  to A.3's underspecified state, **not** back to review — churning review on an
  empty implementation is the expensive failure the empty-diff short-circuit was
  added to stop.
- **⚠ Fail-safe:** an unparseable diff must block, not pass. `_DIFF_HEADER`
  already sets that precedent.
- **Done looks like:** a seeded story whose dev writes only a test file never
  reaches `REVIEWER_REQUESTED_CHANGES` or `REVIEWER_DONE`, and the
  `harumiweb__exstruct-113` trajectory replays to a block.
- **Effort:** ~3 h. Chain code. **Fail-safe review required** — this touches the
  dev → review handoff.

### A.3 — An "underspecified / impossible" terminal state — **DONE**

**Shipped in `7a2d7a68`, PR #233, 2026-08-04.**
`StoryState.BLOCKED_UNDERSPECIFIED` is at `factory/chain/state_machine.py:233`.

- [x] **Evidence:** P7 — GPT-5 cheating **54% → 9%** and o3 **49% → 12%** once the
      agent has a legitimate way to say the task is unsatisfiable.
- [x] **Verified gap.** `StoryState` has eight `BLOCKED_*` sinks
      (`factory/chain/state_machine.py:71-149`), and every one of them means "the
      machine gave up", not "the spec contradicts itself". The nearest,
      `BLOCKED_TESTS_NEED_CLARIFICATION`, is reached only by **exhaustion**
      (`state_machine.py:412`, `:414`, on `EVENT_DEV_EXHAUSTED`). The dev has no
      non-failing way to report contradictory acceptance criteria, so the only
      behaviour that scores is producing *something*.
- **What:** a dev-declarable `BLOCKED_UNDERSPECIFIED` carrying an explicit
  contradiction report (which ACs, which lines), surfaced in `factory inbox`
  rather than retried.
- **⚠ Two guardrails, both non-negotiable.** Declaring it is **terminal for the
  story** — it cannot be used to dodge work twice — and it must **never satisfy a
  gate**: it is a block, and every benchmark denominator counts it as a
  non-resolve. A "get out of work free" state that scores is worse than no state.
- **Done looks like:** a deliberately self-contradictory story reaches the new
  state on the dev's own declaration, appears in `factory inbox`, and counts as
  unresolved in `report`.
- **Effort:** ~4 h (state, transition, persona text, inbox surface). Chain code.

### A.4 — The reviewer gets execution output, not diff text — **MEASURED, NEGATIVE. Do not ship it.**

**DONE, PR #237, merged `f687b7ee`.** Replay over 18 archived reviewer calls (only
the last call per instance carries a label the oracle earned;
`pandas-dev__pandas-63945` never reached review). Model `azure/gpt-5.4`, the
production reviewer route. Pre-registered before any paid call. **Spend $1.2693**
(108 calls, 1,079,340 in / 29,105 out) against a $5 hard stop. **Zero treatment
iterations.** Artifacts committed under `bench/reviewer-replay/`.

- [x] **Evidence it rested on:** P7 — judge agreement with ground truth
      **42% → 72%** on execution output instead of a diff; P5(c) — LLM judges score
      MCC < 15 on code quality, and *more* judge pipeline means *less* validity.
- [x] **Baseline reproduced exactly at $0 first.** TP=6 FP=9 FN=1 TN=2 →
      precision 40.0%, recall 85.7%, accuracy **8/18 = 44.4%**.
      `factory_says_green` gives the identical table.
- [x] **Control-arm fidelity 15/18, 17/18, 15/18** over three replicates, above the
      pre-registered 12/18 floor. The residual is reviewer nondeterminism; no
      temperature is passed in production or in the replay.
- [x] **Result.** Archived recording 8/18 = 44.4% [21.5%, 69.2%]; control rep1
      **11/18 = 61.1%** [35.7%, 82.7%]; treatment rep1 **8/18 = 44.4%** [21.5%,
      69.2%]. **Δ = −16.7 pp.** Paired McNemar exact two-sided **3–0 against the
      treatment, p = 0.25** — not significant, and at n=18 nothing under ±33 pp
      could be. **Control ≥ treatment in 9 of 9 replicate pairings**; the control's
      worst replicate still beat the treatment.
- [x] **Mechanism, and it is an independence error in A.4's own design.** The
      treatment cut findings raised from **26 → 11** across 54 calls per arm and
      raised mean `test_quality_score`. On all three flipped instances the
      control's blocking findings were substantively right and the treatment
      discarded them citing the transcript. The transcript is independent of the
      dev's **narration**, not of the dev's **choices** — a dev on run-until-green
      stops when its own tests pass, so the transcript is **green by
      construction**, and the precedence rule told the reviewer to let that green
      outrank its own reading. **This does not refute P7:** P7's judge sees an
      oracle-side *harness* run; ours saw the author's run history. Different
      variables, same name.
- [x] **A.4's premise text was also wrong.** The reviewer was **never** fed diff
      text only. `## Latest test output` is present on all 31 graded-sweep calls —
      but at **491–1,894 bytes** against a `## PR diff` of **2,053–56,040 bytes**,
      and it is the dev's own `dev_attempts[-1]` output (ANSI included), i.e. the
      dev's self-report. **Absence was never the defect.**
- **Recommendation, recorded: do NOT ship the production change.** Do not add a
  second judge or a judge pipeline either — P5(c) measures that as worse than one
  simple prompt.
- **Forward path: A.4 is not dead, it is blocked on A.1 being real.** The
  genuinely independent execution evidence A.4 needed is the **acceptance
  oracle's** output — authored from spec, before the dev exists, never shown to it.
- **Two incidental findings, open leads.**
  1. **The instance id is in the reviewer prompt on all 18 rows** — the `## Story`
     heading is literally `# <instance_id>`. Not introduced by the splice; this is
     a contamination note about the graded sweep itself.
  2. **The control replay scored 11/18 where production scored 8/18 on identical
     bytes**, so three of production's nine false approvals are recoverable by a
     re-roll alone. That points at **k>1 on the reviewer** — cheap, orthogonal to
     A.4, and the one multi-agent pattern P3 says has clean same-model gains. This
     is an **observation from three replicates, not a measurement.**

### A.5 — Get the broken mutation branch out of the required gate — **DONE, as a DELETION**

> Retitled 2026-08-05. The old title, "Replace `test_quality_score` with a
> diff-scoped mutation score", describes something that did **not** happen:
> `test_quality_score` is still emitted by the reviewer persona and still gates
> the verdict at `factory/chain/handlers.py:3396`. It was left in place because
> replacing it was measured to change **0 of 31 verdicts** (correction #28). What
> shipped was the deletion of the broken ablation branch from the required gate.
> A title that names an unshipped goal is a trap for the next reader.

**Shipped in `79d3576d`, PR #239, 2026-08-05 — and NOT as this section specified
it.** The plan said: rewrite the ablation branch *inside* the required
`tests-meaningful` gate, advisory until measured. That is not what happened.

- **The ablation branch was DELETED from the required gate.** `tests-meaningful` is
  now the static slop detector and nothing else — it cannot shell out, cannot mutate
  a checkout, and cannot block for 600 s on a timeout. About **200 lines removed**.
  This closes the hazard that a single config flag stood between four defects and
  every merge.
- **The repaired measurement lives OFF the merge path** — `factory/chain/mutation.py`
  plus a `factory mutation-score` command. **No gate imports it, and a test enforces
  that.** Record the reasoning, because it generalises: *advisory-by-constant is one
  edit from blocking every merge; advisory-by-not-being-imported is not, and a test
  enforces it.*
- **A new primitive: `check_can_fail`** — ablate the symbol a criterion is about, run
  only the check, and require an **attributable** red. `True` only on an attributable
  red; green, an unattributable red, a timeout and an un-materializable tree are all
  `False` **with the reason**, because "we could not prove it" is not "it can". A.1c
  and A.6 consume it as their failability fallback.
- `gates.mutation_testing` survives as a config field for compatibility and is
  **inert**.

- [x] **What it is today, still: a number the reviewer model asserts about itself.**
      `test_quality_score` is emitted by the reviewer persona
      (`factory/personas/reviewer.md:38`, `:54`, `:178`, `:203`), read at
      `factory/chain/handlers.py:3318`, and the verdict gate is
      `if verdict == "approve" and score >= 0.7` at **`:3396`**. P5(c) puts an
      LLM's judgement of test strength near chance. **PLAN's earlier line reference
      `:3168` was wrong** — that sits inside the empty-diff short-circuit, whose
      hardcoded `"test_quality_score": 0.0` is at `:3162`.
- [x] **⚠ A.5's stated premise is measurably FALSE — do not justify this item as
      "the 0.7 threshold is doing damage".** Measured 2026-08-05 over all 31
      verbatim reviewer calls of the graded n=19 sweep: `approve` with
      `score >= 0.7` = **15**, `approve` with `score < 0.7` = **0** (the lowest
      approve is 0.78); `request_changes` `>= 0.7` = 8, `< 0.7` = 8. **The
      `and score >= 0.7` clause vetoed nothing on any of the 31 calls**, and every
      rejection is independently carried by at least one medium/high finding, so
      the score never blocked alone either. `test_quality_score` is collinear with
      the verdict emitted in the same JSON object — a restatement of the decision,
      not an input to it. **Demoting or deleting it changes 0 of 31 verdicts and
      0 of 19 rows.**
- [x] **The measurement that should replace it existed and was broken.**
      `factory/chain/gates/tests_meaningful.py:63-138` implements real mutation
      testing (no-op a symbol, re-run the suite, fail if it stays green). It has
      **never run** — `mutation_testing: false` in all three app configs
      (`apps/factory/config.yaml:38`, `apps/sacrifice/config.yaml:68`,
      `apps/template-probe/config.yaml:55`) — while `tests-meaningful` **is** in
      `LOOP4_REQUIRED_GATE_LABELS` (`factory/chain/gates/evaluator.py:46-51`).
      That flag is the only thing between this code and every merge.
- [x] **Four verified defects — the reason the branch was deleted rather than kept.**
  1. **It ablates the wrong symbols.** `_changed_public_symbols` (`:140-172`)
     parses each changed file *whole* and returns every public symbol, not the
     ones the diff touched; with `_MAX_ABLATION_SYMBOLS = 5` and a
     `(path, lineno)` sort it takes the top five of the alphabetically-first
     file. Over the last 40 commits: median 21 candidates, 77% hit the cap. For
     `e13d98e0` the five chosen symbols have **zero overlap** with the four the
     commit changed.
  2. **Fail-OPEN on infrastructure failure.** `_run_pytest` returns `False` on a
     600 s timeout or `FileNotFoundError`, and `survived == False` is read as
     "exercised → good" (`:104-107`). There is no green baseline before mutating,
     so an already-red suite, a flaky red, or a failed `uv sync` certifies
     coverage that was never measured.
  3. **It mutates the live story worktree.** `repo_root` is the
     `state/worktrees/` checkout the chain later pushes from, and `_mutate_source`
     round-trips the whole file through `ast.unparse` — on `handlers.py` that is
     4,804 → 2,113 lines with all 756 comments stripped. Restore sits in a
     `finally`, which does not run on `SIGKILL`, and the tick unit has
     `TimeoutStartSec=3h`.
  4. **It fails in dry-run, which is the default.** `:68-75` returns
     `passed=False` when `dry_run`, and `factory auto-merge` defaults to
     `--dry-run` (`factory/cli.py:2464`). Worse, `auto_merge.py:928-942` writes a
     `merge_gates_failed` story event **unconditionally, including dry-run** — so
     flipping the flag manufactures false gate-failure events into the exact
     substrate L1→L2→L3 escalate on.
- **What shipped:** every repair this bullet asked for — diff-hunk-scoped symbol
  selection, a green baseline, timeout and infra failure distinguished from a real
  red, mutation in a throwaway copy, per-`(head_sha, symbol)` caching — landed in
  `factory/chain/mutation.py`, **off the merge path**, instead of inside the gate.
  The reviewer's self-reported number is untouched, which per the measurement above
  changes nothing.
- **Of the three justifications that survived the 2026-08-05 measurement, (a) is the
  one that was resolved.** (a) `tests-meaningful` was in `LOOP4_REQUIRED_GATE_LABELS`
  while broken four ways, one flag from every merge — **closed by deletion**, because
  a gate detached from a real check is worse than no gate
  (`factory/chain/gates/evaluator.py:18-29`). (b) Chain-verdict precision is 6/15 =
  **40%**, so the reviewer's *judgement* of test strength still wants replacing with
  a *measurement* — the measurement now exists, unwired. (c) SWE Atlas grades
  test-writing **by mutation score** (P8), so Phase C comparability is bought.
- **The `mutation_testing` hazard is closed.** The field is inert, so there is no
  longer a flag that breaks every merge. The history is in memory
  `ablation_gate_dormant_and_broken`.
- **Cost context, still true of `factory mutation-score`:** the full factory suite is
  5m36s warm, so five ablations is ~28 min — which is why the cache is not optional
  and why this does not belong on a per-tick merge path.

### A.6 — Harness-owned red→green, with a regression-only fallback — **DONE**

**Shipped in `23d8a871`, PR #242, 2026-08-05, as `factory/chain/red_green.py`.** It
was **folded into A.1c and built once**, because "require the oracle to be red at the
merge base before crediting a green" *is* harness-owned red→green.

**Its caveat now lives in the module docstring, not only here:** only the
fails-at-base half is oracle-free; a hard both-halves gate rejects good patches;
"fails at base" means **at least one test failed or errored**, never "the whole file
was red"; and an `unknown` falls back to regression-only selection, **never
"approve"**. The errors-only refinement from the adversarial pass is in A.1c above.

- [x] **Evidence:** P7 — red→green doubles patch-stream precision at k=1, and it
      is a second, independent kill for the §1 #5 zero-byte class.
- [x] **Red-first was instructed, not verified.** `factory/personas/dev.md:41`:
      "Tests are red-first: a test that passes before the implementation exists is
      slop." The chain trusts that claim. `PRContext.commit_history` already
      carries `tests_run_red: bool | None` per commit
      (`factory/chain/gates/evaluator.py`), which is the dev's report, not an
      observation.
- [x] **What shipped:** the harness runs the **oracle** at the PR's merge base and
      records the result. "Fails at base" is the gate; "passes at HEAD" is already
      `tests-green` (`factory/chain/gates/tests_green.py:69-83` re-derives it at
      merge time). Built on the oracle path rather than on the dev's own new tests,
      which is what makes it independent.
- [x] **The caveat is in the code, per the instruction above.** Agentless measured
      213/300 tests reproducing the bug but only 94/300 also flipping green under
      the gold patch, so a hard both-halves gate rejects good patches — recorded in
      `red_green.py`'s docstring.
- **Done looks like — and this is what was demonstrated end to end on the real
  sacrifice repo:** a spec-derived oracle is credited, and a tautology for the same
  story is rejected.

### A.7 — Check whether the reviewer is actually STRONGER than the dev — and cut the loop if not — **BLOCKED**

**Blocked, and the block is a guardrail working correctly.** There is no free
replay path and the cheap shortcut is refused by design.

- [ ] **Evidence:** P6. Weaker-reviewer-on-stronger-writer **−8.6 pp** (fixed 3,
      broke 13); stronger-on-weaker **+18.1 pp**; self-review **+0.0 pp**. Our
      8-of-13 byte-identical reviewed rows match the inert case.
- [ ] **What we enforce today is difference, not rank.** `factory/routes.yaml`:
      dev standard `azure/deepseek-v4-pro` (`:130`), dev hard
      `azure/gpt-5.3-codex` (`:135`), reviewer `azure/gpt-5.4` (`:124`).
      `model_router.check_review_independence` refuses a colliding config and
      says nothing about which model is better.
- [ ] **No `azure/gpt-5.4` *agent* arm exists in either archive.** gpt-5.4 appears
      only as the reviewer *inside* the factory arm — 31 single-turn text calls,
      never an agent loop — so there is nothing to replay, and ranking it requires
      it to attempt the instances.
- [ ] **The harness refuses the cheap path, correctly.** `openhands` has
      `model_selectable=False` (`bench/swebench_adapter.py:3704-3721`) and
      `resolve_arm_model` (`:3856`) raises `SystemExit` telling you to change
      `routes.yaml` instead. **And that is blocked too:** setting `dev.standard` to
      `azure/gpt-5.4` collides with `reviewer: azure/gpt-5.4`
      (`factory/routes.yaml:124`) and
      `model_router.check_review_independence` (`factory/model_router.py:117`)
      raises `ReviewIndependenceError` at router load, refusing to resolve *any*
      route.
- **Cheapest valid path:** an operator bench PR setting `model_selectable=True` on
  the `openhands` `ArmSpec`, then `--arm openhands --model azure/gpt-5.4`.
  `run_key` (`:3877`) keys the run dir as `openhands@azure/gpt-5.4`, so it
  **cannot clobber** the existing corpus. Queues behind the in-flight bench PR
  (see §0).
- **What it buys:** rank the three deployments on the same 19 instances. Phase C
  gives most of this free — `openhands` at 53% is a capability read for
  `deepseek-v4-pro` under a fixed harness. One more `openhands` arm on
  `azure/gpt-5.4` places the reviewer on the same axis. If the reviewer is not
  measurably stronger than the dev, cut the review cycle to **one advisory pass**
  and keep the deterministic slop gate, which is the layer that actually runs.
- **Done looks like:** a per-model rate table under one fixed harness, and a
  recorded decision on the review loop that cites it.
- **Effort:** ~half a day of analysis. **Cost ~$18** for one 19-instance
  `openhands` arm on the reviewer's deployment (the measured `openhands` arm was
  $15.37 for 16 rows / $18.20 for 19). **[OPERATOR-PR-ONLY]** for the bench half.

### A.8 — Do NOT add review cycles — **DONE, pinned by a test**

**Shipped in `7a2d7a68`, PR #233, 2026-08-04:** `tests/test_loop_cap_ceiling.py`
pins the loop caps, so raising them now fails CI rather than passing review.

- [x] **Evidence, both directions.** P5(b): multiple submissions with feedback
      raised cheating **33% → 38%**. Ours: reviewer cycles `0×7, 1×9, 2×2, 3×1`
      across the 19 factory rows and the resolve rate did not move (§1 #6).
- **What:** nothing. The caps stay at 3 with inner guards at 2
  (`factory/chain/handlers.py:1244`, `:1259`, `:1304`, `:1305`). Any proposal to
  raise them, or to add a second review pass, needs a measured lift first — and
  P5(b) predicts the opposite.
- **Effort:** 0. This item exists so the next agent does not "fix" convergence by
  buying more of it.

---

## Phase B — capture the 10–22 points that exist at our model class

**Rests on P1, P2, P3. Effort ~3 weeks. Cost ~$300 including re-measurement.**

**⚠ Sequence this AFTER Phase A, without exception.** With a self-confirming
oracle, a stronger single agent is just faster self-confirmation, and every
number this phase produces would be measured by the gate §1 #4 says is right 40%
of the time.

P2 puts 10–22 points on the table for a model in our class, and P1 says none of
them come from splitting the work across SDLC roles. The public anchor is blunt:
`deepseek-v4-pro` scores **41.4%** in a plain single-agent tools harness, our own
`openhands` arm scored **53%**, and our chain scored **37%**.

### B.1 — Collapse the code-producing personas into one long-horizon agent — **Phase 1a DONE, and it has a number**

**Phase 1a shipped in `b5673f17`, PR #243, 2026-08-05: the `solo-noreview` benchmark
arm, the chain with the reviewer round-trip removed.** The result and every
interpretation limit are in §1a — read them together, not the number alone. Zero
production code changed: the arm is bench-side only. **`solo-noreview` 9/18 = 50% at
$2.83 per resolved, against `factory` 7/19 = 37% at $5.13; the stop signal did not
fire, so B.1's premise survives.** Phase 1b is the next step and it is a
measurement, not a build: **both arms in ONE sweep on ONE commit, ~$62.**

- [x] **Evidence:** P1 (no SDLC-role decomposition in the top 20; no sequential
      critic anywhere in it; EPAM *removed* its unit-testing stage and its
      multi-iteration loop and scored 76.8%, joint-highest for its model) and P2
      (the points come from tools, context management and long horizons **inside
      one agent**).
- [x] **Our horizon is long enough, and chopped up.** `sandbox_run`'s default is
      `max_iterations = 600` (`factory/runner.py:1643`), with per-persona caps of
      180 for `onboarder` and 300 for `test_implementer` (`PERSONA_ITERATION_CAPS`,
      `factory/runner.py:1621-1630`). So iteration budget is **not** the deficit —
      the deficit is that the budget is split across handler invocations, and
      since #196 the dev inner loop gets at most **two** sandbox attempts per
      invocation, so `red → red → green` cannot converge in one tick.
- **What:** one dev-and-tests agent per story, no `test_implementer` hand-off, no
  reviewer round-trip inside the inner loop. Keep every deterministic gate —
  those are the durable half, and P2's points do not come from deleting them.
- **⚠ This deletes product surface, and it is the largest change in this plan.**
  It also removes the reviewer from the inner loop, which A.7 may already have
  demoted. Do A first, then A.7's ranking, then this.
- **Done looks like:** one arm on the same 19 instances, reported beside
  `openhands` and the current `factory`, with the model mix printed per row.
- **Effort:** ~1 week. **Cost ~$40** to re-measure 19 instances.

**The production design is SETTLED and operator-approved. Do not redesign it.**

- **Most of B.1's collapse already shipped.** The Loop-4 rewrite already removed the
  separate test-author persona: the dispatch table goes straight from story-written
  to dev, and the dev persona already states it owns code *and* tests. What remains
  is only (a) remove the reviewer round-trip and (b) give the dev **one continuous
  conversation** instead of several fresh ones reading a summary of each other.
- **Mechanism: one per-app config value `chain_mode: solo`, default `chain`**, read
  in **exactly one place** (story spawn), which stamps the existing per-story
  chain-variant field. A story spawned under one mode finishes under it, so
  **flipping mid-flight has blast radius zero for in-flight stories**. Reverting is
  deleting one line. Needs **one** new state-machine edge and no new story state.
- **The horizon change buys no loop budget.** Today 3 fresh conversations × 600
  iterations = 1800; solo is 1 conversation × 3 rounds × 600 = 1800. Iteration- and
  attempt-neutral. **One number must move**: the 1800 s sandbox wall clock to 5400 s
  for solo, or three rounds silently get a third of the horizon each. It is a
  **timeout**, not a loop cap — and the new round constant must be added to the
  loop-cap ceiling test **in the same PR**.
- **Hard coupling: `chain_mode: solo` must refuse to load unless
  `gates.acceptance_oracle: true`**, enforced at config load. With no reviewer, the
  oracle is the only signal the dev cannot influence. And because a longer horizon is
  more turns in which to go looking for the oracle, the leak check must be a
  **blocking precondition on every solo dispatch**.
- **⚠ THE RESTRAINT, pre-committed.** A SWE-rebench win licenses solo mode for
  **issue-shaped work only**. Loop 1 builds an app from a backlog, which is closer to
  the shape where role decomposition *does* win. **Do not flip the default on loop 1
  before C.3 (Commit0-Lite) reports.** The reconciliation worth testing: the
  published multi-agent win decomposes by *work unit* — isolated worktrees,
  branch-and-merge, which this design keeps entirely — not by *SDLC role within one
  work unit*, which is the only thing B.1 removes.

### B.2 — Real navigation tooling inside the one agent

- [ ] **Verified current state.** The dev gets OpenHands' `get_default_agent`
      preset (`factory/runner.py:1813`) — bash plus a file editor. **No symbol
      search, no partial-file views.** `get_planning_agent` is imported at
      `factory/runner.py:934` for a different path.
- **What:** symbol search, tree-sitter partial file views, and a `status` tool
  that forces explicit completion — then **re-prompt any trajectory that ends
  without it**. We already have half the last one: `SELF_SUMMARY:`
  (`factory/runner.py:981`, extracted at `:997-1016`) is a marker the dev is
  *asked* for, and nothing re-prompts a run that omits it.
- **Why this before B.3:** P2 attributes the fixed-model spread to tools and
  context management, which are cheap; sampling k candidates multiplies whatever
  one trajectory is already worth.
- **Done looks like:** trajectory counts showing symbol-search calls, zero
  trajectories ending without an explicit completion, and a re-measured arm.
- **Effort:** ~3 days. **Cost ~$40** to re-measure.

### B.3 — Generate-k → select: regression filter FIRST, reviewer repurposed from critic to selector

- [ ] **Evidence:** P3. TRAE 70.6% → **78.8%** with 30 candidates + a
      regression-test filter + a selector, identical model. Skywork-SWE-32B 38.0%
      → **47.0%** at best-of-8, identical model. Winners execute the existing repo
      tests to kill regressions **before** any jury or vote.
- [ ] **Do not build a selector at k ≤ 3.** CodeMonkeys: random-of-10 45.8% vs
      selected 57.4% — most of the value is in *having* 10 candidates, and
      selection at k=2 or 3 is near-worthless. Either budget for k ≥ 8 or skip
      the item.
- **Costed honestly.** `openhands` measures at $18.20 / 19 = **$0.96 per
  instance**, so k=8 is ~$7.7 per instance ≈ **$146 for one 19-instance arm**;
  k=30 is ~$550 and out of budget at this n. Budget k=8 and say so in the report.
- **The seams already exist.** `factory/chain/gates/tests_green.py:69-83`
  re-derives the truth at merge time — that is the regression filter. The reviewer
  already emits a structured verdict; have it **rank N candidate patches** instead
  of critiquing one, which is also the only reviewer-shaped role P1 finds at the
  top of the leaderboard.
- **Done looks like:** `resolve@1` and `pass^k` reported separately for k=8 on the
  same instances, with the regression filter's kill count printed.
- **Effort:** ~1 week. **Cost ~$150** for one k=8 arm. **[OPERATOR-PR-ONLY]** for
  the bench half.

### B.4 — Retry only on non-termination, never on review disagreement

- [ ] **Evidence:** P5(b) — more submissions with feedback means more gaming —
      plus §1 #6, where cycles happen and nothing moves.
- **What:** a retry fires when the agent fails to *terminate* (cap hit, crash, no
  explicit completion from B.2), never because a critic disagreed. Under B.3 the
  review loop stops being a retry trigger at all, so this is mostly a deletion:
  `_MAX_REVIEW_CYCLES` (`factory/chain/handlers.py:1305`) exists to bound exactly
  the loop B.3 removes.
- **⚠** Keep the cap while the loop exists. Do not delete the bound before the
  loop it bounds.
- **Effort:** ~2 h once B.3 lands.

---

## Phase C — measure where the claim can actually be expressed

**Rests on P4, P8. Effort ~3 weeks. Cost ~$900.** **[OPERATOR-PR-ONLY throughout
— `bench/**`]**

We measured our chain on single-issue patching, which P1 identifies as the one
task shape where role decomposition is *known* not to help. C.3 is the direct
test of the shape where it is known to help. C.4 — more SWE-rebench — is demoted
because it cannot produce a positive result no matter how much it costs.

**⚠ Run order, INVERTED 2026-08-05 by C.1's findings: C.1 (done) → C.3 → C.2 →
C.4.** The section numbers are left alone so references keep resolving; the
ordering is what changed. Commit0-Lite (C.3) is Python/pytest end to end, so
`_GRADE_SCRIPT`, per-node `PASSED` grading, the oracle store, the five report
tables and the Clopper-Pearson / McNemar statistics all transfer untouched — 4–7
days — and it is the only option that can come back positive. SWE Atlas (C.2)
costs more than this plan priced it; the reasons are in C.2. Keep C.2 — after C.3.

### C.1 — Free availability probe, first — **DONE, $0**

**PR #235, merged `b721f65d`, cost $0.** Deliverable committed at
`bench/benchmark-availability-2026-08.md`. **All seven probed candidates EXIST** —
every arXiv id resolved to a real paper with a real public artifact, no name was a
phantom. It also produced two ids this plan was missing (DevOps-Gym **2601.20882**,
SWE-EVO **2512.18470**), corrected P8's "axis D is covered by nothing published",
and inverted the Phase C run order.

- [x] **1 day, $0, and the highest expected value per dollar in the plan.** Probe
      whether these are actually runnable: **RoadmapBench** (2605.15846 — 115
      tasks, median 5 weighted subtasks, hidden target-version tests, git tags
      pruned, OpenHands baselines published — the best axis fit we found),
      **ChainSWE** (2607.02606 — sequential dependent fixes, up to 70%
      degradation with chain length), **SlopCodeBench** (2603.24755 —
      erosion/verbosity over 196 checkpoints; best agent passes 14.8%),
      **SWE-EVO**, **DevOps-Gym**.
- **⚠ Verify the names before you quote them.** These reached us through a fetch
  pipeline that silently rewrites proper nouns — see the confidence rule in §2 and
  the note in `SOTA-RESEARCH-2026-07.md`. Check each arXiv id resolves and each
  dataset has a downloadable harness. A "this benchmark does not exist" outcome is
  a *successful* probe.
- [x] **Done looks like:** a five-row table — name, arXiv id resolves y/n, harness
      public y/n, oracle shipped y/n, axis covered — committed under `bench/`.
- **Effort:** 1 day. **Cost $0.**

### C.2 — SWE Atlas, n=60, three arms — **run AFTER C.3**

- [ ] **Why this suite:** 2605.08366 ships its harness **and** its judge prompts,
      284 expert-authored tasks, frontier ~42–43% Pass@1 with Pass^3 dropping
      30–50% (so it has headroom and it measures consistency), and it grades
      **test-writing by mutation score** — which pairs with A.5 and gives us one
      external number for the layer §1 #4 says is broken.
- [ ] **Arms: `factory`, `openhands`, `claude-5`.** `openhands` is mandatory in
      every sweep from now on — it is the only pair that holds the model fixed and
      varies the harness, so it is the only arm that can measure the product. A
      factory number published without it is a number about the model.
- [ ] **⚠ It costs more than the line below prices it. Verified in C.1's probe.**
      **200 of its 284 tasks are not Python** (Go 106, Python 84, TS/JS 56, C/C++
      38). Its oracle is a **paid LLM judge** — `EVAL_MODEL` defaults to
      `claude-opus-4-5` — which both contradicts our own P5(c) evidence and
      **defeats `report --check` byte-stability**. And it needs Harbor + Modal +
      ~4.28 GB per image. None of that kills the suite; all of it says C.3 first.
- **Done looks like:** the five pre-registered tables, an archived
  `report --check`-green run, and the mutation-score column filled.
- **Effort:** ~1 week for the adapter. **Cost ~$400** — re-cost it against the
  four findings above before committing to the number.

### C.3 — Commit0-Lite, n = 16 — the direct test of P4 on our own architecture — **run FIRST in Phase C**

- [ ] **This is the highest-information experiment in the plan for the product
      question, because it is the only one that can come back positive.** CAID
      (2603.21489) measured its Commit0 lift — build a library from scratch — using
      centralized delegation with **isolated git worktrees and branch-and-merge**.
      That is our architecture, including primitives we already have
      (`factory/chain/worktree.py`, per-story worktrees, `freshen_behind_prs`,
      conflict-rebuild-on-fresh-branch). Both CAID arms are public
      (`JiayiGeng/CAID`, `run_single.sh` / `run_multi.sh`), so **C.3 reproduces a
      published comparison rather than inventing one.**
- [ ] **The plumbing transfers untouched, which is why it goes first.** Commit0 is
      Python/pytest end to end, so `_GRADE_SCRIPT`, per-node `PASSED` grading, the
      oracle store, the five report tables and the Clopper-Pearson / McNemar
      statistics all carry over. 4–7 days.
- [ ] **Arms: `factory` and `openhands`, same model, n = 16.** `SPLIT_LITE` is
      exactly **16 repos** (`commit0/harness/constants.py:87`), so this plan's
      earlier "n ≈ 15" matches the published split. **Pre-register the effect you
      are actually powered for, and it is not 14.7 pp** — per P4, +14.7 is the
      MiniMax 2.5 row, the frontier effect is +6.0 pp, and at n=16 paired a 6-pp
      effect is far below resolution. Note also that CAID scored Commit0 as a
      **continuous mean with a paired t-test**, not binary resolve; pre-register
      which statistic we report.
- [ ] **⚠ The Commit0 integrity trap — design grading around it before spending
      anything.** The tasks reimplement stripped bodies of famous PyPI libraries
      (jinja, pyjwt, babel, cachetools, marshmallow), so the reference
      implementation is one `pip download` away: **grading MUST be offline.**
      Contamination is maximal by construction, which makes any Commit0 number a
      **paired within-corpus comparison and never a published rate.**
- **⚠ State the asymmetry up front.** A positive result here does not rehabilitate
  the chain on single-issue patching; it relocates the claim to a different task
  shape, which is exactly what P1 and P4 together predict. Write that in the
  pre-registration, before the data.
- **Done looks like:** a paired two-arm table on Commit0 with the same
  archive/`--check` discipline as §1.
- **Effort:** 4–7 days for the adapter, and a plumbing probe first (queued behind
  the in-flight bench PR — see §0). **Cost ~$450.**

### C.4 — Widening SWE-rebench — DEMOTED, with its honest costing

- [ ] **What it costs and what it buys.** n=60, k=3 costs **$513 Azure + ~$550
      subscription** and moves the MDE from ±38 pp to ~**±12–15 pp**. Our effect is
      −7 pp on the committed report and −16 pp on the later one. Detecting an
      effect that size needs **high hundreds of instances, $4–6k**.
- [ ] **The structural limit.** **Widening can bound the negative; it can never
      show the chain works.** Do it when a bound is what you need — e.g. to state
      publicly "the chain is not worse than one agent by more than X" — and not
      before C.1–C.3.
- [ ] **The design below is correct and cheap to reuse.** Keep it verbatim when
      C.4 runs; it was built and paid for in Phase 1.6.
  - Manifest **frozen before the first run**: published RNG seed, hash-pinned
    manifest (task id → repo → base SHA → problem-statement hash), committed and
    tagged. **k ≥ 3**, reporting `resolve@1` and `pass^k` separately. Measured
    variance to budget against: 0/10 oracle flips over 10 same-condition factory
    replications (95% upper bound on per-instance flip probability 25.9%, i.e.
    ±3 instances at n=19), 1/10 chain-verdict flips, and cost varying up to 2.6×
    on the same instance.
  - **Filter on `created_at`, never on split label.** SWE-rebench's `2026_03`
    split (110 rows) is exactly `created_at > 2026-03-01` — it aggregates March,
    April *and* May PRs.
  - **Two strata.** Measured supply in `nebius/SWE-rebench-leaderboard` (860 test
    rows): `>2026-01-01` = 215, `>2026-02-01` = **167**, `>2026-04-24` = **30**,
    `>2026-06-01` = **0**; corpus max **2026-05-12**. Main stratum: 120 tasks from
    `>2026-02-01` (clears both OpenAI deployments' published 2025-08-31 cutoff).
    High-margin stratum: the 30 tasks from `>2026-04-24` (additionally clears
    `deepseek-v4-pro`'s release-date bound). Report every arm **per stratum**. At
    n=30 that resolves a large effect (~±9 pp at 50%), not a subtle one.
  - **The suite of record is SWE-rebench and it is healthy** —
    execution-validated, docker image and oracle shipped in-row, monthly splits
    through 2026-05-12. Rejected alternatives: **SWE-bench Verified** (the
    comparability standard, but 2023 instances and the most contaminated corpus in
    the field — use only if a leaderboard-comparable number is the goal),
    **SWE-bench Pro** (frozen after OpenAI's ~30%-broken audit, and it leaks
    post-`base_commit` git objects via `git log -p`), **SWE-rebench V2** (nothing
    after 2026-01), **MultiLang** (no Python). **SWE-bench-Live is dead** — last
    modified 2025-09-18, newest instance 2025-09-02, 0 rows after 2025-10-01, so
    the old 30-instance freshness control was never executable.
  - **Five arms, `_ARMS` is the registry.** `factory`; `openhands`
    (**mandatory**); `bare` (its one pre-committed repaired run is spent, it reads
    6%, keeping it is an operator decision and it anchors nothing); `claude-5` and
    `claude-4.8` on the **Claude Code CLI on a subscription, never an API or Azure
    route** — verified invocation `claude -p <prompt> --model <id> --max-turns 60
    --output-format stream-json`, `apiKeySource: "none"`, cwd = the instance clone.
    Keep both: the probe came back clean (§1 #8) and the second arm is near-free.
  - **Record the bound, not just the date.** `deepseek-v4-pro` publishes **no**
    cutoff — absent from the model card and from arXiv 2606.19348 (full text
    grepped) — so its only defensible bound is its **release date, 2026-04-24**.
    Azure catalog metadata is *not* a source: Microsoft published Oct 2024 for
    GPT-5.2 whose real cutoff is 2025-08-31 (MS Q&A 5667726). Print `margin_days`
    per row **and** the bound type.
  - **State what a positive margin does not buy.** `created_at` is the *merge-PR*
    date; the issue text, its pre-solution comments (the dataset ships
    `hints_text`) and the repository wholesale all predate it. arXiv 2506.12286
    shows models name the file to edit from repo name + issue text alone far above
    their accuracy on equally-popular non-benchmark repos; arXiv 2410.06992 found
    32.67% of SWE-bench issues carry the solution in the issue or comments and
    31.08% of passing patches pass only because the tests are weak — together
    dropping SWE-agent+GPT-4 from 12.47% to 3.97%. A date filter touches neither.
    The strata are a *measurement*; the date is only a *bound*.
  - **If you want a genuinely post-cutoff public suite, wait or build.** Nebius
    ships ~40–55 validated instances/month with a ~10–12 week publication lag, so
    a 120-row `>2026-05-31` pool should exist around **Oct–Nov 2026**. Minting
    your own (SWE-Bench++ style, arXiv 2512.17419) means owning docker images and
    oracle extraction — multi-week, and `swebench_harness_selftest` is why to
    respect that: the gold-patch control caught three harness bugs that each faked
    a 0% score.
- **Effort:** ~2 weeks. **Cost ~$1,060** all in. Not before C.1–C.3.

---

## Phase D — SacrificeBench

**Rests on P9. Effort 2–3 person-weeks, dominated by human test authoring. Cost
~$400.** **[OPERATOR-PR-ONLY — `bench/**`]**

**The only design in this plan that can measure the real product claim.** Every
public suite scores single-issue patching. Our claim is a chain that turns a
written direction into merged, deployed software over days, and the axes that
would test it — **B** concurrent stories, **D** CI-failure recovery, **E** docs
and context maintenance, **F** dollars per delivered unit over days — are covered
by **nothing published** (P8).

- [ ] **Corpus: the held-out directions.** Verified 2026-08-04 against
      `state/factory.db`: `apps/sacrifice/directions/` holds **76** directions,
      **45 `pm-validated`** and **31 `closed`**. The 45 are the pool; the 31 are
      contaminated (the factory has shipped them). Filter to behaviourally
      testable and **expect 20–25 tasks**.
- [ ] **Oracle: acceptance tests authored by a HUMAN from the direction text
      alone.** Never by the factory, and never by an LLM. An LLM-authored oracle
      reintroduces the self-consistency bias *as the oracle* — ProdCodeBench
      (2604.01527) found ~65% of its retained diffs were AI-authored and flagged
      exactly this. This is the line item that costs the person-weeks, and it is
      the line item that makes the benchmark worth anything.
- [ ] **Mandatory red-baseline control.** The test must **FAIL at the
      pre-direction base SHA** or the task is void. Same principle as A.6, and the
      only cheap protection against a task that was already satisfied.
- [ ] **Reuse `bench/swebench_adapter.py`'s guardrails wholesale** — encrypted
      oracle stored outside the repo, test-edit stripping asserted in code,
      collection-config refusal (`pyproject.toml`, `pytest.ini`, `tox.ini`,
      `setup.cfg`, `noxfile.py`, `conftest.py`, `sitecustomize.py`, `*.pth`),
      `--network none` grading in a fresh `--rm` container, per-node `PASSED`
      grading, flat workspace isolation, `audit.json` with `prediction_sha256`. Do
      not re-derive any of it; four retractions paid for that code.
- [ ] **Uniquely post-cutoff by construction.** The corpus is private, so no
      public instance can postdate it — and no public instance postdates
      `claude-opus-5`'s May-2026 cutoff either, with Nebius supply not reaching
      that until ~Oct–Nov 2026.
- **⚠ It cannot produce a leaderboard-comparable number.** Report it as a paired
  within-corpus comparison — `factory` vs `openhands` vs `claude-5` on the same
  directions — and never as a rate comparable to anything published.
- **⚠ It is the one place axes B/D/E/F can be scored at all**, so design the
  scoring for them up front: stories in flight concurrently, CI failures injected
  and recovered, context docs refreshed, and dollars per delivered unit measured
  over days rather than per instance.
- **Done looks like:** a pre-registration committed before the first run, 20–25
  tasks with human-authored oracles, a red-baseline control pass on every task,
  and a paired three-arm table.
- **Effort:** 2–3 person-weeks. **Cost ~$400** of compute.

---

## Phase E — cheap safety, and the FMS decision

**Effort ~1 day of work plus the FMS soak. Cost ~$0.** These are the items from
the old Phase 3 that survive on their own merits, plus one decision now justified
on cost alone.

### E.1 — Snapshot `state/factory.db` before each tick — ~2 h

- [ ] **Verified gap:** no snapshot mechanism exists anywhere in `factory/**`.
      `state/factory.db.bak-1784662396` is a one-off manual copy. The staging twin
      (`factory/manager/staging.py`) guards **source only**.
- **What:** before the tick's first write, use the sqlite3 **backup API** (not
  `shutil.copy` — the manager daemon writes concurrently) into
  `state/db-snapshots/factory-<ISO>.db`, keeping the last 10.
- **Why:** a prior session lost a whole run to 6 poisoned invalid-enum `closed`
  rows that failed every tick, with no clean rollback point.
- **Files:** `factory/chain/orchestrator.py` (tick entry) or the `factory tick`
  wrapper in `factory/cli.py`. Confirm `state/**` gitignore coverage; don't
  assume.

### E.2 — Ratchet the package-wide `mypy` count, per file — ~1 h

- [ ] **Verified:** `.github/workflows/test.yml:145-154` runs two mypy steps.
      `mypy factory/chain/gates/` is a real zero-tolerance gate and is clean —
      **leave it alone**. The package-wide step pipes to `|| true`, counts with
      `grep -c "error:"` and emits a `::warning::`. Advisory, no baseline.
- [ ] **The drift is larger than the docs claim.** `test.yml:143-144` says "~85
      pre-existing findings"; measured 2026-08-01: **99 errors in 29 files**.
- **What:** commit `mypy-baseline.json` mapping **file → error count** (not a
  scalar — a scalar lets you add three errors in one file and delete three in
  another and stay green). CI fails when any file exceeds its entry. Count from
  `--output json` or the `Found N errors` line, **not** `grep -c "error:"`, which
  counts substring matches and is inflated by mypy's own excerpts.
- **Ship standalone.** It blocks unrelated PRs the moment it lands. Any lockfile
  bump must re-baseline in the same PR. Also fix `CLAUDE.md` to name the baseline
  file instead of "compare against `origin/main`".

### E.3 — Make `software-factory-copy` private — 5 min **[OPERATOR ACTION]**

- [ ] **Verified:** `gh repo view xvanov/software-factory-copy --json visibility`
      → `PUBLIC`. It is the staging twin (`factory/manager/staging.py:72`) and
      receives **every candidate self-edit diff** on a staging branch before
      promotion — including the 3 of 20 the gate later rejected.
- **Command:** `gh repo edit xvanov/software-factory-copy --visibility private
  --accept-visibility-change-consequences`
- **Then run one staging validation end to end.** The flow clones over SSH, so a
  private repo is fine provided the manager's identity has access — and
  `staging.py` failing closed would silently block every self-edit.

### E.4 — Isolate gate exceptions, and make a scan error GLOBALLY blocking — ~2 h

- [ ] **Verified:** `factory/chain/gates/evaluator.py:188-197` calls
      `mod.evaluate(...)` with no `try`, while its docstring (`:175-176`) promises
      "failure of one gate does not short-circuit the others" — true for a
      *returned* failure, false for a *raise*.
- [ ] **What actually happens today — checked, do not re-diagnose.** Both
      orchestrator call sites catch (`orchestrator.py:2591`, `:3117`), so the tick
      does not crash and the merge is not waved through; `summary.errors`
      non-empty makes `factory tick` exit 1. It is fail-safe by accident. The real
      costs are that one raise aborts merge evaluation for **every remaining
      fixture** on that tick, and `factory/cli.py:2480` (`factory auto-merge`) is
      unwrapped. **Zero gate raises have occurred in production** (441 ticks at
      `errors=0`).
- **⚠ The naive fix is a fail-OPEN regression.** `missing_labels` is computed only
  over `required_gate_labels(...)` (`auto_merge.py:948-954`), so a raise in a
  **non-required** gate that becomes a non-required blocking `GateResult` is
  filtered out and **the merge proceeds** — strictly weaker than today. So:
  `scan_error` results are **globally blocking**, evaluated alongside
  `missing_labels` and **not** filtered through `required_gate_labels`; append to
  `summary.errors` so the tick still exits non-zero; wrap `cli.py:2480`. Adopt the
  precedence rule while you are there: **can't-run > found-something > clean**.
- **This is robustness, not a closed failure class.** Sell it as such.

### E.5 — Bring the units up, watch one cycle, and decide the FMS on cost — **promoted**

**⚠ Sequenced, deliberately: the units stay OFF until A.1's blockers close, then
come up with the acceptance oracle enabled on one app.** That makes E.5's soak and
A.1's soak one cycle, and it stops a live tick racing an agent's test runs. See §0
for the current operational state.

- [ ] **Start:** `uv run factory on`, then confirm
      `systemctl --user status factory-manager.service factory-tick@sacrifice.timer`.
      Check `Result=` and `errors=` **across two runs** — "services up" is not
      "sustains".
- [ ] **Watch one full L1→L4 cycle** (L1 fires every 60 s), then re-read
      `state/.manager_apply_history.json` and count entries with a non-null
      `pr_number`. Baseline: **163 attempts, 0 PRs, newest 20260723**.
- [ ] **Decision rule, pre-committed:** if after one full cycle *and* one genuine
      concern reaching L4 the yield is still **0 PRs**, delete the L4 tier. Keep
      `factory/manager/recovery.py` (the auto-fix layer for known operational
      faults — that one demonstrably works) and keep `fms_yield.py` as the
      detector. **[OPERATOR-PR-ONLY]**
- **The cost case, which is now the strongest argument in this phase.** The
  manager has consumed **$1,028.58 = 52.0% of all-time LLM spend** ($972.23 of it
  `manager_watcher` alone, 44,127 runs at a 60 s cadence) for **zero shipped
  PRs**. In July it was $371.60 of $588.78 — deleting it takes per-story cost from
  **$7.85 to $2.90**. And 165 L3 proposals collapse to **37 distinct concern
  classes (78% redundant)** with 107 carrying `escalate_to_human: true`: the tier
  mostly re-reports the same handful of problems to a human. Set against §1's
  finding that orchestration is not what produces value here, a self-improvement
  tier that has never shipped is the easiest $1,000 in the repo.
- **Do not delete before measuring.** The wiring bugs were fixed in PR #113
  (2026-07-24) and the newest apply attempt predates parts of that work, so the
  tier has arguably never run in its fixed form. One honest cycle first.
- **This step is the only way to generate a *production* `prompt_bodies` corpus**,
  which today has **zero rows** — the writers landed after the last run. It is not
  a prerequisite for Phase A's replay corpus; that corpus lives in the bench run
  dirs. Read the corrected facts in the Phase A preamble.
- **Effort:** ~half a day of watching, plus the deletion PR if the rule trips.

### E.6 — Extend the persona contract-collision validator — ~2 h

- [ ] **Verified:** `factory/personas/validator.py:59-62` `_ENUM_CONTRACTS` covers
      only `scope` and `chain_kind`. The check already runs in CI
      (`tests/test_persona_loader.py:60`, `:296` call `validate_all`).
- **Why this and not a persona prompt audit:** the story-14 non-convergence was a
  prompt *example literal* colliding with a live contract value.
  `_check_contract_collisions` catches that mechanically. See "Rejected" #7 for
  why the personas are not the bloat they look like.
- **What:** extend `_ENUM_CONTRACTS` to every field whose values are enumerated in
  code.

### Deferred — named, costed, and not scheduled

Each of these was in the old plan and does not survive the new ordering. Listed so
nobody re-proposes them without new evidence.

- **Patch-apply fuzzing (old 3.1 — port Hermes `fuzzy_match.py`).** **Payoff is 21
  historical failures**, not 179: of the improver's 179 apply failures, 158 were
  `dirty_working_tree`, already fixed (Corrections #10). Fuzzy matching addresses
  only 16 `corrupt patch` + 5 `patch failed`. If it is ever revisited, try
  `git apply -3` on both call sites first
  (`factory/chain/factory_improver_apply.py:490`, `factory/manager/apply.py:958`)
  and re-measure before porting 967 lines. **[OPERATOR-PR-ONLY]** — both halves.
- **Lint/typecheck before review (old 3.2).** `_autoformat_changed_py_before_pr`
  (`factory/chain/handlers.py:3592`) is format-only; there is no full `ruff check`
  gate, no `mypy` step and no lint gate in `factory/chain/gates/`. Deferred because
  it buys style, not correctness, and Phase A/B may move the handoff it hooks
  into. **While deferring it, do not forget the four write-never columns it was
  going to use** — `stories.lint_passed`, `format_passed`, `types_passed`,
  `coverage_passed` have zero references anywhere in `factory/**`. Drop them or
  wire them; do not leave them next to the `smoke_passed` bug #195 removed.
- **Typed block kinds + recurrence counter reset only on merge (old 3.3).** Hermes
  `kanban_db.py:104-134` / `:5847-5856` is a good design — the unblock path
  deliberately does not reset `block_recurrences`, because "resetting the
  recurrence counter on unblock is exactly the amnesia that let the loop run
  unbounded" — and the motivating failure (`blocked_ci_unresolved` terminal with
  no path back) is real. Deferred because no story is currently blocked and A.3
  adds the one new block kind the evidence demands. Revisit if blocked stories
  reappear. **[OPERATOR-PR-ONLY]** for the `recovery.py` half.
- **Wire or drop `gates_failed_json` (old 3.9).** #195 added
  `MergeAction.gates_failed`, the column (`auto_merge.py:126`, `:200`, `:234`) and
  the `merge_gates_failed` story event (`:933`) — with **one writer and zero
  readers**. The diagnosis reaches a human via `factory trace` and nothing else.
  Deferred, not resolved: pick "feed it into the dev re-dispatch findings path
  (and cap that loop)" or "drop the column" the next time this area is open.
- **GEPA on the reviewer (old 5.1).** ~150 rollouts ≈ $6, corpus = 118 merged PRs
  plus review history (`stories.reviewer_history_json`, the `review_events` table,
  `state/events/chain_steps.ndjson`). Deferred twice over: it is blocked on prompt
  bodies that have **zero production rows**, and it optimizes a critic that A.7
  may demote and B.3 may repurpose. Do not tune a component you may delete.
- **Merge gates → GitHub Actions + Projects v2 (old 5.2).** Still worth
  *evaluating* — moving gates to required GH checks would make `proxy ≠ real`
  structurally impossible for the merge decision, and `CLAUDE.md` already declares
  GitHub the only source of truth for merge reality. Cost: loses the local dry-run
  fast path and couples every gate to Actions minutes. Write the trade-off up
  before building anything.

---

## Rejected — LifeOS-derived proposals, adversarially reviewed 2026-08-02

A survey of `danielmiessler/LifeOS` (cloned at `/home/k/LifeOS`) produced 11
candidate additions. Three adversarial reviews rejected **nine**. Recorded so
they are not re-proposed. Each entry is the refutation, not the proposal.

1. **`evidence-corroborated` gate** — classify the dev's completion claim,
   corroborate it against the ledger. There is no prose claim in the merge path
   to classify: `runner.py:2107-2108` runs pytest and scans git *itself*, and
   `RunResult.test_run_passed` is the factory's own observation, never the
   model's word. `gates/tests_green.py:69-83` already re-derives the truth at
   merge time and its docstring states that as the design intent. The
   corroborating ledger does not exist — there is **no `sandbox_run` table**,
   `prompt_bodies.ndjson` has **zero production rows** (#193 merged 2026-08-01;
   units stopped since ~07-30), `chain_steps.ndjson` still has zero `retried` /
   `review_cycle` rows, and `runs` carries no diff, file list, or exit code. The
   proposed 118-PR replay corpus is fiction (and the count is 138).
2. **Gate-reason lint** — require a problem *and* a remedy in every failing
   `reason`. Roughly 15 strings across 6 files; "names a remedy" is not
   statically decidable, so any implementation is a keyword heuristic — a proxy
   gate, in the repo whose #1 failure pattern is `proxy ≠ real`. The loop it
   claims to prevent does not exist: nothing reads the string (see the deferred
   `gates_failed_json` item).
3. **"L4 falsify, not L4 apply"** — have the manager emit a red replay fixture
   instead of a diff. The premise is false. Of 163 apply attempts only **58 ever
   carried a patch**, and **53 of those died on `dirty_working_tree`**, an
   environment bug fixed 2026-07-24 — `apply.py:864-869` records exactly this.
   Not one attempt was ever rejected for diff quality; zero reached review. The
   107 escalations are **information** failures (84 are "source bundle
   insufficient"), and a model that cannot see `tick()` cannot write a fixture
   for it either. Run E.5 instead.
4. **Detector graduation lifecycle** — log-only → counterfactual corpus →
   blocking. Manager detectors are already advisory by construction
   (`factory/manager/detectors/__init__.py:1-6`: "Detectors never make
   decisions"); the only blocking path is `halt.py`, which is L3, not a
   detector. The motivating episode (SM-truncation) was **test pollution** — a
   counterfactual corpus built from those same contaminated streams scores
   FP = 0 and passes the very case it was designed to catch. And no adjudicator
   is specified for up to 190 observations per detector.
5. **Turn on the ablation gate** — superseded by A.5. The gate was broken four
   ways; the flag flip was not the adoption path, and flipping it as an experiment
   would have broken every merge. **Moot since 2026-08-05 (#239):** the ablation
   branch was deleted from the required gate and `gates.mutation_testing` is inert,
   so there is no longer a flag to flip.
6. **Property tests in the dev persona** — already ships in a better seam.
   `hypothesis>=6` is a dev dependency, `acceptance_author.md:52-72` authors
   Hypothesis property tests from EARS criteria, and `acceptance.py:101-194`
   injects that automatically. The cited evidence does not support it either:
   `right_place_wrong_fix` is defined at `swebench_adapter.py:1349` as **file
   overlap only**, and those failures read as unstated-convention failures —
   which #201 already addressed. **Amended 2026-08-04:** the better seam this
   refutation points at has never been switched on — see A.1.
7. **"Bitter Pill" audit of the 22 personas** — the trim already happened.
   `27008931` (2026-06-11) cut `dev.md` 177→108 and `reviewer.md` 158→102,
   citing the same story-14 incident this proposal cites. Genuinely cuttable
   today is ~25 lines (`pm.md:242-251`, `sm.md:127-135`, two role preambles) —
   5–8%, not bloat — while several lines that *look* cuttable are measured
   load-bearing (`dev.md:54-64`, 2/2 vs 0/2). The "no regression" guard is
   statistically fake: on a 5-instance precision denominator it fires only at
   0/5, which occurs **32.8%** of the time when nothing changed.
8. **Per-persona A/B with a no-persona arm** — the SWE-bench harness runs
   `allowed = {"dev", "review"}` (`swebench_adapter.py:2416`) and seeds the story
   at `SM_DONE`, so **20 of 22 personas never execute**. Of the two reachable,
   the reviewer had `reviewer_cycles = 0` on 5/5 — it modified nothing, so
   ablating it was a guaranteed null result at full cost. `run_bare` is a
   separate agent, not the factory-minus-a-persona. Cost at a detectable n:
   **$673 at n=33, $2,591 at n=127**. **Amended 2026-08-04:** the reviewer is no
   longer inert (§1 #6), and the `openhands` arm now does the ablation this
   proposal wanted, correctly and for $18 — see A.7 and Phase B.
9. **AC-ID stability + falsifier test** — already shipped. `sm.md:46-57`
   mandates `AC<n>.<m>` EARS IDs and 93 of the 139 stories with an
   `sm_result_json` carry them; `acceptance_author.md:37-38` names generated
   tests off those IDs. The guarded failure has never occurred (0 hits across
   326 review/dev blobs). The measurement has no data source: story markdown has
   been gitignored since #181 and the DB stores one `sm_result_json`, not a
   revision series. The falsifier test already exists in triplicate
   (`pm.md:231-236`, `sm.md:55-57`, `acceptance_author.md:39-42`).

**Adopted from the same survey:** E.2 (mypy ratchet), E.4 (gate exception
isolation, in inverted form), E.6 (validator extension). **1.5, A.5 and the
`gates_failed_json` item were found *by* the review, not proposed to it.**

### Rejected 2026-08-04, from the research synthesis this plan was rewritten around

10. **"Make test files read-only to the dev", taken literally.** P7's
    ImpossibleBench ablation cannot be applied as written here, because there is
    **no separate test author**: `factory/personas/dev.md:38` — "You own code AND
    its tests — there is no separate test author" — is the Loop-4 design, and
    `tests/test_dev_no_test_modification.py:111`
    (`test_dev_modifying_test_file_is_allowed`) asserts the permission. Freezing
    the dev out of test files would invert the design that shipped 91 sacrifice
    stories. **What survives is A.1**: an independently authored oracle the dev
    never sees, which is the stronger form of the same countermeasure and is
    already built. *(Note for the next reader: that test module's docstring still
    describes the pre-Loop-4 prohibition and is stale — the tests below it assert
    the opposite.)*
11. **Raising the dev/review caps to buy convergence.** P5(b) measures more
    submissions-with-feedback as *more* gaming, and §1 #6 shows our own cycles
    rising with no change in resolve rate. See A.8.
12. **A second reviewer, a judge panel, or any additional critic stage.** P5(c):
    complex agentic judge systems scored α 37–49.5 against 62.5–63.0 for a single
    simple prompt, and P1 finds no sequential critic anywhere in the SWE-bench
    Verified top 20. More judge is less validity.

---

## Corrections to the briefing this plan was written from

Every claim in the original 2026-08-01 briefing was re-checked. Nine needed
correcting; the rest verified exactly. Corrections 14–19 were added 2026-08-04,
when the plan was rewritten around the research synthesis. **Corrections 20–29
were added 2026-08-05**, after the session that shipped A.2/A.3/A.8 (#233), the
archive commit (#232), C.1 (#235), A.1's chain half (#236) and A.4 (#237).
**Corrections 30–36 were added later the same day**, after A.5 (#239), A.1b (#238),
A.1c + A.6 (#242), B.1 Phase 1a (#243) and the docs headline set (#241).

1. **Manager spend share — 52.0%, and the in-repo docstring says 53%.**
   `factory/manager/detectors/fms_yield.py:12` reads
   "$1,028 (53% of all factory LLM spend)". Measured: $1,028.58 / $1,976.91 =
   **52.0%**. Not a bug — the denominator grew.

2. **L3 `escalate_to_human` — 107 is right, but only in the proposals.**
   107 of the 165 proposal files carry `escalate_to_human: true`. The
   *classification* field in `state/.manager_apply_history.json` records
   **105**. Two proposals set the flag but never reached L4 classification.

3. **"37 distinct concern classes" is normalization-dependent.** Raw distinct
   `concern_title` values: **48**. Normalizing story numbers only: **40**.
   Normalizing story numbers *and* dropping
   repeat/repeated/continuation/continued/persists/again/still: **37 (78%
   redundant)**. State the normalization when you quote it.

4. **`factory audit` estimated share is window-dependent.** Default 7-day
   window: **55.4%** ($25.81). `--days 60`: **33.9%** ($515.90).

5. **"`stories.dev_retries` shows 41" — 41 is a story count, not a retry
   count.** 41 stories have `dev_retries > 0`; total retries all-time = **71**.

6. **`smoke_green.py` line ref off by three.** The `details={"exit_code",
   "output_tail"}` dict is at **`:55`** (the `GateResult` spans `:51-56`).

7. **`bench/bench.py` SM_DONE seed is at `:267`**, inside the `StoryRecord`
   block spanning `:260-270`.

8. **Claude-arm usage limits: 4 of 13, on a subscription — not 6 of 12, not org
   billing.** `bench/CAMPAIGN-2026-07-17.md:33`, `:51`. `summary.md` holds 20
   rows (12 Claude attempts, 8 factory).

9. **`clean()` destroyed the raw artifacts for *all 20* reported runs, not 19 of
   20.** `bench/runs/` holds exactly one `result.json` (`t3_csrf/factory-2`) and
   it is **not** among the 20 rows in `bench/results/summary.md`.

10. **The 158 `dirty_working_tree` failures are already fixed — the patch-apply
    payoff is 21, not 179.** Both apply paths were made path-scoped 2026-07-24
    (`factory/manager/apply.py:882-897`,
    `factory/chain/factory_improver_apply.py:418-436`). Try `git apply -3` first.

11. **The retry caps are 6, not 3.** RESOLVED 2026-08-01 (#196):
    `_MAX_DEV_RETRIES = 3`, `_MAX_REVIEW_CYCLES = 3`, inner guards
    `_MAX_DEV_SAME_SIGNATURE` / `_MAX_REVIEW_STUCK` 3 → **2** so early escalation
    still fires before the hard cap. Keep that gap.

12. **Phase 0.6's assertion fired on the then-current `routes.yaml`.** RESOLVED
    2026-08-01 (#196): `reviewer` moved to `azure/gpt-5.4` in BOTH blocks (the
    `direct` block had the same collision, which the original note missed). The
    `test_implementer` overlap remains, as a warning.

13. **Four more write-never columns exist alongside `smoke_passed`.**
    `stories.lint_passed`, `format_passed`, `types_passed`, `coverage_passed`
    have **zero references anywhere in `factory/**`**. Now tracked in the
    deferred lint/typecheck item.

14. **The `openhands` number depends on which `report` run you read, and any doc
    quoting it must say which.** The archive committed to `origin/main`
    (`2026-08-04T04-18-05.349995Z`) reports **7/16 = 44%**, `$15.37`, McNemar
    p=0.625, with 3 rows lost to 429s. A later, **uncommitted** archive
    (`2026-08-04T23-19-24.998844Z`, present in the live tree) re-ran those three
    rows as `attempt: 2` and reports **10/19 = 53%**, `$18.20`, p=0.375. §1 uses
    the later one and labels it. Two consequences for numbers already in circulation:
    the cost ratio is **2.8×** ($5.13 / $1.82), not 2.3×; and the fresh-input
    token ratio is **1.8×** (14.3 M / 7.8 M), not 2.1×. `CLAUDE.md`, `README.md`,
    `STATUS.md`, `bench/swebench/README.md` and
    `bench/swebench/PRE-REGISTRATION-1.6.md`'s outcome section all still carry the
    44% / p=0.625 pair. They are **consistent with the committed archive**, so they
    are not wrong today — update them in the same PR that commits the later
    archive, not before, or the docs will cite a number the tree cannot re-derive.
    (`SOTA-RESEARCH-2026-07.md` carries both, with the provenance stated.)

15. **The `openhands − bare` tooling result is stronger than previously
    published, not weaker.** The committed report has the pair at n=15,
    `bare vs openhands` 0 / 6, p=0.031; the later report has n=18, 0 / 9,
    **p=0.004**. Either way it is the only significant result among the three
    DeepSeek arms.

16. **"Make test files read-only to the dev" contradicts the shipped design.**
    The dev owns its tests (`factory/personas/dev.md:38`), and
    `tests/test_dev_no_test_modification.py:111` asserts that modifying a test
    file is *allowed*. The countermeasure that does apply is the independent
    acceptance oracle — see A.1 and Rejected #10. **That module's docstring is
    stale**: it still describes a prohibition the tests below it contradict.

17. **The independence layer the research recommends is already built here and
    has never run.** `factory/chain/acceptance.py` authors an oracle from the
    spec only, before the dev, outside the dev's worktree; it is enforced by
    `gates/acceptance_verified.py` and becomes merge-required on opt-in. Measured
    2026-08-04: `gates.acceptance_oracle` is set in **no** app config
    (`factory/app_config.py:113` defaults it False), and in `state/factory.db`
    **0 of 165 stories** carry `acceptance_expected` or `acceptance_test_ref`.
    The 37% in §1 was therefore measured without it twice over — the flag is off
    in production *and* the bench runs only `{"dev", "review"}` from `SM_DONE`
    (`bench/swebench_adapter.py:2404`, `:2416`).

18. **Iteration horizon is not our deficit.** The synthesis notes "OpenHands runs
    500 iterations; mini 250 steps/$3"; `sandbox_run`'s default is already
    `max_iterations = 600` (`factory/runner.py:1643`). The deficit is that the
    horizon is split across handler invocations — at `_MAX_DEV_RETRIES = 3` the
    dev inner loop gets **two** sandbox attempts per invocation. *(Minor: the
    comment at `factory/runner.py:1604` still says "dev keeps the default
    200" while the signature and the `PERSONA_ITERATION_CAPS` comment both say
    600. Fix in passing.)*

19. **The `SOTA-RESEARCH-2026-07.md` line reference in the old 3.1 was stale, and
    the claim behind it is now downgraded.** The "69.1% → <1.5% apply failures
    from changing diff transport" claim was never at `:164`; it now sits at
    **`SOTA-RESEARCH-2026-07.md:225`**, struck through, because the citation it
    rests on (`Claw-SWE-Bench`, arXiv 2606.12344) **could not be verified to
    exist**. The design intuition — collect file state, not model-emitted unified
    diffs — stands; the number does not. Do not lean on it.

20. **Both archives are now committed, so #14's "uncommitted" clause is stale.**
    `664bcd7d` (PR #232) committed `2026-08-04T23-19-24.998844Z` — `git ls-files`
    shows all seven archive roots, 293 tracked files in that one — and amended
    `PRE-REGISTRATION-1.6.md` Rule 5, which addresses the `attempt > 1`
    contradiction at `:220-221`. §1's provenance note has been corrected. **The
    docs half of #14 was not done in that PR and is still open**: `README.md` now
    carries 53% / p=0.375 / 2.8×, while `CLAUDE.md`, `STATUS.md` and
    `bench/swebench/README.md` still carry 44% / p=0.625 / 2.3×. Both readings are
    now re-derivable from committed archives, so neither is *wrong* — but the repo
    disagrees with itself, and the next doc PR should settle it.

21. **CAID's Commit0 lift is per-model, not one effect size — and +14.7 pp is the
    WEAKEST model's row.** Appendix C, Commit0-**Lite**, one-sided paired t-test:
    Claude Sonnet 4.5 **+6.0 pp** (t=2.87, p=0.006); GLM 4.7 **+3.6 pp** (t=1.37,
    p=0.095, not significant); MiniMax 2.5 **+14.7 pp** (t=2.81, p=0.007). Two
    consequences, both in P4: the gradient *strengthens* C.3's rationale for a
    cheap-model regime, and **C.3 must not be powered against 14.7 pp**.

22. **CAID is a METHOD, not a benchmark.** arXiv 2603.21489 is *"Effective
    Strategies for Asynchronous Software Engineering Agents"* (Geng & Neubig), with
    both arms public at `JiayiGeng/CAID` (`run_single.sh`, `run_multi.sh`). It
    scored Commit0 as a **continuous mean with a paired t-test**, not binary
    resolve. `SPLIT_LITE` is exactly **16 repos**
    (`commit0/harness/constants.py:87`), so this plan's "n ≈ 15" matched the
    published split.

23. **"Axis D is covered by nothing published" was wrong, and two arXiv ids were
    missing.** **DevOps-Gym** (**2601.20882**) has **66 build/CI-failure tasks**
    plus **17 end-to-end** pipeline tasks — Java/Go only, **zero Python**, 3–4
    weeks of integration. **SWE-EVO** is **2512.18470**. And **all seven probed
    candidates EXIST**: every id resolved to a real paper with a real public
    artifact. Given the fetch-rewrite hazard, that was not the expected outcome.
    Details in `bench/benchmark-availability-2026-08.md`.

24. **Phase C's order inverts: C.3 before C.2.** Commit0-Lite is Python/pytest end
    to end, so the whole grading and reporting substrate transfers untouched (4–7
    days), and it is the only option that can come back positive. SWE Atlas costs
    more than this plan priced it: **200 of its 284 tasks are not Python** (Go 106,
    Python 84, TS/JS 56, C/C++ 38), its oracle is a **paid LLM judge**
    (`EVAL_MODEL` defaults to `claude-opus-4-5`) which contradicts our own P5(c)
    evidence **and defeats `report --check` byte-stability**, and it needs Harbor +
    Modal + ~4.28 GB per image. C.2 stays; it moves after C.3.

25. **Phase A's replay-corpus premise named a path that has never existed.**
    `state/events/prompt_bodies.ndjson` has never existed. Production
    `state/events/prompts.ndjson` (2,028 rows) and `prompts.ndjson.1` (43,840 rows)
    carry **metadata only**, and `prompt_hash` is a truncated 16-char digest whose
    own docstring (`factory/runner.py:205-215`) says it cannot be replayed.
    Production has **zero rows after 2026-07-31** — the writers landed 2026-08-01/02
    (#193, #208) and the units stopped 2026-07-30. The real corpus is
    `bench/swebench/runs/<instance>/factory/root/state/events/{prompt_bodies,response_bodies}.ndjson`,
    which is gitignored, `rmtree`d by `_reset_run_artifacts`
    (`bench/swebench_adapter.py:1556`) at the top of every run function, and
    excluded from archives by `_ROW_ARTIFACTS` (`:7197`). **Rule: copy the run-dir
    body files out BEFORE any sweep.** Operator backup 2026-08-05:
    `/home/k/sf-reviewer-corpus-2026-08-05/` (25 instance dirs, 38 reviewer prompts
    + 38 responses, 47 trajectory files, 25 run logs, 36 MB).

26. **The §1.6 G aggregate debt hits FOUR of five sweep files, not one, plus a
    stale file.** In `2026-08-04T23-19-24.998844Z`, header `resolved` vs its own
    `results` list: factory 2 vs 7; openhands 3 vs 9 (per-row files say 10);
    claude-5 5 vs 15; claude-4.8 8 vs 14; bare 1 vs 1 (the only consistent one).
    `sweep-factory.json` also claims `audited_valid: 6, audit_failed: 13` while all
    19 `audit.json` files read `"ok": true`. And
    `2026-08-04T04-18-05.349995Z/sweep-factory.json` is a **stale file from an
    entirely different sweep** (`instances: 4`,
    `finished_at: 2026-08-03T02:47:45Z`) archived alongside 19 per-instance rows.
    **Published numbers are unaffected** — they derive from
    `<instance>/<arm>/result.json`. **Trust only the per-row artifacts.**

27. **A.4's premise was wrong and its treatment is measurably worse.** The reviewer
    was **never** fed diff text only: `## Latest test output` is present on all 31
    graded-sweep calls, at 491–1,894 bytes against a `## PR diff` of
    2,053–56,040 bytes, and it is the dev's own `dev_attempts[-1]` output. Absence
    was never the defect. Measured (PR #237, $1.2693): control rep1 **11/18 =
    61.1%** vs treatment rep1 **8/18 = 44.4%**, **Δ = −16.7 pp**, McNemar exact
    3–0 against the treatment, p = 0.25, control ≥ treatment in **9 of 9**
    replicate pairings. The mechanism is an independence error in A.4's own design:
    a run-until-green dev's transcript is **green by construction**, so the
    precedence rule let that green outrank the reviewer's own reading. **This does
    not refute P7** — P7's judge sees an oracle-side harness run. Do not ship the
    production change; A.4 is blocked on A.1 being real.

28. **A.5's stated premise is measurably FALSE, and its cited line was wrong.**
    Over all 31 verbatim reviewer calls: `approve` with `score >= 0.7` = 15,
    `approve` with `score < 0.7` = **0** (lowest approve 0.78);
    `request_changes` 8 / 8. **The `and score >= 0.7` clause vetoed nothing**, and
    every rejection is independently carried by a medium/high finding.
    `test_quality_score` is collinear with the verdict in the same JSON object.
    **Demoting or deleting it changes 0 of 31 verdicts and 0 of 19 rows.** The gate
    is at `factory/chain/handlers.py:3396`, score read at `:3318`; the cited
    `:3168` sits inside the empty-diff short-circuit (hardcoded
    `"test_quality_score": 0.0` at `:3162`). A.5's surviving justifications are the
    `LOOP4_REQUIRED_GATE_LABELS` hazard, the 40% chain-verdict precision, and SWE
    Atlas comparability.

29. **A.7 is blocked by two guardrails behaving correctly, not by missing work.**
    No `azure/gpt-5.4` **agent** arm exists in either archive — gpt-5.4 appears only
    as the reviewer inside the factory arm (31 single-turn text calls), so there is
    nothing to replay. `openhands` has `model_selectable=False`
    (`bench/swebench_adapter.py:3704-3721`) and `resolve_arm_model` (`:3856`) raises
    `SystemExit`; changing `routes.yaml` instead collides
    `dev.standard` with `reviewer: azure/gpt-5.4` (`factory/routes.yaml:124`) and
    `check_review_independence` (`factory/model_router.py:117`) refuses to resolve
    *any* route. Cheapest valid path: an operator bench PR flipping
    `model_selectable=True` on the `openhands` `ArmSpec`, then
    `--arm openhands --model azure/gpt-5.4`; `run_key` (`:3877`) keys the run dir
    `openhands@azure/gpt-5.4`, so it cannot clobber the corpus. ~$18.

30. **A.5 shipped as a DELETION, not the rewrite this section specified.** The
    ablation branch was removed from the required `tests-meaningful` gate — ~200
    lines — leaving a static slop detector that cannot shell out, cannot mutate a
    checkout and cannot block for 600 s on a timeout. The repaired measurement lives
    off the merge path as `factory/chain/mutation.py` + `factory mutation-score`,
    imported by no gate, with a test enforcing that. **The reasoning generalises:
    advisory-by-constant is one edit from blocking every merge; advisory-by-not-being-imported
    is not.** `gates.mutation_testing` survives as an inert config field. New
    primitive `check_can_fail` returns `True` only on an **attributable** red; green,
    an unattributable red, a timeout and an un-materializable tree are all `False`
    **with the reason**, because "we could not prove it" is not "it can". (The
    measurement that removed A.5's stated justification is correction #28 — unchanged,
    still correct.)

31. **A.1's bench half is done, and building it caught a real independence exposure
    on live data.** The `factory` arm now authors the oracle from the instance's
    problem statement **before the dev's first model call**, through the chain's own
    authoring code, and `result.json` records an `acceptance.ordering` fact a reader
    re-derives from the run's own event stream rather than a boolean the code asserts
    about itself. With the oracle stored inside the factory root, **the dev on a real
    run ran a filesystem search from one level above its worktree and the listing
    named the acceptance store**; the detector fired and **refused the row**. The
    store is now outside the factory root, the in-root copy is deleted with the
    deletion asserted, and any acceptance-named leftover refuses the row.

32. **A.6 was folded into A.1c and built once**, because "require the oracle to be red
    at the merge base before crediting a green" *is* harness-owned red→green
    (`factory/chain/red_green.py`). Three generalising defects came out of two
    adversarial passes over two fully-green PRs (13 defects between them): **an
    errors-only red at the base laundered a tautology into an authoritative green**
    for the common add-a-module story shape, and "red" being definitive bypassed the
    ablation check entirely (fixed: errors-only ⇒ `unknown` ⇒ ablation; a mixed
    `1 failed, 1 error` stays red); **`pyproject.toml` is both a pytest collection
    channel and the dependency manifest**, so rolling it back wholesale
    authoritatively false-blocked every dependency-adding story — and the operator's
    proposed fix, an empty factory-owned pytest config, was **measured wrong** because
    it kills `asyncio_mode = auto` and false-blocks every `async def` oracle on a
    FastAPI app, so only the `[tool.pytest.*]` tables are spliced out, re-verified
    with a TOML parse; and the **standing rule** that an import or collection error at
    HEAD must be **non-authoritative** whenever the environment rollback set is
    non-empty, because a gate must never authoritatively blame the dev for something
    it may have caused. `pyproject.toml` is now a documented special case, not the
    clean complement of the production-path classifier.

33. **The acceptance oracle's flag is still off, but for a NEW reason — the blockers
    are closed.** All four A.1 blockers plus the gate-ordering test closed in #242 and
    #239. What keeps `gates.acceptance_oracle` absent from every app config is an
    **in-process hole**: three lines of production code reassigning pytest's
    test-runner function to a no-op forge a genuine-looking red→green, and no file
    rollback closes it — it needs an out-of-process behavioural oracle. It is carried
    as an `xfail(strict=True)` whose stated reason is that it is why the flag stays
    off, so a silent "fix" fails the suite. Same class: a HEAD dependency registering
    a pytest plugin entry point via a local-path dependency.

34. **B.1 Phase 1a has a number, and the cost mechanism it predicted was wrong.**
    `solo-noreview` **9/18 = 50%** [26%, 74%] at **$2.83** per resolved against
    `factory` 7/19 = 37% at $5.13; paired n=18, only-factory 2 / only-solo 4,
    p = 0.688, descriptive only; `reviewer_cycles` = 0 on all 19 rows; **actual spend
    $25.49**; the pre-committed stop signal did not fire. **The reviewer's own tokens
    are $0.65 of $35.94 = 1.8% of spend** — the 29% saving comes from **9 fewer dev
    calls (30 vs 39)** and a median story of **1 tick instead of 4**. The reviewer was
    not expensive; it was causing rework. **Optimise for round-trips eliminated, not
    tokens per persona.** And it is **not** a clean single-variable ablation — three
    things differ, disclosed in the pre-registration before the data existed. Full
    limits in §1a.

35. **Correction #20's docs half is CLOSED.** #241 unified the headline set:
    `CLAUDE.md`, `STATUS.md` and `bench/swebench/README.md` now carry 53% / p=0.375 /
    2.8× with the provenance travelling alongside, matching `README.md` and `PLAN.md`
    §1. The repo no longer disagrees with itself about which report run it quotes.

36. **`README.md`'s own `report --check` command pointed at the wrong archive.** It
    cited `results-archive/2026-08-04T04-18-05.349995Z`, which **prints
    `CHECK FAILED`** — `results.md` re-derives from
    `2026-08-04T23-19-24.998844Z`, which prints `CHECK OK`. Both verified by running
    them 2026-08-05. Fixed in the same PR as this entry. This is a *command*, not a
    figure; the README's five-arm figures were not touched.

Verified exactly as stated, no correction needed: the 122/118/24 chain counts;
17-validated/3-rejected staging; 1 open issue / 0 open PRs / 0 blocked; L4's
163 attempts / 0 `pr_number` / newest `20260723`; the $1,028 figure; reviewer
convergence (0 stories at 6+ in 14 days, max 5, 101 of 122 at zero, 11 all-time
at 6–7); dev retries `{0:86, 1:27, 2:5, 6:4}`; 196 improver proposals → 1 landed
commit `6bd463a3`; 179 apply_failed split 158/16/5; Azure $1.93/$3.83 verified
and $0.161 cache-read estimated; `db_path` threading fixed; July $588.78 / 75 =
$7.85 and $217.18 / 75 = $2.90; the twin at `staging.py:72` is a real
run-the-clone canary and is **PUBLIC**; **45 `pm-validated` and 31 `closed`
sacrifice directions of 76** (re-verified against `state/factory.db`
2026-08-04); Hermes `fuzzy_match.py` = 967 lines, MIT, `re`/`typing`/`difflib`
only; Hermes `kanban_db.py:104-134` and `:5847-5856`; `bench/**` and
`factory/manager/**` forbidden to self-edit.
