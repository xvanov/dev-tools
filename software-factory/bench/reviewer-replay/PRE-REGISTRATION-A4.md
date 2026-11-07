# Pre-registration — A.4 reviewer execution-evidence replay

**Written and committed before any paid model call.** Everything below is fixed
now so the result cannot be reported in whatever framing flatters it. This repo
has retracted four benchmark results; every one was retracted because the
framing was chosen after the number was known.

- **Date written:** 2026-08-05
- **What this is:** the measurement `PLAN.md` A.4 names as its done-condition —
  *"a replay over archived reviewer prompts shows agreement with the hidden
  oracle rising on the 19 instances in §1, measured **before** the change
  ships."*
- **What this is not:** the production change. No file under `factory/` is
  touched. `factory/personas/reviewer.md` is not touched.

---

## 1. The question

Does giving the Reviewer **independent execution evidence** — the sandbox
runtime's own record of what the Dev actually ran and what actually came back —
raise its agreement with the hidden SWE-bench oracle, relative to the prompt the
Reviewer actually got during the graded 2026-08-04 sweep?

External claim under test (`PLAN.md` §2, premise **P7**): LLM-judge agreement
with ground truth rises **42% → 72%** when the judge is given execution output
instead of a diff.

## 2. A premise correction, stated up front

**P7's framing does not describe our reviewer.** The archived prompts show the
Reviewer already receives a `## Latest test output` section on all 31
graded-sweep calls. What is wrong with it is not absence but two things:

1. **It is the Dev's own report, not an independent observation.** It is
   `story.dev_attempts_json[-1].test_output_tail` — written by the Dev-handling
   code from the Dev's own final run, capped at 1,800 chars, ANSI codes intact,
   under a `run_verdict=PASSED` header.
2. **It is dominated by diff text.** 491–1,894 bytes of test output against a
   `## PR diff` of 2,053–56,040 bytes.

So the treatment tested here is **replacing the Dev's self-reported green tail
with an independent, runtime-recorded execution transcript, and telling the
Reviewer that the transcript outranks the Dev's artefacts.** Any writeup that
says "we added execution output" is wrong.

## 3. Corpus

- **Location:** `/home/k/sf-reviewer-corpus-2026-08-05/` — a read-only
  preservation copy of
  `bench/swebench/runs/<instance>/factory/root/state/events/`, taken 2026-08-05.
  The live directory is gitignored and wiped by `_reset_run_artifacts`
  (`bench/swebench_adapter.py:1556`) at the top of every bench run, so the
  backup is the only durable copy. The replay script reads a **configurable**
  corpus path; the backup is only the default.
- `PLAN.md`'s claimed path `state/events/prompt_bodies.ndjson` never existed.
- **Faithfulness of the replay.** The Reviewer is dispatched at
  `factory/chain/handlers.py:3292` as `text_run(..., schema=None)` with no
  `messages=`, so the wire payload is a single `user` turn holding exactly the
  logged `prompt` string (`factory/runner.py:2478`); because `schema is None`
  the JSON-schema augmentation at `factory/runner.py:2384` never fires.
  Therefore **the archived `prompt` IS the exact model input.** Verified:
  `sha256(prompt) == prompt_hash` on every row.
- The archived prompts begin byte-for-byte with the current
  `factory/personas/reviewer.md`, and the assembly block at
  `handlers.py:3268-3286` is unchanged since the sweep.

## 4. Denominator — n = 18, and why not 31 or 19

- **Label source:** `grade.oracle_resolved` from
  `bench/swebench/results-archive/2026-08-04T23-19-24.998844Z/<instance>/factory/result.json`.
  Two committed archives carry these labels and they agree; the 23:19Z one is
  used, and this file says so on the record.
- **The oracle grades the final patch.** Therefore only the **last** Reviewer
  call on each instance carries a label that is about the thing the Reviewer was
  looking at. Earlier calls in a dev↔review cycle judged intermediate states the
  oracle never saw. Scoring all 31 calls against one per-instance label would
  count a correct `request_changes` on a broken intermediate as agreement or
  disagreement at random.
