# Jarvis native rebuild: tracked plan

Status: **approved 2026-11-07, not started.** This file is the source of truth for progress.
Design rationale: the plan page (proposal, 7 Nov 2026) and the research summary in [DESIGN.md](DESIGN.md).

## How to work this plan (read first, implementing agent)

1. Work top to bottom. A phase may start once the phase before it has its **Exit** box ticked,
   except where an item says `parallel-ok`. No Exit box is ticked without a green golden-path
   run (Track E, `e2e`) on both stacks.
2. Each `- [ ]` item is one unit of work: one or more commits to `main`, tests green, pushed.
   Locally run only the tests relevant to the change (`npm test -- --changed`, or the test
   files for the touched modules); CI (T6) runs the full suites on every push and must be green
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
| D10 | 2026-11-07 | **The plan ends with a workflow acceptance review**: an independent reviewer session runs each workflow in the Map and scores it against its metrics | Phase 8. The workflows (research, open a PR on DeepSeek, continue a PR, answer locally, Teams ask, phone) are the product; components passing tests is not enough. |
| D11 | 2026-11-07 | **Implementation runs on the work laptop (Windows).** Two GitHub identities: `xvanov` (personal; this repo) and `kalinivanov-innergy` (work) | Git uses the SSH host aliases `github-xvanov` / `github-innergy`. `gh` picks the account by repo owner, never by whichever is active (P1). |
| D12 | 2026-11-07 | **Desktop only; no week-long shadow run** | Phone app and the `phone` workflow are out of scope: 7.6 is the Tauri desktop shell only, Phase 8 skips `phone`. 3.4 is a one-shot comparison over a recorded query set instead of a week of shadowing. |
| D13 | 2026-11-07 | **Each stack runs its own factory**; this repo gets a factory app and GitHub Actions CI | The work laptop's PA stops dispatching to the personal machine's factory (it crossed stacks); it uses a local factory running natively on Windows: item 2.3 is pulled forward into phase 0, with no WSL interim step. A factory app for `xvanov/dev-tools` is registered on both stacks so the golden path has a target; T6 adds the CI the "CI done" hop waits on. |
| D14 | 2026-11-07 | **No macOS**: Windows and Linux only | No macOS CI jobs, no macOS sandbox, no macOS install in Exit 7. Both stacks run on Windows or Linux. |
| D15 | 2026-11-07 | **Cut the factory port to TS, protobuf and mTLS** | Phase 6 dropped: once the factory is a native daemon (phase 2) the port gains little beyond one language, so Python stays. 1.1 uses JSON Schema instead of protobuf/ConnectRPC: one schema source, TS types generated, Python/Rust validate against it; transport is JSON over HTTP + SSE. 7.2 dropped: the stacks never connect and Tailscale ACLs already separate them. |
| D16 | 2026-11-08 | **Phase 1 (and 2.1/2.2) start in parallel with the end of phase 0** | They are refactors with no behaviour change and don't depend on the golden path; waiting on Exit 0 left most agents idle. Exit gates are unchanged: Exit 1 and Exit 2 still need a green e2e run on both stacks. |
| D18 | 2026-11-08 | **All independent items start now, in parallel** | Extends D16: any item whose inputs exist may start (5.1 ptyd, 5.2/5.3 sandbox and broker, 3.1 SQLite on converted aggregates, 4.3 policy engine, 7.3–7.5, 8.1, ...). Phase Exit boxes are unchanged: each still needs its items done and a green e2e on both stacks. |
| D17 | 2026-11-08 | **Prune test work** | Delete the factory tests for `apps/sacrifice` and `bench/swebench` (not in this repo; they only fail or skip). Drop T5 (timing budget in CI). The load-sensitive `supervisor` and `lease` tests were de-flaked instead (80f48d5, 20 loaded runs green) and keep running locally (CI-only was tried and reverted, f402f3f). Suite time targets are unchanged. |

## Prerequisites (before phase 0)

- [x] **P1 GitHub identities.** Done 2026-11-07 from this machine: `gh` holds both accounts with `kalinivanov-innergy` active; draft PR xvanov/dev-tools#2 opened as xvanov via `GH_TOKEN=$(gh auth token --user xvanov)` and closed, branch deleted; innergy-dev/faas-cli reachable with WRITE as the work account. The factory half is P2. Verified 2026-11-07: `git pull`/`git push` to this repo work
  over `git@github-xvanov:xvanov/dev-tools.git` with the xvanov key. `gh` is logged in only
  as `kalinivanov-innergy`, which has READ on `xvanov/dev-tools`, so it cannot open PRs here.
  Fix: the user adds the xvanov account to `gh` (`gh auth login`, then
  `gh auth switch --user kalinivanov-innergy` to keep work as the default), and every tool
  that calls GitHub for a repo picks the token by owner
  (`GH_TOKEN=$(gh auth token --user xvanov)` for `xvanov/*`). Done when `gh pr create
  --draft` on a throwaway branch of this repo succeeds from this machine and the factory, and
  an INNERGY repo still uses the work account.
