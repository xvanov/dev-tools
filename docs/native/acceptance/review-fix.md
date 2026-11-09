# Acceptance review: `review-fix` (plan 8.3)

## Re-review, 2026-11-09

**Verdict: FAIL, on time. The outcome happened.** The factory updated the same PR in place.
Both review comments are fixed, the push is a fast-forward, the job opened no other PR,
nothing was merged, and CI on the final head is green. Cost is $0.0214, under the $0.05
ceiling (D26). Two hops miss their 1 s targets: the tool call is 4418 ms without the model,
and approval to "started" is 1793 ms. The e2e wrote `summary.json`, took its screenshots,
and cleaned up. It exited 1 for those two hops.

| | |
|---|---|
| Date | 2026-11-09, 02:08-03:32Z |
| Stack | work. `--on personal` is not a `PA_MACHINES` name (`--on personal: not in PA_MACHINES`), so the dry run and the real run were on this machine. PA `GET /api/version` is `9cd5567`. |
| Commit served | `9cd55676963b2e09580f8cb7cf45dcbfe0279f28` |
| Input | [xvanov/dev-tools#75](https://github.com/xvanov/dev-tools/pull/75), a draft PR opened as the repo owner from a worktree of this clone: branch `e2e/review-fix-dummy-20261109T0206` off `main`, adding `personal-assistant/src/util/e2eClip.ts` (two deliberate flaws) and a happy-path test. Head `be2fde6`. Closed after the run, not merged, branch deleted. |
| Job | `dev-tools:021` (PA run 33, no card), `claude_session`, delivery `pr`, pipeline `solo`, `base: {branch: e2e/review-fix-dummy-20261109T0206, pr: 75, into: main}` |
| Reviewer | a fresh session that did not implement the workflow or its fixes (D10) |
| Criteria | `architecture.json` → `examples[review-fix].acceptance` |

### The input

One `COMMENT` review (GitHub refuses "request changes" on your own PR) with two inline threads on `e2eClip.ts`:

1. Line 11: `s.slice(0, limit) + '...'` returns `limit + 3` characters and uses three ASCII dots. Cut to `limit - 1` and append one `…`, so the result is exactly `limit` long. Test `clipLabel('hello world', 5)` is `'hell…'` and 5 long, and limit 1 returns `'…'`.
2. Line 8: guard `limit`. `limit = 0` returns `'...'`, a negative limit drops characters from the end and still appends `'...'`, and `1.5` is truncated by `slice`. Throw `RangeError` unless `limit` is an integer ≥ 1, and test 0, -1 and 1.5.

### How it was run

1. `node bin/pa.js help e2e`, then `node bin/pa.js e2e review-fix --pr 75 --repo xvanov/dev-tools --dry-run --on personal`. That refused at once: `personal` is not in `PA_MACHINES`.
2. The same dry run without `--on`, on the work stack, at 02:08:42Z. **14 of 14 checks passed**, including the four PR checks (open, from the repo, 2 of 2 threads unresolved), "factory ticks app dev-tools", and "claude logged in on the factory machine". The effective ceiling read from `GET /api/workflow-limits` is $0.05.
3. The real run, once, at 02:09:00Z: `node bin/pa.js e2e review-fix --pr 75 --repo xvanov/dev-tools --stack work --report <file>`. It drove `factory_continue` through the e2e approval, waited for the job, wrote `summary.json` and four screenshots, killed the sessions, and exited 1. The PR was left open, then closed here.
4. One setup fault, separate from the product: the dummy branch was checked out in a worktree of the same clone the factory uses. The first three dev attempts (02:10-02:15Z) failed with `fatal: 'e2e/review-fix-dummy-20261109T0206' is already used by worktree`. The worktree was removed at 02:19Z. The dev step then ran. Those 11 minutes are not the product's.

### Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `updated`: the same PR is updated; no new PR, nothing merged | **pass** | Head `be2fde6` became `2db99ba`. The e2e's compare of old to new is `ahead` (+10), `behind` 0: a fast-forward, no force push. Same branch. The job's only PR is #75 (`pr_urls`). #78 opened meanwhile from another branch and was not counted (8.4.42). `mergedAt` null; the PR stayed an open draft until it was closed here. |
| `ci`: CI is green on the new head | **pass**, with a note | The e2e check is `CI SUCCESS` on `2db99ba`. The input head was not green: jarvisd's typecheck failed on `compose.ts` and `ledger.ts`, the same errors as main's push of `9cd5567` (8.4.29, 8.4.56). The personal-assistant jobs on that head passed. The final head went green only after the factory merged a later main (`6ca8e02`, the typecheck fix) at 03:21Z. The branch's own fix commit does not touch those files. |
| `review`: no blocker, and each comment is addressed or answered | **pass** | Both are fixed in `878e7d2` and still present at `2db99ba`. (1) The slice is `limit - 1` plus one `…`, and the tests check `'hell…'` at limit 5 (length 5) and `'…'` at limit 1. (2) `RangeError` unless `limit` is an integer ≥ 1, tested for 0, -1 and 1.5. The threads stay unresolved; the commit body names each. |
| `scope`: the diff stays inside the review comments | **pass**, with a note | Against `main`, the PR is only `e2eClip.ts` and its test. The fix commit touches only those two files. The factory also merged `origin/main` twice, unasked (`f16aa13` at 02:20Z, four docs files; `2db99ba` at 03:21Z, which is what carried the typecheck fix onto the branch). No review comment asked for that. The second dev session (the CI-fix, 03:22-03:25Z) pushed no commit of its own. |

### Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: the existing PR updated in place (fast-forward) so its comments are resolved, on the subscription | **pass** | Updated in place, by fast-forward, both comments fixed, delivery `pr` (not `auto_merge`). The brief says "Continues PR #75" and its stop condition is to commit onto that branch, open no new PR, and never merge (8.4.27). Compose dropped a constraint about opening a PR and a question about the comments before render. |
| Cost ≤ $0.05 | **pass** | `job status`: `cost_usd` 0.0214, `subscription_equiv_usd` 0.9634. pm $0.0021 and sm $0.0025 (DeepSeek-V4-Flash), tech_writer $0.0098 and, on the CI-fix, $0.0070 (Kimi-K2.7-Code). Both dev steps were $0 (`claude_session/claude-opus-5-5`). The equivalent is high because the dev model was Opus, twice; it is recorded, not billed (D26). |
| Approvals: `factory_continue` | **pass** (exercised) | Audit seq 7 `allow` (`approve-chat-actions`) on the e2e channel, then seq 8 `ask` (`chat-actions-ask`) for the call. |
| View: build | **pass** | `/api/factory` listed `dev-tools:021` under Needs you while CI was red, with `base {pr: 75}`, `ticked: true` (8.4.28). The screenshot is `ready: true` (devtools, waited 10163 ms). |
| View: run | **pass** | Four step sessions plus the follow session. Two run screenshots are `ready: true` (waited about 10 s each). |
| View: ask | **pass** (tool) | `factory_continue` answered `started: true`, `continues {pr: 75}`, runtime `claude_session`, delivery `pr`. |

### Hops

The e2e's numbers are from `summary.json`. The split of the tool call is the dispatch log's `ms`. Clock of the job is `job status` and the story log.

| Hop | Target | Measured | Detail | Result |
|---|---|---|---|---|
| jarvis: tool call (`factory_continue`) excluding model time | 1000 ms | **4418 ms** (wall 6811 ms, less compose's 2393 ms) | route 209, prepare 16, gather 1502, **submit 2480** (serve 2448 of it), follow 203. Was 4540 ms without the model on the previous re-review (submit 3483), and 8300 ms on the first (submit 7056). | **fail** |
| dispatcher: approval to "started" | 1000 ms | **1793 ms** from the tool's return to the pm step (02:09:11.566, `runs[].started_at`) | Serve pushed `queued` in that same second and `triaging` at 02:09:38. Was 3204 ms on the previous re-review. | **fail** |
| runtime-claude: the session fixes the comments | unbounded | **156 s** for the fixing dev step (02:21:13.531-02:23:49.558). The e2e hop is **4921970 ms** | The e2e times first `runs[].started_at` to the job's `updated_at` (02:09:11 to 03:31:13): the whole job, including the CI-fix. The second dev step (03:22:17-03:25:07, 170 s) merged main and pushed no further commit. | reported |
| github: CI watch on the new head to green | unbounded, ≤ 3 CI-fix cycles | e2e **2809 ms**, which is the poll after the job had already seen green. The checks themselves ran **03:25:59-03:28:15Z** (136 s; jarvisd on Windows finished at 03:28:15). The watch reported green at 03:31:13, **322 s** after the push (03:25:51) | 1 CI-fix cycle. The cycle could not start for 50 min (8.4.58). 0 of the cap of 3 were spent on a code change. | reported (within bounds) |
| worker: state change to the board redraw | 200 ms | **264 ms** from the story's `delivered` event (03:31:13.566) to PA's "factory runs settled from a push" (03:31:13.830). Serve's push of `done` is the same second. | The e2e still does not time this hop (`ok: null`, "measured by E3/0.4, not by this run"). The redraw in the browser was not timed. The 27.3 s poll gap from the previous re-review is gone (8.4.44). 264 ms is the settle, and it is over 200 ms. | **not measured** by the e2e; the log sample is over the target |

For D27, the numbers to reset from, on this machine, one run: tool call without the model 4418 ms (gather 1502, submit 2480 of which serve is 2448); approval to started 1793 ms; the fixing dev step 156 s; CI checks 136 s and the factory's watch 322 s from the push to "CI green" (the e2e's 2809 ms is not that watch); push to PA settle 264 ms, redraw not timed.

### Defects (filed under 8.4 in PLAN.md)

1. **8.4.26** still open. 4418 ms without the model, against 1 s. Submit alone is 2480 ms, and 2448 ms of that is factory serve.
2. **8.4.29** not ticked. The dev-tools base was not green when the job started. The final head went green only by merging a later main.
3. **8.4.58** A CI-fix cannot reclaim a worktree whose terminal is still there. Nine ticks from 02:30Z to 03:16Z failed with WinError 32. `1f99fe1` on main is that fix; this factory was not running it.

Still open and not filed again: approval to "started" is 1793 ms (the previous re-review left the same gap unfiled). Not filed again: the factory merges `main` into a PR it continues, unasked.

### Evidence

- `<PA data dir>/e2e/20261109T020842Z-review-fix-dry/summary.json` (14/14).
- `<PA data dir>/e2e/20261109T020900Z-review-fix/summary.json`, transcripts, and four screenshots, all `ready: true`.
- `dev-tools:021` direction `021-fix-the-unresolved-review-comments-on-pr-75-automated-e2e-ru` (brief, thread snapshot).
- On GitHub: PR #75 (review 5820886558, commits `878e7d2` and `2db99ba`, the closing comment). CI runs 42549199414 (input head, jarvisd red) and the final head's checks (03:25:59-03:28:15Z, success).

## Re-review, 2026-11-08

**Verdict: FAIL, on cost and time. The outcome happened.** The factory updated the same PR in
place: two commits pushed fast-forward onto [xvanov/dev-tools#66](https://github.com/xvanov/dev-tools/pull/66).
Both review comments are really fixed, CI went green on the new head, nothing was merged and
the job opened no PR. All four rubric items pass. Four things fail:

- **Cost: $0.0271 against $0.** Only the dev step ran on the subscription (Claude Code on Haiku:
  $0, $0.0131 API-equivalent). The pm and sm steps (DeepSeek-V4-Flash) and tech_writer
  (Kimi-K2.7-Code) ran metered on the API, as JOBS-API v1.2 says a `claude_session` job does.
  The Map promises `cost_usd 0`.
- **The tool call takes 4.5 s without the model**, against 1 s. Submit alone took 3.5 s, down
  from 7.1 s.
- **Approval to "started" takes 3.2 s** from the tool's return to the first step, against 1 s.
  From the approval itself it is 13.5 s.
- **The e2e real run died silently.** It hung on the Build screenshot, then exited 0 with no
  summary, no report and no cleanup. Six sessions were left alive, and the laptop's `--on` side
  would have polled for its whole timeout. Every number below is read by hand from the logs,
  the job and GitHub.

| | |
|---|---|
| Date | 2026-11-08, 22:38-22:56Z |
| Stack | personal (the personal machine, Linux): PA on :7300, factory serve on :7330, its termhub |
| Commit served | `b674e67702646f867d348f27c603432926f5ff0f` (GET /api/version; the checkout is clean at `main...origin/main`). It includes 8.4.24-8.4.28 (23ec085, 5f19b68, 7f7baa9, 0e6b5a0, 3883b97, 744bc37) |
| Input | [xvanov/dev-tools#66](https://github.com/xvanov/dev-tools/pull/66), a draft PR I opened as the repo owner from a scratch clone: branch `e2e/review-fix-dummy-20261108T2238` off `main` (997cdea), adding `personal-assistant/src/util/ellipsize.ts` (two deliberate flaws) and a happy-path test. Head `96aad93`, CI green on it (run 42531278091). Two inline review threads (below). Closed by me after the run, not merged, branch deleted. |
| Job | `dev-tools:007` (PA run 8, no card, story 201, follow session `smw8f1wn03`), `claude_session`, delivery `pr`, pipeline `solo`, `base: {branch: e2e/review-fix-dummy-20261108T2238, pr: 66, into: main}` |
| Reviewer | a fresh session that did not implement the workflow or its fixes (D10) |
| Criteria | `architecture.json` → `examples[review-fix].acceptance` |

### The input

One `COMMENT` review (GitHub refuses "request changes" on your own PR) with two inline threads
on `ellipsize.ts`:

1. Line 10: `text.slice(0, limit) + '…'` returns `limit + 1` characters. Cut to `limit - 1` so
   the result is exactly `limit` long, and test the length on long text.
2. Line 8: guard `limit`. `limit = 0` returns `'…'`, and a negative limit slices from the end.
   Throw a `RangeError` unless `limit` is an integer ≥ 1, with a test.

### How it was run

1. `node bin\pa.js e2e review-fix --on <the personal machine> --pr 66 --repo xvanov/dev-tools
   --dry-run`, from the laptop's live checkout (at `cba272a` by then, so it has 744bc37). `--on`
   now runs it on the personal machine: the evidence folder is there. **14 of 15 checks
   passed.** They include the four new PR checks (it exists, is open, is from the repo, 2 of 2
   threads unresolved) and "factory ticks app dev-tools". The one failure is "claude logged in on
   the factory machine": `spawn claude ENOENT`. termhub's exec runs with a PATH that lacks
   `~/.local/bin`, which is where `claude` is. By its full path it is logged in (`claude.ai`), and
   factory serve's unit has `~/.local/bin` on its PATH. So the check is wrong, not the machine
   (8.4.43).
2. The real run, once, at 22:40:43Z: the same flags without `--dry-run`. `--on` started
   `pa e2e review-fix --pr 66 --repo xvanov/dev-tools --report <file>` in a termhub session on the
   personal machine. The driver answered the approval on the `e2e` channel, called
   `factory_continue {repo, pr: 66, delivery: pr, ask}`, and polled the job.
3. The job was `done` at 22:45:22.9. The driver saved the four step transcripts at 22:45:56 and
   went on to the screenshots. It never came back. The session returned to its prompt with exit
   0, and there was no `summary.json`, no report file and no cleanup. I stopped the laptop's
   poller. Calling `screens.capture` alone for Build on the personal machine reproduced it: after
   63 s Node exited 0 with the promise still pending (8.4.40). I did not run it a second time.
   This is a driver defect, not an infrastructure failure, and a second run would put another
   job on a PR whose outcome was already in.
4. Outputs inspected by hand:
   - the PR's head, commits, compare, checks and the repo's PR list, with `gh`;
   - `job status` through serve's `/api/cli`, and serve's and pa-worker's journals;
   - `pa audit tail --tool factory_continue`;
   - `/api/factory`, `/api/state`, and the `factory_job` tool through the e2e's `chatCall`;
   - termhub's sessions, then a GET of each link;
   - the direction folder and the step transcripts.
5. Cleanup:
   - killed the six sessions (the runner, the follow, pm, sm, dev and tech_writer). termhub
     lists none now;
   - `gh pr close 66 --delete-branch` (the branch now 404s);
   - the job was already terminal. Run 8 has no card, so there was none to drop.

   The story's worktree on the personal machine belongs to the factory, and I left it.

### Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `updated`: the same PR is updated; no new PR, nothing merged | **pass** | Head `96aad93` became `0774c0b`. GitHub's compare of old to new is `ahead` by 4, `behind` 0: a fast-forward, no force push. Same branch. The job's only PR is #66 (`pr_urls`). The repo's newest PR did become #69, at 22:45:13Z, but the work stack's factory opened it (a story-65 branch), not this job; the driver's check would have failed on it (8.4.42). `mergedAt: null`; the PR stayed an open draft until I closed it. |
| `ci`: CI is green on the new head | **pass** | Run 42531585127 on `0774c0b`: success, 22:42:43-22:45:14Z, 0 CI-fix cycles. |
| `review`: no blocker, and each comment is addressed or answered | **pass** | Both are fixed in `0774c0b`. (1) The slice is now `limit - 1`, and new tests check that `ellipsize('hello world', 5)` is `'hell…'`, 5 long, and that limit 1 gives `'…'`. (2) A `RangeError` unless `limit` is an integer ≥ 1, with tests for 0, -1 and 1.5. No blocker. A nit: `typeof limit !== 'number'` is redundant under the type. The threads stay unresolved, with no reply on them; the commit body says what was done for each. |
| `scope`: the diff stays inside the review comments | **pass**, with a note | `0774c0b` touches only `ellipsize.ts` and its test, and the PR's diff against `main` is those two files. Before the fix, though, the factory merged `origin/main` into the branch (`ac0e9a9`: main's `cba272a` and `0df69a3`, 13 files). No comment asked for that. |

### Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: the existing PR updated in place (fast-forward) so its comments are resolved, on the subscription | **partial** | Updated in place, by fast-forward, with both comments fixed. Not all of it on the subscription (next row). The brief is right this time (8.4.27): it says "Continues PR #66", and its stop condition is "Commit onto PR #66's branch … Open no new pull request … never merge it". |
| Cost ≤ $0 (subscription) | **fail** | `job status`: `cost_usd 0.0271`, `subscription_equiv_usd 0.0131`. That is pm $0.0016 and sm $0.0020 (azure/DeepSeek-V4-Flash, metered), and tech_writer $0.0236 (azure/Kimi-K2.7-Code, metered). The dev step was $0 (`claude_session/claude-haiku-5-5`, subscription). PA's compose call (claude-sonnet-5-5 through the subscription, 5.6 s) is outside the job. tech_writer's spec landed nowhere in the PR. |
| Approvals: `factory_continue` | **pass** (exercised) | Policy `ask` (`chat-actions-ask`). The e2e's answer was audited at 22:40:47.217 (channel `e2e`, `allow`, `approve-chat-actions`, subject `e2e-c2af3a4a-…:factory_continue`), then the chat call at 22:40:47.334 (channel `chat`, `ask`). The answer is the harness's, not the dashboard card's. |
| View: build | **pass** (API), no screenshot | `/api/factory` lists `dev-tools:007` under delivered, with `base {pr: 66}` (8.4.28), `ticked: true`, story `delivered_pr` with PR #66 open and CI passing, the cost, and four runs with session links. The screenshot hangs (8.4.40). |
| View: run | **pass** (API) | termhub listed the four step sessions (`factory <persona> · dev-tools:007 …`) and the follow session `pa#8 factory · Fix the unresolved review comments on PR …`. Each link answers 200 with the termhub page. The follow session's log has the story's path: CI watch started 22:42:39, delivered 22:45:22 ("CI green on PR #66"), job done seen 22:45:48. |
| View: ask | **pass** (tool level) | `factory_job {job: dev-tools:007, fresh: true}` answers in 3757 ms with the state, `continues {branch, pr: 66}`, `pa_run` 8, each run with its runtime, billing and session link. Once I had closed the PR, it reports the done job as `failed` ("PR #66 was closed without merging"). |

### Hops

Clock references: PA's log line in the runner session (`ms`), the audit rows, `job status`,
serve's and pa-worker's journals, and GitHub's run times.

| Hop | Target | Measured | Detail | Result |
|---|---|---|---|---|
| jarvis: tool call (`factory_continue`) excluding model time | 1000 ms | **4540 ms** (10144 ms from the audited call to PA's "dispatched" line, less compose's 5604 ms) | `ms`: route 101, prepare 4, gather 932, brief 6538 (5604 of it the model), **submit 3483**, follow 12. Submit took 7056 ms in the first review (8.4.26). | **fail** |
| dispatcher: approval to "started" | 1000 ms | **3204 ms** from the tool's return (22:40:57.478) to the pm step starting (22:41:00.682) | 13465 ms from the approval (22:40:47.217). The submit woke a tick 372 ms after the return (serve: `push: dev-tools:007=queued` at 22:40:57.689, `tick dev-tools started (wake)` at 22:40:57.850). The job left `queued` at 22:41:08.0 (10.5 s) and was `in_progress` at 22:41:09.3. | **fail** |
| runtime-claude: the session fixes the comments | unbounded | **32.8 s** for the dev step (22:41:29.306-22:42:02.124) | Claude Code on Haiku, 8 turns, tests written first. The whole job ran 262 s from the pm step's start to delivery (22:45:22.9). | reported |
| github: CI watch on the new head to green | unbounded, ≤ 3 CI-fix cycles | **151 s** of CI (22:42:43-22:45:14Z); 163 s from the watch's start to delivery | 0 CI-fix cycles. | reported (within bounds) |
| worker: state change to the board redraw | 200 ms | not measured | The driver died before it could (and it does not time this hop: 8.4.10, 8.4.16). One sample from the logs: serve's push at the job's end, 22:45:23.099, says `in_progress`, and pa-worker logged "factory runs updated … ended: 1" and raised "Factory run #8: done" at 22:45:50.209, **27.3 s** after the job's `done` (8.4.44). Whether Build redrew at the push was not timed. | **fail** (not measured) |

### Defects (filed under 8.4 in PLAN.md)

1. **8.4.40** The e2e real run dies silently in the screenshot step: `screens.capture` never
   settles on Build, and Node exits 0 with no summary, no report and no cleanup. `--on` then
   polls for the whole timeout.
2. **8.4.41** A `claude_session` job is not free: pm, sm and tech_writer run metered on the API
   ($0.0271 here). The Map's cost of $0 ("Billed to the subscription: cost_usd 0") cannot pass.
3. **8.4.42** The driver's "no new PR" check fails whenever anyone opens a PR in the repo during
   the run. dev-tools has two factories.
4. **8.4.43** The dry run's claude check fails over `--on`: termhub's exec PATH lacks
   `~/.local/bin`.
5. **8.4.44** The job's end is not pushed. Serve's last push says `in_progress`, and PA's run row
   and "done" notification follow from its poll, 27.3 s later.

Still open and not filed again: the tool call is over 1 s (8.4.26), and approval to "started"
waits for the first step (8.4.15's wake now fires in 372 ms; the 3.2 s is the tick's own triage
and pm-sync). Not filed: the factory merges `main` into a PR it continues, unasked (scope note
above), and the closed PR turns the done job into `failed` in `factory_job`.

### Evidence

On the personal machine:

- `~/.local/share/personal-assistant/e2e/20261108T223924Z-review-fix-dry/summary.json`: the dry
  run (14/15).
- `~/.local/share/personal-assistant/e2e/20261108T224043Z-review-fix/transcripts/`: the four
  step transcripts the real run saved before it died. There is no `summary.json`.
- `~/dev-tools/software-factory/apps/dev-tools/directions/007-fix-the-unresolved-review-comments-on-pr-66-automated-e2e-ru/`
  holds the composed brief (`direction.md`), the thread snapshot (`artifacts/pr_review_threads.md`)
  and `state.yaml`.
- `journalctl --user -u factory-serve` and `-u pa-worker`, 22:40-22:46Z.

On GitHub: PR #66 (review 5819987167, commits `ac0e9a9` and `0774c0b`, the closing comment), CI
runs 42531278091 (input head) and 42531585127 (new head).

## First review, 2026-11-08

**Verdict: FAIL.** The outcome did not happen: the PR was not updated. The PA side worked up to
the factory. The approval was asked and audited. `factory_continue {repo, pr, ask}` submitted a
`claude_session` job that continues the PR's own branch (delivery `draft_pr`), and the factory put
both review threads into the dev's brief. Then the job sat `queued` ("waiting for pm-sync on the
next factory tick") until I cancelled it 5.7 min later. On the personal machine, factory serve
ticks only the apps with `serve_tick: true` (dev-tools, factory, template-probe), and nothing else
ticks `sacrifice`. A job for that app never starts, and nothing says so: not the dry run, not the
submit, not Build.

Two more things fail before that wall:

- The tool call takes 14.2 s, or 8.3 s without compose's model, against 1 s. The factory submit
  alone took 7.1 s.
- `pa e2e review-fix` has no real-run driver. `--on` is ignored for any workflow, so the run had
  to be driven by hand on the personal machine.

Also, sacrifice's `main` is red today (three date-rotted tests), so `ci` could not have passed on
any new head.

| | |
|---|---|
| Date | 2026-11-08, 21:20-21:30Z |
| Stack | personal (the personal machine, Linux): PA on :7300, factory serve on :7330, its termhub |
| Commit served | `2fb3715fafb7339a638561b1c52553cb7bd7f7c0` (GET /api/version; the checkout is clean at `main...origin/main`) |
| Input | [xvanov/sacrifice#418](https://github.com/xvanov/sacrifice/pull/418), a draft PR I opened as the repo owner: `backend/app/core/text.py` (`truncate()`, two deliberate flaws) and a happy-path test. Head `772ebd1`, with two inline review threads (below). Closed by me after the run, not merged, branch deleted. |
| Job | `sacrifice:131` (PA run 7, no card, follow session `smw8c9ca01`), `claude_session`, delivery `draft_pr`, pipeline `solo`, `base: {branch: chore/truncate-helper-review-fix-e2e, pr: 418, into: main}` |
| Reviewer | a fresh session that did not implement the workflow (D10) |
| Criteria | `architecture.json` → `examples[review-fix].acceptance` |

### The input

Two inline review comments on `text.py` (posted as one `COMMENT` review, since GitHub refuses
"request changes" on your own PR):

1. Line 10: `text[:limit] + "…"` returns `limit + 1` characters. Cut to `limit - 1` and add a
   long-text test.
2. Line 6: guard `limit`. `limit = 0` returns `"…"` and a negative limit slices from the end.
   Raise `ValueError` for `limit < 1`, with a test.

Both are inline review threads on purpose: the factory reads only unresolved review threads at
submit (`factory/jobs/pickup.py`, GraphQL `reviewThreads`). PR issue comments are not read.

### How it was run

1. `node bin\pa.js e2e review-fix --on <the personal machine> --pr 418 --repo xvanov/sacrifice --dry-run`, from
   the laptop's live checkout as instructed, **ran on the work stack, not the personal one**. The
   evidence folder is the laptop's, and its one failure is "factory app for xvanov/sacrifice (not
   registered)" against the laptop's factory. `cli/e2e.ts` sends any named workflow to
   `workflows.main`, which never reads `o.on`. Only the golden path (`goldenPath.main`) calls
   `remote()`. Even there, `remoteArgv` would drop the workflow name.
2. The same dry run went directly on the personal machine (termhub `/api/exec`, `--stack personal`)
   and passed **9 of 9 checks**: Map block, $0 ceiling, a local factory with a `sacrifice` app,
   `/api/factory`, claude logged in on the subscription, the `factory_continue` tool, and the policy
   asking for it. It does not look at the PR, or at whether anything ticks the app.
3. The real `pa e2e review-fix --pr 418 --repo xvanov/sacrifice` on the personal machine exits 1
   in 0.1 s: "a real review-fix run is not automated yet … 8.3's reviewer drives it by hand". No
   runner is registered (`RUNNERS` has whats-on, research and deepseek-pr).
4. So I drove the Map's step by hand, once, on the personal machine. A throwaway script in
   `/tmp` (removed afterwards) used the e2e's own helpers. `goldenPath.answerPrompt` asks the
   policy as the chat's hook does and answers on the `e2e` channel as `pa-e2e`. Then
   `goldenPath.chatCall('factory_continue', {repo: 'xvanov/sacrifice', pr: 418, ask: 'Fix the
   review comments on PR 418.'})`, which is the Map's `say` with no delivery or runtime given. A
   read-only `previewDelivery` before it resolved the delivery to `draft_pr` (PA's fallback), so
   the call could not merge.
5. I polled `job status` through serve's `/api/cli` every 5 s. When it stayed `queued`, I read
   serve's journal, the app configs and the timers to find out why. I watched the 21:25:58
   interval tick skip sacrifice, then cancelled the job (`job cancel`) with PA's `/api/events`
   open, to time one state change reaching the feed.
6. Outputs inspected by hand:
   - the PR's head, commits, checks and the repo's PR list, with `gh`;
   - the direction folder (`direction.md`, `artifacts/pr_review_threads.md`, `state.yaml`);
   - `audit_log` rows for `factory_continue`;
   - `/api/factory`, the `factory_job` tool, and termhub's `/api/sessions`, then a GET of each
     follow link.
7. Cleanup:
   - `job cancel sacrifice:131`; PA's run 7 went to `dropped`, `factory_state: cancelled`;
   - killed the follow session, which was still alive after the cancel;
   - `gh pr close 418 --delete-branch` (the branch now 404s).

   No second run: sacrifice would hit the same wall. Making it pass needs a factory config
   change on the personal machine, which this review may not make. A hand `factory tick` for
   sacrifice would also act on that app's own old state, and its delivery default is
   `auto_merge`.

### Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `updated`: the same PR is updated; no new PR, nothing merged | **fail** | Head `772ebd1` before and after, one commit, no push of any kind. No new PR (#418 stays the newest in the repo), `mergedAt: null`. The job never left `queued`: no stories, no runs. |
| `ci`: CI is green on the new head | **fail** (not reached) | No new head. On the input head: lint, typecheck and smoke passed, and pytest failed **3 of 1597** in `tests/test_chat_criteria_coercion.py`, which expects `2026-08-15T18:00:00-04:00` and gets today's date. My two new tests passed. `main`'s head `2d676e6` was green on 15 August, so these tests have date-rotted since, and no sacrifice PR can be green today. |
| `review`: no blocker, and each comment is addressed or answered | **fail** (not reached) | No diff to review. Both threads did reach the dev's brief verbatim (`artifacts/pr_review_threads.md` and the "Unresolved review comments" section of `direction.md`), and are still unresolved on GitHub. |
| `scope`: the diff stays inside the review comments | n/a (not reached) | No diff. The brief's constraints do say to keep to the comments. |

### Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: the existing PR updated in place (fast-forward) so its comments are resolved, on the subscription | **fail** | Not updated (above). The submit was right: `base {branch, pr: 418, into: main}`, runtime `claude_session`, and the brief says "the factory commits onto that branch and updates that PR (it opens no new one)". |
| Cost ≤ $0 (subscription) | **pass** (vacuous) | `job status`: `cost_usd 0.0`, `subscription_equiv_usd 0`. Nothing ran. PA's compose call (claude-sonnet-5-5 through the subscription, 5.9 s) is outside the job. |
| Approvals: `factory_continue` | **pass** (exercised) | Policy `ask` (`chat-actions-ask`). The e2e answer was audited at 21:22:31.208 (channel `e2e`, `allow`, `approve-chat-actions`, subject `e2e-5332ff9c-…:factory_continue`), and then the chat call at 21:22:31.328 (channel `chat`, action `call`, actor `pa-e2e`). The answer is the harness's, not the dashboard card's. |
| View: build | **partial** (API) | `/api/factory` lists `sacrifice:131` with `paRun` 7 and its follow link. But it is in the **running** group while queued for an app nothing ticks, and with `base: null`, `prs: null`: the board doesn't say which PR the job continues, though `job status` has it. Not screenshotted (no runner). |
| View: run | **pass** (API) | The personal termhub lists `smw8c9ca01` "pa#7 factory · Fix the review comments on PR 418." (`factory job follow sacrifice:131`) with links run 7 and job `sacrifice:131`. Both forms of its link answer 200 with the termhub page: the HTTPS front that `factory_continue` returned, and the `:7000` base that Build and `factory_job` give. No step sessions existed. |
| View: ask | **pass** (tool level) | `factory_job {job: sacrifice:131, fresh: true}` returns the state, `continues {branch, pr: 418}`, `pa_run` 7, `delivery draft_pr`, the follow link and `can_cancel`, in one call. |

### Hops

Clock references: the driver's own timestamps, PA's log line (`timings_ms`), `job status`,
serve's journal and PA's `/api/events`.

| Hop | Target | Measured | Detail | Result |
|---|---|---|---|---|
| jarvis: tool call (`factory_continue`) excluding model time | 1000 ms | **8279 ms** (14166 ms round trip less compose's 5887 ms) | `timings_ms`: route 2, prepare 4, gather 1072, compose_model 5887, **submit 7056**, follow 16. The approval itself took 176 ms. A continuation's submit asks GitHub for the PR and its review threads, and that is most of the 7 s. | **fail** |
| dispatcher: approval to "started" | 1000 ms | **never** | The job was created at 21:22:45.43 and was still `queued` at the cancel, 21:28:25.25 (340 s). Serve's interval ticks at 21:25:58 (and 21:20:57 before) ran dev-tools, factory and template-probe only. `apps/sacrifice/config.yaml` has no `serve_tick`, and no timer or cron ticks it. The submit also woke no tick (serve logged only `push: sacrifice:131=queued`; 8.4.15). | **fail** |
| runtime-claude: the session fixes the comments | unbounded | not reached | | — |
| github: CI watch on the new head to green | unbounded, ≤ 3 CI-fix cycles | not reached | The base is red regardless (above). | — |
| worker: state change to the board redraw | 200 ms | not measured by any run | One hand sample at the cancel. `job cancel` returned at 21:28:25.290, and `factory_board` and `push` events reached PA's `/api/events` at 21:28:25.481 (**191 ms**; 263 ms after the call was issued). The run row update followed at 21:28:28.793 (3.5 s). The board's redraw after the event was not timed. Much faster than research's 6-7 s, with E3 push served. | **fail** (not measured) |

### Evidence

On the personal machine:

- `~/.local/share/personal-assistant/e2e/20261108T212146Z-review-fix-dry/summary.json`: the dry
  run (9/9).
- `~/.local/share/personal-assistant/e2e/20261108T212153Z-review-fix/summary.json`: the real
  run's "not automated yet".
- `~/dev-tools/software-factory/apps/sacrifice/directions/131-fix-the-review-comments-on-pr-418/`
  has the composed brief with the factory's continuation and review-thread sections
  (`direction.md`), the thread snapshot (`artifacts/pr_review_threads.md`), the verbatim ask
  (`artifacts/ask.md`) and `state.yaml`.
- `journalctl --user -u factory-serve`, 21:15-21:30Z: the interval ticks without sacrifice, and
  the push lines for `sacrifice:131`.

On the laptop: `%LOCALAPPDATA%\personal-assistant\e2e\20261108T212129Z-review-fix-dry\` is the
`--on` dry run that ran locally. On GitHub: PR #418's review, its CI run 42524759452 and the
closing comment.

### Defects (filed under 8.4 in PLAN.md)

1. **8.4.24** The personal factory never ticks `sacrifice`. The job is accepted and stays `queued`
   forever, saying "waiting for pm-sync on the next factory tick", while the dry run passes and
   Build shows it as running.
2. **8.4.25** `pa e2e review-fix` has no real-run driver, `--on` is ignored for every workflow,
   and the dry run does not check the PR.
3. **8.4.26** The tool call takes 8.3 s without the model (target 1 s), 7.1 s of it the factory
   submit of a continuation.
4. **8.4.27** The composed brief contradicts the continuation. Its stop condition says "Push and
   open a DRAFT pull request", and it states that the request "gives no detail about what the
   comments say", because compose runs before the factory reads the threads.
5. **8.4.28** Build shows a continuation without its PR (`base: null`), and groups a job that
   cannot start under running.
6. **8.4.29** sacrifice's `main` is red today: three date-rotted tests in
   `test_chat_criteria_coercion.py`. The `ci` criterion cannot pass on any sacrifice PR, and a
   CI-fix cycle would chase tests outside the comments' scope.

Shared and not filed again: approval to "started" waits for a tick, since the submit wakes none
(8.4.15). The worker hop is not measured by the e2e (8.4.10, 8.4.16).
