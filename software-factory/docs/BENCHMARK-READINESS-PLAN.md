# Benchmark-readiness plan — oracle authority, harness integrity, end-to-end proof

**Written** 2026-08-09, after factory PR #279 (`factory resume-story`) and the
oracle-authority research in `SOTA-RESEARCH-2026-08-oracle-authority.md`.

**Audience.** A loop-3 agent (you). Read `CLAUDE.md` first, then the memory index,
then `STATUS.md`. This plan assumes all three.

**Objective.** Make the factory *pristine* for a benchmark run: every gate
truthful, no false blocks from stale config, no hamster wheels, no terminal sink
without a path back. The benchmark must measure the chain's capability, not the
harness's drift.

> **Why this is urgent and not cosmetic.** In the two curated benchmarks that
> have published audits, the largest named defect category is tests that fail
> correct solutions — **our exact failure mode**:
> * OpenAI's SWE-Bench Pro audit (July 2026): *"overly strict tests — hidden
>   tests require implementation details not in the prompt → correct solutions
>   fail"*, **14.4%** of 731 tasks; OpenAI retracted its recommendation to use the
>   benchmark. Primary source returned HTTP 403; figures via
>   https://explainx.ai/blog/openai-swe-bench-pro-audit-broken-tasks-july-2026 —
>   **second-hand, treat the category percentages as indicative.**
> * SWE-bench Verified: **68.3%** of the original benchmark filtered out,
>   **61.1%** of samples flagged for *"unit tests that may unfairly mark valid
>   solutions as incorrect"*. Primary (openai.com) also 403; via
>   https://github.com/irthomasthomas/undecidability/issues/933 — **second-hand.**
>
> Bounded to those two audits deliberately; this is not a survey of all
> benchmarks. The DIRECTION of the finding is well-supported, the precise
> percentages are not ours to quote as settled — and per CLAUDE.md failure
> pattern 8, a fetched NUMBER outranks a fetched NAME. Full citations and
> confidence notes: `SOTA-RESEARCH-2026-08-oracle-authority.md`.
>
> If we benchmark before fixing this, our numbers carry an unknown, unseparable
> false-block component and cannot be compared to anything.

---

## Definition of done

All of these, verified against **real artifacts**, never a recorded flag:

1. Every route path and required field in `acceptance_harness_hint` is
   mechanically cross-checked against the app's real surface by a CI test, so a
   drifted API fact cannot reach an oracle author undetected. (The semantic facts
   — plugin-type enums, error vocabulary, response bodies — stay prose. That is
   an accepted limit, not an oversight; see A1.)
2. Base-run status observation is recorded as **advisory diagnosis only**, with
   ≥20 runs of data accumulated before any classification is proposed.
3. The `explore` + AC-scope decision (A4) is made and implemented.
4. The information-budget ablation has been run and its numbers are committed,
   including the **waiver / `oracle_not_discriminating` rate** (A1 can make
   oracles WEAKER, and that is the dangerous direction — see B).
5. Every open harness defect below is either fixed or explicitly deferred with a
   written reason.
6. **Three fresh stories drive end-to-end, unattended, each to a MERGE COMMIT on
   GitHub** with `acceptance-verified` in `merge_actions.gates_passed_json` and
   `stub_runs.json` + `base_runs.json` on disk — no operator intervention, no
   block, no repeated-work loop. **Not "deployed":** `deploy.enabled: false` on
   sacrifice, so `deployed` is a STATE NAME, not a deploy (`STATUS.md`: all 102
   `deploy_actions` rows skipped or errored). Using it as evidence is `proxy ≠
   real`, this repo's most common bug class, in its own readiness plan.
7. No story in the Workstream D run stalls: nothing sits in an `*_in_progress`
   state beyond the stale threshold without being surfaced (`E1`), and no dev run
   times out without being charged and counted (`E3`).
8. **PR-blocking CI finishes in under 60 seconds** on a representative code PR
   (E6), with the full suite still gating merge or post-merge.
9. `factory audit-chain` reports no tampering; `factory inbox` is empty of
   needs-human rows; `uv run pytest -q` exits 0; live tree == `origin/main`.

**None of 1–6 may be claimed from a green test run alone.** Name the commit SHA
or merged PR for every fix (memory: `session_fix_claims_need_git_verification` —
a prior session reported two fixes that were never committed).

---

---

# How to execute this — be efficient, parallelise, but ground everything in a running factory

**Two rules that fight each other, and the second one wins.** Fan out
aggressively for anything that is *reading, searching, or implementing in
isolation*. Serialise ruthlessly for anything that *touches the live factory*.
Getting this backwards produces fast, confident, wrong answers.

## Delegate by difficulty — pick the cheapest model that can do the job

Pass `model` explicitly on every `Agent` call. Do not let everything inherit Opus;
most of this plan's work does not need it.

| Model | Use for | Examples from this plan |
|---|---|---|
| **haiku** | mechanical, verifiable, low-judgment | grep sweeps for a pattern; listing routes/config keys; collecting `factory trace` output; checking for leaked docker networks; tallying spend from `factory audit` |
| **sonnet** | standard implementation and analysis with a clear spec | C3 (resume the two parked stories); C7 (environment hygiene); writing the D-1/D-2/D-3 directions; most test-writing; doc refreshes |
| **opus** | design judgment, adversarial review, anything where being wrong is expensive | A1's cross-check design; **A4's `explore`/AC-scope call**; C1 (shared control flow); the adversarial pass on every fix; interpreting B's ablation numbers |

Rule of thumb: **if the task has one right answer that can be checked by running
something, go cheaper. If it involves a trade-off, an invariant, or a safety
direction, go to opus.** The adversarial review pass is always opus — it has
caught ~5 production bugs that green tests hid.

### Parallelise these (independent, no shared mutable state)

Send them in **one message with multiple `Agent` calls** so they actually run
concurrently:

