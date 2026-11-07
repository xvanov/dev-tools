# Jarvis native rebuild: tracked plan

Status: **approved 2026-11-07, not started.** This file is the source of truth for progress.
Design rationale: the plan page (proposal, 7 Nov 2026) and the research summary in [DESIGN.md](DESIGN.md).

## How to work this plan (read first, implementing agent)

1. Work top to bottom. A phase may start once the phase before it has its **Exit** box ticked,
   except where an item says `parallel-ok`. No Exit box is ticked without a green golden-path
   run (Track E, `e2e`) on both stacks.
2. Each `- [ ]` item is one unit of work: one or more commits to `main`, tests green, pushed
   (see the root `CLAUDE.md`). **Tick the box in the same commit that finishes the item** and
   append the short commit hash: `- [x] … (abc1234)`.
3. If an item turns out wrong or needs splitting, edit it here in the same commit and say why
   in the commit body. Do not silently skip an item; mark it `- [~] … — dropped: <reason>`.
4. Keep the system working after every commit. Both stacks deploy by `git pull` from `main`.
5. When a component, port, table or tool changes, update
   `personal-assistant/src/dashboard/architecture.json` in the same commit (root `CLAUDE.md`,
   "Architecture map"). New components land there as `planned`, then `landing`, then `live`.
6. This repo is public: no company repo configs, real people's names, tokens, or tailnet
   hostnames in commits, tests or this file.
7. Record any new decision in the decision log below, dated, before acting on it.

## Decision log

