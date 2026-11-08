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
| D19 | 2026-11-08 | **Durable tasks on SQLite run on a small queue we own; Postgres keeps Absurd until 3.5** | Part of 3.1. Absurd is a Postgres schema with no SQLite port. `src/durable/sqliteQueue.ts` gives the slice of its interface the PA uses (spawn once per key, `step` checkpoints, `sleepFor`, `awaitEvent` with timeout and Absurd's `TimeoutError`, retries with backoff, scheduled runs) over `sql-sqlite/006` (task, checkpoint and event tables), with leases from the `lease` table, so the spawners and tasks (chase, runReview) do not change. `src/durable/durable.ts` picks the engine by store. |
| D20 | 2026-11-08 | **Cut over to the new system now**: SQLite (3.5), ptyd (Exit 5's switch), jarvisd (runtime and front), WSL off (3.6) | The owner's go-ahead. Passkeys (7.1) and the Windows sandbox's ACL and egress steps (5.2) stay off for now. WSL is shut down and kept registered (not unregistered) so the Postgres rollback stays possible until both stacks have run on SQLite for a while. |
| D21 | 2026-11-08 | **The factory's planning steps run on DeepSeek-V4-Flash** | PM triage took ~146 s on deepseek-v4-pro (a reasoning model); the owner accepts Flash's quality risk for speed. Applies to the planning personas only; dev stays on v4-pro. |
| D22 | 2026-11-08 | **No agent sandbox**: agents keep full access to the machine they run on | The owner's call. 5.2 is dropped and Exit 5 is node-pty's retirement alone. The code behind `FACTORY_SANDBOX` / `PA_SANDBOX` (off) and the credential broker (5.3) stay as they are. |
| D23 | 2026-11-08 | **Exit 7 becomes a one-command install on the work laptop** | No fresh machines: the owner installs Linux later. 7.7 is one command that installs (or reinstalls) the whole stack on this Windows machine, proven by reinstalling here. |
| D24 | 2026-11-08 | **Retire Postgres and WSL now** | After a static copy of each: Postgres's last state as an encrypted `.pabak` per stack, the WSL distro as an encrypted export. Then the work laptop's Ubuntu distro is unregistered and the personal stack's `pa_personal` database dropped (its Postgres server stays: other software uses it). Supersedes D20's "kept registered". |

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

Golden path (E4/E5, claude_session, draft_pr), 2026-11-08 at e013834:

| Hop | Work (run 5) | Personal (E6 run 1) |
|---|---|---|
| card created | 0.2 s | 0.1 s |
| card → job started (factory_start + first poll) | 19.7 s | 14.2 s |
| submit → job started | ≈ 3.4 s, polled at 2 s (77–341 s in runs 1–4) | within the 5 s poll |
| job started → first session output | same poll | same poll |
| job started → PR opened | 1026.8 s | 304.5 s |
| PR opened → CI done (passing) | 151.0 s | 156.5 s |
| card → CI done | 1197.5 s (≈ 20 min) | 475.2 s (≈ 8 min) |

factory_start on the work stack is about 16 s: ≈ 11 s card context, 3.3 s compose (azure/pa), ≈ 1.3 s
submit through serve. The "card context" was routing in a cold process. 8.2.2 brings it to under
0.8 s; compose and submit remain.

E6 variants, 2026-11-08, both stacks on SQLite (3.5), the factory's state outside the repo (2.5),
planning on DeepSeek-V4-Flash (D21: PM triage 9.7 s, SM 10.6 s, was ~146 s for PM). Seconds since
the card was created:

| Variant | Stack | job started | stopped / resumed | PR opened | CI done |
|---|---|---|---|---|---|
| api (deepseek-v4-pro dev) | personal | 16.3 | | 776.4 | 908.1 |
| --resume (cancel mid-step, `job resume`) | personal | 18.0 | 45.4 / 55.8 | 295.6 | 451.3 |
| --branch (continue an existing branch) | personal | 23.8 | | 275.3 | 430.8 |
| --resume | work | 18.3 | 101.7 / 108.7 | 580.6 | 693.5 |
| --branch | work | 19.9 | | 521.3 | 701.7 |
| api | work | 18.4 | | 1707.0 | 1865.1 |

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
- [x] **T3 Factory tests in parallel.** `pytest -n auto` (xdist is installed) must pass with
  the same results as serial. Fix the parallel-unsafe ones (`test_benchmark_record_store.py`
  errors under `-n 16`: shared runs dir). Mark true integration tests `@slow` and keep them out
  of the default run. `parallel-ok` (be7d440, 71a4b7d, 14521ee, 32587f8). Tests that only covered apps/sacrifice and bench/swebench data were deleted (D17); `slow` is off by default, `-n auto` is the default; a fake `claude` guards every test; oracle-boot tests are `flaky_under_load` (run in CI, skipped by the hook). The Linux factory leg gates CI; the full Windows suite is informational (fec5637).
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
  - [x] **T6a** (done, fec5637) software-factory CI leg was informational (continue-on-error) on both OS: on Linux 38 tests fail
    because this public repo does not track apps/sacrifice or bench/swebench (plus the gitignore test
    assumes a repo-root layout), and the suite takes ~10 min on a 2-core runner. T3 skips-when-absent, then
    flip the leg to blocking on Linux; Windows stays informational until phase 2.3.
    Done (fec5637): the tests needing untracked data skip when it is absent (tests/conftest.py), so the
    Linux leg gates; the full Windows suite stays informational (60 min: it never finished in 25); a
    gating `software-factory (windows-latest, 2.x gate)` job runs the native-Windows and JOBS-API files
    (oscompat, serve + API, claude_session rounds, text-step watch, test_jobs_*, test_delivery_*, gh auth,
    power), green on its first run (bf4c2cf).
    The factory's CI watch (draft_pr/pr), `factory job status` ci and the push_to_main main-green
    hold ignore informational checks (factory/ci_scope.py): GitHub required checks when set, else
    `ci_required_checks` in the app config, else everything but `ci_informational_checks` and
    continue-on-error jobs (dev-tools: the full Windows leg, read from ci.yml).
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
  `personal-assistant/src/e2e/deployTest.ts` (spare mode in `test/deployTest.test.js`; `--live
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
- [x] **E3 Live status in all three views.** Card state, job stage and session state update
  within 1 s of a change (SSE from 0.4 / 1.4), including "waiting for your approval" with the
  approve action reachable from Plan, Build and voice.
  Landed in e36357f except one hop: card state (~0.5 s) and Run's session state (≤ 1 s, idle-hub
  tick) meet it, and Approve is on Plan, Build and voice; job stage in Build is 5-6 s for a local
  factory (each `uv run factory` costs ~5 s of Python start-up) until the native factory (2.3)
  calls the PA's `POST /api/factory/events` on each job transition (measured 26 ms to Build).
  Last hop: `factory serve` pushes from its own thread once a tick commits a transition to
  factory.db (statted every 0.1 s; a new `state` or `why` is a change; terminal jobs are skipped
  between 5 s full checks). Measured in `tests/test_serve_push_latency.py` (real story write, real
  `list_jobs`, fake PA over HTTP): 182-404 ms from the write to the PA over 9 transitions, so job
  stage reaches Build in about 0.2-0.45 s. A PA that is down costs a log line, never a transition.
  Measured locally. The live stacks pick it up when serve restarts on the new HEAD. (e88e204)
- [x] **E4 `e2e` command.** One command runs the golden path headless against the live stack,
  creates the dummy card, waits for the PR, asserts every link in E1 resolves in every view's
  API, asserts the API-runtime step produced a watchable session (E2), prints a timing per
  hop (card → job started → first session output → PR opened → CI done), then cleans up.
  `--keep` leaves the PR open for a human look. Prerequisite: the factory machine's `gh` can
  push to this repo with the personal identity.
  (1f1ee4f) `pa e2e [--dry-run|--sweep|--keep|--resume|--branch b|--runtime api --model m|--on machine]`.
  The dry-run was green on the work stack 2026-11-08 at ca701ce, with config, build, plan, run, mcp and
  github all passing.
- [x] **E5 Baseline now.** Run E4 on today's system before phase 1 starts; record the timings
  and every broken hop here as new items. Fix what is broken in phase 0.
  Run 1 (work stack, claude_session, draft_pr, 2026-11-08 03:19Z; card #6758, job dev-tools:004):
  card 0.2 s → job started +108.5 s (factory_start itself took 37 s) → first session output
  NOT REACHED after 600 s. Cleanup ran (job cancelled, card dropped). Broken hops:
  - [x] **E5.1 Plan's /api/state is down.** It returned 500 `repo.sources.calendarToday is not a function` at
    3b37fe1; during the run it and /api/commitments/:id exceeded 30 s. Fixed in 94c4de3: 3b37fe1 was an
    in-between main where a caller landed before its repo method.
  - [x] **E5.2 Planning steps are not watchable (E2).** The job's first step (`sm`, runtime api, state ok)
    had `session: null` even though the job runtime is claude_session, so its planning work never
    shows in Run.
    Fixed in code (717699c, 15cbc74), live after the next deploy: every model step of a job opens
    E2's stream and termhub session, text steps included (PM triage, SM, reviewer: `text_run`), with
    E1 links on a runs row opened at the step's start; PM triage now carries the job's app/direction.
  - [x] **E5.3 Dev step starts late.** After 10 min the dev step (the first session) had not started:
    the factory moves a story one step per 300 s tick. Card to job started took 109 s against a < 1 s target.
  Run 2 (same variant, first_output timeout 1800 s, 04:19Z; card #6759, job dev-tools:005): card 0.3 s,
  then job started NOT REACHED. factory_start took 3 min 19 s, and the job then stayed `queued` until the
  300 s job_started limit (341 s). Cleanup ran (job cancelled, card dropped, no PR).
  - [x] **E5.4 Job start is slow and can stall in queued.** factory_start (compose + submit) took 37 s in
    run 1 and 199 s in run 2, and run 2's job never left `queued` in 5 min. Before 2.2 a queued job waited
    for the next 300 s tick.
    Run 3 on native `factory serve` (2.1/2.2, 9be2b0a, 07:54Z; card #6760, job dev-tools:007): card 0.2 s,
    factory_start took 2 min 19 s, and the job again stayed `queued` past the 300 s job_started limit.
    A concurrent smoke job (dev-tools:006) on the same app was live the whole time, so the job may have been
    serialized behind it (asked factory-native). The live feed delivered 17 run/factory events.
    Run 4 (2d7fdbf, with the E5.2/E5.4 fixes, 09:11Z; card #6761): failed at factory_start with
    `factory bad_output: exit 0, no JSON object on stdout`. Serve's POST /api/cli returns empty stdout for
    `app list --json` (and the submit path), while job list and status are fine. No job was created; the
    card was dropped.
    Run 4 retry (f92a06a, serve with 6e96a0d, 09:17Z; card #6763, run 19, job dev-tools:009): factory_start
    13.5 s (about 7 s card context, 3.7 s compose model call on azure/pa, 2.7 s submit through serve and the
    follow session). So the earlier 2-3 min starts came from factory calls before the serve fixes, not
    from compose. PM and SM steps ran with sessions (E5.2 fixed). The dev step (claude_session, story 7)
    was still dev_in_progress after 50 min, with no job update since 09:20, so I cancelled it at 10:10Z.
    Hops: card 0.2 s → job started +76.9 s → first session output +76.9 s (same poll) → PR not reached.
    Cleanup killed the pm, sm and dev sessions and dropped the card. Defects:
  - [x] **E5.6 A headless dev step waits on a notification that never comes.** The `claude -p` dev session
    started the gate suite with run_in_background, said "waiting for completion notification" and ended
    its turn (result success, twice). In -p mode a background task's notification never reaches the
    session, so the step sits in dev_in_progress. Headless runs need foreground gate commands (or a
    setting that forbids background tasks).
  - [x] **E5.7 The dev-tools app's gate is the whole software-factory pytest suite.** For a
    personal-assistant change, the dev session ran in `<worktree>/software-factory`, installed its dev
    extra and ran the full suite, which took over 10 min and hung at 98%. A monorepo app needs a gate
    per changed tool (personal-assistant: `npm test`).
  - [x] **E5.8 Step sessions carry no E1 links in termhub.** GET :7000/api/sessions shows `links` empty
    on every factory step session (pm, sm, dev of dev-tools:009), so Run cannot lead back to the job
    or step. Fixed by 7e9bbb8 once the work sessiond was restarted (by the owner, 2026-11-08):
    the work stack's e2e of dev-tools:013 showed every step session listed with its job and
    step links.
  - [x] **E5.5 factory serve returns empty stdout for some CLI commands** (`app list --json`, the submit
    path), so nothing can be dispatched through serve (sent to factory-native).
    factory-native: yes, serialized. One tick per app at a time, and a tick runs agent steps
    synchronously: 006's tick (with its onboarder inside) held dev-tools for 339 s, so 007's triage
    waited. Measured on serve after 2.2 (dev-tools:008, alone on the app): submit 1.3 s, wake tick
    +2 s, PM triage call starts +7.9 s; with 15cbc74 that step's runs row opens at its start, so
    job_started reads ~8 s. The PM call itself takes ~146 s (azure/deepseek-v4-pro). Left: (a) a
    new job's triage should not queue behind another job's long step on the same app (a separate
    intake lane in serve); (b) the PA's factory_start (compose + submit) took 2-3 min in runs 2-3:
    needs PA-side timing to split compose from submit (submit through serve is ~1-2 s).
  Run 5 (work, e013834, 10:27Z; card #6764, job dev-tools:011, PR #25): every hop was reached. Timings
  are in the Targets section. The view checks pass except Run's session links (E5.8: the old sessiond,
  restart pending) and the Plan board check. That one was a checker bug, fixed here: a delivered card
  closes (dispatched → done) and leaves the open board, so it is now found in `closed`. Cleanup closed
  PR #25 with its branch, killed the sessions and dropped the card. E5.5, E5.6 and E5.7 are fixed
  (6e96a0d, 0df2bb1); factory_start (a) and (b) above are resolved by the warm triage lane (e013834)
  and the 16 s measured start.
- [x] **E6 Gate.** Each phase's Exit box below requires a green E4 run (all variants) on both
  stacks, with the timings recorded in the targets table. Green on both stacks, all four
  variants, 2026-11-08 (the work api variant at 73e824d, dev-tools:017, PR #60). The gate
  itself stays: each Exit box still needs its own green run.
  First gate run, 2026-11-08, claude_session variant only: personal stack green (`pa e2e --on <personal
  machine>`, card #1, job dev-tools:001, PR #28, CI passing, every link resolved, cleanup ran). Work
  stack: every hop reached; links green except E5.8.
  Variants, same day (timings in the Targets section): the personal stack is green on all four
  (claude_session, api, --resume, --branch); the work stack on claude_session, --resume and
  --branch. Fixed on the way: --resume first killed the PM step's read-only viewer (3dbeff5), then
  killed the dev session, which the factory replaces by itself within ~30 s; it now stops the run
  with the factory's own `job cancel` and resumes it (305665a); worktree names overran MAX_PATH
  under the moved state dir (c6f2c44). The work stack's api variant took two runs. The first
  (dev-tools:013) ran the API dev step inside serve's tick, which serve killed at 3600 s, and every
  retry then failed on the dead attempt's worktree (fixed: 0772cec, a1b1cab, 5e2228f). The second
  (dev-tools:017) was green, slowly: PR at 1707 s, CI done at 1865 s, after an Azure
  content-filter refusal on deepseek-v4-pro (retried by the factory) and a hung commit.
  - [x] **E6.1 The API dev agent breaks the shell and hook rules on Windows.** It hangs
    PowerShell at a `>>` prompt with multi-line `-m` arguments (minutes of Ctrl-C each), commits
    with --no-verify, and once pushed and opened a PR itself (#43, closed). The prompt says not
    to (73e824d) and dev-tools:017 did it again, so this needs a guard in the runtime: detect a
    continuation prompt and answer the agent at once, and refuse `--no-verify`, `git push` and
    `gh pr` in the API terminal (delivery is the factory's).
    Done: `factory/terminal_guard.py` replaces the API agent's `terminal` tool (same name and
    params, after the sandbox rewrite; on Windows and Linux, not claude_session). Before the shell
    sees a command it refuses, with an immediate tool error that says what to do instead: a newline
    inside a quoted argument (PowerShell: any newline, an unterminated quote or bracket, a trailing
    pipe); `--no-verify`, `git commit -n`, `core.hooksPath`, `DEVTOOLS_SKIP_TESTS`; `git push`;
    `gh pr` other than view/list/status/checks/diff/checkout; `gh api` other than GET (also inside
    `bash -c`, `pwsh -Command`, `python -c`). Ctrl-C did not clear the `>>` prompt in dev-tools:017
    (only a reset did), so an observation stuck at `>>` on PowerShell resets the terminal and
    returns the error; tested against a real PowerShell. If the guard cannot install, the run is
    refused (fail safe). (e2b0323)
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
- [x] **0.7** T1, T2, T3 and Z1 landed (from the tracks above). (T1 5bc7a6d, T2 d3f7a19, T3 32587f8, Z1 262f4ab)
- [x] **0.8** E1, E4 and E5 landed: the golden path runs on today's system and its broken hops
  are fixed. E2 (watchable API runs) lands here too if the baseline shows it missing.
  2026-11-08: E1, E4 and E5 have landed, and the golden path is green on the personal stack. On the work
  stack E5.8 was the last; its links showed after the owner's sessiond restart (see E5.8).
- [ ] **Exit 0:** measured again; targets table updated with new numbers.

## Phase 1: contracts and the repository layer

- [x] **1.1 JSON Schemas (D15)** for Job, Run, Card, Event, Approval, mirroring JOBS-API v1.4
  and the MCP tools. One source; TS types generated; Python and Rust validate against it. (52d2b79, ca701ce)
  `schemas/*.schema.json` at the repo root; `schemas/gen-types.js` writes `types.d.ts`; the PA
  validates with the dependency-free `schemas/index.js` (it throws on any keyword it does not
  implement, so it never means less than Python's), the factory with `factory/contract_schemas.py`
  (`jsonschema`). Tested on both sides against real objects (job status, chainOf/runChain, card
  and board views, bus frames, permission prompts). Rust validates when Rust lands (phase 5).
- [x] **1.2 Repository interface** over today's Postgres: every one of the ~590 SQL call sites
  goes through a typed repository method. No behaviour change. (c664f1d ... 5d4c7a2)
  Scope: the PA only (579 sites in 69 modules; termhub has no SQL). The factory keeps its own
  SQLModel/SQLite store: it is Python and stays so (D15), JOBS-API v1.4 already keeps the PA out
  of it, and it is SQLite already, so phase 3 has nothing to move there. Shape: `src/repo/<aggregate>.js`
  exports `create(db)` with named, JSDoc-typed methods; `repo.withTx(fn)` gives `fn` the set bound
  to one transaction; the default set resolves `src/db` at call time, so tests that stub `src/db`
  keep working. SQL text moves verbatim. `test/repoBoundary.test.js` fails on SQL (or a `src/db` or
  `pg` require) anywhere outside `src/repo` and `src/db`, except the few POOL_ONLY modules that hold a
  connection; `test/repoCalls.test.js` fails on a `repo.<agg>.<method>(` call whose method does not
  exist (a575804).
  Chunks: A meetings (0e6f2c7), B memory/search (4dd952a), C commitments (ca2d764), D ledger,
  proposals, drafts, secrets (d251fa7, a15c566, 8a4d936), E dispatch/durable/e2e/mcp (5d4c7a2),
  F ingest/repos/routines (3e590f5), G cli/dashboard/fastLane (a562a4b), eval and backup (d557ad6),
  notify, lease, budget, worker (cbafe98).
- [x] **1.3 Contract tests** for every repository method, runnable against any backend. This is
  the oracle for phase 3. (c664f1d; strict on SQLite since da223d5)
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
- [x] **Exit 1:** all SQL behind repositories; contract tests green on Postgres. 1.1-1.4 done,
  the contract green on Postgres and SQLite in CI (main at c0c2a3e), and the E6 gate green on
  both stacks on 2026-11-08.

## Phase 2: factory as a daemon

- [x] **2.1** The current Python factory runs as a long-lived JSON-over-HTTP service (no process
  spawn per call). (b766d54, a916c69, aaa8120)
  `factory serve` answers `POST 127.0.0.1:7330/api/cli {argv}` (X-Factory: 1), the same CLI
  command in-process, so the JSON is byte-identical; 40-200 ms warm vs 5-10 s per `uv run`
  (measured live 2026-11-08: job status 0.4-0.6 s under load). Read-only verbs run concurrently
  (per-thread output capture), state-changing ones one at a time. The PA's `call()` tries it
  first (PA_FACTORY_SERVE_URL) and spawns only when nothing ran. Live on both stacks (ab9588f).
- [x] **2.2** An in-process scheduler with DB leases replaces systemd timers and `fcntl` locks.
  (d44ffe1, 0a245c7, b766d54, af171ee, d2cfef1, 166964e)
  Landed with 2.3 (d44ffe1, 0a245c7): `factory serve` (fresh tick subprocess per app every 300 s,
  wake within 1 s of job submit/resume via `state/scheduler/wake.d`, in-process research/report
  dispatch) and portable locks in `factory/oscompat.py` (flock / LockFileEx). Then (b766d54,
  af171ee): a SQLite lease (`state/scheduler/leases.db`, 30 s TTL, dead-pid takeover); restart on
  new code (exit 75; `--supervise` on Windows, since Task Scheduler does not restart a non-zero
  exit); a tick that moved a story re-wakes its app, so a chain advances step to step at once
  (capped at 30 consecutive; the 300 s tick is the backstop). E3's push to the PA
  (`/api/factory/events`, < 0.5 s after a transition is committed to factory.db) rides in serve. Serve
  ticks only apps with `serve_tick: true` (166964e); `factory on/off` manage it. Linux runs
  `factory-serve.service` instead of the tick timers (personal stack, 2026-11-08). Measured on the
  work stack, the same docs job (dev-tools, claude_session, draft_pr) from submit to draft PR
  opened: ~13 min on 300 s ticks (dev-tools:003) -> 7.6 min with wake-on-progress (dev-tools:008:
  triaged +157 s, onboarder done +325 s, PR #18 at +455 s; closed, branch deleted). The rest is
  agent and gate time, not waiting. A git worktree timeout (30 s) found on the way is now 600 s
  (d2cfef1).
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
- [x] **2.4 Per-app context root.** The onboarder and other personas write `context/` at the
  app repo root (hard-coded ~200 times). Route every context path through `canonical_paths`
  and honour `AppConfig.context_dir`, so a monorepo app (dev-tools) keeps its context under
  `software-factory/apps/<app>/`. Found in the 2.3 smoke (a docs-typed job wrote `context/`
  into the dev-tools repo); code jobs don't hit it. Done: `canonical_paths.context_path` /
  `context_files` / `canonical_context_paths` / `forbidden_doc_patterns` take the root; the
  loader, enforcer, updater, context refresh, docs chain, dev/onboarder/PM runs and the
  persona prompts (`{{context_dir}}` placeholder) all use `AppConfig.context_dir`;
  `apps/dev-tools` sets `software-factory/apps/dev-tools/context` (tracked, like
  `apps/factory`). `tests/test_context_root.py` pins default-identical paths and fails on a
  new hard-coded `context/` literal. `prd.md` and `stories/` stay at the app repo root.
  2026-11-08: a dev-tools onboarder (story 8, API runtime) climbed from its worktree
  (`software-factory/state/worktrees/...`, inside the live checkout) and wrote its context set
  into the live tree; the 10 stray files were deleted. Guard landed (e2bcf93,
  `factory/live_tree_guard.py`): files an agent writes into the live checkout are moved into its
  worktree and reported, and every sandbox prompt pins writes to the working directory.
- [x] **2.5 State outside the repo.** (d4e8416) Story worktrees, agent run dirs and job
  workspaces lived under `software-factory/state/`, so for dev-tools every agent cwd was inside
  the live checkout the PA, termhub and the factory run from. `factory/state_dir.py`
  `state_dir(root)` = the gitignored `<root>/.state-dir` pointer > `<root>/state`; no
  environment override (serve's children would carry it into a story worktree or staging clone
  of dev-tools, a second factory copy, and point it at the live state). The ~120
  `<root> / "state"` sites go through it, the `db.parent.parent` root inferences through
  `root_for_db`, stored acceptance refs (`state/acceptance/...`) resolve into the state dir.
  `factory state migrate [--to] [--dry-run]` (operator only: install-serve.ps1 just warns)
  renames `state/*` except the tracked `.gitignore` to `%LOCALAPPDATA%\software-factory\state`
  (`~/.local/share/...` on Linux), refuses while a lock or the DB is held, or for a target in
  the repo, non-empty or on another filesystem, undoes a failed rename, writes the pointer and
  re-links the worktrees (`git worktree repair`); `factory state where`; serve refuses a pointer
  to a missing dir. The PA reads the same pointer (`resolveStateDir`, `factoryPace.ts`; the
  backup bundle keeps the dir's own name). Full suite on Windows: 4157 passed, 202 skipped, 4
  failed (three pass alone; `test_no_first_write_watchdog_pauses_and_still_grades` fails the
  same on main, a wall-clock budget). Migrated on both machines 2026-11-08 (~17:00Z) with serve
  and the PA worker stopped, per docs/WINDOWS.md: work 29 MB to `%LOCALAPPDATA%`, personal to
  `~/.local/share/software-factory/state`; serve ticks every app from there and each repo's
  `state/` holds only `.gitignore`. On Windows `factory off` disables the serve task but leaves
  its processes running, so stop the task (`Stop-ScheduledTask factory-serve`) and its
  `factory serve` processes before migrating. Six personal `context-refresh` worktrees of an
  untracked app failed to re-link; their git metadata had been pruned long before.
- [ ] **2.5b Real dev-tools context through a docs job (open).** After 2.5, file a docs job so
  the onboarder writes `software-factory/apps/dev-tools/context/` in a worktree and delivers it
  as a PR (context is tracked by design; do not gitignore it).
- [ ] **Exit 2:** factory calls take milliseconds; JOBS-API v1.3 tests green on Windows and Linux.

## Phase 3: storage to SQLite (D2)

- [x] **3.1** SQLite schema (WAL, FTS5, vector BLOBs, SQLCipher), implementing every
  repository from 1.2. (d0fd5d9, 2eac0c0, a727675, 817002c, 9e36796, b590afa, 631337e)
  `PA_DB=sqlite|postgres` (default
  postgres) picks the backend; `src/db/sqlite.js` (better-sqlite3-multiple-ciphers: SQLCipher v4,
  WAL, FTS5; sqlite-vec for `vec_distance_cosine`, JS fallback), `sql-sqlite/` (every table of
  sql/001-038, FTS5 for the tsvectors, event triggers, `lease` for advisory locks),
  `src/repo/sqlite/<aggregate>.js` loaded by `createRepos()` for the sqlite dialect. Every
  aggregate of 1.2 has its twin (2026-11-08, through chunk E: audio, audit, commitments,
  drafts, durable, evals, events, factoryBoard, leases, ledger, meetings, memory, notifications,
  passkeys, people, projects, proposals, repos, routines, runs, search, secrets, sources, spend,
  system, workflowLimits). Durable tasks run on SQLite's own queue (D19, `sql-sqlite/006`,
  `src/durable/sqliteQueue.ts`, `test/durableSqlite.test.js`), so `durable.stats` and
  `commitmentsWithoutChase` work there too, with contract cases. Differences SQLite cannot avoid are stated in each twin (FTS5
  bm25 ranks vs ts_rank, ASCII-only `lower()`/`like`, regexes tested in JS, ms timestamps) for 3.4.
- [x] **3.2** Contract tests from 1.3 green on SQLite. (d0fd5d9, 9193e5d, 1adf02f, b590afa)
  `repoContract.test.js` runs every case on both backends (SQLite: a throwaway encrypted file, no
  server, so CI runs it on Linux and Windows, and a SQLite skip in CI fails). 2026-11-08: 1182
  cases green on both. Strict is now the default: a repository method without its SQLite twin
  fails (`PA_CONTRACT_STRICT=0` brings back `todo` for local work in progress).
- [x] **3.3 Export from Postgres, copying existing vectors (no re-embedding, D5).** Optional
  int8 quantization is local arithmetic on the copied vectors, not an API call. (22c70ef)
  `pa db export --to sqlite <file>` (`src/db/export.js`): one read-only REPEATABLE READ snapshot
  of Postgres into a new SQLite file (encrypted when `PA_SQLITE_KEY` is set). Every table,
  ids kept; vectors parsed from pgvector text to the same float32 values; FTS5 filled by its
  triggers; event triggers off during the copy and `pa_event_seq` continued; Absurd's queue
  copied into the SQLite queue (D19: tasks with keys, states, results, committed checkpoints,
  pending waits with deadlines, emitted events). Verified after: row count per table, 50 sampled
  vectors per vector column compared value for value, chunk_fts = chunks, foreign keys checked.
  Int8 quantization not done (not needed: 427 MB). Work stack, 2026-11-08, into a scratch file:
  51 tables match (chunk 31,229, llm_spend 103,251, claim 10,148, fact 11,364, ...), 216 vectors
  sampled with 0 differing, 93 durable tasks, 399 checkpoints, 1,166 events, 0 FK violations;
  105 s, 427 MB (Postgres: 908 MB). `test/dbExport.test.js` runs in CI's contract job.
- [x] **3.4 Shadow comparison (D12):** both backends answer the same recorded query set once;
  compare results and latency; recalibrate rerank thresholds. (7b63313)
  `pa db compare --sqlite <file> [--json]` (`src/db/shadow.js`): Postgres read-only (every
  statement under `default_transaction_read_only`) against a fresh `pa db export`, through the
  repository methods search, recall and the board use. Query set: the 58 active `eval_case`
  questions (48 with gold items) plus the 23 recorded searches in `query_embedding_cache` (with
  their vectors, so no embedding call). Work stack, 2026-11-08, export then compare at once:
  - Board reads (open asks both ways, inbox, notification feed, recent runs, pending proposals):
    identical rows in identical order, 6 of 6.
  - Overlap of top results: people 1.000, memory claims and pages (lexical) 1.000, claim and page
    vectors 1.000, chunk vectors 0.981 (Postgres is an approximate HNSW index; SQLite's two-stage
    scan returns 0.988 of its own exact top results). Chunk lexical 0.385 and fused 0.409:
    FTS5 porter + bm25 ranks differently from `english` + ts_rank.
  - Quality, on the eval cases' gold items (fused text + meaning + people, top 10): SQLite
    hit@10 0.729, MRR 0.476; Postgres hit@10 0.625, MRR 0.413. The difference in lexical ranking
    is a gain, not a loss.
  - Latency p50 / p95 (ms), Postgres vs SQLite: chunk lexical 1340 / 3449 vs 892 / 1634; chunk
    vector 20 / 30 vs 81 / 96; claim vector 15 / 27 vs 36 / 48; claim lexical 4.5 / 12 vs 1.3 / 4.2;
    page lexical 3.1 / 5.7 vs 0.9 / 2.8; page vector 6.3 / 12 vs 2.9 / 4.7; board reads 2-7 vs
    0.4-3.6. The first run had chunk vector at 528 ms p50 (an exact cosine scan over 31k vectors),
    so this item adds `sql-sqlite/007_vector_bits.sql`: each vector's sign bits in a narrow table
    (derived locally, D5), ranked by Hamming distance (sqlite-vec), the best 400 re-ranked by
    exact cosine. That brought it to 81 ms with the exact scan's top results kept (above).
  - Thresholds: none to recalibrate. Fusion is reciprocal-rank (positions, not scores), and
    recall's abstain threshold (`PA_RECALL_ABSTAIN`, 0.6) is on the reranker's own scores, so
    ts_rank and bm25 scales never meet a threshold. Nothing outside `src/repo` reads `rank`.
  - Follow-up (same day): chunk lexical on SQLite went from ~0.9 s to 61 ms p50 (Postgres: 0.9 s)
    by ranking narrow columns before reading text, taking each FTS index's best 2,000 chunks
    when no filter applies (identical results to ranking every match on all 162 query/mode
    pairs), Postgres's English stop words, and the stemmed index only for the loose pass.
    The eval rose with it: hit@10 0.771, MRR 0.519 (Postgres 0.625, 0.413). Chunk vector:
    42-54 ms p50 (Postgres's approximate HNSW 16-21 ms); an index can come past ~1M vectors.
- [x] **3.5** Cutover on the personal stack, then the work stack; Litestream backup + restore
  drill. Done 2026-11-08 on both stacks (personal 14:53Z, work 15:01Z), drill PASS on both
  (CUTOVER-SQLITE.md, "The cutover on 2026-11-08"). The runbook is
  [CUTOVER-SQLITE.md](CUTOVER-SQLITE.md): rehearse, stop writers, export, compare, set
  `PA_DB=sqlite`, start, verify, rollback by unsetting it. Backups for SQLite are in place instead
  of Litestream, which cannot read a SQLCipher file and has no supported Windows build:
  - `VACUUM INTO` snapshots; `pa-latest.sqlite` refreshed hourly
    (`PA_SQLITE_SNAPSHOT_MINUTES`);
  - the nightly encrypted bundle;
  - `pa backup restore --to <file>` as the drill.

  Tested at work-stack size: a 453 MB snapshot in 6 s, the bundle in 10 s, the drill PASS in
  10-12 s. Also ready: live-feed events from other processes arrive through a 500 ms outbox
  poll, `pa doctor` reports the SQLite store, and `PA_SQLITE_KEY` resolves from the OS vault.
  Worker rehearsal (2026-11-08, work laptop, details in the runbook): a second worker on a fresh
  encrypted export, port 7399, `PA_ONLY_PASSES` (new) limiting it to memory, routines, durable,
  backup and retention, Postgres URL pointed at a closed port, no toasts or pushes.
  - Over 12 minutes: healthz 63/63 (median 35 ms), 0 Postgres sockets, 0 pass failures.
  - The durable queue ran the chases copied from Absurd; the memory pass wrote pages.
  - Backup snapshot and bundle written; the drill PASS.
  - Live feed: a cross-process event and `Last-Event-ID` replay both work.
  - The factory board refreshed read-only.

  The first tries found three problems, fixed before it (b0b3a8e, 4510d82):
  - a 69 s pages query blocking the event loop;
  - the snapshot on the main thread;
  - the live-feed listener opening its own Postgres connection, read-only, to the live store.
- [x] **3.6** WSL off on the work laptop (D6); Postgres removed. Also retire the other WSL
  leftovers: the old termhub `server.js` in WSL (ports 7100/7110) and its watchdog timer, the
  `pa-wsl-keepalive` scheduled task, the unused WSL factory checkout, and any Docker/Rancher
  dependency of the API runtime (OpenHands workspace runs as a local process; 5.2 isolates it).
  Done 2026-11-08 after 3.5, per D20: the WSL termhub and its watchdog timer disabled inside
  WSL, `pa-wsl-keepalive` disabled, a stray test server from an old worktree ended, then
  `wsl --shutdown`; nothing listens on 5433/7100/7110 and the PA, termhub and factory run
  without it (Rancher's distros were already stopped; an e2e job's API dev step,
  dev-tools:013, kept running across the shutdown).
  Postgres is stopped with the distro, not uninstalled: the distro stays registered so the
  rollback to Postgres stays possible (`wsl --unregister Ubuntu` is the last step, later).
  The only code that still reaches WSL is the Postgres backup path (`PA_PG_TOOLS`), unused
  on SQLite. The architecture map drops the WSL termhub.
  Retired for good the same day (D24): a final encrypted `.pabak` of each stack's Postgres
  (work: restore drill PASS, 52 tables, from a template database since the role cannot create
  the vector extension; personal: decrypted and all 58 tables listed by `pg_restore`), the
  Ubuntu distro exported (28 GB) and sealed with the backup key (decrypt round trip, same
  sha256), then `wsl --unregister Ubuntu`, the `pa-wsl-keepalive` task removed, and
  `pa_personal` dropped. The copies are in the PA data dir's `retired/` on each machine.
  Rancher Desktop's own two distros are left alone: they belong to that app.
- [x] **Exit 3:** one SQLite file per stack, search quality ≥ Postgres on the recorded query set.
  Both stacks on one encrypted SQLite file since 3.5 (2026-11-08); on the recorded set SQLite
  scores hit@10 0.771 and MRR 0.519 against Postgres's 0.625 and 0.413 (3.4); WSL off (3.6);
  the E6 gate green on both stacks on SQLite the same day.

## Phase 4: jarvisd

- [x] **4.1** TypeScript/Bun core absorbs the PA worker, dashboard, MCP server and termhub
  front; strict TS, module by module. Done: the PA's server-side modules are strict TS (browser
  files and entry shims stay JS; chunk D, dispatch, durable, e2e and audio, finished with
  1659567), the dashboard has one typed router, and `jarvisd front` runs
  termhub's front under Bun 1.4.4 with its tests (and the front swap) in the parity set
  ([JARVISD.md](JARVISD.md) Status). termhub's front and lib are TS too. Both stacks run the
  PA as the compiled jarvisd and termhub's front as `jarvisd front` since 2026-11-08 (D20).
  Left: the in-process front (Exit 4), ES exports and `pa` as a thin client. The
  `supervisor.test.js` flake under load is fixed (92a25c8).
  Design and order: [JARVISD.md](JARVISD.md). Stage 1 (host) landed: `jarvisd/` (strict tsconfig,
  Bun pinned in its package.json) boots the PA worker unchanged under Bun; the PA's own tests run
  under Bun (`jarvisd/scripts/parity.js`; the contract on SQLite and Postgres, since Bun 1.4.4
  loads the SQLite addons); `node scripts/build.js --only jarvisd` makes one executable (`--check` smoke);
  CI runs it on Windows and Linux. Next: the supervisor forks a jarvisd generation, then modules
  become `.ts` leaves first (repo, events, policy, schemas types; then dashboard, MCP, passes; the
  termhub front last).
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
- [x] **4.4** Supervisor from Z1 becomes jarvisd's own; one executable per OS (T7).
  `jarvisd supervise` runs the supervisor (now strict TS, `src/supervisor/index.ts`) and rolls
  generations of itself; supervisor, deploy lock and the Z6 spare-port deploy test pass with the
  compiled binary in CI's jarvisd job on Windows and Linux (run 42466776763). Live stacks still
  run `node src/supervisor` until switched. (276a21c)
- [ ] **Exit 4:** one process per machine, typed approvals, Z6 deploy test green.

## Phase 5: ptyd and the sandbox (Rust, D1)

- [x] **5.1** `ptyd` in Rust (`portable-pty`), same WebSocket protocol, so the UI keeps working;
  terminals survive jarvisd restarts. (956ce58)
  `ptyd/` speaks sessiond's session protocol; `termhub/test/ptydConformance.test.js` runs one
  black-box suite against sessiond, ptyd and sessiond-on-ptyd, green on Windows and Linux CI
  (job `ptyd`, PTYD_REQUIRED=1). Opt-in `TERMHUB_PTYD=1`: sessiond keeps its PTYs in ptyd and
  adopts them after its own restart (`ptydBackend.test.js`). On for both stacks since
  2026-11-08 (`TERMHUB_PTYD=1`, adbe9ff; JARVISD.md runbook): ptyd runs as the termhub-ptyd
  task / unit, and a work-stack terminal outlived a sessiond restart. Left for Exit 5: retire
  node-pty; replay is raw bytes (sessiond's mirror covers the UI).
- [~] **5.2** Agent sandbox per run: sandbox-runtime on Linux, restricted account on
  Windows, egress allowlist proxy. — dropped: D22 (the code stays, off). Landed behind `FACTORY_SANDBOX` / `PA_SANDBOX` (default
  off): the proxy (cb46b10) and the OS sandbox (421e621): bubblewrap on Linux (used directly,
  not sandbox-runtime: the proxy and broker need our own unix-socket relays), a restricted
  Low-integrity token in a job object on Windows instead of an account (no account created).
  Open before the tick:
  - Windows egress is proxy-routed, not enforced (needs a firewall rule or a separate account:
    an admin step, ask first).
  - Windows: folders every local user can read (`C:\repos`) stay readable until the operator
    runs `python -m factory.sandbox.exec setup --deny-read C:\repos` (an ACL change, ask first).
  - Linux is verified in CI only (bubblewrap on the runner; the integration tests pass there
    since 3948e2d), not yet on the personal stack's machine.
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
- [ ] **Exit 5:** termhub's node-pty host retired (the sandbox half dropped: D22).

## Phase 6: factory into TypeScript

- [~] **6.1** Port gate by gate behind the Job contract; Python kept only as an optional
  runtime plugin (OpenHands). — dropped: D15, the factory stays Python as a native daemon.
- [~] **Exit 6:** factory runs in jarvisd; Python not required. — dropped: D15.

## Phase 7: hardening and reach

- [x] **7.1** Passkey sessions; voice never approves merges, pushes to main or secret reveals. (7998d85; Approve with passkey button on Plan and Build, a141d7a) Built and tested behind `PA_PASSKEYS=off|on` (default off); enabling it on the live stacks is pending the owner. Recovery: `pa passkeys reset` at a local terminal. The voice rule itself is 4.3's; its enforce() will call `src/auth/stepup.js` (policy wires it).
- [~] **7.2** Per-stack CA and mTLS between machines of one stack. — dropped: D15, Tailscale
  ACLs already separate the stacks.
- [x] **7.3** Secrets in the OS keychain, labelled by stack. (0b6faff) Pending user: the live
  `pa secrets migrate --from-env --apply` on each stack (dry run first).
- [x] **7.4** Encrypted backups with a restore drill; signed self-update. (0b6faff) The first
  drill ran on each stack on 2026-11-08, on SQLite after 3.5 (PASS on both; neither stack had a
  backup key before, so both got one); signing is warn-only until a trusted-signers
  file exists (docs/native/SIGNED-UPDATES.md). The SQLite-file backup/drill lands with 3.x.
- [x] **7.5** OpenTelemetry into Meter, including the separate Claude subscription credit pool
  (since 15 Jun 2026) with API fallback when it runs out. Spans (voice turn, tool call, factory
  CLI call, deploy; the Python factory's hops posted to `POST /api/telemetry`) land in
  `trace_span` through a local exporter; Meter shows p50/p95 per hop and spend per
  day/model/purpose; `PA_CLAUDE_POOL_USD` tracks the credit pool, and
  `PA_CLAUDE_POOL_FALLBACK_API=1` (default off) moves `claude_session` jobs to the `api` runtime
  once it is spent.
- [x] **7.6** Tauri desktop shell (phone app out of scope, D12). (d779847, 7b75f93)
  `desktop/` (Tauri 2): the stack's browser shell in its own window, tray, OS notifications from
  /api/events (approval, secret, draft, run waiting/landed/failed), optional start at login, and a
  work/personal switcher (one stack connected at a time, separate webview data). Installers come
  from `scripts/build.js` and CI's `build` job: NSIS on Windows, .deb on Linux, both built in run
  42462406341. Later Windows runs failed only on github.com release downloads (504), so the CI
  job now caches Tauri's NSIS tools and retries. Not installed on either machine.
- [ ] **7.7 One-command install (D23).** One command installs or reinstalls the whole stack on
  a Windows machine: PA (jarvisd), termhub (jarvisd front, ptyd), the factory (`uv`, which
  fetches its own Python; D15) and their tasks, idempotent, keeping data, `.env` and the vault.
  Proven by reinstalling on the work laptop. A Linux twin comes later.
- [~] **Exit 7:** install on a fresh Windows and a fresh Linux machine with one install script
  each (jarvisd and ptyd binaries, plus the Python factory via `uv`, which fetches its own
  Python; D15). — dropped: D23, replaced by 7.7.

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
  (65e500e) `pa e2e <workflow> [--dry-run]`, `pa e2e all --dry-run`; evidence in
  `<PA data dir>/e2e/<stamp>-<workflow>/summary.json`. Status on the work stack, 2026-11-08:
  - whats-on: dry run OK. Real run (09:09Z): answered locally (route answer, $0), fast lane first
    words 669 ms (target 200), first audio 1682 ms (target 700). Both are lower bounds, because:
  - [x] **8.2.1 Talk transcription is always empty on the work stack.** POST /api/talk/transcribe
    returns `{"text":""}` in about 4 ms for any WAV. The transcriber's log shows WinError 10054 and
    `No such file or directory: C:\Temp\pa-talk-<pid>-….wav`. The generation's socket closes early,
    askWhisper resolves that as empty text, and the WAV is deleted before whisper opens it. The same file
    sent to :47821 directly is transcribed in 300-600 ms. askWhisper also turns a transcriber
    error into a silent empty answer. Bun only: after the rollback to Node (PA_RUNTIME=node, 2d7fdbf)
    the same WAVs come back "What's on today?" (whisper 740-1014 ms). Root cause confirmed: Bun's
    socket.end() closes instead of half-closing; fixed on both runtimes, test in Bun parity. (2aad672)
  - research, deepseek-pr, review-fix: dry runs fail on `factory app list --json`. Through factory
    serve's /api/cli it returns code 0 with empty stdout; job list and status are fine (sent to
    factory-native).
  - teams-ask: dry run OK. A real run needs a test chat with only you in it, so it is refused.
  - research: dry run OK. Real run (e013834, 11:56Z; card #6765): report.md delivered with file:line
    citations, no PR, $0. Research conversation 75.7 s; tool call 13.5 s (target 1 s); approval to
    "started" 3.4 s (target 1 s). Run links failed only on E5.8. Evidence:
    `e2e/20261108T115604Z-research/` (report, transcript, 3 screenshots).
  - [x] **8.2.2 factory_start spends ~11-13 s before any model call.** Research has no compose step,
    yet the tool call took 13.5 s. In golden-path runs, about 11 s of factory_start goes to gathering
    the card's context before compose (3.3 s) and the submit (~1.3 s). Profile the card-context step
    (dispatch/brief) against the 1 s tool-call target. (002f99e)
    - Cause: there is no card-context model call on this path. The time went to routing, and every
      chat MCP process and every `pa e2e` run starts cold. `factory app list` through serve answers
      empty (above), so each new process fell back to a `uv run factory` spawn: 2.8 s warm, 14.2 s
      cold. For a checkout path, `gh repo view` ran on every call and every run (1.1-1.8 s). A card
      from a mail, chat, Jira or PR thread also paid `relatedInThread`: a full scan of source_item,
      3.1-4.2 s on a 634 MB store.
    - Fix: the app list and each checkout's owner/name (refreshed at most daily) are now kept in the
      store's setting table (`factory.apps`, `dispatch.repo_slugs`). A stale list answers at once
      and refreshes in the background; an app the list lacks is asked for again before anything is
      refused. The app list and gh run in parallel when neither is stored. `relatedInThread` uses
      the thread index (6 ms). codeHints runs ls-files and grep in parallel. factory_start now
      answers `timings_ms` (route, prepare, gather, compose_model, submit, follow).
    - Measured on a scratch store with the model and submit stubbed and app list stubbed at 2.8 s.
      Before: a new process took 3.7 s (owner/name) or 6.2-6.4 s (checkout); a warm call took
      0.6 s (owner/name) or 2.5-3.3 s (checkout). After: a new process takes 0.74-0.78 s, a warm
      call 0.43-0.51 s (gather 0.39-0.45 s, mostly git grep). The first call on an empty store is
      still about 3.7 s, once per install and after `factory app add`.
    - Over 1 s and outside this path: compose's model call (about 3.3 s, code jobs only), the
      submit through serve (about 1.3 s), the follow-session wait (`PA_FACTORY_FOLLOW_WAIT_MS`,
      800 ms), and recall's Azure embed and rerank (run in parallel with codeHints). The next
      live e2e run's `timings_ms` gives the real split.
- [ ] **8.3 Reviewer sessions.** For each workflow, a separate reviewer session (a fresh agent
  that did not implement it, on Claude Code) runs `e2e <workflow>`, inspects the evidence and
  the outputs themselves (reads the PR, the report, the board card), and scores the workflow
  against 8.1. It writes `docs/native/acceptance/<workflow>.md`: pass/fail per criterion,
  measured numbers, evidence links, and defects found. Reviewers run in parallel, one per
  workflow.
- [ ] **8.4 Fix loop.** Every failed criterion becomes an item here; fixed by an implementing
  session; the reviewer re-runs. The Map shows each workflow's latest verdict and date.
  - [x] **8.4.1 whats-on: tomorrow's meetings are spoken as "today".** `calendarToday()` is a
    rolling now−2 h..now+24 h window. The fast-lane snapshot lists it as "Meetings (next 24h)" with a
    bare HH:MM, so on Sunday afternoon Monday's 10:00 and 11:00 come out as "today" (and `pa brief`
    prints the same rows under TODAY). Put the local day on each meeting, or split them into Today
    and Tomorrow, in both the snapshot and the brief. Add a router-eval case for an evening "what's on
    today?" ([acceptance/whats-on.md](acceptance/whats-on.md)).
    The snapshot now has one line per local day ("Meetings today (Sunday 8 November): none left
    today.", then tomorrow's up to this time, cancelled ones apart, titles quoted); `pa brief` prints
    TODAY and TOMORROW. On the live work stack's Sunday data the turn now says "There are no
    meetings today." Router eval: two evening cases added, both answered; 0 actions answered here.
  - [x] **8.4.2 whats-on: the answer turns meeting titles into attendees and drops a meeting.** "a
    meeting at 10:00 with <title>", "a standup at 11:00 with <team>": the snapshot has titles, not
    attendees, and the 11:30 meeting is left out. 13 of 13 turns gave this same answer. Tell the
    answerer to quote titles as titles and to give every meeting (or the count). Add eval cases.
    `ANSWER_RULES` in fastLane.ts, and `pa eval answerer` (6 placeholder day snapshots built by the
    real formatter): 2 of 6 pass on the old prompt and snapshot, 6 of 6 now.
  - [ ] **8.4.3 whats-on: the fast lane takes 728 ms to the first sentence (target 200).** Median
    of 10 turns, range 626-843 ms. Router 75 ms, first token 219 ms. The answer is one 20-word
    sentence, so sentence-by-sentence TTS cannot start until it ends. Lead with a short clause (for
    example "Nothing left today."), let TTS start at a clause boundary, and get the first token
    under 200 ms.
  - [ ] **8.4.4 whats-on: whisper takes 259 ms (target 250).** Median of 13, range 190-526 ms (the
    request adds about 15 ms). Calls after an idle gap take 400-530 ms. Keep the model warm, and
    check its size, beam and compute type against the target.
  - [ ] **8.4.5 whats-on: smart-turn alone is over the talk-page budget.** POST /api/talk/endpoint
    takes 221 ms (median of 10, 96-459 ms). Even after the 96 ms VAD shortcut, end of speech to the
    transcription request is at least ~317 ms (target 150). Make the endpoint faster, or start the
    transcription while smart-turn decides.
  - [ ] **8.4.6 whats-on: first audio takes 1.6-1.8 s (target 700).** In the e2e: 1792 ms median
    of 3 (1330-2619 ms), without the talk-page hop. Summing the probe medians gives ~1.6 s. Kokoro's
    first byte alone is 312 ms (median of 13, 247-734 ms). The hop targets already add up to 600 ms
    before TTS starts, so the budget only fits if TTS's first byte is about 100 ms.
  - [ ] **8.4.7 whats-on: the e2e understates or misses hops.** The fast-lane hop is timed to the
    first token, not the first sentence. The voice hop starts TTS only after the whole turn and leaves
    out the talk-page hop. The talk-page hop is not measured at all (/api/talk/endpoint could be).
    The Ask screenshot shows the idle Talk page, not the turn. Time the first sentence, add the
    smart-turn call, and capture the page after a driven turn.
  - [ ] **8.4.8 research: the tool call takes 2.3 s (target 1 s).** `factory_start` returned
    2312 ms after the call: run row 19:52:09.56, factory job created 19:52:10.96, PA "dispatched"
    19:52:11.30, so about 1.4 s is the `job submit` round trip. Down from 13.5 s on 8.2's run
    (8.2.2), still over. Profile the submit (uv/python start-up per CLI call through serve's
    /api/cli) ([acceptance/research.md](acceptance/research.md)).
  - [ ] **8.4.9 research: approval to "started" takes ~2.1 s (target 1 s), and the e2e reads
    11.5 s.** `factory_start` returned at 19:52:11.3, serve woke and dispatched at 19:52:12, and the
    job's `started_at` is 19:52:13.40. The e2e polls `job status` every 10 s (`--poll 10`), so it
    timed 11472 ms. Time the hop from the job's `started_at`, and cut the wake-to-worker start.
    (The model's first turn is another 10.2 s later, at 19:52:23.6: checkout and brief.)
    Measurement fixed in 53e4e54 (partly met): a research job's status now carries `started_at` (JOBS-API
    v1.5), and the e2e times approval to started from it. A code job uses its first
    `runs[].started_at`, and the poll only when the factory has no stamp. The research runtime hop
    now ends at the job's `updated_at`. Status is polled every 1 s while a start is due. Still
    open: the hop itself (~2.1 s against 1 s; cut the wake-to-worker start).
  - [ ] **8.4.10 research: the worker hop is not measured, and PA learns state changes 6-7 s late.**
    The job ended at 19:53:35.25, serve pushed `done` at 19:53:41, and PA recorded it at 19:53:41.14
    (its event loop was blocked 1230 ms then). `in_progress` was pushed at 19:52:12 and recorded at
    19:52:19.4. The board can't redraw within 200 ms of a change PA hears about 6 s later. Measure
    the hop (factory `updated_at` → the board's change), then find where serve's push waits.
  - [x] **8.4.11 research: the e2e's screenshots show no data.** `chrome-headless-shell
    --screenshot` shoots at page load, before /api/state and termhub answer. Plan shows an empty
    "On me", Build shows "No jobs to show", and Run shows "No terminal open". Shot over CDP 12 s after
    load, the same pages show card #6773 and the researcher's terminal with its links. Capture after
    the data loads (CDP, or a ready marker the pages set), and add the Ask view.
    Done (0959a0b): the shell is now driven over CDP (its own `--remote-debugging-port` and the runtime's
    WebSocket, no new dependency). Each page is shot once its own loaded signal holds and the
    network has been quiet for 500 ms, or after 20 s, when the shot is marked `ready: false`. The
    signals: Plan and Build `#updated` past "loading…", Ask `#chat-log`, Run termhub's open session.
    Research's Plan and Build shots also wait for the card and the job to appear. Each PNG has the
    page's text beside it, and `summary.json` views carry `ready` and `waitedMs`. A workflow whose
    acceptance block lists `ask` gets `/talk` shot. Checked with the real headless shell against a
    local page whose data arrives 2 s after load: shot at 3.0 s with the data in, and no browser
    left running. Not yet on a real run.
  - [x] **8.4.12 research: the approval is not exercised.** The e2e calls `chatTools.handle
    ('factory_start')` directly, so the policy audit log has no row for the run. Live policy does
    say `ask` (`pa audit check factory_start`). Drive the call through the permission path, or at
    least record the policy decision in the evidence.
    Done (aa5e03a): every action tool the e2e calls (factory_start and factory_continue, factory_resume with
    `--resume`) goes through the steps a user's approval takes, headless. First the policy is asked
    about the call as the chat's hook asks it, and must answer `ask`. Then the prompt is answered
    on a new policy channel, `e2e`, which the default policy allows for approvals only (an e2e call
    still asks). That answer is enforced and audited as an approve, with actor `pa-e2e` and subject
    `<marker>:<tool>`. Last, the call is audited on channel `chat`, as the chat's MCP server audits
    it. The run reads `audit_log` back and fails without both rows, in order (view `policy`). A
    policy that never asks also fails, since nothing was approved. Dry runs check that the policy
    prompts for the tool and accepts the e2e answer. Unit-tested against the real policy with a fake
    audit store; not yet on a real run. The answer is the harness's own: it is not the dashboard
    card or Claude Code's prompt UI.
  - [x] **8.4.13 research: e2e cleanup leaves sessions, and `--sweep` is not scoped.** The research
    runner drops the card but leaves the follow and researcher termhub sessions alive (the golden
    path kills them). `pa e2e --sweep` acts on every open e2e card, so during parallel reviews it
    would cancel another reviewer's live job and close its PR. Kill the run's sessions in research
    cleanup, and let `--sweep` take a marker or skip runs still inside their timeout.
    Done (522345e): research and golden-path cleanup kill the step sessions and the run's follow session
    (read from the run row, since it can open after factory_start returns). Research screenshots
    are taken before cleanup. `--sweep` leaves any card a run may still own: a live job the factory
    updated in the last 90 min (the longest hop timeout), or a finished job or jobless card younger
    than 15 min. It lists what it left. `--sweep --marker e2e-<uuid>` cleans that one run now.
    Unit-tested; not run on the live stack, because reviewers were running there.
  - [ ] **8.4.14 deepseek-pr: the tool call takes 6.7 s (target 1 s excluding model time).** Card at
    19:56:39.0, compose's model call ended 19:56:44.74 (2954 ms), PA "dispatched" 19:56:45.74: about
    2.8 s before compose and 1.0 s of submit, so ≈3.7 s without the model. Measured on `c0c2a3e`,
    before 002f99e. Re-measure with its `timings_ms`, then cut what remains
    ([acceptance/deepseek-pr.md](acceptance/deepseek-pr.md)).
  - [ ] **8.4.15 deepseek-pr: approval to "started" is ≈2.9 s (target 1 s); the e2e read 11.1 s.**
    factory_start returned ≈19:56:45.7, and the job sat `queued` ("waiting for pm-sync on the next
    factory tick") until the pm step started at 19:56:48.59. Same root as 8.4.9: a submit should
    wake the tick. The steps also waited 20 s (pm to sm) and 35 s (sm to dev) between ticks.
  - [ ] **8.4.16 deepseek-pr: the worker hop is not measured.** One sample: PR #63 closed at
    20:24:37Z, the PA `run` row reached the live feed at 20:25:01 (24 s) and `factory_board` at
    20:25:08 (31 s). The factory's `updated_at` moved only at 20:28:52, so it can't time the change.
    Re-measure once serve runs e88e204 (E3 push), with 8.4.10's measurement.
  - [x] **8.4.17 deepseek-pr: step session links open a 404.** Plan's card chain, Build and
    `factory_job` give `http://127.0.0.1:7010/#session=…` for every factory step, and sessiond's
    `GET /` is 404; only the run's follow session links to the front (:7000). Set
    `FACTORY_TERMHUB_PUBLIC_URL` to the front on the work stack (or default it there), and have the
    e2e GET each link it reports, not only find the session in `/api/sessions`.
    Done: no env needed on either stack. The factory's link origin is `FACTORY_TERMHUB_PUBLIC_URL`,
    else the `/api/secure-url` of the base or termhub's front (:7000), else the front, never
    sessiond. The PA re-points any loopback link at the factory machine's front (`PA_TERMHUB_URL`
    or `PA_MACHINES`) where factory JSON enters (`factory.call`) and where stored step links are
    read, so old rows open too. The golden path GETs each step link (`link opens`). Unit-tested;
    not run live.
  - [ ] **8.4.18 deepseek-pr: the API dev still hangs PowerShell on a multi-line `git commit -m`.**
    It did so twice in dev-tools:018 (20:05-20:12, 7.6 min, 18 turns, $0.16 of the $1.11 step),
    with 73e824d's prompt rule in place, and it considered `--no-verify` before using `-F`. The
    served `c0c2a3e` predates E6.1's guard (e2b0323). Re-run with it served, and check the stream
    for guard refusals instead of `>>` prompts.
  - [ ] **8.4.19 deepseek-pr: the generated diff fails review and scope.** PR #63's `pa version`
    runs its git fallback without a `cwd`, so it prints another repo's commit, or nothing, when run
    outside the checkout (the dashboard uses `cwd: __dirname`). It hardcodes
    `127.0.0.1:7300` instead of `config.dispatch`, and it adds an unrequested `meeting`
    HELP_TOPICS entry. Tests and lint can't catch either, and the solo pipeline has no review step.
    Add a review pass before the PR (or put the precedents in the brief), then re-run.
  - [ ] **8.4.20 deepseek-pr: the dev prompt says "NO CONTEXT AVAILABLE … You are likely the
    Onboarder persona".** The work factory has no `apps/dev-tools/context/project.md` or
    `navigation.md`, so a dev step is told to write the context set and spends its first ~25 of 76
    turns exploring. Generate the context on the work factory (local, untracked), and keep the
    Onboarder text out of other personas' prompts.
  - [x] **8.4.21 deepseek-pr: the dummy card asks the agent to "open a draft PR".** The workflow
    delivers a ready PR, and the factory forbids the agent from opening one.
    `goldenPathCore.dummyCard` should word the ask by delivery and say the factory delivers.
    Done: the ask describes only the change and carries the marker; delivery is factory_start's
    `delivery`, never the card's. A test refuses an ask that mentions a PR, a push or a merge.
  - [x] **8.4.22 deepseek-pr: Map and e2e drift.** The Map's steps and `cost.basis` name
    `deepseek/deepseek-coder`, but `pa e2e deepseek-pr` runs `azure/deepseek-v4-pro`. The e2e also
    times the jarvis hop including compose's model call, which the target excludes: subtract
    `timings_ms.compose_model`.
    Done: the example's steps and cost basis name `azure/deepseek-v4-pro` (and the azure routes of
    the other steps), and a test keeps them so. The jarvis hop is the round trip less
    `timings_ms.compose_model` (`workflowsCore.toolCallMs`); a PA without it is timed whole and
    the note says so. The verdict is unchanged.
  - [ ] **8.4.23 deepseek-pr: PA keeps stale state after a job ends.** Run rows kept a live
    `factory_state` for dev-tools:004-015, hours after the factory ended them, so `--sweep`
    reported "cancelled" for each. The `card` tool's narrative said run #29 "is still running"
    after card #6774 was `done`. Sync `run.factory_state` on terminal jobs, and refresh the card
    context when the run lands.
- [ ] **8.5 Architecture map review.** A full pass over `architecture.json` (the `/architecture`
  page) against the finished system: every component, process, port, table, tool, workflow and
  storage location as it now runs on both stacks (jarvisd, ptyd, native factory, SQLite,
  supervisor, no WSL); nothing left `planned`/`landing` that has shipped, nothing describing
  removed parts. Checked on the live page of both stacks. Known so far: the `postgres`
  component is retired (D24) but still the end of many edges and workflow hops, which should
  point at `sqlite-store`.
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