- **Investigation fan-out**: C2 (tech_writer JSON), C4 (oracle KNOWN OPEN #2–#4),
  C6 (the config-fact sweep) are three independent read-only questions. One agent
  each, in parallel, at the tier the question deserves.
- **Independent implementation**, with a caveat found by adversarial review:
  A1 and A2 look independent (`acceptance.py` authoring vs
  `acceptance_verified.py` base run) but **do collide**. Both are referenced by
  `tests/test_acceptance_oracle.py` and `tests/test_acceptance_oracle_executable.py`;
  A2 needs a `RUNNER_VERSION` bump (`oracle_run.py:73`) that is in BOTH the
  stub-run and base-run cache keys; and A1 changes the prompt, so `oracle_sha256`
  changes, invalidating every cached run **and every `waiver.json`** (waivers are
  scoped to oracle content, `acceptance.py:652`). **Serialise A1 and A2**, or
  scope A1 to production code and land its test changes in an integration pass.
  After either lands: delete `state/acceptance/*/*/[base|stub]_runs.json` and
  re-check waivers — a stale cache keyed on an old `RUNNER_VERSION` is the classic
  `compose-bugs between fixes` shape.
- **Direction drafting**: D-1, D-2, D-3 are three separate documents — draft
  concurrently, review together.
- **Research**: any external-literature question. Warn every research agent about
  the fetched-text corruption (see below).

### Do NOT parallelise these

- **Anything writing `state/factory.db`.** One writer per fact. Two agents
  ticking, resuming, or repairing stories at once will corrupt state, and a DB
  edit races a live tick.
- **`factory tick` / `factory on` / deploys.** Serialise. The tick is the
  factory's single-threaded heartbeat; running two is not a speedup, it is a race.
- **The Workstream D proof itself.** It is a *measurement of unattended
  behaviour*. Running three stories concurrently is fine **only if that is the
  real configuration you intend to benchmark** — otherwise you have measured
  something you will not ship. Decide, then keep it constant.
- **The full test suite.** ~17–19 min locally. Run it once, at the end of a batch
  of changes, not per-agent. Concurrent pytest runs contend and produce mirages
  (memory: `red_test_can_mean_nothing_too`).
- **Docs stories.** Running D-1/D-2/D-3 concurrently produces three concurrent
  `tech_writer` docs stories; parallel docs PRs conflict and only one docs story
  may be in flight per app (memory: `docs_chain_serialization`). This matters
  doubly because C1/C2 are *about* tech_writer failures.

### Ground everything in a running factory — nothing counts until the factory did it

This is the part that cannot be delegated away. Subagents produce *claims*; the
factory produces *evidence*. Every claim in this plan is closed by an artifact,
not by a report:

| Claim | What actually closes it |
|---|---|
| "the fix is in" | a commit SHA or merged PR — a session's summary is a self-report, and one prior session reported two fixes that were never committed (memory: `session_fix_claims_need_git_verification`) |
| "the oracle is correct now" | a real gate run: `state/acceptance/<app>/<id>/stub_runs.json` + `base_runs.json`. **The gate emits NO events** — those files are the only proof it ran (memory: `acceptance_oracle_validated_live_2026_08_08`) |
| "the story merged" | GitHub's merge commit. Never a local flag |
| "it deployed" | the change present on `origin/main`. **`deployed` the STATE is not a deploy** — `deploy.enabled: false` on sacrifice, so every `deploy_actions` row is skipped |
| "no hamster wheel" | `factory audit --app <app>` showing no repeated spend on the same persona/story, and `factory trace <id>` with no repeating event signature |
| "the services sustain" | `systemctl --user status` Result + `errors=` across **two** runs. "Services up" ≠ "sustains" |

**Therefore: after every fix, run the factory and watch it.** Do not batch six
changes and then look. The repo's own history is a list of fixes that were green,
reviewed, and still did not work unattended — that is failure pattern
`marked-solved ≠ soak-validated`, and it is the single most repeated mistake here.

**Never take a subagent's result at face value.** If an agent reports a story
merged, check GitHub. If it reports a gate passing, read the artifact. Agents
report incorrect or misleading results, and a confident summary is not evidence.

### Two standing hazards when delegating

1. **Research agents and fetched text.** The org-level `DESIGN → ENGINEERING`
   rewrite is applied to *fetched web content*, not only authored prose — it was
   **confirmed live** during this plan's research. Instruct every research agent:
   cite by URL + arXiv id, treat a fetched **name** as lower-confidence than a
   fetched **number**, and flag any suspicious title rather than reporting it as
   fact.
2. **Wait-loops that never exit.** `until ! pgrep -f "<pattern>"` matches the
   waiting shell's **own argv** and loops forever (three such loops were left
   running during this session's work). Wait on a *file* or an exit code, or match
   a pattern that cannot match the watcher itself.

## Guardrails that bind this whole plan

- **Gate on the real artifact.** Never a recorded flag, an `--auto` *enable*, a
  dry-run's intent, or a green test run with no commit. `proxy ≠ real` is the
  most common bug class here.
- **Fail SAFE.** A broken detector/gate must BLOCK, not wave things through. When
  changing the oracle, the direction of any new failure must be false-block, never
  false-green — the latter is unrecoverable, the former merely costs a resume.
- **Nothing loops more than 3 times**, and any early-escalation guard stays
  strictly below the hard cap or it is unreachable.
- **Never `git add -A`** in the live tree. Deploy surgically.
- `factory/manager/**` and `bench/**` are operator-PR only.
- **Fixes to shared control flow do not compose for free.** Touching
  merge/reconcile/dispatch means re-verifying everything keyed off it.
- Spend caps in `factory_settings.yaml`. **Notify the operator at $50 / $75 / $100.**
- Do not weaken an existing test to make new code pass. Two tests in
  `test_cli_inbox.py` / `test_dependency_deferral_cap.py` pin deliberate
  invariants; PR #279 made a new feature opt-in rather than relax them. Do the same.

---

> **REVISED 2026-08-09 after adversarial review.** The first draft of this
> workstream rested on two premises that are FALSE against this codebase, and
> shipping it would have made the gate worse. Both are recorded here rather than
> quietly deleted, because the next person will have the same two ideas:
>
> **False premise 1 — "OpenAPI carries the missing facts."** It does not.
> `grep -n "responses=" backend/app/routes/*.py` returns **zero hits** in
> sacrifice; every non-2xx is raised via bare `HTTPException`. Measured directly:
> `POST /api/goals` declares only `['201', '422']` — **no 401**. Key routes
> (`GET /api/auth/me`, `POST /api/goals`) have no `response_model`, so OpenAPI
> reports an untyped `{}`. And the constraint that actually blocked story 179 —
> `goal_type` must be a REGISTERED PLUGIN TYPE, and `"youtube_video"` expects
> `criteria: {min_duration_seconds, video_description}` — lives in a
> `field_validator` (`backend/app/schemas/goal.py:33-48`) and the plugin
> registry, **invisible to the schema**. The current prose carries facts the
> derived surface does not (`config.yaml`: "a duplicate email is
> `409 {"error": "account_exists"}`; a weak password is `400`"). Replacing prose
> with OpenAPI is a NET LOSS of exactly the facts that caused the incidents.
>
> **False premise 2 — "the base run can classify HTTP status."** It cannot.
> `_base_run` sees only junit `{nodeid: PASS|FAIL|ERROR|SKIP}`
> (`oracle_run.py:208-232`; `OracleRun` carries no HTTP data), plus
> `boot.probe_paths`, which is explicitly *"a BLIND replay — no request body, no
> auth headers"* (`boot.py:358-397`). A blind `POST /api/auth/email/register` is
> **422 by construction, always** — as recorded in story 179's own
> `base_runs.json`.

# Workstream A — oracle source of authority

**The defect.** The acceptance author is dev-blind (correct — that is the
anti-reward-hack freeze). But it needs route paths, request schemas and status
codes it *structurally cannot obtain*, so those come from **hand-written prose**
(`gates.acceptance_harness_hint`). The author cannot detect drift — being unable
to check is the point — so a stale fact is laundered into an authoritative oracle
that blocks a correct implementation. Three instances, three patches at the fact,
zero at the mechanism.

**The principle is already right**: `acceptance.build_spec_prompt`'s docstring
already argues the hint is not an independence leak. Total blindness was rejected
in practice (it produced `No module named 'app'`, 2026-08-05). Do not re-litigate
the freeze; it is well-supported (ImpossibleBench arXiv:2510.20270 — whose
mitigation is denying the **dev** test access, never denying the **author** the
API surface).

**But the prose is not going away.** The honest conclusion from the review is
that a machine-derived surface cannot carry the semantic facts (plugin-type
enums, error vocabulary, response bodies). So the goal changes from *replace the
prose* to **make the prose impossible to drift undetected.**

## A1. Derive the surface as an ADDITIVE CROSS-CHECK on the prose (not a replacement)

Keep `acceptance_harness_hint` as the source of semantic truth. Add a derived
artifact and a **consistency test** between them.

- **Derive** the OpenAPI surface, scoped to **the routes the direction's
  `api_spec.md` names, plus auth** — never all 55 routes. sacrifice has 55 route
  decorators and 31 schema classes; an unpruned dump is 10–20× the current
  2,895-char hint and would dilute the acceptance criteria in a 4096-token
  authoring call. Add a size assertion.
- **Cross-check**: every route path and required field named in the prose hint
  must exist in the derived surface. Extend
  `tests/test_sacrifice_acceptance_harness_hint.py`, which already pins the auth
  routes as a deliberate invariant (*"that coupling is the point"*). **Do not
  weaken that test** — extend it.
- **This catches incidents 1 and 3-part-A mechanically at CI time**, with no boot,
  no per-story cost, and no new terminal sink. It does not catch the semantic
  half; that stays prose, and that is an accepted limit, stated here rather than
  wished away.
- **Optional app-side follow-up:** file a direction adding `responses=`
  declarations to sacrifice's routes. That is what would make the error
  vocabulary genuinely derivable. Until then it is prose by necessity.

**If a per-story derived surface is later fed to the author** (beyond the
cross-check), these become binding:

- **Base sha must be verified, not assumed.** Authoring runs at spawn
  (`handlers.py:373`, during pm-sync, before any branch exists); the gate computes
  `base_sha = merge-base(origin/<base>, HEAD)` (`red_green.py:426-439`) from a
  branch created later at dispatch. `auto_merge.enabled: true` with
  `per_repo_concurrent_agents: 10` means **main routinely moves between those two
  moments** — story 179's graded base (`679c091a4219`) was a commit merged in the
  same session. So: record the surface's sha and have the gate **BLOCK on
  `api_surface.base_sha != base_sha`**. Silent drift becomes a named block.
- **Never re-derive on a `force=True` re-author.** Two `explore: true` alternates
  are competing full attempts, not slices (memory:
  `oracle_grades_direction_acs_not_story_scope` — 23 pairs, 20 superseded). If a
  loser's oracle is re-authored later, re-deriving from a *current* origin/main
  would hand it the winner's implementation of the same spec — a genuine
  implementation leak into the channel this design asserts cannot leak. Reuse the
  stored surface, or refuse.
- **Fail-closed must keep a path back.** The "expected but no oracle" gate branch
  (`acceptance_verified.py:495-507`) returns a `GateResult` directly with
  `authoritative: True` and never calls `_unverifiable`, so there is **no
  `waiver_sha` and `factory acceptance-waive` cannot touch it** — operator-only,
  forever. Before adding any new way to reach it: route it through
  `_unverifiable(..., waiver_sha=oracle_sha)` or add `factory
  acceptance-rederive`. Also call `boot.check_prerequisite` first and treat
  "prerequisite down" as **not a failed authoring pass** — a down `sacrifice-db`
  must never burn one of the three `_MAX_AUTHOR_PASSES`. Cap derivation at **1
  per tick**, not `max_per_pass: 10`.

## A2. Base-run status observation — ADVISORY INSTRUMENTATION ONLY

> **The first draft made this the "cheapest, highest-value, ship-it-regardless"
> item. It was the opposite on all three counts, and it would have blocked story
> 179 — the correct, deployed story this plan cites as its success case.**

The proposed taxonomy was *404/501 = feature absent (valid red); 400/422 =
malformed oracle (block)*. It inverts on this app. Story 179's own
`base_runs.json` records, at a base where `goal_count.py` did not exist:

```json
{"method":"GET","path":"/api/goals/count","status":401}
```

`GET /api/goals/count` is shadowed at base by `@router.get("/{goal_id}")`
(`goals.py:163`), whose `Depends(get_current_user)` fires **before** a 404 can be
produced. In a FastAPI app with parameterised routes behind an auth dependency —
most of sacrifice's 55 — **"feature absent" presents as 401/403, and 404 is the
exception.** A blocking taxonomy here is a false-block *generator*, shipped into a
live required merge gate in the name of curing false blocks.

**So: record, classify nothing, block on nothing.**

- Add observed base statuses to the gate's `details` for diagnosis.
- Accumulate **≥20 base runs** before proposing any classification.
- A future blocking version needs per-request statuses out of the oracle
  process — a new channel from `run_oracle`, whose entire design point is that
  nothing crosses back except junit (`oracle_run.py:1-52`), plus a
  `RUNNER_VERSION` bump (`oracle_run.py:73`) that **invalidates every cached stub
  and base run**. That is the most invasive item in this plan, not the cheapest.
- **Strike the claim that this catches anything "at authoring time".**
  `_base_run` is called from `_evaluate` (`acceptance_verified.py:890`) — the
  merge gate, after full dev spend. Of the three incidents it would have caught
  at most one, and only at merge time: incident 1 yields 404 → "valid red,
  proceed"; incident 2 is body-level and the gate has no body data at all.

A cheaper diagnostic that carries **no route-topology assumption**, using data the
gate already holds (`stub_criteria_by_variant`, `acceptance_verified.py:665`):
flag when a credited criterion's base failure is **identical to its failure
against the `200 {}` stub**. That is suspicious without asserting what any status
code means.

## A3. Separate arrange from assert — MOVED BEFORE A2

Setup ("create a goal so the count can increment") is not a behavioural judgment
and carries no independence requirement. Today a `422` on setup is reported as a
verdict on the story — a category error, and what blocked story 179.

**A2 depends on this, which is why it now comes first.** The proposed
"401/403 *on a setup call*" row presupposes an arrange/assert distinction that
does not exist yet: in 179's oracle (`test_acceptance.py:63-67`) the 401 arrives
on the *assertion* call while `_register` (setup) succeeds — one criterion, two
roles, one junit verdict.

Minimum: classify and report setup failures distinctly from assertion failures so
they can never be read as "the feature is wrong". Better: let setup use the app's
own fixtures/factories rather than oracle-authored HTTP bodies. Inference, not a
cited finding — but it is the split arXiv:2504.07244 found *necessary* in industry
(scenario stage 95% helpful from the story alone; executable stage required the
page HTML, semantic relevance 60% → 92%).

## A4. Decide the `explore` + AC-scope block — NEW, and it will dominate D

Memory `oracle_grades_direction_acs_not_story_scope` (2026-08-08/09) documents
three mechanisms that **jointly guarantee** a block: `explore: true` emits
competing alternates; SM writes them as if they were slices and descopes ACs to
"siblings" that never exist; and the author grades against `direction.acceptance`
(`acceptance.py:422`), not the story's scope. The memory ends *"Not yet decided —
needs an operator call."* **That call is still outstanding, and it is the
structural cause of the 173/177/178 family** — not the shape A1/A3 address.

Pick one and implement it: scope the oracle to the story, forbid SM descoping
under `explore`, or make `explore` emit real slices plus an integration story.
Until then every AC-carrying `explore` direction carries a ~50% structural block
rate that would swamp Workstream D's signal.

# Workstream B — measure before benchmarking

The research found a **genuine published gap**: nobody has run a controlled
ablation of oracle-author information budget. We can, cheaply — we already have a
vacuity control, a reviewer-replay corpus, and a per-run cost meter.

**Arms** (same stories, same models, `k` repeats):
1. **criteria-only** — the INTENDED design. Note this arm has never actually run:
   `acceptance_harness_hint` is always supplied today, so this is a new condition,
   not a baseline.
2. **prose hint** — **today's ACTUAL behaviour, and therefore the real control.**
   Report every comparison against this arm; comparing against arm 1 would be
   comparing against a mode that has never run.
3. **derived base surface** — A1
4. *(optional, expect it to be bad)* **HEAD surface** — to demonstrate the
   false-green risk that justifies choosing base

**Measure**: false-block rate (correct implementation rejected), false-green rate
(gutted implementation accepted — the stub control already gives this), authoring
cost, and time-to-merge.

**AND the metric adversarial review says is the real risk — pre-register a
threshold on it.** More base information means more oracles that MIRROR the base
contract. Such an oracle **passes at base**, so `verdict_over` returns `green` →
`oracle_not_discriminating` (`acceptance_verified.py:896-905`) → which is
**waivable** (`waiver_sha=oracle_sha`) → and `_unverifiable` then returns
`passed=True` with the text *"the oracle did NOT verify this story"*. Under a
2 h/day ratification budget, a rising waiver rate is a **false-green pipeline**.
The first draft of this plan asserted "false-block is recoverable, false-green is
not" and never noticed that its recovery mechanism for false blocks IS the
false-green channel. So: track `oracle_not_discriminating` + waivers-granted per
arm, add a waiver counter to `factory inbox`, and **if that rate rises versus the
prose control, A1 has made oracles weaker regardless of what the false-block
number does.**

**Pre-register the arms and the metric before running** — the ablation gate has
been misused before (memory: `ablation_gate_dormant_and_broken`; never flip
`mutation_testing` as an experiment). Archive artifacts per run; **re-running a
sweep destroys published-number artifacts** (memory:
`bench_artifacts_overwritten_2026_08_02`).

Expected outcome: arm 3 ≥ arm 2 on false-block with no false-green regression. If
arm 3 does *not* beat arm 2, **stop and report that** — do not ship A1 on faith.

---

# Workstream C — harness and plumbing defects

Each of these is known and open. Fix or explicitly defer with a written reason.

## C1. Late-stage failure rebuilds from `SM_DONE`
`orchestrator._recover_blocked_stories` re-enters `BLOCKED_REVIEW_NONCONVERGENT`
at `SM_DONE`, re-running SM + dev + review to retry a **tech_writer** step. Story
177 burned **$5.96** over two recoveries rediscovering that its tech_writer model
would not emit parseable JSON. PR #279 added `--at tech_writer` for the operator;
the automatic path is still blunt. Re-enter at the failed step's own predecessor.
*Shared control flow — re-verify everything keyed off it.*

## C2. tech_writer JSON-parse fragility
Story 177's model never returned a parseable JSON object in 2 attempts, then
burned 2 full recoveries. Establish whether this is prompt, model routing, or
parser strictness. A persona that cannot emit its output format is a benchmark
confound.

## C3. Resolve the two remaining parked stories
177 (`blocked_review_nonconvergent`, $5.96) and 178 (`blocked_budget_exceeded`,
$12.41 vs a $12.00 cap). Use `factory resume-story`; 178 needs either a cap
raise or `--force` (never zero the ledger). The inbox must be empty before the
benchmark.

## C4. Oracle runner KNOWN OPEN #2–#4
From `factory/chain/gates/acceptance_verified.py`'s module docstring. #1 was
closed by PR #256. Each open one has a named v1.1 candidate — read them before
any soak. Decide per risk: fix, or accept with a written justification.

## C5. `detector_watch` soak
Ships disabled (`detector_watch.enabled: false`). The first cut would have filed
**48 unfixable directions in ~16 ticks**; liveness+recency scoping was added but
has **never run in production**. Either soak it read-only against live state and
enable, or leave disabled and say so. Do not enable it untested during a
benchmark.

## C6. Sweep for the same class as A1
The defect class is "a hand-maintained fact the consumer cannot verify." Grep the
config surface for others: `acceptance_boot`, gate commands, route tables,
`app_repo_path`. Anything a persona is told and cannot check is a latent false
block. Report what you find even if you fix nothing.

## C7. Environment hygiene
- Leaked docker networks/containers make host-only test gates red invisibly
  (sacrifice #394). Verify none are leaked before the run.
- The dirty-app-tree redeploy failure (memory:
  `dirty_app_tree_fails_the_redeploy_timer`) — `unit-active ≠ unit-working`.
- Establish the local suite baseline *before* blaming any diff (memory:
  `red_test_can_mean_nothing_too`): CI `pytest` has a 25-min cap and the local
  suite runs ~17–19 min.

---

## A5. AC-precision gate — extracted from the closed Karpathy direction

Rescued from direction `002-karpathy-quality-layers` (P1.2) before closing it as
superseded: **the backpressure validator should check that each acceptance
criterion is observable and testable, and reject the vague ones.**

It belongs here, not there, because it is the upstream half of this workstream's
problem. A vague AC produces an oracle that cannot discriminate, which lands in
`oracle_not_discriminating` → waiver → `_unverifiable` returning `passed=True` —
the false-green channel Workstream B now measures. Catching an untestable AC at
triage costs one PM call; catching it at the gate costs a full dev cycle and an
operator waiver.

Related but distinct from criterion VACUITY (memory:
`criterion_vacuity_is_the_second_sensor_failure`): vacuity is "a no-op satisfies
it", precision is "nobody can tell what would satisfy it". Both end at the same
gate.

# Workstream E — make it faster, on measured causes

**Measured 2026-08-09 over 196 dev runs and the per-story event logs. Read the
numbers before optimising anything, because the intuitive answers are wrong
here.**

**The factory is NOT slow when it is working.** Story 179 went creation → PR in
**22.7 min wall clock against 26.5 min of LLM work — ~0% dead time**, entirely
work-bound. That is its real speed.

**It is slow when a story stalls.** Story 172: **289 min wall, 21.4 min of work —
92.6% dead**, and **255 of those minutes were a SINGLE gap** between
`handler_start` and `stale_recovery`. A handler died without writing
`handler_end`, and the row sat in `*_in_progress` until a sweep noticed. Two of
its three largest gaps are that same pattern.

Where the work actually is:

| persona | n | avg | total | share of work time |
|---|---|---|---|---|
| **dev** | 196 | **658 s** | **35.9 h** | **~97%** |
| tech_writer | 83 | 92 s | 2.1 h | 6% |
| acceptance_author | 13 | 118 s | 0.4 h | 1% |
| sm / reviewer / pm / contract | 241 | 5–17 s | 0.6 h | ~2% |

(`manager_watcher`'s 17 h is the deleted FMS tier and no longer runs.)

**What NOT to do — ruled out by the measurements:**
- Do not shorten the 5-min tick. Handlers already chain within a tick
  (`max_advances_per_story = 10`), so the local SM→dev→review→tech_writer segment
  does not wait on ticks at all.
- Do not micro-optimise SM / reviewer / pm / contract. Together they are ~2% of
  work time; making them free saves minutes out of hours.
- Do not chase model speed for dev. 658 s is OpenHands doing real work.

## E1. Kill the stall class — the single biggest latency, by an order of magnitude

The 255-minute gap happened because `_prune_stale_in_progress`
(`_STALE_THRESHOLD_SECONDS = 10 * 60`) only runs inside a tick, and **no tick was
running**. That is an availability failure presenting as a performance one.

**The same root cause produces the "issue-lifecycle leak" that keeps getting
re-diagnosed as an architecture problem. It is not one.** When direction 002 was
rejected on 2026-08-09 its GitHub tracker (#122) stayed open, which looked like a
sync bug. It is not: `orchestrator.py` already runs `reconcile_completed_issues`
inside the tick, rate-gated to ~once/hour/app, with a comment saying it exists so
"the repo's issues stay clean WITHOUT a manual `factory reconcile-issues`". The
tracker stayed open because the factory was OFF. **Do not "fix" issue lifecycle by
adding a sixth reconciler — fix the tick not running.**

- **A stall detector that does not depend on the thing that stalled.** Today the
  only detector of a stalled story is a sweep inside the loop that stalls. At
  minimum, surface it: `factory inbox` should list any story in an
  `*_in_progress` state older than the stale threshold, and any direction whose
  local status is `closed` while its tracker is still open — both computed as
  pure reads, so they work with the factory off.
- **Make "the factory is OFF while stories are in flight" loud.** `factory power`
  printing OFF is not the same as anyone noticing.
- Verify `_prune_stale_in_progress` actually fires at 10 min in a live run. It has
  never been observed doing so in the data reviewed here.

### E1a. Lifecycle writes should attempt the remote side inline

`factory approve-direction --reject` calls `mark_direction_status(..., "closed")`,
which writes the on-disk `state.yaml` and **touches GitHub not at all**
(`cli.py:419-427`). Having a backstop is right; making the backstop the PRIMARY
mechanism for an operator-initiated lifecycle change is not — it guarantees a
window of visible disagreement, and that window is unbounded when ticks are not
running.

Add a best-effort tracker close at the point of decision (failure is fine — the
sweep still catches it). Then the reconciler catches genuine drift instead of
routine work. Same treatment for any other operator command that terminalises a
direction or story.

### E1b. Five reconcilers is the real cost of the split — consolidate the predicate

`reconcile_completed_issues`, `reconcile_closed_trackers`, `reconcile_from_github`,
`reconcile_dual_draft_winners`, plus the `reconcile-issues` CLI command. Each
encodes its own notion of "this is finished", and drift hides in the gaps between
them (the tracker-closer's resolved-states allowlist vs the inbox predicate vs the
dependency gate's dead-end set is exactly this, three times over).

**This is NOT an argument for moving state to GitHub.** `StoryRecord` carries ~40
fields, many of them counters mutated several times per tick per story
(`dev_retries`, `total_attempts`, `total_spend_usd`, `max_progress_ordinal`,
`dependency_defer_count`, plus dev/reviewer history blobs). Against the GitHub API
that is ~200-500 ms per write, a 5,000 req/hr ceiling, and no transactions — which
is why the orchestrator already caps `max_reconcile` calls per tick. Worse, it
would put a hard dependency on someone else's uptime in the merge path: a gate
that cannot read its own story state because of a 403 is strictly worse than one
reading slightly stale local state. Authority is already assigned correctly —
**merge reality is GitHub** ("never trust a local flag"), operational state is the
DB. Consolidate the PREDICATE, not the store.

## E2. Cut dev RETRIES, not dev speed

Dev is 97% of work time and one clean pass is ~11 min. The cost is repetition:
stories 177 and 178 burned **6 dev calls each — 88 and 146 minutes of dev alone**.
Every retry cause removed is worth more than any per-call speedup.

**This means Workstreams A and C ARE the performance work.** A false-blocking
oracle, a wrong contract fact, and an ambiguous AC each cost a full dev cycle.
Do not treat "make it faster" as separate from them.

## E3. Timed-out dev runs — 30 minutes for nothing, invisible to the breakers

**8 of 196 dev runs hit the 1800 s cap.** Each spent 30 minutes producing nothing,
and per memory `sandbox_timeout_loses_usage_and_retry` a timed-out run records
**$0**, so the budget breakers cannot see it and the retry bounces free. Fix the
accounting first (a timeout must charge and count), then decide whether the cap
should fail faster.

## E4. Throughput is a concurrency lever, not a latency one

`per_repo_concurrent_agents: 10`, but in-flight has been **2**. Since the operator
thesis is **throughput at an acceptable defect rate, not $/task** (memory:
`operator_decisions_2026_08_07`), running 8–10 stories concurrently multiplies
output without touching per-story latency at all.

**Caveat that must be honoured:** Workstream D measures *unattended behaviour*, so
whatever concurrency is chosen must be the configuration actually benchmarked —
and docs stories still serialise per app (memory: `docs_chain_serialization`).

## E6. HARD CRITERION — PR-blocking CI must finish in 60 SECONDS

**Operator decision 2026-08-09. This is a hard criterion, not a target.**

**Today:** 3,008 tests, 219 files, **~19 min locally and 19m12s in CI** (PR #280).
Everything else in CI is noise beside it — lint 11 s, typecheck 61 s, `changes`
11 s. The job cap has already been raised **15 -> 25 min** (2026-08-08) after
three runs were cancelled at ~15m with zero failures; at 19m12s it is heading for
25 as well.

**The proof that 60 s is reachable — measured, not assumed.** PR #280 is
documentation plus 35 lines of `apps/sacrifice/config.yaml`. The tests that
genuinely cover that config —
`test_sacrifice_acceptance_harness_hint.py` + `test_app_gates_config.py` +
`test_deploy_app_config.py` — run in **0.586 s**. The other 19 minutes tested
nothing that could have changed.

**How to get there. The criterion applies to the PR-BLOCKING lane, and the full
suite does not disappear — it moves.**

1. **Tier the suite.** A fast lane gates the PR; the full suite gates merge-to-main
   (or runs post-merge and blocks further merges on red). **The tiering rule must
   be "what can this diff actually break", not "what is quick"** — a fast lane
   chosen for speed rather than coverage is how a regression merges. Anything
   that boots a server, spawns a subprocess, or touches docker belongs in the full
   lane; that is where the ~380 ms/test average comes from.
2. **Fix `docs_only` first — it is nearly free.** It currently means "every changed
   path is a ROOT-LEVEL `*.md`", which is why a docs PR with one `apps/*/config.yaml`
   line paid the full 19 minutes. Widen it carefully: the narrow rule exists
   because `factory/personas/*.md` are prompts covered by contract tests, and that
   carve-out must survive.
3. **`COVERAGE_CORE=sysmon`.** CI runs `pytest --cov=factory`; tracing is pure
   overhead on every test. Python 3.12 + coverage.py >= 7.4 support
   `sys.monitoring`, which is far cheaper than the classic trace function. One env
   var. Coverage belongs in the full lane anyway, not the fast one.
4. **Parallelism, sized to the runner.** `runs-on: ubuntu-latest` is a
   GitHub-hosted standard runner (2-4 vCPU), NOT the 16-core dev box — so xdist
   buys much less on CI than locally. Locally, `pytest-xdist` is **not installed**
   and the suite runs single-threaded on 1 of 16 cores; that is the big local win.
   Use `-n auto --dist loadfile` so same-file tests stay on one worker.
5. **A larger runner** for the full-lane job: the only lever needing no
   test-isolation work at all.

**The hazard this must not create.** This repo has been bitten three times by
exactly what suite-splitting and parallelism trigger:
`fms_sm_truncation_was_test_pollution` (tests wrote into production telemetry),
`sacrifice_conftest_ddl_lock_contention` (an autouse `create_all` fabricated **46
fake failures**), and `red_test_can_mean_nothing_too` (concurrent runs produce
mirages). Treat every new failure as a GENUINE isolation bug to fix, never as
flakiness to retry. **A fast suite that is quietly wrong is far worse than a slow
one that is right.** Bank the wall-clock only after two consecutive green runs.

**Acceptance for this item:** the PR-blocking lane completes in **< 60 s** on a
representative code PR, the full lane still gates something (merge or post-merge
with a red-blocks-merges rule), and no test moved to the full lane because it was
slow rather than because the diff could not affect it.

**Scope note.** E6 buys **loop-3 and loop-2 iteration speed** — most of what a
readiness push waits on — and **not** Workstream D's story throughput. A sacrifice
story's merge gate runs the app's own, much smaller `test_command`; the factory
suite gates only factory PRs.

## E5. Note the trade-off the retry cap makes

Raising `max_dev_retries` 3 → 4 (2026-08-09) **trades latency for completion**:
more stories finish, each slower, and a 4th attempt costs ~11 min. That is the
right direction for a throughput thesis, but it is a hypothesis — **Workstream B
should measure completion rate and per-story wall clock at 3 vs 4**, not assume.

# Appendix — what closing direction 002 (Karpathy quality layers) leaves behind

`apps/factory/directions/002-karpathy-quality-layers` + GitHub issue **#122**
are closed as **substantially delivered and partly superseded**. Recorded here so
the reasoning is not lost with the issue, and so the live parts are not
re-discovered from scratch in three months.

**Status audited 2026-08-09, against the tree, not the doc:**

| Item | State |
|---|---|
| P0.1 `smoke-green` gate, config-guarded, per-app required set | **SHIPPED** — story 179 lists `smoke-green` in its passed gates |
| P0.2 app-side smoke harness | **SHIPPED** — `smoke_harness_ready: true` (the direction text still says FALSE; it rotted) |
| P2.1 per-app `CLAUDE.md` | **SHIPPED** — `/home/k/sacrifice/CLAUDE.md` exists |
| P0.4 deploy probe | **MOOT** — `deploy.enabled: false`; `deployed` is a state name, not a deploy |
| P0.3 adversarial refute-critic | not shipped |
| P1.1 goal-discovery persona | not shipped |
| P1.3 agile first-slice checkpoint | not shipped |
| P2.2 reusable per-app skills | not shipped |
| P2.3 tool-level forbidden-path guardrails | not shipped |
| **P1.2 AC-precision gate** | **not shipped — RESCUED into A5 above** |

**Why closing is right, not lossy:**

1. **Every one of its formal acceptance criteria is about P0.1, and P0.1
   shipped.** By the direction's own definition of done, it is complete.
2. **Its central thesis was delivered by a stronger mechanism than it asked
   for.** "Green must mean the product runs" is now enforced by the acceptance
   oracle (direction 019): authored from the spec, frozen before dev starts,
   booted and exercised OUT OF PROCESS over HTTP, with a gutted-implementation
   control. That is a better verifier than the deploy probe P0.4 specified.
3. **It has been parked in `needs-direction` since 2026-07-29** for missing
   `user_flow` / `api_spec` / `explore_tag` — artifacts that do not fit a
   *factory* direction. It blocks nothing and clutters the approval queue.

**What survives, and where it went:** P1.2 (each acceptance criterion must be
observable and testable) is now **A5** in Workstream A, because it is the
upstream half of the oracle problem — a vague AC produces an oracle that cannot
discriminate, which is the `oracle_not_discriminating` → waiver → false-green
channel Workstream B measures.

**What is genuinely dropped, and should be re-filed if wanted:** P0.3
(refute-critic), P1.1 (goal-discovery persona), P1.3 (first-slice checkpoint),
P2.2 (reusable skills), P2.3 (tool-level guardrails). None is load-bearing for
benchmark readiness. P2.3 is the most defensible of them — forbidden paths are
still a *prompt request* rather than a tool-level block — but it is a hardening
item, not a correctness gate, and the staging twin already bounds self-edit blast
radius.

**The transferable lesson, which is why this appendix exists:** the direction's
own text asserted `smoke_harness_ready: false` and "no per-app CLAUDE.md" long
after both had shipped. **A long-lived direction document rots into a false
account of the system**, and anyone reading it to decide what to build next is
reading fiction. Audit a direction against the tree before acting on it — the
same failure as memory `stale_context_doc_refiles_shipped_work`, where a stale
context doc caused the same direction to be re-filed five times.

# Workstream D — end-to-end proof

**The necessary condition for benchmarking. Not, on its own, a readiness proof —
see the power note at the end.**

Write **three fresh directions** against `sacrifice`, all with **`explore: false`,
stated explicitly in each direction and justified there.** Under `explore: true`
SM emits two competing alternates and `superseded_by_sibling` is the NORMAL,
CORRECT outcome for half of them (measured: 23 pairs → 23 deployed / 20
superseded, memory `oracle_grades_direction_acs_not_story_scope`). The first draft
listed that sink as a plan failure, which would have auto-failed on correct
behaviour. The trade-off is explicit: `explore: false` is not the shipping
configuration, so D tests the chain's *mechanics*, and the explore path is
covered by A4 instead.

| # | Shape | Exercises | Constraint |
|---|---|---|---|
| D-1 | a new read endpoint, no setup state | the simple path end-to-end | purely additive |
| D-2 | a criterion needing **prerequisite state** (create an entity, then observe) | **A1 + A3** — the setup-vs-assert split | purely additive; see the KNOWN OPEN #2 note below |
| D-3 | a change to an **existing** endpoint's behaviour | how the harness handles a route that already exists | **blast-radius bounded — see below** |

**D-3 is the shape that has already killed a direction.** Direction 117 gated an
existing route (`POST /api/goals`), broke ~40 sibling tests, exhausted both
alternates and 6 dev attempts, burned ~$14, and terminated as story 177
(`blocked_review_nonconvergent`) + 178 (`blocked_budget_exceeded`) — measured
2026-08-09, the same day as this plan (memory:
`direction_117_was_oversized_for_one_story`). And `caps.per_story_spend_usd: 12.0`
is a **terminal** breaker. So: before filing D-3, run
`grep -rl "<route>" backend/tests/` and **pre-register the number in the
direction**; require ≤3 files. Prefer adding a field to an existing response over
changing existing behaviour. **Decide in advance** whether a
`blocked_budget_exceeded` on D-3 falsifies the plan or is out of scope — do not
decide after seeing the result.

**KNOWN OPEN #2 and D-2.** `acceptance_boot.env` points at the **shared** dev
Postgres (`config.yaml`, and its own comment says so), and D-2 is precisely the
shape that trips cross-run contamination. Either close #2 before D-2 (run the HEAD
oracle twice, require both green), or state in the direction that a D-2 red will
be re-run before being believed.

Use the `new-direction` skill. Then run them through **unattended**:

```bash
factory pm-sync --app sacrifice --dry-run   # PURE preview; verify, then run for real
factory on                                   # or drive with `factory tick --app sacrifice`
```

**Watch for, and treat each as a FAILURE of this plan:**
- any story reaching a `blocked_*` sink, or `superseded_by_sibling` **given
  `explore: false`** (under `explore: true` it would be normal)
- any story needing an operator to advance
- **any hamster wheel**: repeated identical work with no state change — check
  `factory audit --app sacrifice` for repeated spend on the same persona/story,
  and `factory trace <id>` for a repeating event signature
- any oracle that fails at HEAD on a *correct* implementation (the false block
  this plan exists to remove)
- any gate passing on a story whose implementation is wrong (**false green — stop
  everything and report; this is worse than every other outcome combined**)
- a rising **waiver / `oracle_not_discriminating`** rate (the false-green channel
  identified in B)

**Exit criterion — artifacts, not state names.** For each of the three:
1. a **merge commit on GitHub** (never a local flag);
2. `acceptance-verified` present in `merge_actions.gates_passed_json`;
3. `state/acceptance/sacrifice/<id>/stub_runs.json` **and** `base_runs.json` on
   disk, showing a credited `K` and a corroborated base — **the gate emits no
   events, so these files are the only proof it ran**;
4. zero rows in `factory inbox`; zero operator interventions; spend within cap.

**`deployed` is NOT an exit criterion.** `deploy.enabled: false` on sacrifice, so
it is a state name and every `deploy_actions` row is skipped.

**ABORT TRIGGER.** `gates.acceptance_oracle: true` is live. If A1/A3/A4 regress,
every AC-carrying story blocks and this phase becomes unrunnable. So:
**if two consecutive fresh stories block for an acceptance reason, set
`gates.acceptance_oracle: false`, stop, and diagnose.** Do not push through.

If a story blocks: diagnose, fix the *class* not the instance, record a memory
file, then **re-run from a fresh story** — a resumed story proves the resume path,
not the unattended path. Both matter; do not confuse them.

**What D can and cannot establish.** Three stories, k=1, three different shapes is
**n=1 per shape**. This repo's own MDE is ±38 pp at n=19 (`STATUS.md`); the 95% CI
on 3/3 is roughly [29%, 100%], i.e. 3/3 is consistent with a true per-story
success rate of 30%. So: **3/3 is a necessary condition for benchmarking, not
evidence of a rate.** 0/3 or 1/3 is decisive evidence *against* readiness. If you
want a rate, the 45 held-out pm-validated sacrifice directions (`STATUS.md`) are
the pool — run 10 and pre-register the threshold.

---

## Suggested order — sequential phases, parallel inside each

Everything inside a phase runs concurrently; phases are barriers because each one
needs the previous phase's *observed* result, not its predicted one.

**Phase 0 — look before touching (all parallel, mostly cheap)**
- `haiku`: environment sweep — leaked docker networks/containers, `factory power`,
  `factory mode`, live tree == `origin/main`, local suite baseline timing (C7)
- `haiku`: collect current parked/blocked state, spend rollups, open PRs
- `sonnet`: C2 tech_writer JSON diagnosis — **read `factory trace 177` FIRST.**
  This plan's C1/C2 attribute 177 to a tech_writer parse failure, while memory
  `direction_117_was_oversized_for_one_story` attributes it to contract ambiguity
  at review. Resolve the discrepancy before designing any fix around tech_writer.
- `sonnet`: C6 sweep for other unverifiable config facts
- `opus`: C4 read the oracle's KNOWN OPEN #2–#4 and recommend fix/accept —
  **#2 gates D-2, so this is on the critical path**

**Phase 1 — the decision that dominates everything downstream**
- `opus`: **A4** — make the `explore`/AC-scope call the memory has been waiting
  for, and implement it. Until this lands, every AC-carrying `explore` direction
  carries a ~50% structural block rate that would swamp D's signal.
- `sonnet` (serialise the actual `resume-story` calls — they write the DB): **C3**,
  resume stories 177/178.
- Then: full suite, adversarial `opus` review, PR, CI, merge, deploy.
- **Observe**: run a tick and watch real stories move.

**Phase 2 — the cheap mechanical guard**
- `sonnet`: **A1's cross-check test** — hint-vs-derived-surface consistency in CI.
  No boot, no per-story cost, no new terminal sink. Extends
  `tests/test_sacrifice_acceptance_harness_hint.py`; **do not weaken it**.
- `haiku`: **A2's advisory instrumentation** — record base statuses in `details`.
  Classify nothing. Block on nothing.
- These two are genuinely independent. Everything richer in A1 (a per-story
  derived surface fed to the author) is **deferred** until the cross-check has
  been live and the A1 preconditions — base-sha verification, no re-derive on
  `force`, `_unverifiable` path back — are all implemented.

**Phase 3 — A3, then measure (B)**
- `opus`: **A3** arrange/assert split. **A3 precedes any blocking version of A2**,
  which presupposes the distinction A3 creates.
- `sonnet`: draft D-1/D-2/D-3 concurrently, with blast-radius numbers
  pre-registered and `explore: false` justified in each.
- Then **B**: pre-register arms and metric *including the waiver /
  `oracle_not_discriminating` rate*. Archive artifacts per run — re-running a
  sweep destroys published-number artifacts. `opus` interprets.
  **If the derived surface does not beat the prose control on false-block, OR the
  waiver rate rises, STOP and report.**

**Phase 4 — remaining harness integrity + speed (parallel)**
- `opus`: C1 (shared control flow — re-verify everything keyed off it)
- `sonnet`: C5 detector_watch read-only soak, then decide
- `sonnet`: C2 fix, if Phase 0 identified a real cause
- `sonnet`: **E1** (stall visibility) and **E3** (timeout accounting). E2 needs no
  separate work — Workstreams A and C ARE the retry-reduction work. **E4**
  (concurrency) is a decision to make BEFORE Phase 5, because it changes the
  configuration Phase 5 measures.

**Phase 5 — the unattended proof (D) — SERIAL, and the point of all of it**
Run the three directions through the real factory and watch. No agent may
"conclude" this phase from a summary; it is closed by the four artifacts listed in
D. Honour the abort trigger.

## Reporting

Report honestly and specifically. State what was fixed with SHAs, what was
deferred and why, and what remains unproven. A summary is a self-report until a
commit backs it. If the chain still cannot run three fresh stories unattended,
**say so plainly** — "not ready to benchmark" is a valid and useful outcome, and
far more valuable than a number nobody can trust.

Refresh `apps/factory/context/modules/*.md` for any subsystem touched: manual
loop-3 PRs bypass the chain's `tech_writer` step, which is the only thing keeping
those docs current.