- [x] **P2 Factory on this machine** can reach GitHub with the same per-owner rule (needed by
  Track E's golden path). (33e3b01, d57e6a9, 295833a) Verified natively on Windows 2026-11-07: the factory's
  `gh_auth` resolver (Popen hook) opened draft PR xvanov/dev-tools#3, and the `bin\gh.cmd` shim
  opened #4, both as `xvanov` on throwaway branches over the SSH remote; both were closed and their
  branches deleted. A non-xvanov owner resolved to the active work account.
  Tracked app `software-factory/apps/dev-tools`. Windows factory run itself is item 2.3.

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

- [x] **T1 Parallel test runner for PA and termhub.** Replace the `&&` chains in `package.json`
  with one runner that runs every test file in a worker pool (cores − 1), never stops early,
  prints a per-file pass/fail/time table and exits non-zero on any failure. Keep the file list
  in one place (glob `test/*.test.js`, with an explicit skip list for the known
  environment-bound files, each with a reason). `parallel-ok` (5bc7a6d)
- [x] **T2 Make tests parallel-safe.** Each test gets its own temp dir, port 0 (OS-assigned),
  and its own DB schema or SQLite file; no shared fixed ports or files. Fix the known slow
  timeouts (`termhub` exec and csrf) so they fail fast or pass. `parallel-ok` (d3f7a19)
  Zero skips and no platform-gated entries left in either tool's `runner.config.js`; the runner gained
  `platform`, `env`, `shards`, `touches`/`narrow` (scripts/README.md). Spawn-bound files are sharded
  (`dispatchStart` x5, `remoteExec` x4). Found on Windows and fixed: `gh auth token` printed the
  operator's keyring token inside a no-push session even with an empty `GH_CONFIG_DIR`; `noPushEnv` now
  sets `GH_TOKEN`/`GH_ENTERPRISE_TOKEN` to a worthless sentinel (the test asserts `gh auth token`,
  `--hostname`, `gh api` and `git credential fill` give no real token).
  `supervisor`, `deploy` (a ~9 s PowerShell cold start) and `lease` (80-200 ms sleeps; failed in
  two loaded full runs, alone it always passes) are the remaining slow or load-sensitive files.
- [ ] **T3 Factory tests in parallel.** `pytest -n auto` (xdist is installed) must pass with
  the same results as serial. Fix the parallel-unsafe ones (`test_benchmark_record_store.py`
  errors under `-n 16`: shared runs dir). Mark true integration tests `@slow` and keep them out
  of the default run. `parallel-ok`
- [x] **T4 Changed-files mode.** `npm test -- --changed` (and the factory equivalent) runs only
  tests that import a changed module (static import graph). Wire it into the pre-commit hook,
  keep the full suite for CI. Target < 5 s. (4253252, 2736d74)
  `scripts/hooks/pre-commit` (guard, then `scripts/pre-commit-tests.js`), installed by
  `node scripts/install-hooks.js`; skip for humans: `DEVTOOLS_SKIP_TESTS=1`. A leaf edit runs in about
  3 s; a change to a module the whole app imports runs most of the suite.
- [~] **T5 Timing budget in CI.** Fail CI if any single test file takes > 5 s or the suite
  exceeds its target; print the 10 slowest. — dropped: D17.
- [x] **T6 CI matrix.** GitHub Actions: Windows and Linux jobs in parallel (D14), dependency
  caches (Bun, cargo with sccache, uv). Required green before an item is ticked. (7a080d9)
  .github/workflows/ci.yml: path-filtered per tool (PA, termhub, ios-messages, software-factory), npm/uv/pip
  caches, workflow_dispatch runs all, no secrets, no Postgres service needed (tests skip or fake it). Bun and
  cargo/sccache caches land with phases 1 and 5 (T7). Raw job logs are not downloadable from the work laptop
  (blob host blocked), so test steps run through .github/scripts/run.sh, which republishes failing lines as
  an annotation (`gh api repos/xvanov/dev-tools/check-runs/<job id>/annotations`). Follow-ups:
  - **T6a** software-factory CI leg is informational (continue-on-error) on both OS: on Linux 38 tests fail
    because this public repo does not track apps/sacrifice or bench/swebench (plus the gitignore test
    assumes a repo-root layout), and the suite takes ~10 min on a 2-core runner. T3 skips-when-absent, then
    flip the leg to blocking on Linux; Windows stays informational until phase 2.3.
  - **T6b** personal-assistant remoteExec.test.js SKIPs on Windows (it stands the local host in for a
    Linux machine); split its host-bound half from the pure unit assertions so Windows keeps the latter.
  - Found by CI and fixed: termhub updateHeal.test.js asserted a stale source shape (invisible on Windows,
    where it skips); PA deploy.test.js needs etch-depth: 2 for HEAD~1.
- [x] **T7 Build pipeline (from phase 4).** `bun build --compile` per OS in parallel;
  `cargo build` with sccache and incremental; one command builds everything; incremental
  < 30 s. Release artifacts are signed (phase 7). (545f743)
  `node scripts/build.js` (scripts/README.md): targets in parallel into `dist/<os>-<arch>/` plus a
  sha256 manifest; CI job `build` runs it on Windows and Linux (release, sccache) and uploads
  `dist-Windows` / `dist-Linux` (run 42449358629). ptyd one-file incremental: 9 s, no-op 0.4 s on
  the `local` cargo profile (release with thin LTO took 95 s). jarvisd's `bun build --compile` is
  a listed, skipped target until 4.1 gives it an entrypoint. Signing hook: `DEVTOOLS_SIGN_CMD` (7.4).
- [ ] **Exit T:** all suites meet the targets table on Windows and Linux.

## Track Z: zero-downtime deploys (cross-cutting, starts in phase 0)

Design: a tiny, rarely-changing **supervisor** owns the listening sockets and routes to the
current worker generation. Deploy = start generation N+1 beside N, health-check it, switch
routing, drain N, stop N. Terminals live in `ptyd`, a separate process, so they never restart
with the app. Clients reconnect to the event stream with `Last-Event-ID` and miss nothing
(outbox, phase 1).

- [x] **Z1 Supervisor with socket handoff** for the PA worker today (Node): holds the port,
  spawns generation N+1, waits for `/healthz` ready, flips, sends N `drain`, kills N after
  in-flight requests finish (timeout 30 s). Works on Windows and Linux. `parallel-ok`
  Built as a reverse proxy (`personal-assistant/src/supervisor`), not fd passing, which
  Windows cannot do; control socket `node src/supervisor roll|status` for Z4. (262f4ab)
- [x] **Z2 Single-owner background work.** Schedulers and passes take a DB lease, so during the
  overlap only one generation runs them; the new one takes over when the old releases.
  Lease = advisory lock 7300, released on `drain`; per-pass lock (7301, name) so a pass still
  finishing in the old generation is skipped, not doubled. (c73f192)
- [x] **Z3 Expand/contract migrations.** Every schema change is additive first; old and new
  code both run on the new schema; the cleanup migration ships one release later. A test
  runs the previous release's code against the new schema. Without Postgres: the previous
  commit's INSERTs are checked against a schema modelled from `sql/`. (f25ea8e)
- [x] **Z4 Deploy command.** `deploy` = `git pull --ff-only` + install + build + Z1 handoff +
  rollback by flipping back if health fails within 60 s. Replaces the stop/kill/start
  restart. Same on both stacks. `src/supervisor/deploy.js` behind `windows/redeploy.ps1` /
  `linux/redeploy.sh`; the restart stays only to bootstrap or when the supervisor itself
  changes. Live on the work stack 2026-11-07 (roll and rollback under load: 1 request in
  ~880 timed out at 10 s around the flip, left for Z6). (9207f32)
- [x] **Z5 termhub sessions survive deploys** (already via sessiond; make it explicit and
  tested), later replaced by `ptyd` (phase 5). `termhub/test/frontSwap.test.js`: the front is
  killed and replaced mid-command; sessiond's pid is kept and every tick replays. The PA roll
  half is in Z6's terminal check. (44b86fc)
- [x] **Z6 Deploy test.** A test hammers the dashboard, an SSE stream and a terminal during a
  deploy and asserts zero failed requests, no lost events, no dropped terminal.
  `personal-assistant/src/e2e/deployTest.js` (spare mode in `test/deployTest.test.js`; `--live
  [--deploy]` on a stack). Events now survive a roll: `pa_event_seq` ids (sql/035). (2793e9b)
- [x] **Exit Z:** a deploy on each stack with the Z6 test passing. Work stack 2026-11-08:
  PASS with `--live --deploy` (5186 requests, 0 failed; 1251/1251 events, 0 resyncs; terminal
  598 ticks, socket held), then three failed runs whose causes were fixed (overlapping deploys:
  deploy lock; synchronous supervisor log; a CPU starved by test pools: serving processes above
  normal), then two passes in a row at d9e0545 (4614 requests, 0 failed; 1137/1137 events;
  497 ticks). Personal stack 2026-11-08 at 0a39be9: PASS with `--live --deploy` over https
  termhub (10568 requests, 0 failed, p99 2 ms; 1335/1335 events, 0 resyncs; terminal 683
  ticks, 0 missing, socket held).

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

- [x] **E1 One id chain.** Card id ↔ job id ↔ run/step id ↔ session id ↔ PR number are stored
  as links in the data (not inferred from titles), returned by the board, JOBS-API and session
  APIs, and rendered as links in Plan, Build and Run. Jarvis's MCP tools return them too.
  (7e9bbb8 termhub session links, f6c4480 JOBS-API v1.4, 1ce66ce PA run_pr/run_step + views)
- [x] **E2 Every run is watchable (D9).** API-runtime steps emit the same turn-level stream as
  `claude_session` (model turn, tool call, file diff summary, gate result, tokens and cost), to
  the run's event log. Run opens it as a read-only live session rendered by the same pretty
  renderer `claude_session` uses (`factory/claude_session/pretty.py`), started automatically
  when the step starts, so API and Claude steps look the same in Run. Ends when the step ends;
  stays reviewable afterwards (scrollback/transcript). (d735579, 30e782f)
- [ ] **E3 Live status in all three views.** Card state, job stage and session state update
  within 1 s of a change (SSE from 0.4 / 1.4), including "waiting for your approval" with the
  approve action reachable from Plan, Build and voice.
  Landed in e36357f except one hop: card state (~0.5 s) and Run's session state (≤ 1 s, idle-hub
  tick) meet it, and Approve is on Plan, Build and voice; job stage in Build is 5-6 s for a local
  factory (each `uv run factory` costs ~5 s of Python start-up) until the native factory (2.3)
  calls the PA's `POST /api/factory/events` on each job transition (measured 26 ms to Build).
