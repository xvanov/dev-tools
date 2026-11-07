# STATUS — measured 2026-08-04, audited 2026-08-07, Exteroception v1 closed 2026-08-07, oracle-author classes fixed 2026-08-10

Point-in-time facts. Verify before you rely on them. The commands are in
`CLAUDE.md`. **The Exteroception v1 direction is closed** — its seven
acceptance criteria are implemented by **operator PRs #247–#254, not the
chain** (loop 3 with subagents; see the section below). No successor direction
is filed yet; the carried-over operator queue lives in "What does not work".
The retired long-form plan is archived at
`docs/archive/PLAN-2026-08-07-retired.md`.

**2026-08-10 — the abort, its class fixes, and the staged re-proof.** The
readiness plan's Workstream D fired its abort trigger on 2026-08-09/10: fresh
stories 185/186 both blocked on `acceptance-verified` (185 `SETUP failed at
HEAD` — the author invented `password123`, which the app's strength policy
rejects; 186 `vacuous_oracle` — a `@pytestFixture` NameError only collection
can catch). Both were ORACLE-AUTHOR quality defects; every chain guard behaved
correctly. The class fixes are merged as **PR #297** (`39cca00e`): an
authoring-time `pytest --collect-only` smoke (fail-safe), the password-policy
fact + known-good pattern in the harness hint, and a bounded (once per story
per operator-resume episode, sha-fresh, sanitized-feedback) all-SETUP
auto-re-author. **E6 stage-2's activation items (a)/(b) merged as PR #298**
(`5767c1fa`) — the remaining activation step is manual branch protection
(add `main-green` to required contexts) after a deploy. The oracle is
re-enabled and fresh D-2/D-3-shaped directions (124/125) are filed for the
unattended re-proof; stories 185/186 are to be resumed with
`--reauthor-oracle`.

**2026-08-10 (later) — the re-proof RAN, 4/4 stories deployed; E6 stage-2 is
ACTIVE.** `main-green` was added to branch protection required contexts
(after #298 merged and deploy verified in sync), so the stage-2 guard is
live, not inert. The re-proof, verified against real artifacts (merge commit
+ `acceptance-verified` in `merge_actions.gates_passed_json` + `stub_runs` /
`base_runs` on disk for every story):

| story | shape | outcome | PR / merge |
|---|---|---|---|
| 188 (d125 server_time) | fresh D-3′ | **fully unattended single pass**, $0.28 | sacrifice #415 |
| 186 (d123 unread stats) | resumed `--reauthor-oracle` | clean pass on the fresh oracle, $1.21 | #410 `4e3774b7b616` |
| 185 (d122 notif count) | resumed ×2 | gen-2 oracle invented `@example.test` (422 reserved TLD) → parked → **PR #301** (`4face345`) fixed the class (fixture-borne SETUP failures now classify `oracle_setup_failed`; email-domain fact pinned in the hint) → gen-3 oracle passed, $1.44 | #409 `e08a83f6b6b4` |
| 187 (d124 draft count) | fresh D-2′, 3 interventions | parked 4× on a REVIEWER content hallucination: DeepSeek-V4-Flash quoted the dev's fixed token string while describing its pre-fix shape, every cycle, through the rubric fix **#302**; **PR #303** rerouted reviewer → Kimi-K2.7-Code, which approved on first read; $2.22 | #416 `5799cee6619b` |

Honest accounting: 188 is the unattended proof; 185/186 prove the resume +
class-fix loop; 187 is NOT an unattended pass — it measured a reviewer-model
defect (the strongest live evidence yet for the queued reviewer/solo-mode
ablation) and consumed the C1 auto-recovery once (bounded, worked). Every
class fix shipped the same day it was observed: #301 (credential-fact
family + fixture SETUP shape), #302 (framework-wiring severities), #303
(reviewer routing). The `scheduled-security` persona burst-filed directions
126-130 into the approval queue when the factory woke — correctly
operator-gated, left for the operator to triage.

**Factory is ON** (verified 2026-08-11): all five timers active, mode `normal`,
`Result=success`. It is **idle, not wedged** — 0 stories in flight in any app and
$0.00 spent today, because directions 126-130 are waiting in the approval gate.
Run `factory off` to stop.

## Session of 2026-08-11 — the benchmark plan is COMPLETE, and the answer is negative

Merged: **#321** (the replay result), **#322** (the postmortem), **#323**
(corrections to it). Full analysis: **`POSTMORTEM-2026-08-11.md`**.

**Step 4 was the last open item in the post-sweep-2 plan. Nothing remains in it.**
Phase C (best-of-N selection) was cancelled earlier on evidence. **Phase D — move
the primary gate to live-chain units (merged stories/day, $ per merged story) —
is defined but NOT started.** That is the only remaining work, and it is the
right next step precisely because this benchmark cannot measure the thesis.

**What the replay found, in one line:** fourteen PRs of machinery fixes recovered
exactly the three rows they targeted and moved the resolve rate by **zero**,
while cost per resolved went $5.02 → $8.10 and the single-agent control beat the
chain on the same model in the same week.

**The three findings most likely to be acted on next**, in yield order:

1. **Gates are mute to the dev.** `_build_initial_message` reads only
   `reviewer_result_json` and `dev_attempts_json`; `log_story_event` writes to
   neither, so a gate's real rejection reason never reaches the persona it
   rejected — the dev sees `tests not green after run` above `11 passed in
   0.82s`. The empty-diff gate 40 lines away already does this correctly.
   **~5 call sites.** Also: nothing in this repo is schema-validated —
   `runner.py:2635` cites `jsonschema`, which appears in the repo exactly once,
   in that docstring.
