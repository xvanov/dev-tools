# Acceptance review: `review-fix` (plan 8.3)

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

## The input

Two inline review comments on `text.py` (posted as one `COMMENT` review, since GitHub refuses
"request changes" on your own PR):

1. Line 10: `text[:limit] + "…"` returns `limit + 1` characters. Cut to `limit - 1` and add a
   long-text test.
2. Line 6: guard `limit`. `limit = 0` returns `"…"` and a negative limit slices from the end.
   Raise `ValueError` for `limit < 1`, with a test.

Both are inline review threads on purpose: the factory reads only unresolved review threads at
submit (`factory/jobs/pickup.py`, GraphQL `reviewThreads`). PR issue comments are not read.

## How it was run

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

## Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `updated`: the same PR is updated; no new PR, nothing merged | **fail** | Head `772ebd1` before and after, one commit, no push of any kind. No new PR (#418 stays the newest in the repo), `mergedAt: null`. The job never left `queued`: no stories, no runs. |
| `ci`: CI is green on the new head | **fail** (not reached) | No new head. On the input head: lint, typecheck and smoke passed, and pytest failed **3 of 1597** in `tests/test_chat_criteria_coercion.py`, which expects `2026-08-15T18:00:00-04:00` and gets today's date. My two new tests passed. `main`'s head `2d676e6` was green on 15 August, so these tests have date-rotted since, and no sacrifice PR can be green today. |
| `review`: no blocker, and each comment is addressed or answered | **fail** (not reached) | No diff to review. Both threads did reach the dev's brief verbatim (`artifacts/pr_review_threads.md` and the "Unresolved review comments" section of `direction.md`), and are still unresolved on GitHub. |
| `scope`: the diff stays inside the review comments | n/a (not reached) | No diff. The brief's constraints do say to keep to the comments. |

## Other acceptance items

| Item | Result | Evidence |
|---|---|---|
| Outcome: the existing PR updated in place (fast-forward) so its comments are resolved, on the subscription | **fail** | Not updated (above). The submit was right: `base {branch, pr: 418, into: main}`, runtime `claude_session`, and the brief says "the factory commits onto that branch and updates that PR (it opens no new one)". |
| Cost ≤ $0 (subscription) | **pass** (vacuous) | `job status`: `cost_usd 0.0`, `subscription_equiv_usd 0`. Nothing ran. PA's compose call (claude-sonnet-5-5 through the subscription, 5.9 s) is outside the job. |
| Approvals: `factory_continue` | **pass** (exercised) | Policy `ask` (`chat-actions-ask`). The e2e answer was audited at 21:22:31.208 (channel `e2e`, `allow`, `approve-chat-actions`, subject `e2e-5332ff9c-…:factory_continue`), and then the chat call at 21:22:31.328 (channel `chat`, action `call`, actor `pa-e2e`). The answer is the harness's, not the dashboard card's. |
| View: build | **partial** (API) | `/api/factory` lists `sacrifice:131` with `paRun` 7 and its follow link. But it is in the **running** group while queued for an app nothing ticks, and with `base: null`, `prs: null`: the board doesn't say which PR the job continues, though `job status` has it. Not screenshotted (no runner). |
| View: run | **pass** (API) | The personal termhub lists `smw8c9ca01` "pa#7 factory · Fix the review comments on PR 418." (`factory job follow sacrifice:131`) with links run 7 and job `sacrifice:131`. Both forms of its link answer 200 with the termhub page: the HTTPS front that `factory_continue` returned, and the `:7000` base that Build and `factory_job` give. No step sessions existed. |
| View: ask | **pass** (tool level) | `factory_job {job: sacrifice:131, fresh: true}` returns the state, `continues {branch, pr: 418}`, `pa_run` 7, `delivery draft_pr`, the follow link and `can_cancel`, in one call. |

## Hops

Clock references: the driver's own timestamps, PA's log line (`timings_ms`), `job status`,
serve's journal and PA's `/api/events`.

| Hop | Target | Measured | Detail | Result |
|---|---|---|---|---|
| jarvis: tool call (`factory_continue`) excluding model time | 1000 ms | **8279 ms** (14166 ms round trip less compose's 5887 ms) | `timings_ms`: route 2, prepare 4, gather 1072, compose_model 5887, **submit 7056**, follow 16. The approval itself took 176 ms. A continuation's submit asks GitHub for the PR and its review threads, and that is most of the 7 s. | **fail** |
| dispatcher: approval to "started" | 1000 ms | **never** | The job was created at 21:22:45.43 and was still `queued` at the cancel, 21:28:25.25 (340 s). Serve's interval ticks at 21:25:58 (and 21:20:57 before) ran dev-tools, factory and template-probe only. `apps/sacrifice/config.yaml` has no `serve_tick`, and no timer or cron ticks it. The submit also woke no tick (serve logged only `push: sacrifice:131=queued`; 8.4.15). | **fail** |
| runtime-claude: the session fixes the comments | unbounded | not reached | | — |
| github: CI watch on the new head to green | unbounded, ≤ 3 CI-fix cycles | not reached | The base is red regardless (above). | — |
| worker: state change to the board redraw | 200 ms | not measured by any run | One hand sample at the cancel. `job cancel` returned at 21:28:25.290, and `factory_board` and `push` events reached PA's `/api/events` at 21:28:25.481 (**191 ms**; 263 ms after the call was issued). The run row update followed at 21:28:28.793 (3.5 s). The board's redraw after the event was not timed. Much faster than research's 6-7 s, with E3 push served. | **fail** (not measured) |

## Evidence

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

## Defects (filed under 8.4 in PLAN.md)

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
