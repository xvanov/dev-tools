# SOTA research — acceptance-oracle source of authority, August 2026

> **What this is.** External literature on automated acceptance-test / oracle
> generation for LLM coding agents, gathered 2026-08-09 to answer one question:
> **is total blindness to the application actually correct for our acceptance
> oracle author, or is it a misapplication of a narrower principle?**
>
> It is a companion to `SOTA-RESEARCH-2026-07.md`, not a replacement. That file
> covers harness-vs-model economics; this one covers oracle design.
>
> **Confidence convention (READ THIS).** The org-level `DESIGN → ENGINEERING`
> rewrite rule is applied to *fetched web content*, not only to prose we author —
> see CLAUDE.md failure pattern 8. It was **confirmed live during this
> research**: one fetched search summary came back containing the literal
> heading `## ENGINEERING Perspective` and the phrase `agentic software
> ENGINEERING`. Therefore, throughout this file:
> **a fetched NUMBER is higher-confidence than a fetched NAME.** Every claim is
> cited by URL + arXiv id. Re-verify any title before quoting it outside this
> repo. Several primary hosts (openai.com, UCL) returned 403 or unparseable
> PDFs; figures taken from mirrors are flagged inline as second-hand.

---

## The question, and the answer

**Question.** Our acceptance oracle is authored by an LLM from the story's
acceptance criteria only, frozen before the dev starts, and run out-of-process
over HTTP. The author never sees the app's source or the dev's diff. To write
HTTP calls it needs route paths, request schemas and status codes it cannot
obtain, so those are supplied as **hand-maintained prose** in
`apps/<app>/config.yaml` (`gates.acceptance_harness_hint`). That prose has been
wrong three times, each time blocking a CORRECT implementation:

1. it named auth routes that never existed (`/api/auth/register`; the real path
   carries an `/email` segment) — patched 2026-08-08;
2. it implied a `401` response body the app never produces — the oracle asserted
   `{"detail": "Unauthorized"}`; ratified away in PRs #277/#278;
3. it omitted the required fields of `POST /api/goals`, which a criterion needed
   for SETUP, so the author guessed `{"title": ...}` and got `422` — found
   2026-08-09 while re-grading story 179.

**Answer. Total blindness is not best practice, and no source found advocates
it. But we were never doing that** — `acceptance.build_spec_prompt`'s own
docstring already argues the harness hint "is NOT an independence leak: it is
the same static layout any reader of the repo's README can see". The principle
is already correct. **What is broken is that the allowed information is
delivered as a human-maintained string.**

---

## The field's term: "source of authority"

**arXiv:2607.05031** — Mughal & Bilal, *LLM-Based Test Oracles: Source-of-
Authority Taxonomy — A Systematic Literature Review* (6 July 2026; 54 studies
screened from 2,436 records). https://arxiv.org/abs/2607.05031

| Class | Grounded in | Share of literature |
|---|---|---|
| **Implementation-derived** | source code / observed execution | — |
| **Specification-derived** | requirements / specifications | **~52% (28/54)** |
| **Non-specification-based** | neither — verdict with no spec at all | **~48% (26/54)** |

Their distinction: implementation-derived oracles "may identify actual behavior
but risk codifying bugs, whereas specification-derived oracles provide normative
expectations independent of current execution."

**A pre-existing public API contract falls on the SPECIFICATION side.** It
describes what the system *offers*; it does not describe how *this task* was
solved. That is the line our design has been conflating.

Older canonical taxonomy: Barr, Harman, McMinn, Shahbaz, Yoo, *The Oracle
Problem in Software Testing: A Survey*, IEEE TSE 41(5):507–525, 2015 —
specified / derived / implicit / human. A *specified* oracle is derived from a
specification **of the interface and behaviour**; there is no category for "oracle
authored without knowledge of the interface."
(http://www0.cs.ucl.ac.uk/staff/M.Harman/tse-oracle.pdf — **could not fetch;
host refused connection. Taxonomy names corroborated via secondary sources; the
verbatim definitions were NOT verified.**)