- [x] **E4 `e2e` command.** One command runs the golden path headless against the live stack,
  creates the dummy card, waits for the PR, asserts every link in E1 resolves in every view's
  API, asserts the API-runtime step produced a watchable session (E2), prints a timing per
  hop (card → job started → first session output → PR opened → CI done), then cleans up.
  `--keep` leaves the PR open for a human look. Prerequisite: the factory machine's `gh` can
  push to this repo with the personal identity.
  (1f1ee4f) `pa e2e [--dry-run|--sweep|--keep|--resume|--branch b|--runtime api --model m|--on machine]`.
  The dry-run was green on the work stack 2026-11-08 at ca701ce, with config, build, plan, run, mcp and
  github all passing.
- [ ] **E5 Baseline now.** Run E4 on today's system before phase 1 starts; record the timings
  and every broken hop here as new items. Fix what is broken in phase 0.
  Run 1 (work stack, claude_session, draft_pr, 2026-11-08 03:19Z; card #6758, job dev-tools:004):
  card 0.2 s → job started +108.5 s (factory_start itself took 37 s) → first session output
  NOT REACHED after 600 s. Cleanup ran (job cancelled, card dropped). Broken hops:
  - [x] **E5.1 Plan's /api/state is down.** It returned 500 `repo.sources.calendarToday is not a function` at
    3b37fe1; during the run it and /api/commitments/:id exceeded 30 s. Fixed in 94c4de3: 3b37fe1 was an
    in-between main where a caller landed before its repo method.
  - [ ] **E5.2 Planning steps are not watchable (E2).** The job's first step (`sm`, runtime api, state ok)
    had `session: null` even though the job runtime is claude_session, so its planning work never
    shows in Run.
  - [ ] **E5.3 Dev step starts late.** After 10 min the dev step (the first session) had not started:
    the factory moves a story one step per 300 s tick. Card to job started took 109 s against a < 1 s target.
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

- [x] **0.1 Factory brief without `claude -p`.** Write the brief with a direct API call or a
  warm session; removes ~4 s per job start. (7b5e52d)
- [x] **0.2 Query-embedding cache** (see policy). Removes 0.3–1 s per search. (bc0a4d2)
- [x] **0.3 Embeddings audit.** List every `embed(` call site (`src/search`, `src/memory`,
  `src/recall`, `src/commitments`) against the policy; remove any that embed changing data or
  exact keys; write the result into `architecture.json`'s memory card. Record the measured
  monthly embedding spend in Meter. (60908b9)
- [x] **0.4 SSE instead of polling** for the board and Build (replace the 30 s and 120 s polls). (e36357f)
- [x] **0.5 Voice latency:** keep the fast-lane prompt prefix warm; TTS at the first clause
  instead of the first sentence; cut the fixed 200 ms silence wait where VAD already decided. (ffc2d5a)
- [x] **0.6 System 1 decide-then-speak (D7).** Split the fast lane into:
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
  - Landed: one fixed A/B/C question rather than several yes/no ones, because two sequential
    calls cost ~250 ms (Ollama has ~80 ms of fixed overhead per request here). `pa eval router`
    on 83 turns, llama3.2:3b: 84–87% 3-way, 0 action and 0 lookup turns answered locally,
    threshold 0.85. Router p50 98–124 ms, p95 129–175 ms warm. One run under heavy parallel
    agent load had p50 176 ms. (0163ef0)
- [ ] **0.7** T1, T2, T3 and Z1 landed (from the tracks above).
- [ ] **0.8** E1, E4 and E5 landed: the golden path runs on today's system and its broken hops
  are fixed. E2 (watchable API runs) lands here too if the baseline shows it missing.
- [ ] **Exit 0:** measured again; targets table updated with new numbers.

## Phase 1: contracts and the repository layer

- [x] **1.1 JSON Schemas (D15)** for Job, Run, Card, Event, Approval, mirroring JOBS-API v1.4
  and the MCP tools. One source; TS types generated; Python and Rust validate against it. (52d2b79, ca701ce)
  `schemas/*.schema.json` at the repo root; `schemas/gen-types.js` writes `types.d.ts`; the PA
  validates with the dependency-free `schemas/index.js` (it throws on any keyword it does not
  implement, so it never means less than Python's), the factory with `factory/contract_schemas.py`
  (`jsonschema`). Tested on both sides against real objects (job status, chainOf/runChain, card
  and board views, bus frames, permission prompts). Rust validates when Rust lands (phase 5).
- [ ] **1.2 Repository interface** over today's Postgres: every one of the ~590 SQL call sites
  goes through a typed repository method. No behaviour change.
  Scope: the PA only (579 sites in 69 modules; termhub has no SQL). The factory keeps its own
  SQLModel/SQLite store: it is Python and stays so (D15), JOBS-API v1.4 already keeps the PA out
  of it, and it is SQLite already, so phase 3 has nothing to move there. Shape: `src/repo/<aggregate>.js`
  exports `create(db)` with named, JSDoc-typed methods; `repo.withTx(fn)` gives `fn` the set bound
  to one transaction; the default set resolves `src/db` at call time, so tests that stub `src/db`
  keep working. SQL text moves verbatim. `test/repoBoundary.test.js` lists the modules not yet
  converted (it may only shrink) and fails on SQL anywhere else.
- [ ] **1.3 Contract tests** for every repository method, runnable against any backend. This is
  the oracle for phase 3.
  `test/repoContract.test.js` runs `test/contract/<aggregate>.contract.js` against each backend in
  `test/contract/_backends.js` (today Postgres: a throwaway `pa_test_contract_*` database, migrated,
  dropped; phase 3 adds SQLite), and fails when an aggregate method has no case. CI runs it in its own
  job with a pgvector service container; locally it uses the work stack's server (scripts/README.md).
- [x] **1.4 Events outbox table** + one SSE endpoint with `Last-Event-ID` replay. (cefef7a)
  `sql/036`: the 034 trigger also writes each event to `event_outbox` under its `pa_event_seq`
  number (Z6) in the writer's transaction; NOTIFY stays the live wake-up. `GET /api/events`
  replays a `g<n>` the ring does not hold from the table (across restarts and generations), and a
  LISTEN that reconnects backfills from it. Kept 3 days (pruned by the trigger); a client more than
  1000 events or 3 days behind resyncs. Delivery is at least once in commit order: two
  transactions committing out of sequence order can replay one event twice (ids dedupe it).
- [ ] **Exit 1:** all SQL behind repositories; contract tests green on Postgres.

## Phase 2: factory as a daemon

- [ ] **2.1** The current Python factory runs as a long-lived JSON-over-HTTP service (no process
  spawn per call).
- [ ] **2.2** An in-process scheduler with DB leases replaces systemd timers and `fcntl` locks.
  Landed with 2.3 (d44ffe1, 0a245c7): `factory serve` (fresh tick subprocess per app every 300 s,
  wake within 1 s of job submit/resume via `state/scheduler/wake.d`, in-process research/report
  dispatch) and portable locks in `factory/oscompat.py` (flock / LockFileEx). Its lease is an OS
  file lock (`state/locks/serve.lock`, plus `tick-<app>.lock`), not a DB lease; Linux still runs
  the systemd timers (serve refuses beside them). Left: DB leases, retiring the timers on Linux.
- [x] **2.3** Runs natively on Windows (no WSL); the work stack's factory moves off WSL.
  (0a245c7, d44ffe1, ec83f20, 6de69f0, 916de23, cb0b6b0) `docs/WINDOWS.md`. The `factory-serve`
  logon task runs `factory serve` from the work laptop's dev-tools checkout. claude_session rounds
  run without bash (`python -I -X utf8 -m factory.claude_session.round`, PowerShell command line
  in termhub); the PA runs a local factory with `PA_FACTORY_MACHINE=local`. Smoke 2026-11-08, all
  native: a claude_session research job went submit to started in ~1.7 s and wrote its report in
  a Windows termhub session; a dev-tools code job (draft_pr) was triaged within a tick, opened a
  live onboarder session and draft PR #7 as xvanov, which was closed and its branch deleted.
  Windows suite (`uv run pytest -n auto`): 4255 tests, 265 skipped, 5 load-sensitive failures
  that pass alone (solo watchdog wall-clock bounds, oracle child start-up under load; handed to
  T3). Skipped on Windows as inherently POSIX (`tests/conftest.py`, WINDOWS_POSIX_ONLY): the
  stalled-stories detector tests (Linux /proc); the bash self-deploy tests; four deploy-runner,
  two gate and one solo static-gate test whose commands are POSIX sh; oracle H41b (directory mode
  bits), H5c and H5d (attacker polls /tmp), B2k and one diff-capture test (symlinks); one
  out-of-process oracle test (`sh` boot, process groups); 16 SWE-bench harness tests and
  `test_swebench_bare_openhands_arms.py` (Linux-only harness: docker, bwrap, getuid, signals).
  Open: the work PA's `.env` switch (PA_FACTORY_MACHINE/PATH, and PA_FACTORY_UV, which names a
  path that does not exist on Windows); retiring the WSL factory and its termhub with 3.6.
- [ ] **2.4 Per-app context root.** The onboarder and other personas write `context/` at the
  app repo root (hard-coded ~200 times). Route every context path through `canonical_paths`
  and honour `AppConfig.context_dir`, so a monorepo app (dev-tools) keeps its context under
  `software-factory/apps/<app>/`. Found in the 2.3 smoke (a docs-typed job wrote `context/`
  into the dev-tools repo); code jobs don't hit it.
- [ ] **Exit 2:** factory calls take milliseconds; JOBS-API v1.3 tests green on Windows and Linux.

## Phase 3: storage to SQLite (D2)

- [ ] **3.1** SQLite schema (WAL, FTS5, vector BLOBs, SQLCipher), implementing every
  repository from 1.2.
  In progress (parallel-ok per D18, on converted aggregates): `PA_DB=sqlite|postgres` (default
  postgres) picks the backend; `src/db/sqlite.js` (better-sqlite3-multiple-ciphers: SQLCipher v4,
  WAL, FTS5; sqlite-vec for `vec_distance_cosine`, JS fallback), `sql-sqlite/` (every table of
  sql/001-038, FTS5 for the tsvectors, event triggers, `lease` for advisory locks),
  `src/repo/sqlite/<aggregate>.js` loaded by `createRepos()` for the sqlite dialect. Every
  aggregate converted so far has its twin (2026-11-08: audio, audit, commitments, drafts, evals,
  events, leases, ledger, meetings, memory, notifications, passkeys, people, projects, proposals,
  runs, search, secrets, sources, spend, system, workflowLimits). Left: the aggregates 1.2 has not
  converted yet; tick with 1.2. Differences SQLite cannot avoid are stated in each twin (FTS5
  bm25 ranks vs ts_rank, ASCII-only `lower()`/`like`, regexes tested in JS, ms timestamps) for 3.4.
- [ ] **3.2** Contract tests from 1.3 green on SQLite.
  In progress: `repoContract.test.js` runs every case on both backends (SQLite: a throwaway
  encrypted file, no server, so CI's matrix runs it on Linux and Windows); a case needing a method
  SQLite lacks is `todo` until `PA_CONTRACT_STRICT=1`, which must pass before this is ticked.
  2026-11-08: strict run green, 884 cases on both backends (every converted aggregate).
- [ ] **3.3 Export from Postgres, copying existing vectors (no re-embedding, D5).** Optional
  int8 quantization is local arithmetic on the copied vectors, not an API call.
- [ ] **3.4 Shadow comparison (D12):** both backends answer the same recorded query set once;
  compare results and latency; recalibrate rerank thresholds.
- [ ] **3.5** Cutover on the personal stack, then the work stack; Litestream backup + restore
  drill.
- [ ] **3.6** WSL off on the work laptop (D6); Postgres removed. Also retire the other WSL
  leftovers: the old termhub `server.js` in WSL (ports 7100/7110) and its watchdog timer, the
  `pa-wsl-keepalive` scheduled task, the unused WSL factory checkout, and any Docker/Rancher
  dependency of the API runtime (OpenHands workspace runs as a local process; 5.2 isolates it).
- [ ] **Exit 3:** one SQLite file per stack, search quality ≥ Postgres on the recorded query set.

## Phase 4: jarvisd

- [ ] **4.1** TypeScript/Bun core absorbs the PA worker, dashboard, MCP server and termhub
  front; strict TS, module by module.
- [x] **4.2** Chat moves to the Agent SDK: approvals become typed callbacks instead of reading
  the terminal screen. (cdae3d5) `PA_CHAT_ENGINE=sdk` (`src/chat/sdkFeed.js`) is the default
  since the gaps closed (055ded3, 28fe6b1, 1e13823, b6a072e); `terminal` stays selectable. Same tools (pa-chat MCP server),
  same surfaces (the Waiting for your yes card on Plan/Build/Ask, a spoken yes on Talk), answers
  stream into `/api/chat/stream`. A PreToolUse hook routes every call through 4.3's policy;
  `canUseTool` waits for an answer, which goes through `policy.enforce`; no answer in 5 min is
  an audited deny. Billing: the SDK's bundled Claude Code uses the machine's Claude login (work
  laptop: Team subscription, `apiKeySource: none`, no API key), and the API keys are stripped
  from its environment. Mock-SDK tests (`test/chatSdk.test.js`) plus two real smoke runs (an
  action tool, and a generic prompt). Closed gaps: any other prompt gets a generic allow-once
  card showing the call's whole input (voice only when it can be heard whole and the policy
  allows); the INBOX doorbell rings it (`POST /api/chat/doorbell`, id only); a read-only Run
  view in termhub follows `pa-home/sdk-view/chat.jsonl`; a Z1 drain denies waiting prompts,
  lets the turn finish (20 s), closes the query, and the next generation resumes by session id.
  Not yet seen: a live deploy roll with the SDK chat mid-turn on a stack (needs a deploy).
- [x] **4.3** Policy engine: every tool call is allow / deny / ask, with an audit log
  (hash-chained). (7621d29) Declarative policy (`src/policy`, tracked defaults plus an untracked
  per-stack override); defaults are the old allow/ask split; a locked rule bars voice from merges,
  pushes to main and secret reveals; `audit_log` (sql/037, `src/repo/audit.js`) and `pa audit verify`.
  Applied at the MCP server, chat permission answers and factory approve; jarvisd (4.1) makes it the
  single in-process gate.
- [ ] **4.4** Supervisor from Z1 becomes jarvisd's own; one executable per OS (T7).
- [ ] **Exit 4:** one process per machine, typed approvals, Z6 deploy test green.

## Phase 5: ptyd and the sandbox (Rust, D1)

- [x] **5.1** `ptyd` in Rust (`portable-pty`), same WebSocket protocol, so the UI keeps working;
  terminals survive jarvisd restarts. (956ce58)
  `ptyd/` speaks sessiond's session protocol; `termhub/test/ptydConformance.test.js` runs one
  black-box suite against sessiond, ptyd and sessiond-on-ptyd, green on Windows and Linux CI
  (job `ptyd`, PTYD_REQUIRED=1). Opt-in `TERMHUB_PTYD=1`: sessiond keeps its PTYs in ptyd and
  adopts them after its own restart (`ptydBackend.test.js`). Left for Exit 5: turn the flag on in
  the start/update scripts (and restart ptyd only on purpose), then retire node-pty; replay is
  raw bytes (sessiond's mirror covers the UI).
- [ ] **5.2** Agent sandbox per run: sandbox-runtime on Linux, restricted account on
  Windows, egress allowlist proxy. Landed behind `FACTORY_SANDBOX` / `PA_SANDBOX` (default
  off): the proxy (cb46b10) and the OS sandbox (421e621): bubblewrap on Linux (used directly,
  not sandbox-runtime: the proxy and broker need our own unix-socket relays), a restricted
  Low-integrity token in a job object on Windows instead of an account (no account created).
  Open before the tick:
  - Windows egress is proxy-routed, not enforced (needs a firewall rule or a separate account:
    an admin step, ask first).
  - Windows: folders every local user can read (`C:\repos`) stay readable until the operator
    runs `python -m factory.sandbox.exec setup --deny-read C:\repos` (an ACL change, ask first).
  - The Linux integration test runs in CI only (bubblewrap); not yet seen green there.
  - PA code modes are refused while sandboxed: the session cannot write the shared `.git`, so
    it cannot commit. Next: the broker commits the session's tree into its mirror.
  - API runtime: the terminal is sandboxed on Linux only (OpenHands' PowerShell probe falls
    back unsandboxed, so Windows refuses); its file editor tool runs unsandboxed.
  - Claude Code needs its model credential inside (`CLAUDE_CODE_OAUTH_TOKEN`); no run has
    used the flag live yet.
- [x] **5.3** Credential broker: keys never enter the sandbox; pushes and PRs go through the
  broker, checked against the run's delivery ceiling. (2031b73, 421e621) Ceilings `none` /
  `push_branch` / `draft_pr` from the delivery level or PA mode; per-owner token via
  `gh_auth`; never runs git in the agent's checkout.
- [ ] **Exit 5:** agents run sandboxed on Windows and Linux; termhub's node-pty host retired.

## Phase 6: factory into TypeScript

- [~] **6.1** Port gate by gate behind the Job contract; Python kept only as an optional
  runtime plugin (OpenHands). — dropped: D15, the factory stays Python as a native daemon.
- [~] **Exit 6:** factory runs in jarvisd; Python not required. — dropped: D15.

## Phase 7: hardening and reach

- [x] **7.1** Passkey sessions; voice never approves merges, pushes to main or secret reveals. (7998d85) Built and tested behind `PA_PASSKEYS=off|on` (default off); enabling it on the live stacks is pending the owner. Recovery: `pa passkeys reset` at a local terminal. The voice rule itself is 4.3's; its enforce() will call `src/auth/stepup.js` (policy wires it).
- [~] **7.2** Per-stack CA and mTLS between machines of one stack. — dropped: D15, Tailscale
  ACLs already separate the stacks.
- [ ] **7.3** Secrets in the OS keychain, labelled by stack.
- [ ] **7.4** Encrypted backups with a restore drill; signed self-update.
- [ ] **7.5** OpenTelemetry into Meter, including the separate Claude subscription credit pool
  (since 15 Jun 2026) with API fallback when it runs out.
- [ ] **7.6** Tauri desktop shell (phone app out of scope, D12).
- [ ] **Exit 7:** install on a fresh Windows and a fresh Linux machine with one install script
  each (jarvisd and ptyd binaries, plus the Python factory via `uv`, which fetches its own
  Python; D15).

## Phase 8: workflow acceptance review (the last phase; D10)

Every workflow the Map lists must actually work, end to end, on the stack it belongs to, and
meet its quality and speed metrics. The registry is `architecture.json`'s `examples` (today:
`whats-on`, `deepseek-pr`, `review-fix`, `teams-ask`, `research`; `phone` is out of scope, D12); a workflow that is
not in the Map is not done, and a new one gets added there first.

- [x] **8.1 Acceptance criteria per workflow** in `architecture.json` (an `acceptance` block on
  each example): the outcome that must happen, the hops and their latency targets, a cost
  ceiling (the JSON value is the default; the user can edit it on the `/architecture` page, stored in the
  PA DB and read from `GET /api/workflow-limits` by the e2e runner, the reviewers and Meter), the views it must show in (Plan, Build, Run, Ask), the approvals policy requires,
  and a quality rubric. Examples: `deepseek-pr` and `review-fix`: PR opened or updated, CI green,
  a code review finds no blocker, the diff stays in scope; `research`: sources cited and
  checked, no unsupported claims, the report answers the question asked; `whats-on`: answered
  locally in under 0.7 s to first audio with correct facts; `teams-ask`: the ask lands on the
  board with the right person, due date and source link. The drift test enforces the block's
  shape.
- [ ] **8.2 `e2e <workflow>`** generalizes E4: runs any registered workflow against the live
  stack (with a dummy input where the real one would touch other people, e.g. a test chat
  instead of a colleague), and collects evidence: per-hop timings, every link, transcripts,
  screenshots of each view, cost.
- [ ] **8.3 Reviewer sessions.** For each workflow, a separate reviewer session (a fresh agent
  that did not implement it, on Claude Code) runs `e2e <workflow>`, inspects the evidence and
  the outputs themselves (reads the PR, the report, the board card), and scores the workflow
  against 8.1. It writes `docs/native/acceptance/<workflow>.md`: pass/fail per criterion,
  measured numbers, evidence links, and defects found. Reviewers run in parallel, one per
  workflow.
- [ ] **8.4 Fix loop.** Every failed criterion becomes an item here; fixed by an implementing
  session; the reviewer re-runs. The Map shows each workflow's latest verdict and date.
- [ ] **8.5 Architecture map review.** A full pass over `architecture.json` (the `/architecture`
  page) against the finished system: every component, process, port, table, tool, workflow and
  storage location as it now runs on both stacks (jarvisd, ptyd, native factory, SQLite,
  supervisor, no WSL); nothing left `planned`/`landing` that has shipped, nothing describing
  removed parts. Checked on the live page of both stacks.
- [ ] **Exit 8 (the plan's finish line):** every workflow in the Map passes its review on its
  stack (work or personal, or both), and the user has watched at least `deepseek-pr`,
  `research` and `whats-on` run live.

## Risks

- Claude subscription billing changed 15 Jun 2026: headless use draws from a separate credit
  pool. Meter must track it.
- Windows sandboxing is the least mature of the two OSes.
- SQLite move: dialect bugs, FTS ranking drift, rerank thresholds need recalibrating (3.4).
- Still moving: MCP auth spec, Tauri mobile, sqlite-vec's nearest-neighbour index (not needed below ~1M
  vectors; exact scan is 10–30 ms).
