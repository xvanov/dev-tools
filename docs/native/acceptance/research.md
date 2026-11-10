# Acceptance review: `research` (D30)

## Review, 2026-11-10

**Verdict: PASS.** One sonnet Build agent with no repo researched on the web, wrote `report.md` with a source for every claim, and ended the run `done` with the file path. No PR, nothing metered. (The earlier 2026-11-09 review scored the frozen factory's research job; this one scores the Build path, D30.)

| | |
|---|---|
| Date | 2026-11-10, 19:12-19:14Z |
| Stack | work. Serving commit `3b28b1d` |
| Started by | `POST /api/build/runs`, sonnet, no repo, cost cap $1.50: "how SQLite WAL handles concurrent readers and one writer, and checkpoint starvation and how to avoid it; under 400 words; cite URLs you opened; one subagent allowed" |
| Run | build_run 7. Report at `<data>\build-reports\run-7\report.md` (copy of the worktree file) |

### Rubric

| Criterion | Result | Evidence |
|---|---|---|
| `cited` | **pass** | Every bullet ends in a URL, `sqlite.org/wal.html` or `sqlite.org/pragma.html`. The transcript shows 2 WebFetch calls, one per page. |
| `supported` | **pass** | Spot checks against the SQLite docs: readers' end mark, a checkpoint cannot finish while a reader holds the WAL, auto checkpoints are PASSIVE at 1000 pages, RESTART/TRUNCATE complete at the cost of blocking, `journal_size_limit` caps the WAL left on disk. All match. |
| `answers` | **pass** | Concurrency model, what starvation is, how to avoid it. |

### Hops and cost

| Hop | Target | Measured | Result |
|---|---|---|---|
| dispatcher: build_start to session running | 30 s | 16.7 s | pass |
| build-agent: research and write | unbounded | 111 s (19:12:01 to 19:13:52), 5 tool calls, no subagent used (allowed, not required) | n/a |
| dashboard: GET /api/build | 500 ms | 18-29 ms | pass |
| Cost | $1.00 | $0.306 notional | pass |

Not exercised: the chat's approval prompt (dashboard API start).
