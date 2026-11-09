# Acceptance review: `deepseek-pr` (plan 8.3)

## Re-review, 2026-11-09

**Verdict: FAIL.** The outcome happened. The factory opened a ready PR (#78) through the metered
DeepSeek API runtime and the diff is in scope. The git fallback now runs in the checkout, so the
blocker from #63 and #72 is gone, and Kimi approved with only lows and no fix round. The context
update is in the PR. CI was not green, and after the e2e had already returned the factory started
a CI-fix that took the job from $1.42 to **$2.34**, over the $2 ceiling. Two hops still miss the
Map's current `max_ms` (D27: report the numbers, the lead resets the targets): the tool call
**1165 ms** (target 1000) and the worker hop **2207 ms** (target 200). Approval to "started" is
**275 ms** (target 1000).

Load before the run was 0.23 on 16 cores. Serve had restarted onto `9cd5567` at 01:56:29Z, and the
run started about nine minutes later. At 02:12Z the load was 0.83. Another e2e opened a dummy PR
(#75) at 02:07Z, during this job's dev step.

| | |
|---|---|
| Date | 2026-11-09 02:03Z to 02:29Z |
| Stack | personal (the personal machine, Linux): PA on :7300, factory serve on :7330, its termhub |
| Commit served | `9cd55676963b2e09580f8cb7cf45dcbfe0279f28` (GET /api/version, and the checkout HEAD). Factory serve logged "checkout moved … -> 9cd5567" and restarted at 01:56:29Z. |
| Job | `dev-tools:008` (card #7, run 9, story 202, steps 51057 pm, 51058 sm, 51059 dev, 51060 reviewer, 51061 tech_writer; 51062 is the later CI-fix dev). Runtime `api`, delivery `pr`, solo pipeline. Marker `e2e-b3efe900-4b04-40a4-8a22-2e5e8d88c59f`. |
| PR | [#78](https://github.com/xvanov/dev-tools/pull/78), head `d4ef131` (commits `71f470a` feat, merge of origin/main `ccec530`, `d4ef131` context). Closed after review, branch deleted. No later commit landed. |
| Reviewer | a fresh session that did not implement the workflow or its fixes (D10) |
| Criteria | `architecture.json` → `examples[deepseek-pr].acceptance` |

### How it was run

1. `node bin\pa.js e2e deepseek-pr --dry-run --on <the personal machine> --stack personal` from the
   laptop's live checkout passed **23 of 23 checks** (map 2, config 3, build 5, plan 3, run 1,
   mcp 7, policy 1, github 1).
2. The real run, once, with `--keep` (the remote runner adds `--report`): 02:05:17Z to 02:17:52Z
   on the personal machine. It passed **100 of 100 view checks** and exits 1 on the jarvis and
   worker hops. The laptop lost its path to the machine for a few minutes after the start; the
   run continued there, and the report came back when the path returned.
3. Outputs inspected by hand: the PR's metadata, checks and diff with `gh` (owner token; the
   active account was not changed); `job status` through serve's `/api/cli`; the story log; the
   dev and reviewer `stream.jsonl` (commands, the review JSON, usage); `/api/state` on that PA.
   The dispatch journal line with the per-lap `timings_ms` was not in the window searched, so the
   jarvis split below is the e2e's own note.
4. Cleanup: a CI-fix dev had already started (02:25:08Z). The PR was commented and closed, the
   branch deleted, then `job cancel` (02:28:50Z, job cost **$2.336**) and
   `pa e2e --sweep --marker e2e-b3efe900-…`, which killed the seven sessions and dropped card #7.

### Rubric, previous re-review → now

| Criterion | 2026-11-08 | Now | Evidence |
|---|---|---|---|
| `pr`: the PR is open and ready for review | pass | **pass** | #78 `OPEN`, `isDraft: false`, `mergedAt: null` while kept. Body is the factory's (`pr`, will not merge). Head `d4ef131`. |
| `ci`: CI is green on the PR head | pass | **fail** | Run 42549793897. personal-assistant (ubuntu, windows) and the contract job SUCCESS. jarvisd (ubuntu, windows) FAILURE in `npm test` (`tsc`). software-factory (ubuntu) FAILURE in pytest (5m21s); the windows job was still running when this was scored, so its log was not downloaded. The e2e recorded `ci: failing` and still marked the github hop reached. |
| `review`: an independent code review finds no blocker | fail | **pass** | The `cwd` blocker is fixed (below). Remaining notes are lows. |
| `scope`: the diff stays inside what the card asked for | pass | **pass** | Five files: `src/cli/version.ts`, `test/version.test.js`, the HELP line and registration in `src/cli/index.ts`, two paths added to the dashboard component's code list in `architecture.json`, and `apps/dev-tools/context/navigation.md` from tech_writer. No unrequested HELP topic. |

### Code review of #78

The git fallback is `execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })`
with `repoRoot = path.resolve(__dirname, '..', '..')`, the personal-assistant directory inside
the checkout. Git from that directory returns this repo's HEAD, not the caller's working
directory. If the dashboard answers nothing and git throws, `fail()` sets exit code 1. The
address is `config.dispatch.host` and `port`. That is the #63/#72 blocker, fixed.

Lows, not blockers:

- `version.ts` and the test still have no trailing newline. Kimi's only findings were those two
  lows, plus a note that one test compares two literals.
- The tests cover `formatVersionOutput` only. The git `cwd` and the HTTP call are untested.
- A `0.0.0.0` bind is still not rewritten to `127.0.0.1`. This stack listens on `127.0.0.1`.
- The new paths were appended to the dashboard component's code list, beside the passkey files.

The diff was read at `d4ef131`. The branch was deleted after that; the verb was not executed
from a second directory.

### The independent review (8.4.50)

One Kimi cycle, `azure/Kimi-K2.7-Code`, `num_turns` 0, 22017 input tokens, 35.7 s, $0.0589.
Verdict `approve`, test score 0.85. Findings: two lows (the missing newlines). No high, no
medium. No second dev step. The stream stores only the persona head of the prompt and notes the
full prompt was 88214 characters, so the ask and the precedent files are not visible there; the
token count is about twice the previous cycles' ~10k.

`comments_to_post` held those lows and two "cite the precedent" notes. None of them is on the
PR (no review comments, no "Reviewer note" in the story log). The review handler ended at
02:13:37Z and the PR was pushed at 02:14:10Z, so the post, which requires a PR number, had
nothing to post to (8.4.55).

### Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: a ready PR through the metered API, never merged | **pass** | pm and sm `azure/DeepSeek-V4-Flash`, dev `azure/deepseek-v4-pro`, reviewer and tech_writer `azure/Kimi-K2.7-Code`, all `runtime: api`, `billing: metered`. #78 was not merged. |
| Delivery is the factory's | **pass** | The dev commands that mention commit or push are a `git add`, a message-file write, and two greps. None is `git push`, `gh`, or `--no-verify`. The factory pushed at 02:14:10.35 (`delivery_pr_head_pushed`). |
| Dev setup (8.4.51) | **pass** | Handler 02:05:58.72, `solo_checks` 0.8 s later, lint baseline 02:06:01.23 on the three context markdown files (not `ruff check .`). Stream's first event 02:06:02.05, **0.8 s** after `started_at` 02:06:01.25. The agent then took 416 s. |
| Context update (8.4.52) | **pass** | Commit `d4ef131` is in #78 and adds `src/cli/version.ts` and the test to `navigation.md`. |
| Cost ≤ $2 | **fail** on the final job | The e2e read **$1.4232** (pm $0.0022, sm $0.0028, dev $1.3325, reviewer $0.0589, tech_writer $0.0268) and passed. The CI-fix dev (step 51062) then ran; at cancel the job was **$2.336**. |
| Views | **pass** | 100/100 checks. Plan, plan-card, build, run, mcp, github, e2. Each reported step link returned 200 on that machine's termhub front. Five screenshots; the images were not opened. Ask is the `factory_job` tool check. |
| Approvals | **pass** | Policy checks: allow (`approve-chat-actions`) then ask (`chat-actions-ask`). |
| Plan board leak (8.4.53) | **not shown** | `/api/state` had one commitment, card #7. No other card's text named the dummy ask. There was no second card for a leak to land on. |
| E6 / multi-line commit | **pass** | No guard refusal and no hang. The commit message went through a file. |

### Hops

Targets are the Map's current `max_ms`. D27 says these are the numbers the lead resets from.
The e2e is the clock except where the story log is named.

| Hop | Target | 2026-11-08 re-review | Now | Detail | Result |
|---|---|---|---|---|---|
| jarvis: tool call excluding model time | 1000 ms | 3945 ms | **1165 ms** | Round trip 9972 ms less compose's model call 8807 ms. Per-lap `ms.serve` was not in the log window searched. | **fail, 165 ms over** |
| dispatcher: approval to "started" | 1000 ms | 7348 ms | **275 ms** | factory_start return to the pm step's `started_at` 02:05:27.779. | **pass** |
| factory-chain: dev, review, gates, PR | unbounded | 1637 s | **536.5 s** | pm 5.0 s, then 12 s to sm (11.2 s), dev setup ~3 s, dev agent 416 s, review 36 s, tech_writer 19 s, push at 02:14:10. | reported |
| github: CI watch to green | unbounded, ≤ 3 CI-fix cycles | 147 s, green | **36.3 s, not green** | e2e `ci_done` 02:15:00 with `ci: failing`. The factory's own watch started 02:19:21 and redispatched a dev at 02:25:04 (cycle 1 of 3). That dev was cancelled. | **fail** (not green) |
| worker: state change to the board redraw | 200 ms | not measured; 300–334 ms by hand | **2207 ms** | e2e note: queued 179 ms via the run row (job status); triaging not seen; in_progress 2207 ms via the run row (job status). No terminal plan-card sample: the job was still `pr_open` when the e2e scored the hop. | **fail, 2.0 s over** |

### Defects

Ticked from this run: 8.4.15 (275 ms), 8.4.16 (the e2e now records the hop; the number is 2207 ms),
8.4.49 (the `cwd` is the checkout), 8.4.51 (agent's first event 0.8 s after `started_at`),
8.4.52 (the context file is in the PR).

Still open: 8.4.14 (1165 ms). 8.4.50's fix round is gone, but the lows never reached the PR, so
that item stays open. 8.4.53 was not shown either way.

New, filed under 8.4:

1. **8.4.55** Solo review notes never reach the PR. The review ends before the PR number exists,
   and the post is skipped.
2. **8.4.56** CI on the PR head is red, and the e2e counts a failing watch as the hop. jarvisd's
   `tsc` fails on `compose.ts`'s `ms.hints`, which this diff does not touch; the last green run
   on main skipped jarvisd. software-factory ubuntu failed pytest.
3. **8.4.57** After the e2e returns, a failing CI starts a fix dev. This one took the job from
   $1.42 to $2.34, over the $2 ceiling, before it was cancelled.

### Evidence

On the personal machine, under its PA data dir `e2e/`:

- `20261109T020300Z-deepseek-pr-dry/summary.json`
- `20261109T020517Z-deepseek-pr/summary.json` (hops, 100 checks, cost $1.4232, golden timeline)

Factory state (that machine): `api_runs/dev-tools-202-dev-20261109T020602053388Z/stream.jsonl`,
`…-reviewer-20261109T021300809484Z/stream.jsonl`,
`logs/0202-008-add-pa-version-verb-with-dashboard-git-fallback-and-unit.log`.

## Re-review, 2026-11-08

**Verdict: FAIL.** The outcome happened again, and most of the first review's failures are fixed
live. The factory opened a ready PR (#72) through the metered DeepSeek API runtime and delivered
it: CI was green on its head, nothing was merged, and the job cost $1.42 of the $2 ceiling. Kimi
reviewed the diff independently before delivery and sent it through one fix round. E6.1's guard
refused a multi-line commit, so nothing hung. The agent never pushed, never opened a PR and never
used `--no-verify`. The dev prompt opens with the dev-tools context set, the step links open, and
the diff stays in scope. Three things still fail:

- **My review finds the same blocker as in #63.** With the dashboard down, the git fallback runs
  in the caller's working directory. Run from another repo, `pa version` prints that repo's
  commit; run outside any repo, it says "git unavailable" and exits 0. The agent's own comment
  cites `server.ts:618`, the line with `cwd: __dirname`. Kimi's two cycles missed it (8.4.49).
- **Two hops miss the Map's current `max_ms`**, which D27 says to score against. The tool call
  takes **3945 ms** against 1000 ms (2.9 s over, about the same as before). Approval to "started"
  takes **7348 ms** against 1000 ms (6.3 s over; about 2.9 s before).
- **The worker hop (200 ms) is still not measured by the e2e.** By hand, a factory transition
  reached the live feed in 300-334 ms, and the Plan card's run row followed 9.1-13.6 s later.

Load: CPU read 0-1% before the run. Serve had restarted onto `5d98440` at 23:50:38Z (8.4.48 covers
its first minutes), and I started 45 s after its interval ticks ended. Another agent's
`pytest -n auto` in a different worktree started at 23:57:20, 2 s after the pm step. It ran
alongside the pm, sm and dev-setup stretch, though not alongside the two hops above.

| | |
|---|---|
| Date | 2026-11-08 23:55Z to 2026-11-09 00:33Z |
| Stack | work (this Windows laptop): PA on :7300, factory serve on :7330, termhub on :7000 |
| Commit served | PA `5d984402cd292d63a8fe77d372e469052d4ce14f` (GET /api/version); factory serve restarted onto `5d98440` ("checkout moved 4460699a -> 5d984402"). It includes eb7be37 (8.4.17), 8b00685 and 151e570 (8.4.19), bec30c1 (8.4.20), 6f0aa15 (8.4.21), 00a5a39 (8.4.22), 5c9defa and bd7b768 (8.4.23), e2b0323 (E6.1) and fe23854 (8.4.44). It does not include 9ed9172 (8.4.46), which landed during the run. |
| Job | `dev-tools:020` (card #6779, run 31, story 18, steps 64 pm, 65 sm, 66 dev, 67 reviewer, 68 dev fix round, 69 reviewer, 70 tech_writer), runtime `api`, delivery `pr`, solo pipeline; marker `e2e-553cdffc-480e-49cc-a653-383dbdb98b61` |
| PR | [#72](https://github.com/xvanov/dev-tools/pull/72), head `730dea1` (commits `f709a58` feat, `098744f` fix round, two merges of origin/main). Closed by me after review, branch deleted. |
| Reviewer | a fresh session that did not implement the workflow or its fixes (D10) |
| Criteria | `architecture.json` → `examples[deepseek-pr].acceptance` |

### How it was run

1. `node bin\pa.js e2e deepseek-pr --dry-run` from the live checkout passed **23 of 23 checks**
   (map 2, config 3, build 5, plan 3, run 1, mcp 7, policy 1, github 1).
2. `node bin\pa.js e2e deepseek-pr --keep --stack work`, once, ran from 23:57:01Z to 00:28:42Z
   (31.7 min). It passed **130 of 130 view checks** and exits 1 on the two hop targets. The checks
   now include a GET of each step link and the policy audit of the approval.
3. Outputs inspected by hand:
   - the PR's metadata, checks, CI run and diff with `gh`, using the owner token (the active
     account was not changed);
   - the PR head, run in a throwaway checkout: `pa version` with the dashboard up and down, from
     a non-repo directory, another repo and the checkout;
   - `job status --json` through serve's `/api/cli`; the story's handler log
     (`state/logs/0018-…log`); serve's log;
   - each step's `stream.jsonl`: all 48 terminal commands of the two dev conversations, the guard
     result, the gates, the usage, the prompt head, and the two reviews in full;
   - `/api/factory`, `/api/state`, `/api/commitments/6779`, and termhub's `/api/sessions`; a GET of
     every step link and of the follow link;
   - the chat's `factory_job` and `card` tools, called directly; `pa audit tail` and
     `pa audit verify`;
   - the dashboard's live feed (`/api/events`), recorded with timestamps from 00:02:47 to 00:33, to
     time the worker hop by hand;
   - the six screenshots and their page text.
4. Cleanup:
   - `gh pr close 72 --delete-branch`;
   - `pa e2e --sweep --marker e2e-553cdffc-…` killed the follow session and all seven step
     sessions, and nothing else;
   - the card was already `done` (the job delivered), and I dropped it with `pa done 6779 --dismiss`.
   Termhub lists none of the run's sessions afterwards.

### Rubric, first review → now

| Criterion | First | Now | Evidence |
|---|---|---|---|
| `pr`: the PR is open and ready for review | pass | **pass** | #72 `OPEN`, `isDraft: false`, `mergedAt: null` while kept. Story 18 `delivered_pr` ("CI green on PR #72"), level `pr`, job `done`, `merged: false`. The body is the factory's: "approved by an independent reviewer model … the factory will NOT merge it". |
| `ci`: CI is green on the PR head | pass | **pass** | Head `730dea1`, run 42540008525, 00:24:28-00:26:48Z: changes, personal-assistant (ubuntu, windows), contract (postgres, sqlite), jarvisd (ubuntu, windows) all SUCCESS. Path-filtered jobs were skipped, and CodeRabbit skipped its review. There were 0 CI-fix cycles. |
| `review`: an independent code review finds no blocker | fail | **fail** | The same blocker as #63, confirmed by running it (below). The hardcoded port is fixed. |
| `scope`: the diff stays inside what the card asked for | fail (minor) | **pass** | 3 files, +153/−0: `src/cli/version.ts` and `test/version.test.js` (new), plus `src/cli/index.ts` (the HELP line, the registration, and a `version` HELP_TOPICS entry for its own `pa help version`). The unrelated `meeting` entry is gone. |

### Code review of #72

- **Blocker: the git fallback still reads the caller's directory.** `execFileSync('git',
  ['rev-parse', '--short', 'HEAD'], …)` has no `cwd`. I ran the PR head with
  `PA_DISPATCH_PORT=7399` (nothing listening) in four places:
  - from a non-repo directory, it printed `version unknown (dashboard unreachable, git
    unavailable)` and exited 0;
  - from another repo, it printed that repo's commit (`git: bb7e247`);
  - from the checkout, it printed `git: 730dea1`;
  - with the dashboard up, it printed `dashboard: 5d98440…` from anywhere.

  The card asks for "`git rev-parse --short HEAD` of the checkout". The file's own comment cites
  `dashboard/server.ts:618`, which is the line with `cwd: __dirname`, so the agent read the
  precedent and dropped its `cwd`. The "git unavailable" text is wrong too: git is there, it is
  just not in a repo.
- Fixed since #63: the address is `config.dispatch.host`/`port`, the dashboard's own listener
  (`server.ts` `start()`). Minor: it doesn't map a `0.0.0.0` bind to `127.0.0.1` the way
  `goldenPath.ts:49` and `notify/chat.ts:196` do. Against a `0.0.0.0` bind the request gets 403
  here, so on such a stack the verb always falls back to git.
- Minor issues:
  - `version.ts` and the test still end without a newline, which both Kimi reviews asked to fix;
  - six tests cover one three-line pure function, and the fallback (the part that is wrong) is
    untested;
  - the fix round added comments that cite file:line (`server.ts:290`, `:618`,
    `e2e/deployTest.ts:93`) and say why the code is right. Those line numbers will rot, and the
    comments talk to the reviewer, not the next reader;
  - the PR title still says `feat(backend):` (the factory's title).
- Fine: the plugin pattern, the 5 s timeouts, `windowsHide`, the dashboard response check
  (`typeof parsed.commit === 'string'`), the output that names its source, and a HELP line
  aligned with its neighbours.

### The independent review (8.4.19)

The review ran on the API solo path as 8.4.19 describes, on `azure/Kimi-K2.7-Code`, a different
model from the dev's. Each cycle is one model call on the diff (`num_turns 0`, about 10 k tokens
in), with no repo access.

| Cycle | Time | Verdict | Findings |
|---|---|---|---|
| 1 (step 67) | 00:16:48-00:17:51, 50.2 s call, $0.0553 | `request_changes`, test score 0.78 | 1 medium: the `/api/version` path and `{commit}` shape have "no cited repo precedent". That is a false alarm: the dashboard serves exactly that at `server.ts:290`. 4 low: raw `http.get`, two missing trailing newlines, duplicate tests. **No blocker.** |
| fix round (step 68) | 00:17:52-00:22:15, 29 turns, $0.4027 | gate green | Added the line citations and dropped the duplicate tests (commit `098744f`, +10/−17). The trailing newlines are still missing. |
| 2 (step 69) | 00:22:17-00:23:18, 47.0 s call, $0.0472 | `approve`, 0.80 | 3 low: the trailing newline, raw `http.get`, "confirm `config.dispatch` is the dashboard listener". |

Neither cycle saw the `cwd` blocker. Cycle 1 had no blocker, yet it cost a full fix round:
$0.45 and 6.4 min, and the round's main output was comments (8.4.50). 8.4.19 says a *blocking*
finding gets the fix round.

### Other acceptance items, first review → now

| Item | First | Now | Evidence |
|---|---|---|---|
| Outcome: a ready PR through the metered DeepSeek API runtime, never merged | pass | **pass** | All seven steps ran `runtime: api`, `billing: metered`. The two dev steps used `azure/deepseek-v4-pro`, pm and sm `azure/DeepSeek-V4-Flash`, and the two reviewers and tech_writer `azure/Kimi-K2.7-Code`, as the Map says. |
| Delivery is the factory's, not the agent's | pass | **pass** | 48 terminal commands (26 + 22): none is `git push`, none is `gh`, and none uses `--no-verify`, `-n` or `core.hooksPath`. The agent's text never mentions any of them. Both commits ran the pre-commit hook (6 of 121 test files selected, all passing). The factory merged origin/main, pushed (`delivery_pr_head_pushed` 00:24:29.74) and opened the PR. |
| E6 behaviour of the API dev on Windows (8.4.18) | fail | **pass** | The fix round's first commit had a raw newline in `-m`. At 00:21:34.22 the guard answered "Refused by the factory before it reached the shell; nothing ran. This command has a newline in it; send PowerShell one line…". 3 s later the agent committed on one line (`` `n `` escapes). There was no `>>` prompt and no terminal reset; the first review's hang took 7.6 min and $0.16. Round 1's commit was one line from the start. |
| Dev prompt has the context (8.4.20) | fail | **pass** (as far as the stream shows) | Both dev prompts open with "# Context for persona: dev … ## software-factory/apps/dev-tools/context/project.md". "NO CONTEXT AVAILABLE" and "Onboarder" are absent. The stream keeps only the first 600 characters of the prompt, so the rest can't be read. The first dev conversation took 48 turns (76 before). |
| Dummy card (8.4.21) | fail | **pass** | The ask names only the change and the marker. Nothing in either dev conversation mentions a PR, a push or a merge. |
| Cost ≤ $2 (job `cost_usd`) | pass ($1.17) | **pass ($1.4198)** | pm $0.0015, sm $0.0029, dev $0.8704 + $0.4027, reviewer $0.0553 + $0.0472, tech_writer $0.0397. The fix round and the two reviews add $0.5052. The PA's compose call (azure/pa, 3530 ms) is outside the job cost. This run was the review's only metered spend. |
| View: plan | pass (API) | **pass** | `/api/state` and `/api/commitments/6779` (plan 19/19, plan-card 19/19): card → run 31 → job `dev-tools:020` → steps 64-70, each with its session, → PR #72, CI passing. The shot is ready after 10.1 s but doesn't show the card, which had closed to `done` at 00:27:18, before the shot. |
| View: build | pass | **pass** | `/api/factory` (build 18/18). The shot shows the job under Delivered: "story 18 · delivered_pr · PR #72 · open · CI passing · 7 finished runs · $1.42 metered · card #6779 run #31". |
| View: run (8.4.17) | fail | **pass** | Every step link Plan, Build and `factory_job` give is now termhub's front (:7000, by its secure URL), not sessiond. All 7 step links and the follow link answer 200 (e2e `link opens` 7/7, and my own GETs). Each session is listed with its job/step links. The two Run shots show the tech_writer's and the second reviewer's finished terminals, not blank pages. |
| View: ask | pass (tool level) | **pass** (tool level) | `factory_job {job: dev-tools:020, fresh: true}` took 2687 ms and returns the state, PR #72, $1.42, `pa_run` 31 and all seven steps with their sessions. `card {id: 6779}` took 16 ms; it returns the run, the job, the steps and the PR, with no stale "still running" (8.4.23). The `/talk` shot never gets ready (8.4.47). |
| Approvals: `factory_start` | pass (policy), not exercised | **pass** (exercised) | `pa audit tail`: #3 23:57:03.841 `allow e2e/approve factory_start [e2e-553cdffc-…] rule=approve-chat-actions`, then #4 23:57:03.844 `ask chat/call factory_start [6779] rule=chat-actions-ask`. `pa audit verify`: chain ok, 4 rows. The answer is the harness's, not the dashboard card's. |
| Stale state after the job (8.4.23) | fail | **pass** | Run 31's row went to `landed`, `factory_state: done` at 00:27:18, and the sweep's output lists only this run's sessions, with no "cancelled" lines for old jobs. |
| Cleanup | by hand | **pass** | Above. |

### Hops, first review → now

Clock references: PA's dispatch log line (`ms` laps), the audit rows, `job status` (`started_at`/
`ended_at`), the story's handler log, serve's log (1 s resolution), the streams, GitHub's run and
job times, and my timestamped recording of `/api/events`.

| Hop | Target | First review | Now | Detail now | Result |
|---|---|---|---|---|---|
| jarvis: tool call (card, factory_start) excluding model time | 1000 ms | 6701 ms with compose; ≈3.7 s without | **3945 ms** | The audited call was at 23:57:03.844, and PA logged "dispatched" at 23:57:11.316: a 7475 ms round trip, less compose's model call (3530 ms). Laps (`ms`): route 37, prepare 7, **gather 2097**, compose_model 3530 (brief 5711 with gather), **submit 1345**, follow 361. A 386 ms sqlite vector statement is logged inside the gather. | **fail, 2.9 s over** |
| dispatcher: approval to "started" | 1000 ms | ≈2.9 s (factory); the e2e read 11097 ms | **7348 ms** | From factory_start's return (≈23:57:11.32) to the pm step's `started_at` (23:57:18.666). Serve logged `tick dev-tools started (wake)` at 23:57:12 and `push: queued` at 23:57:13, so the submit now wakes the tick within about 1 s. The tick then took ≈6.7 s to start the pm step. | **fail, 6.3 s over** (worse) |
| factory-chain: dev step, review, gates and PR | unbounded | 1119.7 s | **1637.0 s** (e2e); 1631.1 s factory | `started_at` 23:57:18.67 → PR head pushed 00:24:29.74. See the breakdown below. | reported |
| github: CI watch to green | unbounded, ≤ 3 CI-fix cycles | 148.1 s | **147.1 s** | By GitHub's clock, CI ran 00:24:28-00:26:48 (140 s); the factory recorded `delivered` at 00:27:04.51, 16 s later. 0 fix cycles. | pass |
| worker: state change to the board redraw | 200 ms | not measured (24-31 s from a PR close) | **not measured by the e2e**; 300-334 ms by hand | `pr_open` at 00:24:29.980 reached the feed as a `factory` push frame at 00:24:30.314 (334 ms). `delivered` at 00:27:04.513 reached it at 00:27:04.813 (**300 ms**). That is frame arrival at my client, before any redraw. The Plan side (run row 31 and card #6779) came at 00:24:39.127 (9.1 s) and 00:27:18.086 (**13.6 s**), on code without 9ed9172. | **fail** (not measured; over 200 ms by hand) |

The factory chain, by the factory's clocks:

| Stretch | Time | Note |
|---|---|---|
| pm | 23:57:18.67-23:59:46.00, 147.3 s | One Flash call took 141 s (prompt 23:57:24.3, answer 23:59:45.4); 8.8 s in the first review |
| pm → sm | 26 s | the next wake tick |
| sm | 00:00:12.11-00:00:27.36, 15.3 s | |
| dev setup | 00:00:27.6 → agent's first event 00:05:53.7, **326 s** | solo checks after 90.6 s, the lint baseline (`uv run --all-extras ruff check .`) 95 s more, then 140 s from the run row (00:03:34) to the stream's init (8.4.51) |
| dev round 1 | 00:05:53.7-00:16:47.2, 10.9 min | 48 turns, 2.27 M input tokens (2.01 M cached), 10.1 k output, $0.8704; gate green in round 1 |
| review 1 | 00:16:48.8-00:17:51.4 | `request_changes` without a blocker |
| fix round | 00:17:52.3 → agent 00:18:49 → 00:22:15.8 | setup 57 s, agent 3.4 min, 29 turns, $0.4027 |
| review 2 | 00:22:17.1-00:23:18.3 | `approve` |
| tech_writer | 00:23:18.7-00:23:57.9 | its `navigation.md` rewrite reached neither the PR nor the checkout (8.4.52) |
| docs_enforcer, merge, push, PR | 00:23:58.3-00:24:29.7, 31 s | PR #72 |

From the run's start (the card came 2 s later): PR at 1654 s, CI done at 1801 s (30.0 min),
delivered at ≈1803 s. The first review took 1287 s to CI done. The review cycle accounts for 7.7 min
of the difference, and the slow pm call for 2.3 min.

### Other findings

- **An e2e dummy card leaked into a real card.** On the Plan board, an unrelated work card shows
  "You need: Needs the ArgoCD sync to deploy the target service before adding the pa version
  verb." It is a stored blocker verdict (`verdict: blocks`, `task_id: null`) whose reason names the
  e2e's dummy task. So the blocker pass counted an open e2e card among the owner's tasks (8.4.53).
- The job reads `failed` ("PR #72 was closed without merging") once I closed the PR, as the
  earlier e2e runs did. That is the factory's reading of a closed `pr` delivery, not a run failure.

### Defects

Verified live (notes under each in PLAN.md): 8.4.17, 8.4.18, 8.4.20 (the context set), 8.4.21,
8.4.22, 8.4.23. 8.4.19's review step runs, but it misses the blocker. Still open: 8.4.14 (3945 ms),
8.4.15 (7348 ms) and 8.4.16 (not measured; 300-334 ms by hand).

New, filed under 8.4 in PLAN.md:

1. **8.4.49** The diff fails review on the same blocker as #63 (a `cwd`-less git fallback), and
   both Kimi cycles miss it. Each cycle is one call on the diff, without the repo.
2. **8.4.50** A review with no blocker still costs a fix round ($0.45, 6.4 min), and the round
   adds line-number citations to code comments.
3. **8.4.51** The dev step spends 5.4 min before the agent's first turn (1 min more for the fix
   round).
4. **8.4.52** The tech_writer's context update is lost: written to the story's worktree, absent
   from the PR and from the checkout.
5. **8.4.53** An e2e dummy card leaks into a real card's blocker verdict on the Plan board.

### Evidence

Under `%LOCALAPPDATA%\personal-assistant\e2e\`:

- `20261108T235532Z-deepseek-pr-dry/summary.json`: the dry run.
- `20261108T235701Z-deepseek-pr/`:
  - `summary.json`: hops, 130 checks, links, cost, golden-path timeline;
  - `transcripts/`: the step sessions' tails;
  - `screenshots/{plan,build,run-smw8ipmelm,run-smw8iof06l,github-pr,ask}.png` and their `.txt`.

Under `%LOCALAPPDATA%\software-factory\state\`:

- `api_runs/dev-tools-18-dev-20261109T000553682674Z/stream.jsonl`: dev round 1, with the gate and
  the result (`total_cost_usd 0.870424`, 48 turns);
- `api_runs/dev-tools-18-dev-20261109T001849032352Z/stream.jsonl`: the fix round, with the guard
  refusal at 00:21:34.22;
- `api_runs/dev-tools-18-reviewer-20261109T001656929276Z/` and `…-reviewer-20261109T002226369179Z/`:
  the two reviews in full;
- `api_runs/dev-tools-0-pm-20261108T235718942479Z/`, `…-18-sm-…000012…`, `…-18-tech_writer-…002322…`:
  the other steps;
- `logs/0018-e2e-add-pa-version-cli-verb-with-dashboard-git-fallback.log`: the story's handler
  events (checks, baseline, reviews, delivery).

## First review, 2026-11-08

**Verdict: FAIL.** The outcome happened. A ready PR (#63) was opened through the metered DeepSeek
API runtime (`azure/deepseek-v4-pro`) and the factory delivered it (`delivered_pr`). CI was green on
its head, nothing was merged, and the job cost $1.17 of the $2 ceiling. The factory did the delivery:
the agent never pushed, opened a PR or used `--no-verify`. Four things fail:

- My code review finds a blocker. The `pa version` git fallback reads the caller's working
  directory, not the checkout's.
- The diff adds an unrequested `pa help meeting` entry, so it is out of scope.
- Two latency hops miss their targets: the tool call takes 6.7 s (3.7 s without the compose model)
  and approval to "started" about 2.9 s, both against 1 s. The board-redraw hop is not measured.
- Run's drill-down links for the factory steps point at sessiond `:7010`, which answers 404.

The stack served `c0c2a3e`. Fixes for several of these are on `main` but were not deployed yet:
002f99e (factory_start), 53e4e54 (8.4.9), e88e204 (E3 push), e2b0323 (E6.1 terminal guard) and
522345e (8.4.13). A re-run on a newer HEAD is needed (8.4).

| | |
|---|---|
| Date | 2026-11-08, 19:56-20:29Z |
| Stack | work (this Windows laptop): PA on :7300, factory serve on :7330, termhub on :7000 (sessiond :7010) |
| Commit served | `c0c2a3eca717ee61ad8ba766f1e038a7ee6c0dad` (GET /api/version) |
| Job checkout | `e00340c` (the story branch's base) |
| Job | `dev-tools:018` (card #6774, run 29, steps 55 pm, 56 sm, 57 dev, 58 tech_writer), runtime `api`, delivery `pr`, solo pipeline |
| PR | [#63](https://github.com/xvanov/dev-tools/pull/63), head `6c1051f`, closed by me after review, branch deleted |
| Reviewer | a fresh session that did not implement the workflow (D10) |
| Criteria | `architecture.json` → `examples[deepseek-pr].acceptance` |

### How it was run

1. `node bin\pa.js e2e deepseek-pr --dry-run` from the live checkout passed 21 of 21 checks: Map
   block and $2 ceiling, a local factory with a dev-tools app, the dashboard, the live feed, termhub,
   the chat tools, gh write access, and `azure/deepseek-v4-pro` accepted for the dev step.
2. `node bin\pa.js e2e deepseek-pr --keep --stack work` ran once, from 19:56:37Z for 22.5 min. This
   is the E4 golden path with `runtime: api, delivery: pr`. It adds a dummy card ("add a `pa version`
   verb", marker `e2e-95c87256-…`) and calls the chat's `factory_start`. Then it polls `job status`
   every 10 s until CI is done and checks every view's API. Every hop was reached and 79 of 79 view
   checks passed. It exits 1 on the two hop targets.
3. Outputs inspected by hand:
   - the PR's metadata, checks and diff with `gh`, as the repo owner through `GH_TOKEN`;
   - `job status` through serve's `/api/cli`, including the per-step cost;
   - the dev step's `stream.jsonl`: all 74 terminal commands, the gate, the usage events;
   - `/api/state`, `/api/commitments/6774` and `/api/factory`;
   - termhub's `/api/sessions` on :7000 and :7010, and `GET /` on both;
   - the chat's `factory_job` and `card` tools, called directly;
   - the live chat home's `.claude/settings.json`;
   - the dashboard's live feed (`/api/events`) while I closed the PR, to time a factory change
     reaching the board.
4. Cleanup:
   - `gh pr close 63 --delete-branch`, then `pa e2e --sweep`. The served sweep is the old, unscoped
     one (8.4.13). Every factory job was terminal at the time, so no other reviewer's run was
     touched. Its six "job cancelled" lines were no-ops on already-terminal jobs (see 8.4.23).
   - The sweep left card #6774 `done`, so I dropped it with `pa done 6774 --dismiss`.
   - It also left the run's own follow session (`pa#29 factory`) alive, so I killed it by id.

### Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `pr`: the PR is open and ready for review | **pass** | #63 `OPEN`, `isDraft: false`, `mergedAt: null` while kept. Story 16 `delivered_pr`, `delivery_level: pr`, job `done`, `merged: false`. The PR body is the factory's ("Delivery level `pr`: the factory will NOT merge it"). |
| `ci`: CI is green on the PR head | **pass** | Head `6c1051f`, run 42519185811: changes, personal-assistant (ubuntu, windows), contract (postgres, sqlite) and jarvisd (ubuntu, windows) all SUCCESS. Six path-filtered jobs were skipped, and CodeRabbit passed. No CI-fix cycles (limit 3). |
| `review`: an independent code review finds no blocker | **fail** | One blocker and one major issue, below. |
| `scope`: the diff stays inside what the card asked for | **fail** (minor) | The diff touches 3 files, +141/−1, all for `pa version`, except one unrequested change: `meeting: './meeting.ts'` added to `HELP_TOPICS` in `src/cli/index.ts`. The agent notes in its stream that it was not there before and adds it anyway. |

### Code review of #63

The diff is `src/cli/version.ts` (new), `test/version.test.js` (new) and `src/cli/index.ts`
(HELP line, registration, HELP_TOPICS).

- **Blocker: the git fallback reads the caller's directory.** `execFileSync('git', ['rev-parse',
  '--short', 'HEAD'], …)` has no `cwd`. `pa` is an npm bin, so it runs from anywhere. Run from
  another repo, it prints that repo's commit as `Git: <sha>`. Run outside any repo, it prints
  `Git: ` with nothing after it and exits 0. The card asked for "`git rev-parse --short HEAD` of
  the checkout". The dashboard's own `/api/version` passes `cwd: __dirname`
  (`src/dashboard/server.ts:618-619`). The verb has one job, and on this path it gives a wrong
  answer.
- **Major: the dashboard address is hardcoded.** The code fetches `http://127.0.0.1:7300/api/version`.
  The address is configuration (`config.dispatch.host`/`port`, `PA_DISPATCH_HOST`/`PA_DISPATCH_PORT`),
  and the other callers derive it from there (for example `paBase` in `e2e/goldenPath.ts`). On a
  non-default port, the verb silently takes the fallback above.