- The graded sweep has **19** instances. `pandas-dev__pandas-63945` never
  reached review (3 dev dispatches, 0 reviewer calls), so it contributes no
  Reviewer verdict. **n = 18.**
- Excluding pandas is not a filter on outcome: it is a label-negative
  (`oracle_resolved=False`) and dropping it *removes* a free true-negative the
  Reviewer never earned. The exclusion therefore cannot flatter either arm.
- 6 corpus directories are not in the graded archive (3 ansible, 2 openlibrary,
  1 qutebrowser — instances from a separate contamination-margin run). They are
  **out of scope** and are not scored.

### 4.1 Pre-change baseline — fixed here, reproducible at $0

Positive class = the Reviewer says the PR ships (`verdict == "approve"`).
Ground truth = `grade.oracle_resolved`.

| | oracle resolved | oracle not resolved |
|---|---|---|
| **reviewer `approve`** | TP = 6 | FP = 9 |
| **reviewer `request_changes`** | FN = 1 | TN = 2 |

- **accuracy 8/18 = 44.4%**
- **precision 6/15 = 40.0%**
- **recall 6/7 = 85.7%**

Substituting `factory_says_green` for the Reviewer verdict gives the identical
table. This is derived from the archive with no model calls; the replay
reproduces it as a sanity check **before** any paid call, and a mismatch is a
STOP condition — the run is abandoned and the mismatch reported instead.

## 5. Arms

Both arms: **one** `litellm.completion` call per instance per replicate, via
`factory.runner.text_run(persona="reviewer", schema=None, messages=None,
max_tokens=max_output_tokens_for(model))` — the production call shape.
Verdict parsed with the production parser
`factory.chain.handlers._parse_reviewer_result`, so an unparseable response
degrades to `request_changes` exactly as it does in production.

**Model, pinned:** `azure/gpt-5.4`. This is `routes.yaml:124`'s `reviewer` route
and the deployment all 31 graded-sweep reviewer calls ran on. The script
asserts `model_router.route("reviewer") == "azure/gpt-5.4"` and refuses to run
otherwise. No temperature is passed — production passes none either, so the
provider default applies to both arms equally.

### Arm C — control

The archived prompt string, replayed **verbatim, byte-for-byte**. Asserted in
code: `sha256(sent_prompt) == archived prompt_hash`.

Arm C does double duty: it is the comparison baseline *and* the harness
validation. Reproducing the recorded verdicts is evidence the replay is
faithful; not reproducing them bounds how much any C↔T difference can mean.

### Arm T — treatment

The archived prompt with **one** edit, at literal section boundaries.

Delete the span from the literal `"\n\n## Latest test output\n\n"` up to (not
including) the literal `"\n\n## DEV SELF-SUMMARY"`. Insert in its place:

1. `## Independent execution transcript (sandbox runtime record — NOT the dev's report)` + the evidence block of §6.
2. `## Evidence precedence (READ THIS BEFORE THE DIFF)` — a fixed paragraph
   stating that the transcript is the runtime's own record, that the Dev did not
   write it and cannot edit it, and that **when the transcript disagrees with
   the self-summary or with what the diff appears to do, the transcript wins.**

Everything else — persona text, rubric, `## Context`, `## Story`,
`## Test plan`, `## DEV SELF-SUMMARY`, the **entire unmodified `## PR diff`**,
and the trailing return instruction — is untouched. Per `PLAN.md` A.4: keep the
diff, add the execution evidence, say which one wins.

If either boundary literal is absent from an archived prompt, that instance is
**hard-failed, not silently skipped**, and reported.

### Deviations forbidden

**Exactly one treatment is run.** If it does not help, that is the result. Any
iteration on the treatment prompt would be reported as its own arm with its own
number, because selecting the best of k treatments on the test set is precisely
how the earlier results in this repo got retracted.

## 6. The evidence block — mechanical construction, no per-instance tuning

**Source, and only source:** the OpenHands trajectory `.ndjson` files inside the
corpus instance directory.

