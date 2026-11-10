# Acceptance review: `build-pr` (D30)

## Review, 2026-11-10

**Verdict: FAIL.** The outcome happened: one haiku Build agent opened a draft PR with the one-line change and ended the run `done` with the PR URL. Two criteria miss. CI on the PR head is red (inherited from main, see below), and the start hop took 55 s against a 30 s target.

| | |
|---|---|
| Date | 2026-11-10, 19:10-19:14Z |
| Stack | work. Serving commit `3b28b1d` |
| Started by | `POST /api/build/runs` (the dashboard API behind `build_start`), model `haiku`, repo `C:\repos\dev-tools`, cost cap $1 |
| Run | build_run 6, branch `jarvis/6-acceptance-test-build-pr-make-one-tiny-d`, PR xvanov/dev-tools#89 (draft). Closed after the run, branch deleted, not merged |
| Input | append one comment line to `keep-awake/README.md`, draft PR, `pa run done` with the URL |
| Criteria | `architecture.json` -> `examples[build-pr].acceptance` |

### Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `pr` | **pass** | #89 was a draft, +1/-0 on `keep-awake/README.md`, title as asked. |
| `ci` | **fail** | The `jarvisd (ubuntu)`, `jarvisd (windows)` and `personal-assistant (ubuntu)` jobs failed on TypeScript errors in `src/build/heartbeat.ts` and `src/dashboard/cards.ts`. Main's own CI at `3b28b1d` and `8d7f665` fails the same way, so the red is not from the PR's one doc line, but the criterion is "green". |
| `scope` | **pass** | One file, one line. |
| `done` | **pass** | `result` = the PR URL, `summary.json` written. `mergedAt` null. |

### Hops and cost

| Hop | Target | Measured | Result |
|---|---|---|---|
| dispatcher: build_start to session running | 30 s | 55.1 s (the POST's own time; the same on run 8: 53.0 s; with no repo 16.7 s) | **fail**. The worktree plus the Claude Code boot. Worth profiling. |
| build-agent: edit, push, PR | unbounded | 196 s end to end (19:10:59 to 19:14:15), 8 tool calls, 1 agent | n/a |
| github: CI | unbounded | red, see `ci` | n/a |
| dashboard: GET /api/build | 500 ms | 18-29 ms | pass |
| Cost | $0.50 | $0.117 notional (subscription, nothing billed) | pass |

### Not exercised

`build_start` was called through the dashboard API, not the chat, so the approval prompt, the fast lane and the Plan card chip were not walked. Views: Build only (`GET /api/build` listed the run done, with cost and result).
