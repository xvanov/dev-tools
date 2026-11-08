# Acceptance review: `research` (plan 8.3)

## Re-review, 2026-11-08

**Verdict: FAIL, on latency only.** Every criterion passes again. report.md answers the question
in 295 words (300 asked), and all 17 claims I checked against their sources hold. No PR was
opened, and the job cost $0 metered against the $0.05 ceiling (D26). The approval is now exercised
and audited, the screenshots wait for data, and the marker-scoped sweep cleans the run up. Three
hops miss the Map's current `max_ms`, which D27 says to score against until the targets are reset:

- **The tool call takes 11355 ms against 1000 ms: 10.4 s over** (2312 ms in the first review).
  Routing is fast now (route, prepare and brief take 136 ms together), but the factory submit
  took 10864 ms. The factory wrote the job 2.2 s into the submit, and PA got the answer 8.7 s
  after that (8.4.45).
- **Approval to "started" takes 7021 ms against 1000 ms: 6.0 s over** (about 2.1 s before).
  Serve dispatched the job about 10.3 s after it was written, during the same stall. The worker
  then took 5.7 s to its `started_at`.
- **The state-change-to-redraw hop (target 200 ms) is still not measured by the e2e.** Serve now
  pushes the job's end at most 1.4 s after it happens (5.7 s before), and Build showed `done`. But
  the Plan card showed the job `in_progress` until PA's run row ended, 125.5 s after the job did
  (8.4.46).

The machine was not idle, which D27 asks for. Factory serve had restarted 104 s before the submit
(its checkout moved to `4460699` at 23:32:35), a dev-tools tick ran from 23:34:24 to 23:34:42, and
another PA worktree server started during the run.