2. **The 0444 lock re-creates the Loop-4 deadlock** and its repair layer is ~50%
   effective by construction (see the containment paragraph below).
3. **A no-progress abort for dev attempts** — the 1,800 s cap wasted $25.97
   (32% of the run) on attempts that wrote nothing. **Do NOT simply raise the
   cap**: measured outcomes lost to it are 0 confirmed.

**Two claims from earlier in this session were WITHDRAWN after fuller evidence**
— "horizon slicing is the biggest lever, raise the timeout first" (attempt-level
data: 0 confirmed lost outcomes; dev runs are bimodal), and "`line-bot-981`
traces to the dev's gitlink surgery" (it is chain worktree preparation). Both
corrections are in `POSTMORTEM-2026-08-11.md`.

**Live-loop numbers re-measured this session** (they matter more than the
benchmark): loop 1 delivers **~1.0 story/day**; median cost of a *merged* story
is **$1.40** but the oracle-era cohort spent **$28.57 for 7 deliveries = $4.08
each**; **loop 2 has shipped nothing since 2026-07-30** and the chain's share of
this repo is **24 of 248 merged PRs (9.7%)**.

**Read this first — the 2026-08-11 replay is the current result.** The `factory`
arm was re-run on the pinned manifest with every machinery fix applied
(#310–#320), against a **same-sweep, same-week `openhands` control**, on the
18-instance working set (`pandas-63945` is a broken instance, PR #313):

| arm, same 18 instances | resolved | rate | total $ | $/resolved |
|---|---:|---:|---:|---:|
| **factory, all fixes applied** | **10/18** | **56%** | 81.00 | **8.10** |
| **one OpenHands agent, same sweep** | **12/18** | **67%** | 14.34 | **1.19** |
| factory, sweep 2 (before the fixes) | 10/18 | 56% | 50.18 | 5.02 |
| solo-noreview, sweep 2 | 9/18 | 50% | — | — |

Paired chain-vs-agent: both 9 · chain-only 1 · agent-only 3 · neither 5,
**McNemar exact p = 0.625**. This finally replaces the cross-sweep comparison
with a matched one, and **the chain is behind the single agent on rate and 6.8×
its cost.** k=1 at n=18 still resolves nothing; k ≥ 3 remains the bar.

**The headline finding: the machinery fixes worked and bought zero net rate.**
Against sweep 2 on the same 18 the score is identical (10/18) with **+3 / −3**
turnover. The three gains are precisely the rows the fixes targeted —
`jsonpickle-588` (kept its retry budget), `tox-3931` (diff recovered, 0 →
3,388 B), `canvasapi-716`. The three losses are one **new** machinery defect
(`line-bot-981`) and two rows of dev variance (`openharness-217`, `hiero-1914`).
Cost per resolved went the WRONG way, $5.02 → $8.10, because removing the $2/h
truncation let long rows run to the 5,400 s wall-clock cap. Chain-verdict
precision **did not replicate**: 58% (7/12) against sweep 2's 71%.
Full evidence and the pre-registered criteria, evaluated as written:
`bench/swebench/frozen/PRE-REGISTRATION-2026-08-11-REPLAY.md` (outcome section).

**Two machinery defects the replay found, both still OPEN:**

1. **`_branch_has_production_delta` asks a ref, not the pinned SHA**
   (`handlers.py:3695`). When the branch's own commits land on `swebench-base`
   the diff is empty, and the function maps empty → `False` ("no production
   delta") instead of `None` ("cannot determine"), forcing a green to red. On
   `tox-3931` it fired twice; because the forced-red tail is identical each time,
   the stall guard then fires at 2 of 4 deterministically. Same `ref-not-SHA`
   class as the `_capture_diff` bug fixed in #312 — this second consumer was
   missed. Cost no resolve (grading reads the SHA-anchored diff) but it parks
   correct fixes on the live chain.
2. **A dissolved submodule is captured as a 575 KB diff that cannot apply.**
   `line-bot-981` — resolved by every prior same-model arm — graded
   `patch_did_not_apply`. Its diff opens `deleted file mode 160000` and re-adds
   39 vendored files; the grade log shows every file applying cleanly, including
   both real fixes, and the apply still exiting 2 on the gitlink deletion.
   `diff_integrity.trustworthy` was `true` — the predicate has no assertion for
   submodule teardown or size explosion. **A machinery-attributable lost
   resolve.**

**CORRECTED 2026-08-11 (see `POSTMORTEM-2026-08-11.md` §5).** These two do NOT
share a cause, and the original claim that both trace to the dev's
`mv .git .git.file && ln -s` gitlink surgery is **wrong**. Defect 1 (`tox-3931`)
IS dev-side — its trajectory shows `git --git-dir=<repo>/.git commit`. Defect 2
(`line-bot-981`) has **no dev git plumbing anywhere in its trajectories**, only a
chain `worktree_create`: a `git worktree add` does not materialise submodules as
gitlinks the way a clone does, so the prepared tree carried `line-openapi` as
plain files and the diff against the pinned base SHA necessarily contains the
teardown. It is a **chain workspace-preparation** defect. The distinction is
load-bearing: a prompting fix will not close a prep-tooling hole.

**Containment is NOT closed.** `test_readonly.bypassed_count > 0` on **10 of 18**
rows. On 2 (`canvasapi-716`, `hiero-1914`) the repair failed outright, but
**every one of the 10 carries `restore_errors` reading _"the edit was committed,
not just written"_** — the chain commits before review, so `git checkout --`
restores the commit *containing* the edit. **The repair layer is ~50% effective
by construction, not by accident.** Grading strips test files, so no score is
contaminated — the chain's own green is.

The lock lives **only in `bench/swebench_adapter.py`**; the live chain never
locks anything. It is applied as the **same uid** the agent runs as
(`swebench_adapter.py:1839` calls it "a MEASUREMENT, not a sandbox boundary"),
which is why a `chmod` widening defeats it. And it **re-creates the deadlock
Loop-4 was built to remove**: `memory/loop4_dev_owns_tests_rewrite.md` records
that test-first + test-frozen + test-owned-by-another produced infinite
ping-pong, while `dev.md:46` tells the dev it owns the tests and `dev.md:150`
tells it to apply every review finding verbatim.

**Earlier sweeps, for context.** Two sweeps exist on the pinned SWE-rebench manifest.
Sweep 1 (2026-08-04, five arms): **the chain showed no measurable lift over a
single OpenHands agent on the same model** — 37% vs 53%, p=0.375 — at 2.8× the
cost per resolved instance. Sweep 2 (2026-08-10, re-measuring the CHANGED
factory only: acceptance oracle authored pre-dev, open-weight routing, Kimi
reviewer + #302 rubric, retry cap 4): **factory 53% (10/19), solo-noreview
47%, claude-5 79%** — the chain now matches sweep-1 openhands' 53% headline
rate on identical instances, **but the matched openhands control was cancelled
mid-sweep by operator decision** (harness unchanged since sweep 1), so
chain-vs-single-agent is cross-sweep and DESCRIPTIVE, and the cost gap stands
($5.02 vs $1.82 per resolved). Chain-verdict precision moved 40% → 71%, recall
86% → 100%, reviewer parks were 3/3 correct. See
`bench/swebench/frozen/PRE-REGISTRATION-2026-08-10.md` (outcome section) and
`bench/swebench/results.md`. Nothing here supports "the chain is proven";
k ≥ 3 remains the bar for quoting deltas.

**The 37% → 53% move is NOT a machinery result — do not write it as one.**
Re-derived from the two committed archives (`tests/test_cross_sweep_attribution.py`
re-derives it on every run, so this paragraph cannot drift from the evidence):

- The move is **+4 / −1** on identical instances. The four gains are
  `conan-19735`, `hiero-sdk-1914`, `pyinfra-1665`, `rapid-mlx-289`.
- **All four had already produced a real patch in sweep 1** — 1,360 / 15,039 /
  1,072 / 8,341 bytes, every one graded `right_place_wrong_fix`. There was no
  machinery loss on any of them to remove, and in sweep 2 all four landed in
  **zero dev retries**. Whatever moved, it was the dev writing a *different,
  correct* patch — not a subtraction being lifted.
- **The machinery's own losses got worse**: empty-patch rows **1 → 3**
  (`exstruct` → `conan-19750`, `tox-3931`, `vyper-4801`), and one sweep-1
  resolve was lost (`jsonpickle-588`, 2,670 B → a 1,393 B wrong fix).
- At least **six** capability changes shipped between the sweeps, not the four
  the pre-registration disclosed: the oracle layer, open-weight routing, the
  #302 rubric, retry cap 3 → 4, **plus four undisclosed dev-retry-signal fixes**
  in `factory/runner.py` (#267, #270, #273, #276), each of which changes what
  the dev sees on a retry. p = 0.375 at k = 1 over ≥ 6 confounded changes
  supports no attribution at all.

**The 2026-08-07 audit.** A four-agent independent audit re-derived the sensor
report's claims (report: the "Sensor Problem" artifact; summary in memory
`sensor_report_audit_2026_08_07`). The sensing thesis survived; six claims were
corrected — they are folded into the tables below. The audit also found that a
prior session's fix for two live sacrifice bugs **was never committed**; both
were re-fixed and merged as **sacrifice PR #378** (2026-08-07).

## Operator decisions — 2026-08-07 (do not re-litigate)

1. **Cheap-model thesis stays, reframed**: the claim is "buy throughput the
   subscription can't sell", success = tasks/day at acceptable defect rate,
   not $/task.
2. **Commit0-Lite runs LAST** — only after Exteroception P0–P2 are complete and
   soaked. No experiments while the verifier is broken.
3. **Operator ratification budget: ~2 h/day.** The always-on vision is in scope.
4. **Sacrifice is a benchmark corpus + sensor testbed, not a product.** Its 45
   held-out pm-validated directions are the SacrificeBench pool; the app is the
   bootable target the out-of-process oracle is developed against.
5. **PLAN.md is retired** into the Exteroception direction; its correction
   ledger is archived, not deleted. **E.5's pre-committed "one honest L1→L4
   cycle before deleting" is explicitly retired** — the manager's four LLM
   tiers are scheduled for deletion (operator PR) in favor of the
   detector-ratchet design.

## The benchmark — measured 2026-08-04, five arms, n=19

Suite: SWE-rebench (Nebius), pinned manifest `923aef05add32124` — 19
working-oracle instances, one sweep, k=1, no re-rolls, tables pre-registered in
`bench/swebench/frozen/PRE-REGISTRATION-1.6.md` before the data existed.

> **Provenance.** Two `report` runs exist for this sweep; this file uses the
> later archive (`results-archive/2026-08-04T23-19-24.998844Z/`), which re-ran
> three rows lost to Azure 429s. The earlier archive reports `openhands`
> 44% / p=0.625 / 2.3×. **The conclusion is the same under either report** —
> chain below one agent on the same model, p > 0.3, and at MDE ≈ ±38 pp that is
> "no measurable lift", **not** "the chain hurts". Re-derive:
> `uv run python bench/swebench_adapter.py report --from-archive bench/swebench/results-archive/2026-08-04T23-19-24.998844Z --check`

| arm | harness × model | resolved / valid | rate | 95% CI | $ | $ / resolved |
|---|---|---:|---:|---|---:|---:|
| claude-5 | Claude Code CLI × `claude-opus-5` | 15/19 | **79%** | [54%, 94%] | 34.36 † | 2.29 † |
| claude-4.8 | same CLI × `claude-opus-4-8` | 14/19 | **74%** | [49%, 91%] | 23.56 † | 1.68 † |
| openhands | one OpenHands agent × `deepseek-v4-pro` | 10/19 | **53%** | [29%, 76%] | 18.20 | **1.82** |
| factory | the chain × deepseek-v4-pro + gpt-5.3-codex + gpt-5.4 | 7/19 | **37%** | [16%, 62%] | 35.94 | **5.13** |
| bare | text loop, no tools × deepseek-v4-pro | 1/18 | 6% | [0%, 27%] | 7.94 | 7.94 |

† CLI-reported against a subscription vs Azure price-table estimates — different
accounting bases; never sum them. `factory` vs `openhands` is one basis, exact.

Key pairs (McNemar exact): **factory vs openhands p=0.375** (the chain — no
measurable lift); **bare vs openhands p=0.004** (the tooling — the only
significant result); claude-4.8 vs claude-5 p=1.000 (**contamination probe
clean**). The factory's 7 passes are a strict subset of claude-5's 15.
Chain-verdict precision **6/15 = 40%**; one row went green on a **zero-byte
production patch** (`harumiweb__exstruct-113`).

**Reviewer ablation (2026-08-05, `solo-noreview`):** removing the reviewer
round-trip = 9/18 = 50% at **$2.83/resolved** vs the chain's 7/19 = 37% at
$5.13 — the 29% cost saving is real (9 fewer dev calls, 1 tick vs 4; reviewer
tokens were only 1.8% of spend); the quality delta is inside the ±38 pp MDE
(p=0.688) and the ablation is confounded three ways. Clean re-run (both arms,
one sweep, one commit, ~$62) is still queued — 019 scoped it out (`bench/**`
is operator-PR-only) and no direction has picked it up yet.
Evidence: `bench/swebench/frozen/RESULTS-B1-PHASE1A.md`.

## Exteroception v1 — closed 2026-08-07

Implemented by an **operator agent (loop 3 with subagents), not the chain** —
eight PRs against the direction's seven acceptance criteria plus the paired
P0 manager deletion. Verify merge state with `git log --oneline` / `gh pr view
<n>` rather than trusting this table.

| AC | What shipped | PR |
|---|---|---|
| P0 (paired, out of scope of 019 itself) | Deleted the four FMS manager LLM tiers (watcher/summarizer/diagnostician/apply, −17,182 lines) + retired `factory_improver`/`factory_improver_apply`; `_any_path_is_forbidden_in_patch` moved to `factory/manager/forbidden_paths.py`; `factory-manager.service` removed from the host; mypy 99→68 errors | #247 |
| AC1 | Vacuity gate at `pm-sync` triage (`factory/backpressure/vacuity.py`). First cut scored 0/4 precision under adversarial review; rebuilt around trigger-plus-content-free-residue. Re-calibrated: **precision 1.00, recall 0.80**, 8/45 flagged on the held-out pm-validated sacrifice directions, including direction 094. `explore`-tagged directions exempt | #248 |
| AC5 | Deleted `idle.py`, `rollback.py`, `review_events.py`, `ears.py`, `bug_hunter.py` and the `bug_hunter`/`ralph`/`architect`/`release_manager`/`ux_designer` personas with their schedules/rate-limits/routes; fixed stale persona prompts and 5 stale context-module docs the same review pass found | #249 |
| AC7 | Detector→direction trigger with signature dedupe (`factory/chain/detector_watch.py`); all 11 detectors adapted. A read-only re-measurement found the first cut would have filed **48 unfixable directions in its first ~16 ticks** against real live state; fixed with liveness+recency scoping. **Ships disabled** (`detector_watch.enabled: false`) pending a soak | #250 |
| AC2 + AC3 | Out-of-process acceptance oracle (`factory/chain/boot.py`, `oracle_run.py`, `stub_server.py`, `oracle_probe.py`) + gutted-implementation control. The pinned `xfail(strict=True)` forgery test hard-passes, but adversarial review **reproduced forgery end-to-end twice anyway** — see "closed, but not simply relocated" below | #251 |
| AC4 prep | Sacrifice's `acceptance_boot` needs `DATABASE_URL` explicit — found by booting a real judge worktree before the flag flip; `Settings` refuses its hardcoded default and the var was only in `env_passthrough` (unset under systemd) | #253 |
| AC6 | Idle becomes one deduplicated `operator_ping` per idle episode in `factory inbox`; zero machine-authored directions; re-emits the `app_idle` event `stalled_stories._last_idle_ts` reads | #252 |
| AC4 | `gates.acceptance_oracle: true` for sacrifice, exercised against the real app in a throwaway clone: red at merge base `b40e87aff062` (route absent → 404), green at HEAD, verdict computed out of process over HTTP, `failability_route=merge_base_red`, `authoritative=true`, `verified=true`; a positive-observable criterion failed both stub variants and was credited, a status-code-only criterion passed both and was excluded as vacuous | #254 (merged, `2f81d224`) |

**The live gate HAS now graded a real chain-driven story — 2026-08-08.**
Sacrifice story **172** (`d119-add-unauthenticated-get-api-meta`, direction
119) ran the full chain and merged as **sacrifice PR #381**; story state
`deployed`, **$0.96** total. It is the first and only sacrifice story with
`acceptance_expected = 1` (all 121 earlier rows have `= 0` and
`acceptance_test_ref IS NULL` — they predate the flag flip and never went
through this gate). Sacrifice is now 122 stories, all terminal: 92 `deployed`
/ 28 `superseded_by_sibling` / 2 `closed_by_operator`.

The verdict was real, not a recorded flag — evidence is on disk in
`state/acceptance/sacrifice/172/`:

- `stub_runs.json` — all three criteria FAIL against **both** stub variants
  (`empty`, `plausible`) ⇒ K=3, none excluded as vacuous. The criteria assert
  positive observables (`service == "sacrifice"`, non-empty `version` string),
  so KNOWN OPEN #3 could not exclude them; they create no DB rows, so KNOWN
  OPEN #2 could not forge a red.
- `base_runs.json` — merge base `24c841f9a733`, all three FAIL, `status: fail`.
  **KNOWN OPEN #1's corroboration (#256) fired here on its first real run:**
  `base_probe` recorded a direct factory-issued `GET /api/meta` → **404** with
  `served_a_real_route: true`, so the all-FAIL base was corroborated as
  genuinely serving and trusted as a real `red` rather than downgraded to
  `unknown`.

Ordering was correct, not a bypass: all 7 required gates passed first, **then**
the factory enabled GitHub auto-merge (`auto_merge_attempt`, `merged=0`,
"auto-merge enabled; awaiting required checks"); GitHub merged 23 s later on CI
green.

**Diagnostic trap — read before calling a future oracle run a false green.**
The `acceptance-verified` gate emits **nothing** on the `acceptance` event
stream (every `_emit` in `factory/chain/acceptance.py` is on the *authoring*
side), and it runs inside the auto-merge worker after `pr_open`, so it is not a
chain step either. For story 172 `state/events/acceptance.ndjson` therefore
held exactly one row — `authored` — for a story the oracle had fully graded,
while `merge_actions.gates_passed_json` listed `acceptance-verified`. That
combination looks exactly like the `gate_enforced: false` shape and is not it.
The run artifacts above are the only proof the gate really ran.

**What the adversarial passes caught that green tests did not, twice:**
1. **The oracle's forgery was relocated, not closed, by moving out of process.**
   The booted app runs as the same uid and received `TMPDIR`, so production
   code could poll for the oracle's own run directory and plant a
   `conftest.py` that neuters pytest, or overwrite the oracle file — review
   reproduced both attacks end to end against the first cut of #251. Closed by
   run-directory tamper-evidence (oracle sha256 + the exact expected file set,
   checked **before** junit is parsed) + `--noconftest` + dropping `TMPDIR`
   from `env_passthrough`; new never-waivable block reason
   `oracle_run_tampered`. A second hole — the ablation probe was blind to the
   credited criterion set, so a kill on a stub-excluded (vacuous) criterion
   licensed approval — was fixed with a repeatable `--credit <nodeid>`.
2. **The detector trigger would have filed 48 unfixable directions in its
   first ~16 ticks** (#250), measured by re-running the first cut read-only
   against real live state before it ever shipped enabled.

**KNOWN OPEN risks of the oracle runner** — decisions recorded 2026-08-10
(the gate's module docstring, `factory/chain/gates/acceptance_verified.py`,
is the authoritative and more detailed account; the docstring also carries a
**#5**, arrange-blind base runs, added 2026-08-09):
- **#1 CLOSED** by PR #256 (see below).
- **#2 shared-DB contamination: the HEAD/BASE half is CLOSED** (2026-08-09,
  per-evaluation run-id nonce, validated live on story 177's evaluation).
  Two residuals, both DEFERRED with reasons: (a) the ablation-route nonce —
  the ablation route is the fallback path only, its one fail-open is narrow,
  and noncifying it requires an ablation cache-key change plus a nonce minted
  inside `oracle_probe` (docstring: "deferred, not forgotten"); (b) an oracle
  that hardcodes identifiers instead of using `ACCEPTANCE_RUN_ID` — ACCEPTED,
  because enforcing the reference statically would false-block read-only
  oracles (story 172's reads it never).
- **#3 non-2xx criteria: ACCEPTED.** Measured 2026-08-09: of 20 non-skipped
  authored criteria exactly 1 was status-only and it passed at base —
  immaterial. The v1.1 candidate (a third stub variant) costs a global
  stub-cache invalidation and strictly raises the block rate; not worth it
  before the benchmark.
- **#4 behavioural mimicry: ACCEPTED.** Structurally hard to rule out for any
  black-box oracle; not evidenced. No defense planned.
- **#5 arrange-blind base runs: ACCEPTED with audit trail** (`base_runs.json`
  + `setup_failures` in run artifacts). Mitigation discipline: D-2-shaped
  directions must arrange only via routes that exist at the merge base —
  directions 124/125 encode this explicitly. A naive fix (excluding
  setup-failing criteria from base-red) would false-block the legitimate
  prerequisite-route case; none is attempted.

The original ranked list (kept for history; the docstring supersedes it):
1. **A healthy-but-semantically-broken BASE forges red — CLOSED 2026-08-07/08,
   PR #256.** `boot._poll_health` *used to* return healthy on the first
   response under 400, so a health endpoint answering before its own
   dependency (a DB pool) was ready made the base respond 500 to everything,
   every credited criterion failed at base, and that read as a genuine `red` →
   credit, cached in `base_runs.json`. Two independent mechanisms now close it:
   (a) `boot._poll_health` requires `_HEALTH_CONSECUTIVE_REQUIRED` (2)
   back-to-back healthy polls, with any response ≥ 400 (5xx included)
   resetting the streak to zero — this hardens a *flaky* boot; (b) the real
   fix, in `_base_run`: an all-FAIL-over-`K` base is no longer trusted as
   `red` on its own. It must be corroborated, either by at least one credited
   criterion having already PASSED at base, or by
   `boot.probe_paths`/`served_a_real_route` finding the live base answered a
   direct factory-issued request with something other than a 5xx. Without
   corroboration the candidate `red` is downgraded to `unknown`, which is
   never cached and falls through to the ablation route. Regression tests:
   `tests/test_acceptance_oracle_green_means_something.py` (search
   `KNOWN_OPEN_1`), fixture mode `broken_at_base`. **Stated residual:** the
   probe is a blind replay (no body, no auth), so a body-validating route may
   4xx rather than exercise its real logic, and a 4xx is accepted as "served
   for real" — a deliberate fail-safe trade-off, not an airtight
   corroboration.
2. **Shared-DB cross-run contamination.** A hardcoded identifier that passes
   at HEAD can collide (409, or a stale row) at BASE in the real shared
   Postgres, forging a red the `ACCEPTANCE_RUN_ID` namespacing convention
   (a persona instruction, not enforced) is supposed to prevent.
3. **Non-2xx-status criteria evade the stub.** A criterion asserting "returns
   404" is satisfied by both stub variants (which only ever answer 200), so
   it is structurally excluded from the credited set no matter how
   meaningful it is — a real criterion wrongly excluded, not a fake one
   wrongly credited (fail-safe, but undercounts coverage).
4. **Behavioural mimicry.** Nothing defends against production code that
   distinguishes "being graded" from real traffic and behaves correctly only
   under grading. Not evidenced, structurally hard to rule out for any
   black-box oracle.

**Operational prerequisites now load-bearing for sacrifice merges:** the
`sacrifice-db` container must be up (`prerequisite_command` only checks —
`docker ps | grep sacrifice-db` — it never starts it; hint is `make up-db`);
`DATABASE_URL` is now explicit in `acceptance_boot.env` (#253) rather than
riding the operator's ambient shell.

**`app_idle`/`healthy_drain` window — NOT fully closed by #252 (correction,
019 fail-silent audit):** between #249 (deleted the only writer of
`app_idle`) and #252 (re-added it via the idle→ping rewrite), nothing wrote
`app_idle` at all, so `stalled_stories.healthy_drain` was permanently `False`
in that window — it fails toward NOISE, not silence, so nothing was silently
missed. But #252 did NOT close the window the way this file previously
claimed: it wrote `app_idle` only ONCE PER IDLE EPISODE, and
`stalled_stories.idle_recently` requires one within 30 minutes. A long or
late-checked episode reads stale — measured live: last `app_idle` at 03:24,
checked at 04:22 (55 min later) — `healthy_drain=False` for the entire
window, identical in effect to #249's regression. Fixed on the writer side:
`factory/chain/idle_ping.py::run_idle_ping_tick` now emits `app_idle` on
EVERY idle tick (restoring the pre-#249 cadence) while keeping the
human-facing `operator_ping` deduplicated once per episode — the two are
different signals (a continuous liveness heartbeat vs. a deduplicated
notification) and conflating them was the bug. No `factory/manager/**` change
was needed: `stalled_stories`'s own freshness logic and its unit tests
already assumed "one `app_idle` per idle tick" — the contract was only ever
broken on the emission side. Separately, `healthy_drain`'s only live consumer
(`factory/chain/detector_watch.py::_adapter_stalled_stories`) has a provably
vacuous early-return — `healthy_drain=True` already implies its own `rows`
list is empty by `stalled_stories()`'s own arithmetic (`stuck_in_progress`
feeds `alarms` unconditionally; `stalled` is zeroed whenever `draining` is
true), so the guard changes nothing either way. Left in place (not this
fix's target — an available follow-up is deleting it, since
`detector_watch` is disabled pending a soak regardless).

`detector_watch` ships **off by default** (`factory_settings.yaml`); flip per
app after a soak, never globally on merge.

## What works

| Capability | Evidence |
|---|---|
| Loop 1 — builds an app | 91 sacrifice stories reached the `deployed` state; 71 of 84 merged sacrifice PRs are chain branches |
| Loop 2 — builds itself | 24 factory stories deployed; staging twin 17 validated / **3 fatal self-edits rejected**. Scale caveat (audit): those 24 chain PRs are ~14% of the factory repo's 173 merged PRs — the operator authored ~148 |
| PR pipeline | 122 stories opened a PR; 118 merged |
| Review convergence | 0 stories hit the cycle cap in 14 days |
| CI-failure recovery | Real CI log fed back to dev as a structured finding, capped at 3 |
| Spend control | Daily cap in `factory_settings.yaml`, hourly cap, per-story budget |
| Test suite | 2,368 tests, ~5 min |
| SWE-bench measurement pipeline | Hidden sha256-pinned oracle, test-edit stripping asserted on every arm, `--network none` grading, gold-patch control 19/20, `report --check` byte-stable. Four retractions paid for it — do not "improve" it without a failing case |
| The one exteroceptive gate | `smoke-green` blocked 578 merge *evaluations* (10 distinct PRs; 2 PRs = 86%) — the most active gate blocker. The seed of the target architecture |
| **Independent, out-of-process, tamper-evident acceptance verdict** | Live on sacrifice (`gates.acceptance_oracle: true`, PR #254, merged `2f81d224`). Verdict computed by a separate process driving a booted app over HTTP, never importing the diff's code; tamper-evident (oracle sha256 + expected file set checked before junit parsing, `--noconftest`, no `TMPDIR` passthrough). Exercised end to end against the real app in a throwaway clone: red at merge base `b40e87aff062`, green at HEAD, `authoritative=true`, `verified=true`; the gutted-implementation control **credited** a positive-observable criterion that failed both stub variants and **excluded** a status-code-only criterion that passed both as vacuous. **Not yet proven against a live chain-driven story** — see the Exteroception section for why |

Note (audit): **"deployed" is a state name, not a deploy.** All 102
`deploy_actions` rows skipped (`deploy_disabled_in_config`) or errored;
`smoke_passed`/`health_check_passed`/`rollback_triggered` are 0 on every row.

## What does not work

| Problem | Evidence | Where the fix lives |
|---|---|---|
| **No measurable chain lift, at 2.8× cost** | Sweep 1 table above; sweep 2 (2026-08-10) moved the chain 37%→53% on identical instances but the matched control was operator-cancelled, so the comparison is cross-sweep/descriptive and the ~2.8× $/resolved gap stands | Partially re-measured (sweep 2). A within-sweep factory-vs-openhands pair at k≥3 is still the open bar |
| Chain green ≈ coin flip | Sweep 1: precision 6/15 = 40%, one zero-byte green. **Sweep 2: 10/14 = 71%, recall 10/10, no zero-byte greens; solo-noreview (no reviewer) precision 53%** — the reviewer's parks were 3/3 genuine oracle failures | Re-measured 2026-08-10 with the oracle layer + Kimi reviewer active. Candidate causes shipped together; not separable at this n |
| **The acceptance oracle's green was forgeable in-process** — **CLOSED, but not merely by moving out of process** | Moving the verdict out of process (PR #251) **relocated the attack**: the booted app shared uid + received `TMPDIR`, so production code could plant a `conftest.py` in the oracle's own run dir or overwrite the oracle file — adversarial review reproduced forgery end-to-end twice against the first cut. Closed by run-directory tamper-evidence (oracle sha256 + exact expected file set, checked before junit parsing) + `--noconftest` + dropping `TMPDIR` from `env_passthrough`; new never-waivable reason `oracle_run_tampered`. Three KNOWN OPEN risks remain (#2-#4; #1 closed by PR #256) — see the Exteroception section above | **Done** — PR #251 (+ #253, #254). `gates.acceptance_oracle: true` on sacrifice |
| Manager LLM tiers: cost without yield | All three LLM personas = **$1,028.58 = 52.0%** of all-time spend (watcher alone $972.23 = 49.2%, 44,127 runs); 262 concerns → 165 proposals (48 titles / ~37 root causes, 107 escalate-to-human) → **0 applied fixes**, 1 GitHub issue (via staging, not apply). L4: 163 attempts, 0 PRs | **Done** — deleted, −17,182 lines, PR #247 |
| `factory_improver` | 196 proposals → **1 landed commit ever** (PR #5); 179 apply failures, 158 `dirty_working_tree` | **Done** — retired with the manager tiers, PR #247 |
| Detector coverage is partial | 11 registered detectors; the watcher hard-codes 9 — `conformance_breach` and `fms_yield` have **never run** | **Wired, not yet live** — all 11 detectors adapted with signature dedupe into `factory/chain/detector_watch.py` (PR #250); ships **disabled** (`detector_watch.enabled: false` in `factory_settings.yaml`) pending a soak, so none has run in production yet |
| Scanner personas manufacture noise | `bug_hunter` 705 runs, 0 findings; `ralph` 7,024 runs, 95.8% rate-limited; 70% of the sacrifice backlog was machine-filed, one direction re-filed 33× | **Done** — `bug_hunter`, `ralph`, `architect`, `release_manager`, `ux_designer` and their schedules/rate-limits/routes deleted, PR #249 |
| Merge-gate precision is unknown | Every published precision number is chain-verdict precision; `gate_enforced: false` in all six bench arms | Still open. No direction filed yet |
| A sweep silently loses runs to provider 429s; sweep aggregates contradict their rows | See archive notes | Still open — paired with 019's out-of-scope operator queue, not yet actioned |
| Clean reviewer-ablation re-run (~$62) not yet run | **DONE 2026-08-10** — sweep 2 ran factory + solo-noreview in one sweep, one commit: 10/19 vs 9/19, p=1.000; the B.1 cost saving did NOT replicate ($50.18 vs $49.89); reviewer bought verdict precision (71% vs 53%), not resolves | Closed. Evidence: `bench/swebench/frozen/PRE-REGISTRATION-2026-08-10.md` outcome |
| C1 recovery bluntness: `blocked_review_nonconvergent` auto-recovery re-enters at `SM_DONE`, re-running SM+dev+review to retry a later step | Story 177 burned $5.96 over two recoveries | **DEFERRED with reason (2026-08-10):** the signal-changed guard already escalates an identical failure instead of burning a second cycle, and C2's tech_writer parser fix (`cd750e7e`) removed the known cause. Re-entry-at-predecessor is state-machine surgery on shared control flow that the benchmark does not need |
| C5 `detector_watch` disabled | Ships `detector_watch.enabled: false`; liveness scoping added but never run in production | **DEFERRED with reason (2026-08-10):** stays disabled through the benchmark window — an untested detector filing directions mid-run would contaminate the measurement. Soak read-only after the re-proof |
| State has no backup | The twin guards source only | Still open (E.1 carried over; not scoped into 019) |
| `software-factory-copy` is public | It receives every candidate self-edit diff | Still open (E.3 carried over; not scoped into 019) |

## Sacrifice — current state (2026-08-07)

- **PR #378 merged**: the wrongful-charge path (`inconclusive_reason` dropped in
  `api_check.py`) and the unvalidated dev-sandbox clone URL are **fixed**, with
  wire-level regression tests. Clone-URL policy: validate the **host**, never
  the scheme (ssh/scp-style remotes are a supported feature).
- ~~Deployment is down (`sacrifice-backend.service` failed, `/api/health` → 502)~~
  **STALE, corrected 2026-08-11**: the service is up and both health endpoints
  return 200. The real deploy finding is different and worse — across the whole
  history there are **109 deploy actions, 0 successes, 0 smoke checks, 0 health
  checks**. The `deployed` story state records a *merge*, so it has never once
  meant deployed.
- **The out-of-process acceptance oracle is now live**: `gates.acceptance_oracle:
  true` (PR #254, merged `2f81d224`), the boot recipe requires the
  `sacrifice-db` container up (`prerequisite_command` checks with `docker ps`,
  never starts it — hint `make up-db`) and `DATABASE_URL` explicit in
  `acceptance_boot.env` (PR #253). This does not touch the CI gates below —
  the oracle grades one story's acceptance criteria at merge time, it is not
  a CI step. **Now proven against a live chain-driven story too** — story 172
  → sacrifice PR #381, merged 2026-08-08 (see the Exteroception section above
  for the on-disk run evidence). Sacrifice has zero non-terminal stories right
  now (92 deployed / 28 superseded / 2 closed = 122, all terminal); story 172
  is the only row with `acceptance_expected = 1`, and the other 121 have it
  unset — they never ran this gate.
- Gates are otherwise still hollow: CI typecheck force-exits 0 over 208 real
  mypy errors; lint is changed-files-only over 100 whole-tree errors; Jest
  (267 tests) and the clean `tsc --noEmit` are not in CI; Playwright collects
  35 tests of which 21 self-skip on `E2E_HARNESS_READY` (set nowhere) and none
  run in CI. In-process to out-of-process test ratio ≈ **300:1**. Un-hollowing
  this was explicitly out of scope of 019 (its own text: "a separate
  sacrifice-app direction, after this one proves the oracle runner on a
  booted sacrifice") — the oracle runner is now proven; the un-hollowing
  direction is not yet filed.
- Authorship (audit): the product skeleton is 26 direct human commits
  (2026-05-18/19); the factory's share of surviving lines is **≤ 37.7%** (upper
  bound; the worker commits under the operator's identity); 25 of 72 merged
  factory PRs touched zero production code.

## Two self-modification paths — do not confuse them

- **Chain self-edit (loop 2): works.** direction → story → dev → gates → PR →
  staging twin → merge. 24 factory stories deployed this way.
- **FMS L4 apply: dead** (0/163) — the four LLM tiers it lived in were deleted
  2026-08-07, PR #247.
Measuring only the second produces "the factory cannot improve itself" — false.
Measuring only the first produces "the chain built the factory" — also false
(audit: ~25 of 173 merged factory-repo PRs are chain PRs).

## Cost

July, from the `runs` ledger: $588.78 all-in across 75 deployed stories =
**$7.85/story**; excluding the manager $217.18 = **$2.90/story**. Dollar figures
are partly estimated (cache-read rate unverifiable); prefer token counts.

## Benchmark harnesses — two, do not confuse them

- **`bench/swebench_adapter.py` — the one that counts.** Externally graded,
  archived, `report --check` byte-stable. `bench/swebench/results.md` and
  `results-archive/**` are generated/archival records — **never hand-edit**.
- **`bench/bench.py` — retired for grading** (scores the factory on tests the
  factory wrote). Usable only as a convergence harness.

## Standing evidence locations

- Sensor report (audited v5): claude.ai artifact `2c5bbaef-…` — the strategic
  review Exteroception v1 implemented; corrections marked ⟲.
- Reviewer replay corpus backup: `/home/k/sf-reviewer-corpus-2026-08-05/`
  (bench run dirs are gitignored and wiped by every sweep).
- Failure ledger: memory files (`MEMORY.md` index) + the archived plan's
  correction log (`docs/archive/PLAN-2026-08-07-retired.md`).

## CI cost

Root-level `*.md`-only PRs skip the expensive steps (~20 s); everything else —
including `factory/personas/*.md` and `apps/**/context/*.md`, which are code —
runs the full suite (~4 min). See `.github/workflows/test.yml`.