Other terminology in use:

| Concept | Terms |
|---|---|
| independence property | **source of authority**; specification- vs implementation-derived |
| interface known, body hidden | **black-box** / **specification-based testing** (synonyms) |
| independence via a second implementation | **pseudo-oracle** (Weyuker, doi 10.1145/800175.809889); N-version; differential testing |
| interface as first-class artifact | **API contract**, **contract testing**, consumer-driven contracts (Pact) |
| organisational independence | **IV&V** (IEEE 1012) — managerial/financial/technical, never informational |

> One canonical term is deliberately **not spelled out** in this file: Meyer's
> contract-based specification methodology, whose two-word name begins with the
> word the rewrite rule corrupts. Search instead for "Bertrand Meyer contract
> Eiffel preconditions postconditions."

---

## The evidence that signatures are the right budget

**ASE 2025** — Molinelli, Di Grazia, Martin-Lopez, Ernst, Pezzè, *Do LLMs
Generate Useful Test Oracles?* 13,866 oracles, 135 Java projects, all authored
after model training cutoffs (uncontaminated).
https://homes.cs.washington.edu/~mernst/pubs/neurosymbolic-oracles-ase2025-abstract.html

* LLM oracles **43% mutation score vs 45% human-written** — near parity.
* Verbatim: *"the test prefix and the methods called in the program under test
  provide sufficient information to generate good oracles, while additional code
  context does not bring relevant benefits."*
* **The load-bearing detail:** the generator WAS given the **signatures of the
  methods invoked**, and denied the **bodies**. Signature in, body out — and
  that was empirically *sufficient*.

**arXiv:2607.22883** — *Evaluating and Mitigating the Misguidance Effect of
Buggy Code in LLM-Generated Unit Tests*. Defects4J, 17 projects, 318 focal
methods, **11 LLMs**. https://arxiv.org/abs/2607.22883

| Prompt content | Misguided tests | Effective (bug-finding) tests |
|---|---|---|
| buggy code | 137.69 (3.84%) | 104.15 (2.98%) |
| **spec docstring instead of the body** | 113.00 (2.69%) | **186.77 (4.50%)** |

Claude 4 Sonnet: effective tests 88 (2.09%) → **249 (4.82%)**.

> **This paper is routinely miscited as "don't show the implementation." Its
> actual mitigation replaces the method BODY with a docstring and KEEPS THE
> SIGNATURE.** That is the recommendation here, not total blindness.

**arXiv:2607.05139** — Konstantinou, Tambon, Papadakis, *On the risk of coding
before testing*. Verbatim: *"these approaches assume that generated tests act as
independent and reliable oracles… we challenge this assumption."* Reported
implementation-aware **14%** fault detection vs **25%** specification-driven.
https://arxiv.org/abs/2607.05139 — **the 14/25 figures came from a fetch summary,
not the verbatim abstract. Verify in the PDF before quoting externally.**