- Minor issues:
  - unused `Row` and `Json` type imports, an unused `fail`, and `any` parameters in a strict-TS file;
  - the HELP line is one column off from its neighbours;
  - neither new file ends with a newline;
  - 9 tests cover two trivial pure functions, and two "integrated" tests repeat the unit tests,
    while the fallback (the part that is wrong) is untested;
  - the PR title uses `feat(backend):` instead of the repo's `feat(personal-assistant):`.
- Fine: it follows the plugin pattern (`make(out, fail)`, `Object.assign(commands, …)`, a
  HELP_TOPICS entry), the 5 s timeouts, `windowsHide`, and output that says which source answered.

### Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: a ready PR through the metered DeepSeek API runtime, never merged | **pass** | All four steps ran with `runtime: api`, `billing: metered`. The dev step used `azure/deepseek-v4-pro`; pm and sm used DeepSeek-V4-Flash and tech_writer Kimi-K2.7-Code. PR #63 was ready and never merged. |
| Delivery is the factory's, not the agent's | **pass** | Of the dev agent's 74 terminal commands, none is `git push`, none is `gh`, and none uses `--no-verify`. Its commit `2d0d77c` ran the pre-commit hook (6 tests passed). The factory merged origin/main (`6c1051f`), pushed and opened the PR. |
| Cost ≤ $2 (job `cost_usd`) | **pass** | $1.1651: pm $0.0017, sm $0.0023, dev $1.1113, tech_writer $0.0499. The PA's compose call (azure/pa, 2954 ms) is outside the job cost. This review's total spend was this one run. |
| View: plan | **pass** (API) | `/api/state` and `/api/commitments/6774` show the chain card → run 29 → job `dev-tools:018` → steps 55-58, with models and states, → PR #63, CI passing. The card closed to `done` when the job was delivered. The harness's `plan.png` shows the board without the card (8.4.11). |
| View: build | **pass** | `/api/factory` lists the job under delivered, with cost $1.1651, PR #63 open with CI passing, the four runs, and `paRun` 29 → card 6774. `build.png` shows the card: "PR #63 · open · CI passing · $1.17 metered · card #6774 run #29". |
| View: run | **fail** | termhub :7000 lists all five sessions with E1 links: the follow session links card, run and job, and each step links job, step and story. But the links that Plan's card chain, Build and `factory_job` give for the steps are `http://127.0.0.1:7010/#session=…`, and `GET http://127.0.0.1:7010/` returns **404**: sessiond has no UI. Only the run's follow session links to :7000. Both Run screenshots and the PR screenshot are blank white pages (8.4.11). |
| View: ask | **pass** (tool level) | `factory_job {job, fresh}` returns the state, the PR, $1.17, `pa_run` 29 and every step with its session. It took 22.1 s from a cold process. `card {id: 6774}` returns the card, but its narrative still said run #29 "is still running" after the card was `done` (8.4.23). |
| Approvals: `factory_start` | **pass** (policy), not exercised | The live chat home has `defaultMode: default` and bypass disabled. Its 20 allow rules include no `factory_start` and no server-wide rule, and there is no `settings.local.json`. `verifyClaudeHome` refuses a home that would let it through. The harness calls the tool handler directly, so no prompt was shown (8.4.12). |
| E6 behaviour of the API dev on Windows | **fail** (not a rubric item) | PowerShell hung twice at a `>>` prompt on a multi-line `git commit -m`, although 73e824d's prompt rule is in the served commit. It took 20:05:02 to 20:12:38 (7.6 min, 18 model turns, $0.16 of the dev step's $1.11), 8 control inputs and 2 terminal resets. The agent wrote "Let me try the commit again with `--no-verify`", then committed with `-F` instead. There were no content-filter refusals in any step. E6.1's runtime guard (e2b0323) is not served yet. |