**Which trajectories (strictly causal).** For the last Reviewer call at sequence
`S`, include every `response_bodies.ndjson` row with `persona == "dev"`,
`seq < S`, and a non-null `trajectory_path`, in ascending `seq` order, resolving
`basename(trajectory_path)` inside `<corpus>/<instance>/trajectories/`. This
uses the recorded provenance rather than guessing filenames — it matters:
`alibaba__opensandbox-816`'s dev row points at `1-1-1785786391301.ndjson`, not
`1-1.ndjson`, and `harumiweb__exstruct-113` has an orphan `1-1.ndjson` no row
references. Trajectories from dev dispatches **after** the reviewed call are
excluded, so no future information enters the prompt.

**Block layout.**

```
Dev sandbox sessions: <k>  (chronological)
Total recorded actions: <n>
Test-runner invocations: <m>
Test-runner exit codes, in order: <e1, e2, ...>

### Command spine — every recorded action, in order
[s<i> #NNN] exit=<E> $ <command, truncated to 160 chars, newlines collapsed>
[s<i> #NNN] EDIT <command> <path>
...

### Test-runner invocations — verbatim recorded output
--- run <j>/<m>  session <i>  exit=<E>
$ <full command, truncated to 400 chars>
<tail of the recorded observation text>
```

- Spine covers `TerminalObservation` and `FileEditorObservation` rows so
  edit-after-a-red-run is visible. Budget **5,000 chars**; on overflow keep the
  first 15 and last 60 entries with an explicit elision marker.
- A command is a test-runner invocation iff it matches
  `(pytest|unittest|\btox\b|npm (run )?test|go test|cargo test|nosetests)`,
  case-insensitive.
- Test-output budget **12,000 chars total**, split evenly across the `m`
  invocations, clamped to `[500, 3000]` chars each, each taken as the **tail**
  of the recorded text. If `m * 500 > 12,000`, keep the **last** `24`
  invocations and mark the elision — the most recent runs describe the final
  state.
- Every number and every byte is derived from the trajectory. Nothing is
  written by hand and nothing is chosen per instance.

**Deterministic redaction, applied to the block only.** Absolute paths matching
`/…/swebench-work/…` or `/…/state/worktrees/…` collapse to `<REPO>`, and
`swerebench/sweb.eval…` / `sweb.eval.x86_64…` image references collapse to
`<TESTBED_IMAGE>`. Reason, stated before the run: those tokens carry the
SWE-bench **instance identity** (e.g. `keras-team_1776_keras-22316`), which the
control prompt does not contain. Leaving them in would let Arm T improve by
letting the model *recognise the upstream PR from memory* rather than by reading
execution evidence. The redaction closes a contamination channel; it is two
regexes, applied uniformly.

## 7. Oracle-leakage control — asserted in code, not intended in prose

`result.json`'s `grade` block is the **label**. It is never an **input**.

Three assertions, each with a unit test:

1. **Provenance by construction.** Every command string and every output chunk
   emitted into the evidence block must appear as a literal substring of the raw
   bytes of the source trajectory file (after the same redaction). Nothing can
   enter the block that the sandbox did not record.
2. **Module boundary.** The prompt-building code path never opens
   `result.json`, the pinned oracle (`bench/swebench/oracle.json.z`), or any
   path under `results-archive/`. Enforced by an allowlist on the reader and
   tested by patching `open`.
3. **Negative check on the finished prompt.** For each instance, the assembled
   Arm T prompt is scanned for `grade.log_tail`, every entry of `grade.gold_files`,
   and the strings `FAIL_TO_PASS` / `PASS_TO_PASS`. Any hit aborts the run for
   that instance.

If the evidence block cannot be built without leakage, that is reported as the
finding and nothing is faked.

## 8. Primary metric, decision rule, replication

- **Primary metric:** accuracy against `grade.oracle_resolved` over n = 18,
  positive class `approve`.
- **Secondary, reported always:** precision, recall, the 2×2 table, and the
  per-instance verdict grid.
