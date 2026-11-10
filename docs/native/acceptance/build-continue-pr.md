# Acceptance review: `build-continue-pr` (D30)

## Re-walk, 2026-11-10 (after the start-latency fix, serving `077efc0`)

**Verdict: PASS.** Run via `pa e2e build-continue-pr` (evidence in the PA data dir, e2e folder). The runner seeded its own draft PR (#92) with a review comment through the GitHub API; run 13, haiku, continued it. PR closed and both branches deleted at the end, never merged.

| Check | Result |
|---|---|
| Same PR updated by fast-forward (compare: ahead) | pass |
| No new PR, nothing merged | pass |
| A reply is on the PR | pass |
| Scope: the probe file, 1 change | pass |
| CI green on the new head | pass |
| Cost | $0.067 notional (cap $0.50), pass |
| Dispatcher: POST /api/build/runs | **3.0 s** (was 53.0 s; target 30 s), pass |
| First agent tool call after build_start | 10.1 s |
| Agent, start to done | 41.5 s |
| GET /api/build | 16 ms |

## Earlier review, 2026-11-10 (superseded: FAIL on red CI and a 55 s start)

**Verdict: FAIL.** The outcome happened: a second haiku Build agent addressed a review comment on the existing draft PR, pushed fast-forward, opened no new PR and merged nothing. Two criteria miss: CI on the new head is red (inherited from main) and the start hop took 53 s against 30 s.

| | |
|---|---|
| Date | 2026-11-10, 19:14-19:17Z |
| Stack | work. Serving commit `3b28b1d` |
| Input | PR xvanov/dev-tools#89, the draft opened by run 6 (see `build-pr.md`), plus a comment left as xvanov (`GH_TOKEN=$(gh auth token -u xvanov) gh pr comment`): the last line of `keep-awake/README.md` should gain the word "reviewed". |
| Started by | `POST /api/build/runs`, haiku, repo `C:\repos\dev-tools`, task "continue PR 89: read its review comment, check out its branch, push fast-forward, open no new PR, reply on the PR" |
| Run | build_run 8. PR #89 closed after the run, both branches deleted, not merged |

### Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `updated` | **pass** | The head moved `012ace4` to `52757de`; `merge-base --is-ancestor` old head to new is true (fast-forward). #89 stayed the only open PR; `mergedAt` null. |
| `ci` | **fail** | Same red as main: TypeScript errors in `heartbeat.ts` / `cards.ts` fail both `jarvisd` jobs and `personal-assistant (ubuntu)`; `personal-assistant (windows)` and the contract job passed. |
| `addressed` | **pass** | Commit "mark acceptance probe line as reviewed" and a reply comment "Added the word "reviewed" ... (commit 52757de)". The line now reads `build-pr 2026-11-10 reviewed`: the comment's quoted text dropped the date, the agent kept it and followed "add the word reviewed". |
| `scope` | **pass** | One line of one file. |

### Hops and cost

| Hop | Target | Measured | Result |
|---|---|---|---|
| dispatcher: build_start to session running | 30 s | 53.0 s | **fail** |
| build-agent: fix, push, reply | unbounded | 153 s total (19:14:45 to 19:17:18), 13 tool calls | n/a |
| github: CI | unbounded | red | n/a |
| dashboard: GET /api/build | 500 ms | 18-29 ms | pass |
| Cost | $0.50 | $0.192 notional | pass |

### Notes

There is no continue verb: the task text names the PR. The agent checked out the PR branch in its own worktree (detached HEAD) and pushed to it. Chat approval and Plan chip not walked (dashboard API start). The worktrees `build-6` and `build-8` could not be removed (Permission denied while their sessions were alive); branches are deleted.