| # | Date | Decision | Notes |
|---|---|---|---|
| D1 | 2026-11-07 | **TypeScript core (Bun) + small Rust kernel** | Rust for `ptyd` (terminal host and agent sandbox), later the phone's offline core. Everything else TypeScript, strict. Not all-Rust. |
| D2 | 2026-11-07 | **SQLite** (WAL, FTS5, vectors as BLOBs, SQLCipher), one file per stack | Postgres-as-child-process (plan B) rejected. |
| D3 | 2026-11-07 | Plan is tracked here and handed to an implementing agent | Phase 0 starts now. |
| D4 | 2026-11-07 | **Tests and builds must be very fast; parallelize everywhere.** Deploys are **zero-downtime.** | Cross-cutting track T and track Z; both start in phase 0. |
| D5 | 2026-11-07 | **Keep embeddings as they are**: Azure `text-embedding-3-small`, 1536 dims, embed once, never re-embed | Supersedes the proposal's "local ONNX 512-dim re-embed". Measured: ~41k vectors cost ≈ $0.15 in total. Migration copies existing vectors. Use vectors only where meaning-search beats keywords. |
| D6 | 2026-11-07 | No WSL anywhere when done | Follows from D2 + factory daemon + jarvisd. |
| D7 | 2026-11-07 | System 1 (fast lane) becomes a **decide-then-speak** split: a calibrated classifier routes, a small model only speaks | Same idea as "System One" decision models (e.g. TypeSafe's Jev), built ourselves, free and local. Phase 0, item 0.6. |
| D8 | 2026-11-07 | **The full stack is proven end to end, repeatedly**: a dummy task goes Plan → Build → Run sessions → a real PR in this repo, observable and drillable in all three views | Track E. Runs as the gate at every phase exit, so the rebuild never breaks the path that matters. |
| D9 | 2026-11-07 | **Every agent run is watchable live in Run, whatever its runtime** (Claude Code, API models such as DeepSeek, opencode, local) | Today only `claude_session` runs show turn-by-turn work in a terminal; API runs show stage-level events via `factory job follow`. E2 closes the gap. |

Standing rules carried over: default agent runtime is Claude Code sessions (API/DeepSeek only on
request); voice never approves high-risk actions alone; work and personal stacks never connect.

## Targets (how we know it worked)

| Measure | Today (measured) | Target |
|---|---|---|
| Voice: end of speech to first audio | 1.3–2.0 s | < 0.7 s |
| Jarvis tool call | 4–10 s | < 1 s plus model time |
| Start a factory job, to "started" | 10–25 s | < 1 s |
| Board/Build updates | 30–120 s polling | pushed, < 200 ms |
| PA test suite (68 files) | ~2 min, serial, stops at first failure | < 20 s, parallel, full report |
| termhub test suite (25 files) | ~3.5 min | < 20 s |
| Factory test suite | ~12 min serial, ~6 min on 16 cores (with parallel-unsafe errors) | < 90 s, clean in parallel |
| Changed-files test run (pre-commit) | n/a | < 5 s |
| Build all binaries, incremental | n/a (no build) | < 30 s |
| Deploy | restart: dashboard and sessions drop | zero downtime: no dropped request, socket, or terminal |
| WSL memory | ~0.8 GB in use, 4.8 GB VM | 0 (WSL off) |

---

## Track T: fast tests and builds (cross-cutting, starts in phase 0)

- [ ] **T1 Parallel test runner for PA and termhub.** Replace the `&&` chains in `package.json`
  with one runner that runs every test file in a worker pool (cores − 1), never stops early,
  prints a per-file pass/fail/time table and exits non-zero on any failure. Keep the file list
  in one place (glob `test/*.test.js`, with an explicit skip list for the known
  environment-bound files, each with a reason). `parallel-ok`
- [ ] **T2 Make tests parallel-safe.** Each test gets its own temp dir, port 0 (OS-assigned),
  and its own DB schema or SQLite file; no shared fixed ports or files. Fix the known slow
  timeouts (`termhub` exec and csrf) so they fail fast or pass. `parallel-ok`
- [ ] **T3 Factory tests in parallel.** `pytest -n auto` (xdist is installed) must pass with
  the same results as serial. Fix the parallel-unsafe ones (`test_benchmark_record_store.py`
  errors under `-n 16`: shared runs dir). Mark true integration tests `@slow` and keep them out
  of the default run. `parallel-ok`
- [ ] **T4 Changed-files mode.** `npm test -- --changed` (and the factory equivalent) runs only
  tests that import a changed module (static import graph). Wire it into the pre-commit hook,
  keep the full suite for CI. Target < 5 s.
- [ ] **T5 Timing budget in CI.** Fail CI if any single test file takes > 5 s or the suite
  exceeds its target; print the 10 slowest.
- [ ] **T6 CI matrix.** GitHub Actions: Windows, macOS, Linux jobs in parallel, dependency
  caches (Bun, cargo with sccache, uv). Required green before an item is ticked.
- [ ] **T7 Build pipeline (from phase 4).** `bun build --compile` per OS in parallel;
  `cargo build` with sccache and incremental; one command builds everything; incremental
  < 30 s. Release artifacts are signed (phase 7).
- [ ] **Exit T:** all suites meet the targets table on Windows and Linux.

## Track Z: zero-downtime deploys (cross-cutting, starts in phase 0)

Design: a tiny, rarely-changing **supervisor** owns the listening sockets and routes to the
current worker generation. Deploy = start generation N+1 beside N, health-check it, switch
routing, drain N, stop N. Terminals live in `ptyd`, a separate process, so they never restart
with the app. Clients reconnect to the event stream with `Last-Event-ID` and miss nothing
(outbox, phase 1).

- [ ] **Z1 Supervisor with socket handoff** for the PA worker today (Node): holds the port,
  spawns generation N+1, waits for `/healthz` ready, flips, sends N `drain`, kills N after
  in-flight requests finish (timeout 30 s). Works on Windows and Linux. `parallel-ok`
- [ ] **Z2 Single-owner background work.** Schedulers and passes take a DB lease, so during the
  overlap only one generation runs them; the new one takes over when the old releases.
- [ ] **Z3 Expand/contract migrations.** Every schema change is additive first; old and new
  code both run on the new schema; the cleanup migration ships one release later. A test
  runs the previous release's code against the new schema.
- [ ] **Z4 Deploy command.** `deploy` = `git pull --ff-only` + install + build + Z1 handoff +
  rollback by flipping back if health fails within 60 s. Replaces the stop/kill/start
  restart. Same on both stacks.
- [ ] **Z5 termhub sessions survive deploys** (already via sessiond; make it explicit and
  tested), later replaced by `ptyd` (phase 5).
- [ ] **Z6 Deploy test.** A test hammers the dashboard, an SSE stream and a terminal during a
  deploy and asserts zero failed requests, no lost events, no dropped terminal.
- [ ] **Exit Z:** a deploy on each stack with the Z6 test passing.

## Track E: the full stack works end to end (D8, D9; gate for every phase exit)

**The golden path.** One dummy feature for this repo travels the whole system, and the user can
watch and drill into it at every level:

1. **Plan**: a card is created (by voice in Ask, by Jarvis's `factory_start` tool, or by hand),
   e.g. "Add a `pa version` verb that prints the served commit" (small, real, harmless).
2. **Build**: the card is distilled into a factory job (brief, stories, gates). The job shows its
   stages, runtime per step, cost so far, and links back to the card.
3. **Run**: each agent step appears as a live session. Opening it shows the work as it happens.
4. **PR**: the job opens a draft PR on this repo; CI runs; the PR link and CI state flow back to
   the job (Build) and the card (Plan).
5. **Drill-down both ways**: card → job → step → session → PR, and back from any of them.
6. **Cleanup**: the PR is closed unmerged and its branch deleted (unless the user merges it).

Variants, each run at least once per phase exit: all steps on `claude_session` (the default);
**one step on an API model (DeepSeek)**; a resumed job (`factory job resume`) after killing the
run mid-step; a job continued on an existing branch (`--branch`).

- [ ] **E1 One id chain.** Card id ↔ job id ↔ run/step id ↔ session id ↔ PR number are stored
  as links in the data (not inferred from titles), returned by the board, JOBS-API and session
  APIs, and rendered as links in Plan, Build and Run. Jarvis's MCP tools return them too.
- [ ] **E2 Every run is watchable (D9).** API-runtime steps emit the same turn-level stream as
  `claude_session` (model turn, tool call, file diff summary, gate result, tokens and cost), to
  the run's event log. Run opens it as a read-only live session rendered by the same pretty
  renderer `claude_session` uses (`factory/claude_session/pretty.py`), started automatically
  when the step starts, so API and Claude steps look the same in Run. Ends when the step ends;
  stays reviewable afterwards (scrollback/transcript).
- [ ] **E3 Live status in all three views.** Card state, job stage and session state update
  within 1 s of a change (SSE from 0.4 / 1.4), including "waiting for your approval" with the
  approve action reachable from Plan, Build and voice.
- [ ] **E4 `e2e` command.** One command runs the golden path headless against the live stack,
  creates the dummy card, waits for the PR, asserts every link in E1 resolves in every view's
  API, asserts the API-runtime step produced a watchable session (E2), prints a timing per
  hop (card → job started → first session output → PR opened → CI done), then cleans up.
  `--keep` leaves the PR open for a human look. Prerequisite: the factory machine's `gh` can
  push to this repo with the personal identity.
- [ ] **E5 Baseline now.** Run E4 on today's system before phase 1 starts; record the timings
  and every broken hop here as new items. Fix what is broken in phase 0.
- [ ] **E6 Gate.** Each phase's Exit box below requires a green E4 run (all variants) on both
  stacks, with the timings recorded in the targets table.
- [ ] **Exit E:** the user runs the golden path by voice ("start a factory job for …"), watches
  it in Plan, Build and Run, drills down from the card to the live session and the PR, and
  each hop meets its timing target.

## Embeddings policy (D5, applies to every phase)

- Keep Azure `text-embedding-3-small`, 1536 dims. Embed each item **once**, when it arrives;
  never re-embed on edit of unrelated fields, on migration, or on model "upgrades" without a
  new decision in the log.
- Embed only **text that doesn't change and is searched by meaning**: message and document
  chunks, memory claims, memory pages, commitment text (for semantic dedupe).
- Never embed identifiers, statuses, board state, numbers, dates, or anything with an exact
  key (PR/ticket references dedupe by key, not by vector). Use SQL lookups and FTS5 keyword
  search for those.
- Cache query embeddings (normalized query text → vector, LRU in memory + table), so a
  repeated question costs nothing.

---

## Phase 0: quick wins, no rewrite (days)

- [ ] **0.1 Factory brief without `claude -p`.** Write the brief with a direct API call or a
  warm session; removes ~4 s per job start.
- [ ] **0.2 Query-embedding cache** (see policy). Removes 0.3–1 s per search.
- [ ] **0.3 Embeddings audit.** List every `embed(` call site (`src/search`, `src/memory`,
  `src/recall`, `src/commitments`) against the policy; remove any that embed changing data or
  exact keys; write the result into `architecture.json`'s memory card. Record the measured
  monthly embedding spend in Meter.
- [ ] **0.4 SSE instead of polling** for the board and Build (replace the 30 s and 120 s polls).
- [ ] **0.5 Voice latency:** keep the fast-lane prompt prefix warm; TTS at the first clause
  instead of the first sentence; cut the fixed 200 ms silence wait where VAD already decided.
- [ ] **0.6 System 1 decide-then-speak (D7).** Split the fast lane into:
  - a **router** that returns calibrated probabilities, not text: `p(answer_here)`,
    `p(hand_off)`, `p(action)`. First version: the local model scores fixed yes/no questions
    via single-token log-probabilities (Ollama `logprobs`), with the context snapshot.
    Second version if needed: a small classifier on the turn embedding trained on logged turns.
  - an **answerer** that only speaks when `p(answer_here)` clears a threshold; otherwise the
    turn goes to Jarvis (System 2) verbatim.
  - an eval set from real logged turns (no real names in the repo copy), including the known
    miss "check my mail from <name>" which must hand off. Router accuracy and latency
    reported by `pa eval`.
  - Done when: router decides in < 150 ms warm, no action-like turn is answered locally on
    the eval set, and `architecture.json` describes the new shape.
- [ ] **0.7** T1, T2, T3 and Z1 landed (from the tracks above).
- [ ] **0.8** E1, E4 and E5 landed: the golden path runs on today's system and its broken hops
  are fixed. E2 (watchable API runs) lands here too if the baseline shows it missing.
- [ ] **Exit 0:** measured again; targets table updated with new numbers.

## Phase 1: contracts and the repository layer

- [ ] **1.1 Protobuf schemas** for Job, Run, Card, Event, Approval, mirroring JOBS-API v1.3
  and the MCP tools. One source; generated TS, Rust and Python types.
- [ ] **1.2 Repository interface** over today's Postgres: every one of the ~590 SQL call sites
  goes through a typed repository method. No behaviour change.
- [ ] **1.3 Contract tests** for every repository method, runnable against any backend. This is
  the oracle for phase 3.
- [ ] **1.4 Events outbox table** + one SSE endpoint with `Last-Event-ID` replay.
- [ ] **Exit 1:** all SQL behind repositories; contract tests green on Postgres.

## Phase 2: factory as a daemon

- [ ] **2.1** The current Python factory runs as a long-lived ConnectRPC service (no process
  spawn per call).
- [ ] **2.2** An in-process scheduler with DB leases replaces systemd timers and `fcntl` locks.
- [ ] **2.3** Runs natively on Windows (no WSL); the work stack's factory moves off WSL.
- [ ] **Exit 2:** factory calls take milliseconds; JOBS-API v1.3 tests green on Windows and Linux.

## Phase 3: storage to SQLite (D2)

- [ ] **3.1** SQLite schema (WAL, FTS5, vector BLOBs, SQLCipher), implementing every
  repository from 1.2.
- [ ] **3.2** Contract tests from 1.3 green on SQLite.
- [ ] **3.3 Export from Postgres, copying existing vectors (no re-embedding, D5).** Optional
  int8 quantization is local arithmetic on the copied vectors, not an API call.
- [ ] **3.4 Shadow run:** both backends answer the same searches for a week; compare results
  and latency; recalibrate rerank thresholds.
- [ ] **3.5** Cutover on the personal stack, then the work stack; Litestream backup + restore
  drill.
- [ ] **3.6** WSL off on the work laptop (D6); Postgres removed.
- [ ] **Exit 3:** one SQLite file per stack, search quality ≥ Postgres on the shadow set.

## Phase 4: jarvisd

- [ ] **4.1** TypeScript/Bun core absorbs the PA worker, dashboard, MCP server and termhub
  front; strict TS, module by module.
- [ ] **4.2** Chat moves to the Agent SDK: approvals become typed callbacks instead of reading
  the terminal screen.
- [ ] **4.3** Policy engine: every tool call is allow / deny / ask, with an audit log
  (hash-chained).
- [ ] **4.4** Supervisor from Z1 becomes jarvisd's own; one executable per OS (T7).
- [ ] **Exit 4:** one process per machine, typed approvals, Z6 deploy test green.

## Phase 5: ptyd and the sandbox (Rust, D1)

- [ ] **5.1** `ptyd` in Rust (`portable-pty`), same WebSocket protocol, so the UI keeps working;
  terminals survive jarvisd restarts.
- [ ] **5.2** Agent sandbox per run: sandbox-runtime on macOS/Linux, restricted account on
  Windows, egress allowlist proxy.
- [ ] **5.3** Credential broker: keys never enter the sandbox; pushes and PRs go through the
  broker, checked against the run's delivery ceiling.
- [ ] **Exit 5:** agents run sandboxed on all three OSes; termhub's node-pty host retired.

## Phase 6: factory into TypeScript

- [ ] **6.1** Port gate by gate behind the Job contract; Python kept only as an optional
  runtime plugin (OpenHands).
- [ ] **Exit 6:** factory runs in jarvisd; Python not required.

## Phase 7: hardening and reach

- [ ] **7.1** Passkey sessions; voice never approves merges, pushes to main or secret reveals.
- [ ] **7.2** Per-stack CA and mTLS between machines of one stack.
- [ ] **7.3** Secrets in the OS keychain, labelled by stack.
- [ ] **7.4** Encrypted backups with a restore drill; signed self-update.
- [ ] **7.5** OpenTelemetry into Meter, including the separate Claude subscription credit pool
  (since 15 Jun 2026) with API fallback when it runs out.
- [ ] **7.6** Tauri desktop shell, then the phone app.
- [ ] **Exit 7:** install on a fresh Windows, macOS and Linux machine from one artifact.

## Risks

- Claude subscription billing changed 15 Jun 2026: headless use draws from a separate credit
  pool. Meter must track it.
- Windows sandboxing is the least mature of the three OSes.
- SQLite move: dialect bugs, FTS ranking drift, rerank thresholds need recalibrating (3.4).
- Still moving: MCP auth spec, Tauri mobile, sqlite-vec's nearest-neighbour index (not needed below ~1M
  vectors; exact scan is 10–30 ms).