- **Replicates:** `k = 3` per arm. **The decision rule reads replicate 1 only.**
  Replicates 2–3 exist to quantify the Reviewer's own nondeterminism (the
  provider default temperature applies; production passes none) and are reported
  as a self-agreement rate per arm. A majority-vote table is reported **for
  information and cannot change the recommendation** — pre-registered as
  non-decisive precisely so it is not a second bite.
- **Paired test:** **McNemar's exact test** on replicate 1, on the 18 paired
  correct/incorrect outcomes. Two-sided, exact binomial on the discordant pairs.
  This is the correct test: same instances, two conditions.
- **Interval estimates:** Clopper-Pearson 95% CI on each arm's accuracy.
  Dependency-free exact-binomial bisection; unit-tested against a published
  value.
- **Control-arm fidelity:** fraction of the 18 instances where Arm C replicate 1
  reproduces the archived verdict. Reported before any C↔T comparison. A low
  rate bounds every downstream conclusion and will be said so, not worked
  around.

### Decision rule, fixed now

Let `Δ = accuracy(T, rep 1) − accuracy(C, rep 1)` and `p` = McNemar exact
two-sided.

| condition | recommendation |
|---|---|
| `Δ ≥ +2/18` **and** `p < 0.05` | **ship** the production change |
| `Δ ≥ +2/18` **and** `p ≥ 0.05` | **directional, underpowered** — do not ship on this evidence; widen n before deciding |
| `−2/18 < Δ < +2/18` | **null** — do not ship; the effect, if any, is smaller than this corpus can see |
| `Δ ≤ −2/18` | **do not ship** |
| control fidelity < 12/18 | **measure differently** — the replay does not reproduce production and no C↔T comparison is reportable |

A null or negative result is an acceptable and valuable outcome and will be
published as one.

### Honest MDE — the number that limits this whole exercise

n = 18, paired. Baseline accuracy 8/18.

- One instance flipping = **5.6 percentage points**. A 4-instance swing is 22 pp
  and is **not** "42% → 72% reproduced".
- For McNemar at `p < 0.05` two-sided with an exact binomial on discordant
  pairs: with `b + c = 6` discordant pairs, `6-0` gives `p = 0.031` and `5-1`
  gives `p = 0.219`. So **the smallest detectable significant effect is
  essentially "at least 6 instances change, and every one of them changes in the
  treatment's favour."** That is `Δ = +33 pp`.
- Consequently: this design can detect an effect the size P7 reports
  (+30 pp) **only if it is almost perfectly one-directional**. It cannot detect
  anything smaller. A true +10 pp effect will almost certainly be reported here
  as null. **This experiment can produce a green light or a null; it cannot
  produce a defensible small-positive.**
- Because P7's own delta (+30 pp) sits right at this design's detection
  threshold, a null here does **not** refute P7. It says: not visible at n = 18
  on our corpus, on our reviewer, against our oracle.

## 9. Cost

The 31 real graded-sweep reviewer calls cost **$0.6505** (235,553 in / 13,730
out). Projected here: 108 calls (2 arms × 18 × 3 replicates), control prompts
~5.3k tokens and treatment ~9.3k, so ≈ 730k input + ≈ 80k output ≈ **$2.5–3.0**.
Reported as measured, from LiteLLM's own `response_cost`, via `text_run`'s
accounting. **Hard stop at $5**, at which point the run halts and reports.

Telemetry is written to an isolated `db_path` and `software_factory_root` under
the replay output directory. Nothing is written to `state/**` in the live tree.

## 10. What this cannot show

- Nothing about whether the *production* change would help, beyond agreement on
  this corpus. A prompt replay holds the Dev fixed; the shipped change would
  also alter what the Dev is asked to fix on the next cycle.
- Nothing about cost or latency in production.
- Nothing about instances outside the 18. The corpus is one sweep, k = 1,
  one model per role.
- The transcript is the runtime's record of the **Dev's own** commands. It is
  independent of the Dev's *narration*, not an independent choice of tests. A
  genuinely independent harness run (A.4's other half) is not measured here and
  is not available in this corpus without touching the oracle.