### Hops

Clock references: the e2e's timeline, the PA log lines in the run output, the runs'
`started_at`/`ended_at` in `job status`, and the dev stream's timestamps.

| Hop | Target | e2e | Other clock | Result |
|---|---|---|---|---|
| jarvis: tool call (card, factory_start) excluding model time | 1000 ms | **6701 ms** (includes compose) | The card was added 19:56:39.0, compose's model call ended 19:56:44.74 (2954 ms), and PA "dispatched" 19:56:45.74. That is ≈2.8 s before compose and ≈1.0 s of submit, so **≈3.7 s excluding the model**. Served code predates 002f99e. | **fail** |
| dispatcher: approval to "started" | 1000 ms | 11097 ms (10 s poll) | factory_start returned ≈19:56:45.7. The job sat `queued` ("waiting for pm-sync on the next factory tick"), and the pm step's `started_at` is 19:56:48.59: **≈2.9 s** | **fail** |
| factory-chain: dev step, gates and PR | unbounded | 1119.7 s | pm 8.8 s, then 20 s to sm (11.7 s), then 35 s to the dev step. The dev step took 15 min 36 s (19:58:04-20:13:40, 76 turns, 3.0 M input tokens of which 2.68 M cached, 14.8 k output), 7.6 min of it in the commit hang. tech_writer took 44 s. The factory saw the PR at 20:15:36. | reported |
| github: CI watch to green | unbounded, ≤ 3 CI-fix cycles | 148.1 s | Checks ran 20:15:26-20:17:51, with 0 fix cycles. The job was delivered (`done`) at 20:21:18. | pass |
| worker: state change to the board redraw | 200 ms | not measured | One hand sample: PR closed on GitHub at 20:24:37Z. The PA `run` row update reached the live feed at 20:25:01.04 (24.0 s), and the `factory_board` frame came at 20:25:08.33 (31.3 s). The factory's own `updated_at` moved only at 20:28:52, so the change cannot be timed from the factory side. This sample includes the factory noticing a GitHub change, so it is an upper bound, not the hop. | **fail** (not measured) |