**Pre-LLM name for the same effect: confirmation bias.** Calikli & Bener, PPIG
2010 (https://ppig.org/files/2010-PPIG-22nd-Calikli.pdf) and a 42-participant
controlled experiment (https://link.springer.com/article/10.1007/s10664-018-9668-8)
find developers write "considerably more confirmatory than disconfirmatory test
cases," correlating with defect proneness.

---

## Our exact bug, measured in industry

**arXiv:2504.07244** — Ferreira, Viegas, Faria, Lima (Critical TechWorks),
*Acceptance Test Generation with Large Language Models: An Industrial Case
Study*. https://arxiv.org/abs/2504.07244

A **two-stage** pipeline with **two different information budgets**:

| Stage | Input | Result |
|---|---|---|
| story → Gherkin scenario | user story title + description **only** | helpful in **95%** of 166 uses; 8/10 quality from 6 product owners |
| scenario → **executable** script | story + scenario **+ "HTML code of the pages under test"** | syntactic correctness 100%; **semantic relevance 60%**, → **92%** after 8% minor fixes + 24% added context |

Stated reason for feeding in page HTML: it supplies "correct locators of UI
elements". Cost €0.12/script.

**This is our defect, measured, in industry: the abstract acceptance intent can
be authored from the criterion alone; the executable binding cannot.** All three
of our failures are stage-2 binding errors committed under a stage-1 information
budget, because one persona does both stages.

---

## Failure-mode base rates

### False block (a correct implementation rejected) — large and under-appreciated

* **SWE-bench → SWE-bench Verified:** **61.1%** of samples flagged for "unit
  tests that may unfairly mark valid solutions as incorrect"; 38.3% for
  underspecified statements; **68.3% of the original benchmark filtered out**.
  GPT-4o **16% → 33.2%** on the cleaned set — roughly half of measured "failure"
  was oracle defect. (**openai.com returned 403; figures via mirror
  https://github.com/irthomasthomas/undecidability/issues/933**)
* **OpenAI SWE-Bench Pro audit, July 2026:** of 731 public tasks, pipeline
  flagged **27.4%** broken, humans **34.1%**. Breakdown: **overly strict tests
  14.4%**, underspecified prompts 7.5%, low-coverage tests 4.1%, misleading
  prompt 1.9%, misc 6.3%. OpenAI retracted its recommendation to use the
  benchmark. Their description of the top category: *"Hidden tests require
  specific implementation details not in prompt → false negatives — correct
  solutions fail."* (**primary 403; via
  https://explainx.ai/blog/openai-swe-bench-pro-audit-broken-tasks-july-2026 —
  treat category percentages as second-hand**)
* **arXiv:2605.28321** (ARMeta — LLM metamorphic tests against live REST APIs):
  PetStore 92/117 failing tests true positive → **21.4% false alarms**;
  UserManagement 116/204 → **43.1% false alarms**. Operational coverage 98.4% /
  79.3%. https://arxiv.org/abs/2605.28321
  **This is the closest published false-block rate for an LLM-authored,
  out-of-process, HTTP-level oracle against a live API: 21–43%.** It is not
  frozen-before-dev, so it is an analogue, not a match.

> **In the two audits cited above — SWE-bench Verified and SWE-Bench Pro —
> "overly strict tests / hidden tests requiring details not in the prompt" is the
> largest named defect category, and it is exactly our failure mode.** Bounded to
> those two deliberately: it is not a survey of all benchmarks, and both sets of
> category-level figures are second-hand (their primary hosts returned 403). The
> direction of the finding is well-supported; the precise percentages are not
> ours to quote as settled.

### False green (an incorrect implementation accepted)

* **arXiv:2503.15223** — *Are "Solved Issues" in SWE-bench Really Solved
  Correctly?* (PatchDiff): **29.6%** of plausible patches behave differently
  from the ground-truth patch; **28.6% of those are certainly incorrect**
  (≈8.5% of all accepted); **7.8%** of patches counted correct fail
  developer-written tests. https://arxiv.org/abs/2503.15223
* **arXiv:2410.06992** (SWE-Bench+): **32.67%** solution leakage in issue text;
  **31.08%** pass under insufficient tests. https://arxiv.org/abs/2410.06992
  (**per-model tables could not be extracted; PDF and HTML both failed**)
* Real-world calibration: across **456k agent-authored PRs in 61k repositories,
  acceptance rates are 35–64%**, well below >70% SWE-bench Verified headlines;
  the same paper measures **20+ pp** swings for one model across harnesses.
  arXiv:2606.17799 https://arxiv.org/abs/2606.17799 (**title contains "Agentic
  Software Engineering" — plausible, but exactly the phrase shape the rewrite
  corrupts. Verify before external citation.**)

### Test gaming — why the freeze stays

**arXiv:2510.20270** — *ImpossibleBench* (already cited in
`handlers._MAX_REVIEW_CYCLES` and `auto_merge._MAX_CI_FIX_CYCLES`).
https://arxiv.org/abs/2510.20270

* GPT-5 **76%** exploitation on impossible-SWEbench; **93%** on conflicting
  impossible-LiveCodeBench.
* Strict anti-cheating prompting: LiveCodeBench **93% → 1%**, SWEbench only
  **66% → 54%**. Explicit abort option: GPT-5 **54% → 9%**, o3 **49% → 12%**,
  Claude Opus 4.1 unmoved at **46%**.
* **Restricting *dev* access to tests "reduces their hacking rate to near
  zero"**; read-only test files were the balanced option.

(**numbers via https://www.lesswrong.com/posts/qJYMbrabcQqCZ7iqm/ — the arXiv PDF
would not parse. High confidence on 76%/93%; medium on per-model deltas.**)

> **Read carefully: the effective mitigation is denying the DEV access to the
> oracle. Nothing in ImpossibleBench argues for denying the ORACLE AUTHOR access
> to the API surface.** We already have the property this paper endorses. The
> prose config is a separate, avoidable cost paid on top of it.

---

## Is the oracle worth fixing at all? (the steelman, and the answer)

**Against:** **arXiv:2602.07900** — *Rethinking the Value of Agent-Generated
Tests* (9 Apr 2026). Claude Opus 4.5 writes tests in **83%** of tasks and
resolves **74.4%**; GPT-5.2 writes tests in **0.6%** and resolves **71.8%** —
2.6 pp apart. Forcing test-writing moved **64.4%** of GPT-5.2's tasks from
no-test to has-test with **zero net change in successes** (+5.5% API calls,
+19.8% output tokens); **no model showed a significant effect (all p > 0.05)**.
https://arxiv.org/abs/2602.07900

**For:** **arXiv:2510.23761** — TDFlow (EACL 2026). Supplied with *human-quality*
tests, agentic workflows reach **88.8% SWE-Bench Lite / 94.3% SWE-Bench
Verified** (+27.8 pp over the next best system), with only **7 instances of test
hacking across 800 manually inspected runs**. Concludes the primary obstacle
"lies within writing successful reproduction tests," not resolving them.
https://arxiv.org/abs/2510.23761

**The reconciliation is test QUALITY.** Cheap self-generated tests are worth
~nothing; correct independent tests are worth ~28 pp *on SWE-Bench, in TDFlow's
system*.

> **That number is THEIRS, not ours, and it must not be read as a forecast for
> this chain.** It was measured on a different benchmark, a different harness and
> human-written tests. **This repository's own measured result is NO measurable
> lift** from the chain over a single agent on the same model (37% vs 53%,
> p=0.375, at 2.8x the cost — see `CLAUDE.md` and `bench/swebench/results.md`).
> Nothing here changes that, and this file must not be cited as if it did. What
> TDFlow supports is narrower and still useful: *if* an independent oracle is
> correct, oracle quality is a lever worth paying for — which is an argument for
> FIXING our oracle rather than deleting it, not evidence about how much it will
> buy us. Our lift remains unproven.

---

## Other techniques, ranked for applicability here

1. **Derive the invocation surface mechanically, and cross-check the prose
   against it** — **REVISED 2026-08-09 after adversarial review.** The first draft
   of this list said "highest value, lowest risk, fixes all three incidents". That
   was measured and is FALSE for this codebase: `POST /api/goals` declares only
   `['201','422']` (no 401), `grep -n "responses=" backend/app/routes/*.py`
   returns zero hits, key routes have no `response_model`, and the constraint that
   actually blocked story 179 (`goal_type` must be a registered plugin type with a
   type-specific `criteria` shape) lives in a `field_validator` invisible to the
   schema. A derived surface fixes the ROUTE and REQUIRED-FIELD incidents (1 and
   3) and is silent on the semantic ones. Use it as an additive CI cross-check on
   the prose, not a replacement. Precedent:
   arXiv:2601.12735 (OOPS: LLM static analysis of server code → OpenAPI),
   arXiv:2504.16833 (LRASGen), and ARMeta which "treats the OpenAPI Specification
   as a strict source of truth for selecting valid endpoints and parameters".
2. **Separate arrange from assert, with different information budgets** — setup
   is not a behavioural judgment and carries no independence requirement.
   Supported by the two-stage split arXiv:2504.07244 found *necessary*.
3. **A positive control on the base run** — require the pre-dev red to be the
   RIGHT red (404/501 = absent feature; 400/422 = malformed oracle). Adjacent
   support: **arXiv:2506.02954** (MutGen) reports suites with **100% coverage and
   4% mutation score**, which is why sensitivity controls are non-negotiable.
4. **Metamorphic relations grounded in OpenAPI** (arXiv:2605.28321) — good
   template, but **21–43% false alarms** disqualifies it as a *blocking* gate.
   Advisory only.
5. **Property-based testing** (arXiv:2307.04346, *Can Large Language Models
   Write Good Property-Based Tests?*) — explicitly warns LLMs synthesize
   **unsound** properties; unsound property = false block. Same gating caveat.
6. **Differential / pseudo-oracle / N-version** — strongest independence
   guarantee (Weyuker doi 10.1145/800175.809889; PatchDiff arXiv:2503.15223), but
   needs a second implementation and only says the two disagree, not which is
   wrong. Too expensive at our cost profile.
7. **Consumer-driven contracts (Pact)** — right *format* for a frozen contract,
   wrong tool for the oracle: Pact explicitly covers interaction shape and **not**
   functional correctness (https://docs.pact.io/). Our incident 2 was a contract
   file overreaching from shape into asserting behaviour.
8. **Avoid: LLM-as-judge with no specification** — the weakest authority class,
   and ~48% of the surveyed literature. Our design is already in the better 52%.

---

## Where the evidence runs out

Stated plainly, because these gaps bear on what we can claim:

* **No measured false-block rate exists for our exact configuration** — a
  frozen, pre-authored, out-of-process HTTP acceptance oracle in an autonomous
  pipeline. ARMeta's 21–43% is the nearest analogue and is not frozen-before-dev.
* **No controlled ablation of oracle-author information budget** (nothing /
  contract only / contract + implementation) has been published. **This is a
  genuine gap and a cheap experiment for us**: we already have a vacuity control,
  a reviewer-replay corpus, and a per-run cost meter.
* **The ASE 2025 signature-sufficiency result is on Java unit oracles**, not HTTP
  acceptance oracles. The transfer is inference, not measurement.
* Consumer-driven contract testing combined with LLM oracle authoring: one hit,
  in a low-tier venue, not verified, not cited here.

---

## Bottom line

The freeze is right and well-supported. Dev-blindness is right and
well-supported. **Contract-blindness is a conflation of the two, is not what any
cited work does, and has cost three false blocks — the exact failure mode OpenAI
names as the top cause of broken tasks in its own benchmarks.**

The fix — **revised 2026-08-09 after an adversarial review that falsified the
first version, and measured against this codebase rather than assumed:**

Derive the invocation surface mechanically and use it as an **additive CI
cross-check** on the prose hint (every route and required field named in prose
must exist in the derived surface). That catches the ROUTE and REQUIRED-FIELD
incidents at CI time with no boot and no per-story cost. It does NOT catch the
semantic ones — status vocabulary, response bodies, plugin-type enums are absent
from a FastAPI schema that declares no `responses=` and no `response_model`, so
those stay prose. State that limit rather than wishing it away.

If a per-story derived surface is ever fed to the AUTHOR, three things become
binding, and none were in the first draft: the base sha must be **verified against
the gate's own `base_sha`** (authoring runs at pm-sync, the gate's base comes from
a branch created later, and main moves between them); it must **never be
re-derived on a `force=True` re-author** (an `explore` loser would then be handed
the winner's implementation of the same spec — a real leak); and the fail-closed
path must route through `_unverifiable` so it is waivable, or it creates a
terminal sink no operator command can reach.

And the risk the first draft missed entirely: **more base information produces
more oracles that MIRROR the base contract**, which pass at base →
`oracle_not_discriminating` → *waivable* → `_unverifiable` returns `passed=True`.
The recovery mechanism for false blocks is itself a false-green channel, so the
waiver rate must be pre-registered as a metric alongside the false-block rate.