| | |
|---|---|
| Date | 2026-11-08, 23:33-23:46Z |
| Stack | work (this Windows laptop): PA on :7300, factory serve on :7330, termhub on :7000 |
| Commit served | PA: `d3e3061340d4a940f439a2755a35ddaa254bb068` (GET /api/version). Factory serve: `4460699`. Both include 002f99e (8.4.8 routing), 53e4e54 (8.4.9), e88e204 (E3 push), 0959a0b and de0b0b0 (8.4.11), aa5e03a (8.4.12) and 522345e (8.4.13). Neither has fe23854 (push a job's end with its last delivery). |
| Job checkout | `35c6877` (the job's `base_sha`: origin/main at submit, one commit past `d3e3061`). `termhub/windows/`, `termhub/AGENT.md` and the test are identical at both. |
| Job | `dev-tools:r0003` (card #6778, run 30, step 63), `claude_session`, Opus 5.5; marker `e2e-bacc2d57-7cda-4610-8cdd-31539f559222` |
| Reviewer | a fresh session that did not implement the workflow or its fixes (D10) |
| Criteria | `architecture.json` → `examples[research].acceptance` (`cost.max_usd` 0.05 since D26) |

### How it was run

1. `node bin\pa.js e2e research --dry-run` from the live checkout passed **10 of 10 checks**
   (map 2, config 2, build 3, run 1, ask 1, policy 1). These two are new: the effective ceiling
   is $0.05, and the policy check reports "call ask (chat-actions-ask); e2e answer allow
   (approve-chat-actions)".
2. `node bin\pa.js e2e research --keep`, once, from 23:34:09Z to 23:37:01Z (173 s; 98 s in the
   first review). The four screenshots took 57 s of that, because they now wait for data. The
   question was the first review's. The run exits 1 on two hops. `--keep` left the card up so
   that the Plan chain could be read.
3. Outputs inspected by hand:
   - read report.md in full and opened every reference at `35c6877` (`git show`);
   - compared the job's stream (`run/stream-1.jsonl`) with the report the factory kept;
   - read `job status --json` through serve's `/api/cli`, plus `job.yaml`, serve's log and PA's
     supervisor log, for timings;
   - listed PRs on xvanov/dev-tools with `gh` (owner token, active account unchanged);
   - read `/api/commitments/6778` and termhub's `/api/sessions`, then GET each session link and
     the report link;
   - called the `factory_job` chat tool myself (`chatTools.handle`);
   - ran `pa audit tail` and `pa audit verify`;
   - looked at the four screenshots and read their page text.
4. Cleanup: `pa e2e --sweep --marker e2e-bacc2d57-…` killed the follow session and the researcher
   session and dropped card #6778. termhub lists neither as alive, and the card is `dropped`.
   Another reviewer's `whats-on` run was live and was left alone.

### Rubric, first review → now

| Criterion | First | Now | Evidence |
|---|---|---|---|
| `cited` | pass | **pass** | Every step under "Flow" and "Helpers" carries a file:line. The summary names the commit read, and "Evidence and limits" names the docs and the test, and says what was not checked ("how untracked files that conflict on pop behave", tests not run). I opened every reference (table below). |
| `supported` | pass | **pass** | All the claims hold. Nits that don't change the answer: three ranges run 1-2 lines long (`common.ps1:839-860` ends at 858 and `863-876` at 875; the lockfile step `181-187` is 180-186). "Commit `35c6877`" is the commit the job read. It is not the commit that introduced the stash (`a8b1293`, which the first report cited). |
| `answers` | pass | **pass** | It answers how `update.ps1` handles a dirty tree. It stashes tracked and untracked changes after the fetch and pulls `--ff-only`. It pops the stash before deploying, and stops with blue serving if the stash or the pop fails. It keeps edits through rollbacks (`Reset-TreeTo`). **295 words**, excluding the `SELF_SUMMARY` line. The factory's and PA's "344 words" count that line too. The agent counted its draft at 344 and cut it to 295 itself (stream lines 26-30). |

### Claims checked

All at `35c6877`. "update" is `termhub/windows/update.ps1` and "common" is `termhub/windows/common.ps1`.

| Claim in report.md | Source | Finding |
|---|---|---|
| Stash after fetch: lines 135-139 call `Save-LocalChanges` | update:133 (fetch), 135-139 (call at 137) | supported |
| If the stash fails, `Fail` reports "Nothing changed" | update:138 | supported, exact text |
| `git pull --ff-only` at line 143 | update:143 | supported |
| On refusal `Repair-DivergedHistory` heals, and the update goes on only if HEAD equals `@{u}` | update:145-158 (147, 153-157) | supported |
| Lines 163-171 pop the stash; a failed pop stops with "Nothing was deployed; blue still serving." | update:163-171 (168-169) | supported, exact text |
| `stashPending` is cleared first (line 167), so it is never popped twice | update:166-167, 56-57 | supported |
| `Fail` (53-62) pops the stash while `stashPending` is set | update:53-62 | supported |
| After `npm install`, `package-lock.json` is checked out again (181-187) | update:180-186 (checkout at 185) | supported (range off by one) |
| `-DryRun` exits at line 111, before any stash | update:97-112 | supported |
| `Save-LocalChanges` (839-860) reads `git status --porcelain`, runs `git stash push --include-untracked`, confirms `refs/stash` moved, returns `$true`/`$false`/`$null` | common:836-858 (842, 849-857) | supported (ends at 858) |
| `Restore-LocalChanges` (863-876) runs `git stash pop`; on a conflict git keeps the stash and it prints `git stash list` and `git stash show -p` | common:860-875 (861-862, 866, 872-873) | supported (ends at 875) |
| `Reset-TreeTo` (880-889) stashes before `reset --hard`, and refuses the reset if the stash fails | common:880-889 (883, 885, 886) | supported |
| Rationale in the comments at 821-833 (a dirty tree used to be a hard stop; a stash can be undone) | common:821-833 | supported |
| Docs: `termhub/AGENT.md:473-489` | AGENT.md:473-489, "Uncommitted work is stashed, not a blocker" | supported |
| Tests: `termhub/test/repairHistory.test.ps1` (not run) | file exists; dirty-tree cases at 120-130 and 158- | supported |
| "Commit `35c6877`" | `job.yaml` `base_sha` | supported (the commit read) |
| Summary: a conflicting pop stops the update with blue serving and the stash kept | update:169, common:861-862 | supported |

### Other acceptance items, first review → now

| Item | First | Now | Evidence |
|---|---|---|---|
| Outcome: report.md answers the question, sources cited, research job, no PR | pass | **pass** | Job `done`, `delivery: none`, `stories: []`, `pr_urls: []`. `gh pr list -R xvanov/dev-tools --state all`: the newest PR is #69 at 22:45:13Z, before the run. Searching for `r0003` or the marker finds nothing. |
| Cost ≤ the ceiling | pass ($0 against $0) | **pass** ($0 against $0.05) | `job status --json`: `cost_usd 0.0`, `subscription_equiv_usd 0.5549`. Run 63: `billing subscription`, `cost_usd 0.0`. A research job has no pm, sm or tech_writer step, so nothing here is metered. |
| View: plan | pass | **pass**, with 8.4.46 | `/api/commitments/6778`: the chain is card 6778 → run 30 → job `dev-tools:r0003` → step 63 (researcher, `claude_session`, Opus 5.5), with the follow and step session links, `prs: []`. The harness shot is ready after 10.0 s and shows the card ("#6778 · pa_request · dispatched", run #30, the job and step 63). At 23:36:16, 17.5 s after the job ended, it still reads "job dev-tools:r0003 · in_progress / step 63 researcher · running" (8.4.46). |
| View: run | pass | **pass** | termhub lists the follow session (links card 6778, run 30, job r0003) and the researcher session (links job r0003, step 63; Opus 5.5). Both links answer 200, and so does the report link. The harness shot is ready after 10.1 s and shows the researcher's terminal at its finished state ("result: success … turns=8"), with both sessions and their links in the list. |
| View: build | (manual shot) | **pass** | Harness shot, ready after 10.2 s: r0003 `done` under Delivered, with card #6778, run #30, "$0.00 metered · $0.55 subscription-equivalent". |
| View: ask | pass (tool level) | **pass** (tool level) | My own `factory_job {job: dev-tools:r0003}` returns `card 6778`, `pa_run 30`, the run with its billing and session, the follow link and the report's title and excerpt. The `/talk` shot is new but shows only the idle Talk page, after its full 20 s wait with `ready: false` (8.4.47). |
| Approvals: `factory_start` | pass (policy), not exercised | **pass** (exercised) | `pa audit tail`: #1 23:34:11.339 `allow e2e/approve factory_start [e2e-bacc2d57-…:factory_start] rule=approve-chat-actions`, then #2 23:34:11.343 `ask chat/call factory_start [6778] rule=chat-actions-ask`. `pa audit verify`: chain ok. The answer is the harness's, not the dashboard card's. |
| Cleanup | by hand (8.4.13) | **pass** | `--sweep --marker` removed exactly this run (above). |

### Hops, first review → now

Clock references: PA's log line for the dispatch (`ms`), the audit rows, `job.yaml` and the run
row (`job status`), serve's log (1 s resolution), PA's supervisor log, and the evidence files'
write times.

| Hop | Target | First review | Now | Detail now | Result |
|---|---|---|---|---|---|
| jarvis: tool call (`factory_start`) excluding model time | 1000 ms | 2312 ms (submit ~1.4 s) | **11355 ms** | Audited call 23:34:11.343 → "dispatched" 23:34:22.696. `ms`: route 58, prepare 30, brief 48, **submit 10864**, follow 285. The job was written at 23:34:13.697 (`created_at`), and PA logged the factory's answer at 23:34:22.388. | **fail, 10.4 s over** (worse) |
| dispatcher: approval to "started" | 1000 ms | ~2.1 s (factory); the e2e read 11472 ms (10 s poll) | **7021 ms** | From `factory_start`'s return (23:34:22.70) to the job's `started_at` (23:34:29.72); the e2e now reads it from the factory. Serve logged `push: queued` and `dispatch (wake)` at 23:34:24, about 10.3 s after the job was written. The first review's wake came about 1 s after. From the approval itself it is 18.4 s. | **fail, 6.0 s over** |
| runtime-claude: the research conversation writes report.md | unbounded (5400 s cap) | 73916 ms e2e; 81.9 s job | **88846 ms** | `started_at` → `updated_at` 23:35:58.566. The researcher step ran 23:34:44.14-23:35:58.51 (74.4 s, 8 turns, 58.9 s of it in Claude). Checkout and brief took 14.4 s before it (10.2 s before). | pass |
| worker: state change to the board redraw | 200 ms | not measured; PA heard of `done` 5.9 s late | **not measured** | The job ended at 23:35:58.56, and serve pushed `done` at 23:35:59 (at most 1.4 s later). Build showed `done` in its 23:36:27 shot. The Plan card still showed `in_progress` at 23:36:16. PA's run row ended ("factory runs updated … ended: 1") at 23:38:04.02, **125.5 s** after the job. `in_progress` was pushed at 23:34:28 and reached the run row at 23:34:32.1. | **fail** (not measured, and Plan is 2 min late) |

### Defects

From the first review:

- **8.4.8** (tool call): still open. 002f99e's routing fix is verified live (136 ms before the
  submit), but the hop got worse because of the submit (8.4.45).
- **8.4.9** (approval to started): the measurement is verified live; the e2e's 7021 ms is the
  factory's `started_at` less the tool's return. The hop is still open.
- **8.4.10** (worker hop): partly verified. Serve's push (e88e204) sent `done` at most 1.4 s
  after the job ended (5.7 s before), and Build showed it. The e2e still doesn't time the hop, and
  the Plan card follows the run row, not the push (8.4.46).
- **8.4.11** (screenshots): verified live for Plan, Build and Run. Each was ready after about 10 s
  and shows the run's data. The Ask shot never gets ready (8.4.47).
- **8.4.12** (approval): verified live. Two audit rows, in order, and the chain verifies.
- **8.4.13** (cleanup, `--sweep`): verified live. `--sweep --marker` removed this run's two
  sessions and its card, and nothing else.

New, filed under 8.4 in PLAN.md:

1. **8.4.45** The factory submit took 10.9 s. The job was written 2.2 s into it. Then serve's
   queued push and its wake dispatch both waited until about 10 s after the write, and the reply
   reached PA about 8.7 s after it. Nothing in `create_task` or `request_wake` is slow. PA doesn't
   log the `ms` that serve's `/api/cli` reply carries, so the split between serve and PA's
   run-row write can't be read.
2. **8.4.46** The Plan card shows a finished job as running for about 2 min. The push reaches PA
   within about 1 s and Build shows it, but the card chain reads the run row. The row ended
   125.5 s after the job, though 8.4.44 says the push hurries PA's next poll to 5 s.
3. **8.4.47** The Ask shot (`/talk`) never gets ready. Headless, `#chat-log` stays "loading…", so
   the shot always waits the full 20 s and shows the idle Talk page. Ask is checked only at the
   tool level.

Still stale and not a defect of this workflow: the root `CLAUDE.md` line about `update.ps1`
failing on a dirty tree (noted in the first review).

### Evidence

Under `%LOCALAPPDATA%\personal-assistant\e2e\`:

- `20261108T233350Z-research-dry/summary.json`: the dry run (10/10).
- `20261108T233409Z-research/`: `summary.json`, `report.md` (the delivered report, the same text
  as the factory's copy), `transcripts/session-smw8gz34ae.txt` (the researcher's tail), and
  `screenshots/{plan,build,run-smw8gz34ae,ask}.png`, each with its page text in a `.txt`.

The factory keeps the job folder (`state/jobs/r0003-…/`: `job.yaml`, `ask.md`, `brief.md`,
`report.md`, `run/stream-1.jsonl`) under its data dir. Serve's log is `state/logs/serve.log`.

## First review, 2026-11-08

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

### How it was run

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

### Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `cited`: every claim carries a source, and each source was opened and checked | **pass** | Every step in "Flow" and "Evidence" carries a file:line, commit or command. The summary restates them. I opened all 17 line references, the commit, the AGENT.md section, the test lines and CLAUDE.md (table below). The report also says what it did not verify ("Code read only; tests and script not run"). |
| `supported`: no claim is unsupported by its source | **pass** | All checked claims hold. Two nits that don't change the answer: `common.ps1:839-860` runs 2 lines past `Save-LocalChanges` (it ends at 858). "On every exit after the stash, `Fail` pops it first" holds for exits through `Fail`; an unhandled terminating error between the stash and the pop would skip it. The report repeats the code's own comment there. |
| `answers`: the report answers the question asked, not an adjacent one | **pass** | It answers how `update.ps1` handles a dirty tree: it stashes tracked and untracked changes, pulls, pops before deploying, stops safely if the stash or pop fails, and keeps edits through rollbacks. 296 words (limit 300), with file and line citations. |

### Claims checked

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

### Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: report.md answers the question, sources cited, research job, no PR | **pass** | Job `done`, `delivery: none`, `stories: []`, `pr_urls: []`. `gh pr list -R xvanov/dev-tools --state all`: the newest PR is #60 at 18:16Z, before the run (19:52Z). Searching for `r0002` or the marker finds nothing. |
| Cost ≤ $0 (subscription) | **pass** | `factory job status dev-tools:r0002 --json`: `cost_usd 0.0`, `subscription_equiv_usd 0.6443`. Run 54: `billing subscription`, `cost_usd 0.0`. |
| View: plan | **pass** | `/api/state` has card #6773 with chain card → run 28 → job `dev-tools:r0002` → step 54 (researcher, `claude_session`) and session links. Rendered: after load the page text (`reviewer/plan-loaded.txt`) has the card, "#6773 · pa_request · dispatched", with its context. The card is below the fold of `reviewer/plan-loaded.png`. The harness's `screenshots/plan.png` shows an empty board (8.4.11). |
| View: run | **pass** | termhub `/api/sessions` lists the follow session (links card 6773, run 28, job r0002) and the researcher session (links job r0002, step 54; model Opus), both alive. Rendered: `reviewer/run-loaded.png` opens the researcher's terminal at its finished state (the report summary, "result: success … turns=12"), and the page's session list (`run-loaded.txt`) shows both sessions with their card, run, job and step links. The harness's `screenshots/run-*.png` shows "No terminal open" (8.4.11). |
| View: ask | **pass** (tool level) | The `factory_job` chat tool returns card #6773 and the report (harness check). No Ask page was captured. |
| Approvals: `factory_start` | **pass** (policy), not exercised | `pa audit check factory_start --channel chat --action call` gives `ask (rule chat-actions-ask)`, and there is no per-stack override. The run never reached the policy engine: the harness calls the tool handler directly and the audit log has no row (8.4.12). |

### Hops

Clock references: PA's supervisor log, factory serve's log (1 s resolution), `job.yaml` and
the run row (`job status`).

| Hop | Target | e2e | Factory clock | Result |
|---|---|---|---|---|
| jarvis: tool call (`factory_start`) excluding model time | 1000 ms | **2312 ms** | run row 19:52:09.56, factory job created 19:52:10.96, PA "dispatched" 19:52:11.30 (about 1.4 s of it is the submit) | **fail** (8.2 measured 13.5 s; better, still over) |
| dispatcher: approval to "started" | 1000 ms | 11472 ms (10 s poll resolution) | `factory_start` returned 19:52:11.3, serve woke and dispatched 19:52:12, job `started_at` 19:52:13.40: **~2.1 s** | **fail** |
| runtime-claude: the research conversation writes report.md | unbounded (5400 s cap) | 73916 ms | job 19:52:13.40 to 19:53:35.25 = 81.9 s. Researcher step 19:52:23.62 to 19:53:35.22 = 71.6 s, 12 turns. The first 10.2 s before the model is checkout and brief (`brief.md` 19:52:21). | pass |
| worker: state change to the board redraw | 200 ms | not measured | job ended 19:53:35.25, serve pushed `done` 19:53:41, PA recorded it at 19:53:41.14 (**5.9 s**, with PA's event loop blocked 1230 ms then). `in_progress`: serve pushed it at 19:52:12, PA recorded it at 19:52:19.4 (~7 s). | **fail** (not measured, and PA learns 6-7 s late) |

### Evidence

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

### Defects (filed under 8.4 in PLAN.md)

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