From the run's start (the card came 1.5 s later): CI done at 1287 s (21.5 min), delivered at
≈1481 s.

### Evidence

Under `%LOCALAPPDATA%\personal-assistant\e2e\`:

- `20261108T195628Z-deepseek-pr-dry/summary.json`: the dry run.
- `20261108T195637Z-deepseek-pr/`:
  - `summary.json`: hops, 79 checks, links, cost, golden-path timeline;
  - `transcripts/session-{smw896t9k4,smw897flb5,smw898kq66,smw89spko7}.txt`: the tails of the
    pm, sm, dev and tech_writer sessions;
  - `screenshots/{plan,build,run-smw898kq66,run-smw89spko7,github-pr}.png`: Build is good, Plan has
    no card, and the other three are blank.

Under `%LOCALAPPDATA%\software-factory\state\api_runs\`:

- `dev-tools-16-dev-20261108T195810724563Z/stream.jsonl`: the dev step. It has the two `>>` hangs
  at 20:05-20:12, the gate event (`test_command`, `non_empty_change`, `lint` green) and the result
  (`total_cost_usd 1.111291`, 76 turns). The prompt is cut to 600 characters in the stream, so the
  full shell rules can't be read there.
- `dev-tools-0-pm-…195648…`, `dev-tools-16-sm-…195717…`, `dev-tools-16-tech_writer-…201350…`: the
  other steps.

### Defects (filed under 8.4 in PLAN.md)

1. **8.4.14** The tool call takes 6.7 s, ≈3.7 s excluding compose's model call (target 1 s). Re-measure
   with 002f99e's `timings_ms`, then cut what remains (≈1 s of submit).
2. **8.4.15** Approval to "started" is ≈2.9 s by the factory's clock (target 1 s). The job waits
   for the next tick. Same root as 8.4.9.
3. **8.4.16** The worker hop is not measured for this workflow. A factory change reached the
   board's feed 24-31 s after the PR was closed, and the factory's `updated_at` doesn't move with
   the transition.
4. **8.4.17** Step session links point at sessiond `:7010`, which serves no page (404), from Plan,
   Build and `factory_job`.
5. **8.4.18** The API dev hung PowerShell twice on a multi-line `git commit -m` (7.6 min, $0.16) on a
   commit without E6.1's guard. Re-run with e2b0323 served.
6. **8.4.19** The generated diff fails review (cwd-dependent git fallback, hardcoded :7300) and scope
   (the `meeting` HELP entry). The solo pipeline has no review step, and its gates can't catch
   either.
7. **8.4.20** Every dev-tools dev prompt opens with "NO CONTEXT AVAILABLE … You are likely the
   Onboarder persona" because the work factory has no `apps/dev-tools/context/`.
8. **8.4.21** The e2e's dummy card tells the agent to "open a draft PR", while delivery is `pr` and
   the factory forbids the agent from opening PRs.
9. **8.4.22** Map drift: the steps and the cost basis name `deepseek/deepseek-coder`, while `pa e2e`
   runs `azure/deepseek-v4-pro`. The e2e also times the jarvis hop with the compose model included.
10. **8.4.23** Stale PA state after a job ends. Run rows kept a live `factory_state` for six jobs
    that ended hours earlier (the sweep "cancelled" them), and the `card` tool said "still running"
    after the card closed.

Shared with research and not filed again: blank screenshots (8.4.11), approval not exercised
(8.4.12), cleanup leaving the follow session and the sweep being unscoped (8.4.13; fixed on
`main`, not served).
