# Postmortem — why the factory loses to one agent on the same model

**Date:** 2026-08-11 · **Basis:** the Step-4 replay (PR #321) plus a four-agent
evidence re-read of the run tree, the same-week control, and the chain source.
Every number here is re-derivable from an archive this document names.

**The one-sentence finding.** On a one-patch task with one dev and no selection
term, an orchestration layer can only re-package the same model's samples — so
every part of it that is not neutral is a tax, and this chain's parts are not
neutral.

---

## 1. Where we are

| same 18 instances, same dev model, same week | resolved | rate | total $ | $/resolved | median wall |
|---|---:|---:|---:|---:|---:|
| **the chain** (all fixes #310–#321) | **10/18** | **56%** | 81.00 | **8.10** | 1,804 s |
| **one OpenHands agent, no chain** | **12/18** | **67%** | 14.34 | **1.19** | 454 s |
| the chain, sweep 2 | 10/18 | 56% | 50.18 | 5.02 | 1,038 s |
| the chain minus its reviewer, sweep 2 | 9/18 | 50% | — | — | — |
| Claude Code CLI (frontier reference) | 11/14 | 79% | 30.18 | 2.74 | 264 s |

Paired chain vs agent: both 9 · chain-only 1 · agent-only 3 · neither 5.
**McNemar exact p = 0.625.** k=1 at n=18 proves no delta. What *is* stable across
five same-model arm-runs (37%, 44–53%, 53%, 56%, 67%) is the **absence of any
chain lift** and a **5–7× cost multiplier**.

### The headline number is charitable to us

The benchmark grades the **diff**. The live chain ships on a **verdict**. Three
of our ten resolves (`tox-3931`, `canvasapi-716`, `jsonpickle-588`) ended in
blocked states the live chain would never merge.

> **Under live-chain semantics — only `reviewer_done` ships — the factory is
> 7/18 = 39%, against the control's 67%.**

That is the number the operator's tasks/day thesis would actually experience,
and it appeared nowhere before this postmortem.

---

## 2. Why: five mechanisms, in order of size

The hypothesis we most wanted to test — *the chain's PM/SM/contract decomposition
degrades the dev's input* — is **refuted for this benchmark**. In the bench arm
there is no PM, SM or contract: the dev's story is the raw problem statement
verbatim, byte-shared with the control through one template
(`bench/swebench_adapter.py:2193`, comment at `:2166` — "one string, four arms,
no privileged wording"). The chain loses on what it adds *around* an identical
spec.

*(Caveat: on the live chain those personas DO rewrite specs, and
`SOTA-RESEARCH-2026-08-oracle-authority.md` documents three false blocks caused
by hand-written spec prose. The benchmark cannot see that term. Do not conclude
it is zero in production.)*

### 2.1 It fragments the dev's horizon — a real cost, but NOT the biggest lever

> **CORRECTED 2026-08-11, same day.** This section originally called horizon
> slicing "the biggest single lever" and recommended raising the cap first. A
> subsequent attempt-level accounting of all 40 dev attempts **does not support
> that**, and the recommendation is withdrawn. The mechanism below is real; its
> measured yield is not. See the correction box at the end of this section.

Each chain dev attempt is a **fresh** OpenHands conversation hard-capped at
**1,800 s** (`factory/runner.py:68`; the value actually passed is
`dev_convergence.dev_sandbox_timeout_s`, `factory_settings.yaml:220`), with only
a self-summary and trailing tool calls carried across the boundary. The control
runs **one** conversation under the 5,400 s arm clock.

The chain is **not** starving the dev of iterations — it buys *more*: 2,058 tool
calls vs the control's 1,169, and 4× the wall clock.

> **What the attempt-level data actually says.** The cap killed **6 of 40
> attempts across 4 rows**, costing **$25.97 — 32% of the run's spend — for zero
> graded output**. But outcomes lost to it: **0 CONFIRMED, 1 PLAUSIBLE, 3 NO
> EVIDENCE**. Of the 30 successful attempts, median **552 s**, max **1,329 s**,
> and **nothing finished between 1,366 s and 1,800 s** — dev runs are bimodal, so
> the cap is reaping already-dead attempts, not slicing near-misses.
> `keras-22316` and `rapid-mlx` were killed and **resolved anyway** (the worktree
> is shared across attempts). `vyper`'s three attempts made **zero file-editor
> writes** — 44/29/38 calls, every one a `view`. `exstruct` is the only plausible
> loss, and only because the control resolved it in **1,800.1 s**, 0.1 s over our
> cap — while our own attempt 3 made 0 edits and spent 30 minutes thrashing a
> malformed `think` tool schema.
>
> **Therefore: do not raise the cap as a first move.** The higher-yield fix is a
> **no-progress abort** (kill an attempt that has written nothing), which
> reclaims the same $26 without touching the successful distribution. More
> outcomes were cost by the reviewer churn guards (3 rows) and the same-signature
> stall guard (`tox` — which blocked a diff that graded *resolved*) than by the
> clock. §2.2 is the real lever.
>
> Two further corrections: `runner.py:58-67` claims a timeout is a free infra
> bounce — it is not, it burns a dev retry and discards the attempt's
> `files_changed` and test evidence. And `result.json.model_calls` counts
> **persona invocations, not HTTP calls** (`keras` reports 6; the true count is
> ~163), so no per-call arithmetic should use that field.

> **This is also a measurement-integrity defect.** `swebench_adapter.py:4831–4835`
> asserts the arms are budget-matched — "the shared 5400 s wall clock binds first
> for both". That is false: iteration caps match (600), per-conversation wall
> clock does not (1,800 vs 5,400). An undisclosed arm asymmetry has been sitting
> inside a disclosed identical-budget claim, and it biases **in the chain's
> favour** — the true chain-vs-solo gap may be larger than measured.

### 2.2 Its gates speak a language the dev cannot decode

The production-delta gate rejects a green attempt with the summary **"tests not
green after run"** while the retry prompt shows the dev a **passing** test tail
and no reason.

On `exstruct-113`, attempt 2's prompt literally contains `Summary: tests not
green after run` above a tail reading `11 passed in 0.82s`. The dev cannot update
on a reason it is never given. Combined with a dev-persona clause that legitimises
stopping at "already satisfied at base; no change needed" (`factory/personas/dev.md:60`),
the chain burned two retries replaying an identical disagreement, then lost
attempts 3 and 4 to the 1,800 s slice and an Azure 429. Final diff: **0 production
bytes, $8.83.** The control resolved it.

This is a **feedback-channel failure**, a category none of our pre-registered
criteria model.

### 2.3 Its verdict layer carries approximately zero information

| quantity | value |
|---|---|
| P(resolved \| chain said green) | 7/12 = **58%** |
| P(resolved \| chain blocked) | 3/6 = **50%** |
| base rate | 10/18 = **56%** |

The reviewer, the oracle and the gates together discriminate resolving from
non-resolving patches **at chance**. Three resolving patches were blocked; four
wrong ones and one machinery-corrupted one were approved. Sweep 2's 71% precision
did not replicate (58%).

### 2.4 Its workspace corrupts both the artifact and the evidence

- **The artifact:** `line-bot-981` — resolved by *every* prior same-model arm —
  produced a 575 KB diff opening `deleted file mode 160000`. Every file applied
  cleanly, including both real fixes; the apply still exited 2 on the gitlink
  hunk. `diff_integrity.trustworthy` was `true`.
- **The evidence:** on `jsonpickle-588` the reviewer blocked three times on (a)
  "tests not executed — still 77 collected" and (b) a 0755→0644 mode flip. Both
  are artifacts of our own 0444 lock and digest-restore machinery. The chain fed
  its reviewer corrupted evidence and then punished the dev for it.
- **The remedy, forbidden:** on `canvasapi-716` the reviewer acknowledged the
  production fix correct and demanded one more test — in `tests/test_util.py`, a
  digest-locked file the dev's edits hit with `[Errno 13] Permission denied`.
  **The chain demanded, then physically forbade, then punished the absence of,
  the same edit.**

### 2.5 The tax is the dev loop re-executing itself, not the extra personas

| component | cost | share |
|---|---:|---:|
| dev | $76.82 | 94.8% |
| reviewer | $3.14 | 3.9% |
| acceptance author | $1.03 | 1.3% |

The overhead is **40 fresh dev conversations for 18 instances** (9 of them eaten
whole by infrastructure), each re-reading the repo cold: 34.6 M fresh input
tokens against the control's ~14 M (**corrected**: 4 control rows recorded zero
usage from abandoned worker threads, so the ratio is ~2.5×, not the 5.5× an
earlier draft implied — the *cost* ratio, $8.10 vs $1.20 per resolved, stands).

---

## 3. The identity was wrong, and how

The governing model was `score = capability − tax + selection`, with `selection`
pinned at 0. It correctly predicted the replay's central result — the fixes
recovered exactly their three targeted rows and the rate did not move. But it
treats **capability as a constant the chain merely taxes**. The data says the
chain changes the capability term itself:

```
graded_score  = capability(model, task, horizon_slice, policy, environment)
                − artifact_tax
                + selection_lift            (= 0)
shipped_score = graded_score × verdict_recall        (0.70 here)
```

Every argument in that first term is something the chain sets **worse** than the
control, and the trailing multiplier is something the control does not have at
all. That is the structural reason three sweeps of engineering produced no rate
movement: **every machinery fix moves the chain asymptotically toward the
control, never past it. Parity is the maximum purchasable.**

---

## 4. Layer-by-layer autopsy

### The acceptance oracle: unenforced, and often vacuous

- `gate_enforced` is a literal `False` (`bench/swebench_adapter.py:3057`),
  confirmed on all 18 rows. `acceptance-events.ndjson` contains exactly one
  `authored` event per row — no `ran`, no `passed`, no `blocked`.
- It cost **$1.03 across 18 calls** and sat on the **critical path**: authoring
  completes before the dev's first call on 18/18 rows.
- **7 of 18 oracle files contain zero asserts.** The persona mandates HTTP-only
  tests with no app imports — a contract shaped around the `sacrifice` web app.
  Seven benchmark repos are Python libraries with no HTTP surface, so the author
  correctly declares the criterion untestable and emits a pure `pytest.skip`.

An entire oracle file, verbatim:

```python
def test_ac1_reboot_with_sudo_password_untestable():
    pytest.skip(
        "No public HTTP route or harness facts were provided to observe "
        "server.reboot's wait-and-reconnect behavior with _sudo_password"
    )
```

**This inverts the obvious recommendation.** "Turn the gate on in the benchmark"
would have *lowered* the score: an all-skip oracle blocks (there is a test named
`test_all_skipped_oracle_exits_zero_but_gate_blocks`), so enforcement would have
blocked 7 of 18 rows — including `pyinfra-1665`, `conan-19735` and
`nicegui-5858`, **all three of which resolved**. Roughly 10/18 → 7/18.

This is the `criterion vacuity` failure class recurring: independence is not
enough, because a no-op satisfies a negative criterion.

### The reviewer: 26 calls, and 56% of its blocking findings cannot matter

- 13 approve / 13 request_changes; 52 findings, 18 blocking.
- **10 of the 18 blocking findings are `tests`** — and graded predictions strip
  test files, so more than half of what it blocks on is causally inert.
- **Not** suppressing scope: `scope` findings are hard-fenced to `low`
  (`reviewer.md:101`) and all 4 observed were `low`. The scope-widening
  hypothesis is refuted.
- **No demonstrable conversion.** No replay row shows reviewer feedback turning a
  failure into a resolve. Sweep 2's counterfactual agrees: all three of its
  factory-only resolves had `reviewer_cycles: 0`, and `solo-noreview` resolved
  three instances with no reviewer at all.
- Upper bound on the whole reviewer+oracle apparatus: **≤1 instance** (10/18 vs
  9/18, n.s.) against **3 resolving patches it blocked** in this replay. On this
  data it is **net-negative for shipped work**.

### Containment: defeated by one command, but not by cheating

All 10 bypasses are a `chmod` widening (`chmod u+w`, `chmod +w`, `chmod -R u+w`)
after `file_editor` hits `EACCES` — the lock is applied as the **same uid** the
dev runs as, and `swebench_adapter.py:1839` concedes it is "a strong default plus
a MEASUREMENT, not a sandbox boundary".

**CORRECTED:** an earlier draft said 2 rows had committed edits. It is **all
10** — every `restore_errors` entry on every bypassed row reads "the edit was
committed, not just written". This is structural, not incidental: the chain
commits before review, so `git checkout --` restores the commit *containing* the
edit. **The repair layer is ~50% effective by construction.**

Note also that the lock exists **only in `bench/swebench_adapter.py`** — the live
chain never locks anything, so this is a benchmark-only artifact.

Reading the diffs: **incidental, not gaming.** Four of five sampled are
append-only regression tests; `canvasapi`'s single rewritten assertion matches
what the official test patch does. This is the Loop-4 "dev owns the tests"
mandate colliding with the ImpossibleBench freeze — two deliberate policies that
contradict each other.

**And it is a regression to an already-diagnosed root cause.**
`memory/loop4_dev_owns_tests_rewrite.md` records that Loop-4 exists *because*
"test-first + test-frozen + test-owned-by-another-agent" produced infinite
ping-pong. The 0444 lock restores all three conditions, while `dev.md:46` says
"You own code AND its tests", `dev.md:150` says apply every review finding
verbatim, and the bench's own `_TEST_POLICY` directs the dev to write new tests
*into the files the lock freezes*.

---

## 5. Corrections to what we published

The replay PR (#321) and its docs got most things right. These are wrong and are
corrected here and in the docs:

1. **`line-bot-981` was NOT caused by the dev's gitlink surgery.** We wrote that
   all three capture failures trace to the dev's `mv .git .git.file && ln -s`
   workaround. Searching that row's full trajectories finds **no dev git
   plumbing at all** — only a chain `worktree_create`. The submodule dissolution
   entered at **chain workspace preparation**: a `git worktree add` does not
   materialise submodules as gitlinks the way a clone does, so the prepared tree
   carried `line-openapi` as plain files and the diff against the pinned base SHA
   necessarily contains the teardown. `tox-3931` *is* dev-side (its trajectory
   shows `git --git-dir=<repo>/.git commit`). **The blame assignment matters: a
   prompting fix will not close a prep-tooling hole.**
2. **`exstruct-113` as "not machinery-attributable" is too kind.** It passes the
   pre-registered criterion only because that criterion models diffs, not
   feedback channels. Two of four attempts died to infrastructure; the other two
   deadlocked on an untranslated gate rejection.
3. **The arms are not budget-matched** (§2.1). The adapter claims they are.
4. **The 56% headline omits the number that matters operationally** — 39% under
   live-chain semantics.
5. Minor: **7 of 18** vacuous oracle files, not 9 (recount).

---

## 6. State of the factory

**It is ON, green, and starved — not wedged.** All five timers active, mode
`normal`, `Result=success`, **0 stories in flight in any app**, $0.00 spent
today. The last model call was 2026-08-10T17:27Z: roughly **24 hours of ticking
with zero dispatch**. The only human-blocking item is **five machine-filed
sacrifice directions (126–130) awaiting `factory approve-direction`**, three of
them flagged as duplicating already-shipped routes.

**Loop 1 (the factory builds the app).** 98 of 138 sacrifice stories reach
`deployed`; 78 of 94 merged sacrifice PRs (83%) are chain-attached. Recent rate
is **1.0 story/day** (7 in 7 days; 9 in 14). The 30-day figure of 55 is
misleading — two backlog-drain days carry 33 of them, and there are 20 active
delivery days out of 79.

- Median cost of a merged story: **$1.40 confirmed** (n=23) — but that is the
  cost of a *success*. The oracle-era cohort spent **$28.57 to deliver 7 stories
  = $4.08 per delivery**.
- Median wall **not** reproduced: 2.31 h on that cohort (7.79 h over all 98), not
  the 2.12 h we cite.
- **`deployed` has never meant deployed: 109 deploy actions, 0 successes, 0 smoke
  checks, 0 health checks.** A `proxy ≠ real` sitting on the terminal state 98 of
  138 stories reach.
- `superseded_by_sibling` is 23.2% (32/138) — **and improving sharply**: 37 in
  July against **4 in August**, the A4 one-story-per-AC fix biting.

**Loop 2 (the factory builds itself) has shipped nothing since 2026-07-30.** The
chain's share of this repo is **24 of 248 merged PRs = 9.7%**. Every PR since
#247 — the entire Exteroception build-out, every oracle and bench fix — is loop 3.
*The human wrote all of the work about the factory's inability to sense itself.*

---

## 7. How the research was integrated, and what it returned

**What paid.** Research stopped two builds on evidence, which is its highest-value
use: Phase C (best-of-N) was cancelled after measuring selector failure-recall at
56% [21%, 86%] with its sole target row a false green; and the pre-existing-failure
baseline was refused once #313 removed its only beneficiary. The two-stage
oracle-authority work named a real bug and produced contract-first plus the
derived API surface, which paid an unplanned dividend in #320.

**What did not.** All three *behavioural* transfers from the frontier —
repro-first, scope-widening, never-end-on-prose — yielded **zero**, and two
required emergency fixes. Five external mechanisms the plan itself marked "worth
taking" (rival-consumer loop cap, per-run revocable credentials, risk-tiering,
egress-proxy credentials, branch-per-run harvest) **never shipped** — and the
first would have prevented #319's wedge, the second the `hourly_cap` blindness
behind the $31 overrun.

**A genuine negative result worth publishing.** ImpossibleBench's "read-only test
files were the balanced option" is **measurably insufficient in this harness**:
bypass on 33/38 rows in sweep 2, literal `chmod u+w` in 21 trajectories, and
after the fix still 10/18 with 2 committed edits the restore cannot reach.

**A citation risk we must close.** ImpossibleBench's numbers reached us
second-hand (the arXiv PDF would not parse, so they came via a summary), yet they
are embedded in **15+ code sites** and gate `_MAX_REVIEW_CYCLES`,
`_MAX_CI_FIX_CYCLES`, the 0444 lock **and** the Phase C cancellation. More chain
behaviour rests on that one paper than any other. Separately, the founding
"harness beats model" thesis now rests on **one** verified fixed-model datapoint
(LangChain 52.8→66.5) — `Claw-SWE-Bench` is already retracted in-repo — against
**three of our own sweeps showing 0 pp from harness work**. Our evidence is
stronger than the literature we built on, and it points the other way.

**And the field is not ahead of us.** Of 75 surveyed entries across 12 systems:
**0 publish cost-per-resolved, 0 run a single-agent baseline, 0 implement
best-of-N.** Our measurement discipline is the genuinely differentiated asset —
not the chain.

---

## 8. What follows

Stated as findings, not as a committed plan.

**Stop believing these:**
- That machinery-tax work can raise the resolve rate. It is now measured at ~0
  net, twice. The lever is spent.
- That the benchmark says anything about the operator's thesis. `gate_enforced`
  is false on every row and the driver stops at `reviewer_done`.

**Three cheap, high-information experiments** (each falsifies a claim in §2):
1. **Give the gates a structured reason channel — the highest-yield fix found.**
   `reviewer_result_json` already *is* a bus with 8 producers, and the empty-diff
   gate 40 lines away already synthesizes a reviewer-shaped verdict onto it. The
   production-delta gate simply skipped it: it writes its reason via
   `log_story_event`, and `_build_initial_message` (`runner.py:1483`) reads only
   `reviewer_result_json` and `dev_attempts_json` — so **any gate that expresses
   itself as an event is structurally invisible to the persona it just rejected**.
   Five call sites close the `exstruct` deadlock; ~45 across 9 files would make
   every handoff typed. Related and unfixed: `runner.py:2635` claims JSON is
   validated "via `jsonschema` if installed" — `jsonschema` appears in this repo
   exactly once, **in that docstring**. Nothing is schema-validated.
   *(Do NOT raise the sandbox cap as a first move — see §2.1's correction. Add a
   no-progress abort instead: it reclaims the same $26 and touches nothing that
   works.)*
2. **Grade the pre-review commit against the post-review commit** on the rows
   with reviewer cycles. Settles whether the reviewer has ever converted a
   failure into a resolve — currently unknown, and it is the layer's entire
   justification.
3. **Fix workspace prep to preserve submodule gitlinks**, then re-grade
   `line-bot-981`. Recovers a known-lost resolve and closes the third instance of
   the gitlink class.

**The strategic reading.** With one dev and no selection term, the chain's
expected score is the dev's solo rate minus whatever machinery breaks that week.
Selection is the only mechanism that can exceed the solo rate, and it was
cancelled on good evidence. So the benchmark is the wrong instrument for the
chain's value, and the honest move is the one the plan already makes: **move the
primary gate to live-chain units — merged stories per day and cost per merged
story.** On that axis loop 1 delivers ~1.0 story/day at $4.08 per delivery, with
a deploy step that has never once succeeded — and *that* is the number worth
attacking.
