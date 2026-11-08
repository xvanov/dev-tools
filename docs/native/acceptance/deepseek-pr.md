# Acceptance review: `deepseek-pr` (plan 8.3)

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

## How it was run

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

## Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `pr`: the PR is open and ready for review | **pass** | #63 `OPEN`, `isDraft: false`, `mergedAt: null` while kept. Story 16 `delivered_pr`, `delivery_level: pr`, job `done`, `merged: false`. The PR body is the factory's ("Delivery level `pr`: the factory will NOT merge it"). |
| `ci`: CI is green on the PR head | **pass** | Head `6c1051f`, run 42519185811: changes, personal-assistant (ubuntu, windows), contract (postgres, sqlite) and jarvisd (ubuntu, windows) all SUCCESS. Six path-filtered jobs were skipped, and CodeRabbit passed. No CI-fix cycles (limit 3). |
| `review`: an independent code review finds no blocker | **fail** | One blocker and one major issue, below. |
| `scope`: the diff stays inside what the card asked for | **fail** (minor) | The diff touches 3 files, +141/−1, all for `pa version`, except one unrequested change: `meeting: './meeting.ts'` added to `HELP_TOPICS` in `src/cli/index.ts`. The agent notes in its stream that it was not there before and adds it anyway. |

## Code review of #63

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

## Other acceptance items

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

## Hops

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

## Evidence

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

## Defects (filed under 8.4 in PLAN.md)

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
