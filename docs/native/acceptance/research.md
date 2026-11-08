# Acceptance review: `research` (plan 8.3)

**Verdict: FAIL.** The output passes: report.md answers the question in 296 words, and all
17 file:line citations I opened support their claims. No PR was opened, and it cost $0 on the
subscription. Two latency hops miss their targets: the tool call takes 2.3 s and approval to
"started" about 2 s, both against 1 s. The third timed hop (state change to board redraw,
200 ms) is not measured, and the factory takes 6-7 s to tell PA about a state change.

| | |
|---|---|
| Date | 2026-11-08, 19:51-20:10Z |
| Stack | work (this Windows laptop): PA on :7300, factory serve on :7330, termhub on :7000 |
| Commit served | `c0c2a3eca717ee61ad8ba766f1e038a7ee6c0dad` (GET /api/version) |
| Job checkout | `e00340c` (the job's `base_sha`). Every cited file is identical at `e00340c` and `c0c2a3e`. |
| Job | `dev-tools:r0002` (card #6773, run 28, step 54), `claude_session` runtime, Opus |
| Reviewer | a fresh session that did not implement the workflow (D10) |
| Criteria | `architecture.json` → `examples[research].acceptance` |

## How it was run

1. `node bin\pa.js e2e research --dry-run` from the live checkout passed 8 of 8 checks. The map
   has the block, the effective ceiling is $0, the factory is local with a dev-tools app, claude is
   logged in on the subscription, and the chat has `factory_start`.
2. `node bin\pa.js e2e research --keep` ran once and took 98 s. `--keep` left the card up so
   the Plan view could be inspected. The harness adds a card with an `e2e-<uuid>` marker, then
   calls `factory_start {kind: research, runtime: claude_session}` with the question: *"Research
   how termhub's Windows update script (termhub/windows/update.ps1 in xvanov/dev-tools) handles a
   dirty working tree, and write it up in under 300 words with file and line citations."* It
   polls `job status` every 10 s until the job is done. It exits 1 because two hops fail.
3. Outputs inspected by hand:
   - read report.md in full and opened every citation at `e00340c` (`git show`);
   - read `job status` through factory serve's `/api/cli`;
   - listed PRs on xvanov/dev-tools with `gh`;
   - read `/api/state`, `/api/commitments/6773` and termhub's `/api/sessions`;
   - read the job folder (`job.yaml`, run files), factory serve's log and PA's supervisor log for
     timings;
   - ran `pa audit check factory_start`;
   - re-shot the views over the DevTools protocol 12 s after load (the harness's shots are blank,
     see defect 8.4.11).
4. Cleanup: card #6773 dropped (`pa done 6773 --dismiss`) and both termhub sessions killed by id.
   I did not use `pa e2e --sweep`, because another reviewer's run was live (defect 8.4.13).

## Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `cited`: every claim carries a source, and each source was opened and checked | **pass** | Every step in "Flow" and "Evidence" carries a file:line, commit or command. The summary restates them. I opened all 17 line references, the commit, the AGENT.md section, the test lines and CLAUDE.md (table below). The report also says what it did not verify ("Code read only; tests and script not run"). |
| `supported`: no claim is unsupported by its source | **pass** | All checked claims hold. Two nits that don't change the answer: `common.ps1:839-860` runs 2 lines past `Save-LocalChanges` (it ends at 858). "On every exit after the stash, `Fail` pops it first" holds for exits through `Fail`; an unhandled terminating error between the stash and the pop would skip it. The report repeats the code's own comment there. |
| `answers`: the report answers the question asked, not an adjacent one | **pass** | It answers how `update.ps1` handles a dirty tree: it stashes tracked and untracked changes, pulls, pops before deploying, stops safely if the stash or pop fails, and keeps edits through rollbacks. 296 words (limit 300), with file and line citations. |

## Claims checked

All at `e00340c`. "update" is `termhub/windows/update.ps1`, "common" is `termhub/windows/common.ps1`.

| Claim in report.md | Source | Finding |
|---|---|---|
| `Save-LocalChanges` runs after `git fetch` | update:137 (fetch at 133) | supported |
| It runs `git status --porcelain`, then `git stash push --include-untracked -m "termhub update: …"`, and returns $true, $false or $null | common:839-858 (842, 851, 853-857) | supported (range overshoots by 2 lines) |
| A $null result stops with "could not set aside your uncommitted changes. Nothing changed; blue still serving." | update:138 | supported, exact text |
| `git pull --ff-only` | update:143 | supported |
| `Repair-DivergedHistory` refuses on a dirty tree | common:756-762 | supported |
| `Restore-LocalChanges` runs `git stash pop`; a conflict stops with "…They are in the stash. Nothing was deployed; blue still serving." | update:166-171, common:863-875 (866) | supported, exact text |
| git keeps the stash on a conflicted pop | common:861-862 (comment), AGENT.md:484 | supported |
| `Fail` pops the stash first | update:53-62 (56-58) | supported (see nit above) |
| Rollbacks go through `Reset-TreeTo` (stash, `reset --hard`, restore), called at update 179, 212, 243, 264, 275 | common:880-889; call sites | supported: those are exactly the five call sites |
| npm's `package-lock.json` rewrite is discarded after `npm install` | update:180-185 | supported |
| Introduced in `a8b1293` "updater works under PS 5.1 and with uncommitted edits" | `git show a8b1293` | supported (touches update.ps1, common.ps1, AGENT.md, the test) |
| Documented in `termhub/AGENT.md:473-489` | AGENT.md:473-489 | supported: section "Uncommitted work is stashed, not a blocker" |
| Tested in `termhub/test/repairHistory.test.ps1`, dirty-tree refusal at 120-130 | test:120-131 | supported |
| Root `CLAUDE.md` still says the script "fails on a dirty tree", and that is out of date | CLAUDE.md, "Ship every unit of work" | supported. A real stale-doc finding, not a defect of this workflow; noted below. |

## Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: report.md answers the question, sources cited, research job, no PR | **pass** | Job `done`, `delivery: none`, `stories: []`, `pr_urls: []`. `gh pr list -R xvanov/dev-tools --state all`: the newest PR is #60 at 18:16Z, before the run (19:52Z). Searching for `r0002` or the marker finds nothing. |
| Cost ≤ $0 (subscription) | **pass** | `factory job status dev-tools:r0002 --json`: `cost_usd 0.0`, `subscription_equiv_usd 0.6443`. Run 54: `billing subscription`, `cost_usd 0.0`. |
| View: plan | **pass** | `/api/state` has card #6773 with chain card → run 28 → job `dev-tools:r0002` → step 54 (researcher, `claude_session`) and session links. Rendered: after load the page text (`reviewer/plan-loaded.txt`) has the card, "#6773 · pa_request · dispatched", with its context. The card is below the fold of `reviewer/plan-loaded.png`. The harness's `screenshots/plan.png` shows an empty board (8.4.11). |
| View: run | **pass** | termhub `/api/sessions` lists the follow session (links card 6773, run 28, job r0002) and the researcher session (links job r0002, step 54; model Opus), both alive. Rendered: `reviewer/run-loaded.png` opens the researcher's terminal at its finished state (the report summary, "result: success … turns=12"), and the page's session list (`run-loaded.txt`) shows both sessions with their card, run, job and step links. The harness's `screenshots/run-*.png` shows "No terminal open" (8.4.11). |
| View: ask | **pass** (tool level) | The `factory_job` chat tool returns card #6773 and the report (harness check). No Ask page was captured. |
| Approvals: `factory_start` | **pass** (policy), not exercised | `pa audit check factory_start --channel chat --action call` gives `ask (rule chat-actions-ask)`, and there is no per-stack override. The run never reached the policy engine: the harness calls the tool handler directly and the audit log has no row (8.4.12). |

## Hops

Clock references: PA's supervisor log, factory serve's log (1 s resolution), `job.yaml` and
the run row (`job status`).

| Hop | Target | e2e | Factory clock | Result |
|---|---|---|---|---|
| jarvis: tool call (`factory_start`) excluding model time | 1000 ms | **2312 ms** | run row 19:52:09.56, factory job created 19:52:10.96, PA "dispatched" 19:52:11.30 (about 1.4 s of it is the submit) | **fail** (8.2 measured 13.5 s; better, still over) |
| dispatcher: approval to "started" | 1000 ms | 11472 ms (10 s poll resolution) | `factory_start` returned 19:52:11.3, serve woke and dispatched 19:52:12, job `started_at` 19:52:13.40: **~2.1 s** | **fail** |
| runtime-claude: the research conversation writes report.md | unbounded (5400 s cap) | 73916 ms | job 19:52:13.40 to 19:53:35.25 = 81.9 s. Researcher step 19:52:23.62 to 19:53:35.22 = 71.6 s, 12 turns. The first 10.2 s before the model is checkout and brief (`brief.md` 19:52:21). | pass |
| worker: state change to the board redraw | 200 ms | not measured | job ended 19:53:35.25, serve pushed `done` 19:53:41, PA recorded it at 19:53:41.14 (**5.9 s**, with PA's event loop blocked 1230 ms then). `in_progress`: serve pushed it at 19:52:12, PA recorded it at 19:52:19.4 (~7 s). | **fail** (not measured, and PA learns 6-7 s late) |

## Evidence

Under `%LOCALAPPDATA%\personal-assistant\e2e\`:

- `20261108T195155Z-research-dry/summary.json`: the dry run.
- `20261108T195207Z-research/`: `summary.json`, `report.md` (the delivered report),
  `transcripts/session-smw8915da2.txt` (the researcher's tail), `screenshots/{plan,build,run-smw8915da2}.png`
  (blank, 8.4.11).
- `20261108T195207Z-research/reviewer/`: `plan-loaded.png` and `.txt`, `run-loaded.png` and `.txt`
  (taken over CDP 12 s after load, with the page text alongside), and `build-25s.png`. That last
  one is a plain headless shot a few minutes after the run, by which time Build had caught up: it
  shows r0002 → card #6773, run #28, "$0.00 metered · $0.64 subscription-equivalent".

The factory's job folder (`state/jobs/r0002-…/`: `job.yaml`, `report.md`, `run/stream-1.jsonl`) is
kept by the factory under its data dir.

## Defects (filed under 8.4 in PLAN.md)

1. **8.4.8** The tool call takes 2.3 s (target 1 s). About 1.4 s of it is the factory submit.
2. **8.4.9** Approval to "started" takes ~2.1 s by the factory's clock (target 1 s). The e2e
   reads 11.5 s because it polls every 10 s: time the hop from `started_at`.
3. **8.4.10** The worker hop (board redraw ≤ 200 ms) is not measured, and PA records factory state
   changes 6-7 s after they happen.
4. **8.4.11** The e2e's screenshots are taken at page load, before data arrives. Plan, Build and Run
   all show empty pages, and no Ask page is captured.
5. **8.4.12** The approval is not exercised: the harness calls the tool handler directly, and the
   policy audit log has no row for the run.
6. **8.4.13** Research cleanup leaves both termhub sessions alive. `pa e2e --sweep` acts on every
   e2e card, so during parallel reviews it would cancel another reviewer's live job and close its
   PR.

Not a defect of this workflow: the report is right that the root `CLAUDE.md` line "(`update.ps1`
does `git pull --ff-only` and *fails on a dirty tree*)" is stale. Since `a8b1293` the script
stashes, and the line should be corrected.
