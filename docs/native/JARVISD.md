# jarvisd: the move to a TypeScript/Bun core (plan 4.1)

Plan item 4.1, decision D1 (TypeScript core on Bun, a small Rust kernel), D15 (the factory stays
Python; JSON Schema contracts), D16/D18 (independent items start in parallel). Target shape:
DESIGN.md, "Target shape": one `jarvisd` executable per OS holding the gateway (static UI, SSE,
MCP, CSRF/Host guards), board and memory, ingest, policy and approvals, audit and cost, with
`ptyd` (5.1) and agent runs as supervised children.

The rule for the whole move: **the system keeps working after every commit, and nothing is
rewritten wholesale.** Bun runs the PA's CommonJS unchanged, so jarvisd starts as a Bun host for
today's worker and absorbs it one module at a time, each module becoming strict TypeScript behind
the interface it already has.

## What exists (the module map)

PA (`personal-assistant/src`, ~57k lines of CommonJS), by layer, leaves first:

| Layer | Modules | Lines | Notes |
|---|---|---|---|
| Contracts | `schemas/` (Job, Run, Card, Event, Approval) | | types already generated: `schemas/types.d.ts` (1.1) |
| Store | `db`, `repo` (31 aggregates + `repo/sqlite` twins) | ~10.7k | every statement behind a named method (1.2), contract-tested on Postgres and SQLite (1.3, 3.2) |
| Core utils | `config`, `log`, `util`, `platform`, `models`, `llm`, `budget` | ~3k | `platform` picks windows/linux/darwin |
| Events | `events` (bus, LISTEN, outbox replay) | 318 | 0.4, 1.4, Z6 |
| Policy | `policy`, `auth` (passkeys) | ~600 | 4.3, 7.1 |
| Domain | `commitments`, `ledger`, `proposals`, `draft`, `secrets`, `notify`, `memory`, `recall`, `search`, `projects`, `repos`, `meetings`, `brief`, `distill`, `agent` | ~12k | |
| Ingest | `ingest`, `audio` | ~3.7k | connector passes |
| Dispatch | `dispatch`, `durable`, `e2e` | ~7.9k | the factory side stays Python (D15) behind JOBS-API |
| Surfaces | `dashboard` (HTTP routes + pages), `mcp`, `chat`, `cli` | ~15.7k | gateway, MCP server, PA chat (Agent SDK, 4.2), `pa` |
| Process | `worker.js`, `supervisor` | ~1.6k | passes on the scheduler (Z2), generations (Z1) |

termhub (`termhub/`, ~8k lines in `lib/` plus `front.js`, `sessiond.js`, `server.js`): the front
(HTTP, WebSocket, the `/pa/` proxy) and `sessiond` (PTYs). `sessiond` is replaced by `ptyd`
(Rust, 5.1); the front is absorbed into jarvisd last.

## Migration order

Leaves first, so a converted module only ever imports converted modules or typed shims, and the
surfaces move only once everything under them is typed.

1. **Stage 1, host (this commit).** `jarvisd/src/main.ts` boots `personal-assistant/src/worker.js`
   (its exported `main()`) under Bun, unchanged. Same process shape, ports, env, logs and
   supervisor protocol as the Node worker. Proven by running the PA's own tests under Bun
   (`jarvisd/scripts/parity.js`: schemas, events, dashboard, the repository boundary and calls,
   the contract on SQLite and Postgres, the SQLite backend's tests, migrations, architecture,
   lease) on Windows and Linux.
2. **Contracts and the store.** `schemas` types are imported, not redeclared. `repo` aggregates
   become `.ts` one per commit (each has its contract cases, the oracle), then `db`, with the
   twins in `repo/sqlite`. SQLite under jarvisd keeps the Node driver
   (`better-sqlite3-multiple-ciphers`, for SQLCipher) and `sqlite-vec`: both load under Bun
   1.4.4 (see below).
3. **Core utils, events, policy.** `config`, `log`, `util`, `events/bus`, `policy` (pure modules
   with unit tests), then `llm`, `budget`.
4. **Domain and ingest**, aggregate by aggregate, in the order the repository chunks went
   (meetings, memory/search, commitments, ledger/proposals/drafts/secrets, ingest/repos/routines).
5. **Dispatch** (after 2.1's factory daemon has settled the JOBS-API calls), `durable`, `e2e`.
6. **Surfaces.** Dashboard routes into one typed router, the MCP server and chat tools, `cli`
   (`pa` becomes a thin client of jarvisd's API where it now opens its own pool).
7. **termhub front last**: its HTTP/WebSocket server and the `/pa/` proxy move into jarvisd's
   gateway once `ptyd` (5.1) owns the PTYs; termhub's `server.js` then retires. Done as a role:
   `jarvisd front [--port N] [--sessiond-port N] [--host H]` runs `termhub/front.js` under Bun,
   bundled into the executable. sessiond stays on Node (node-pty aborts Bun; with
   `TERMHUB_PTYD=1` the terminals are in ptyd anyway). It needed Bun 1.4: on 1.3.13 a
   `node:http` server's `upgrade` socket took no writes, so every WebSocket through the front
   hung (terminals, the voice feed). The parity set runs termhub's front tests under Bun and
   `frontSwap.test.js` with every front in jarvisd (`TERMHUB_FRONT_JARVISD=1`).
   The role is a stepping stone. The target (Exit 4, one process per machine plus ptyd and agent
   runs as children) is the front **in-process**: the jarvisd supervisor process owns both public
   ports (termhub's 7000 and the dashboard's 7300) and routes front traffic itself, with no
   separate front process; sessiond stays separate until ptyd replaces it.

How a module moves (the pattern is `personal-assistant/src/events/bus.ts`, the first one):

- `git mv x.js x.ts`; callers `require('./x.ts')` (Node resolves no extension to `.ts`).
  A directory module (`require('../policy')`, many callers) keeps a one-line `index.js`:
  `module.exports = require('./policy.ts');`, so its callers do not change.
- **Erasable syntax only** (no enums, namespaces, parameter properties, `<T>expr` assertions):
  Node runs `.ts` by stripping types (default since Node 22.18), Bun natively. Both run the file
  unchanged. `erasableSyntaxOnly` in `jarvisd/tsconfig.json` makes tsc refuse the rest.
- **Stay CommonJS while any `.js` caller remains**: keep `module.exports`; no `import`/`export`
  statements, not even `import type` or `export interface` (either makes Bun load the file as
  ESM, where `module` is undefined). Contract types come in by type query:
  `type BusEvent = import('../../../schemas/types.d.ts').Event;`. `tsc` still treats each file as
  a module (`moduleDetection: "force"` in `jarvisd/tsconfig.json`), so two files' local types
  (`PassFn` in exclusive.ts and scheduler.ts) never collide, nor a local with a global
  (`crypto`, `Event`).
- Strict types on every export; `jarvisd/tsconfig.json` includes `personal-assistant/src/**/*.ts`,
  so jarvisd's typecheck covers each converted module.
- Its tests run under Node (the PA suite) and Bun (`jarvisd/scripts/parity.js`). One module, or
  one aggregate with its contract file, per commit. When a module's last `.js` caller is gone it
  switches to ES `export`s.

## Node and Bun side by side

- Until stage 6 every module still runs under Node too: the PA's `npm test` (Node) and
  jarvisd's `npm test` (typecheck + Bun parity + `--check`) both gate CI. A module that becomes
  `.ts` is loaded under Node through Bun's output (`bun build --target=node`) only if a Node-only
  caller still needs it; the default is that `.ts` modules are reached from jarvisd.
- Bun specifics found so far: `require` of a computed path is invisible to the bundler, so the
  platform loader, the worker's memory passes, the SQLite twins (`repo/index.ts`) and the
  dashboard's module routes use literal requires. In the compiled binary a computed require
  either fails (the dashboard's `/api/routines`, `/api/memory/*`, `/api/debriefs`, and
  `/api/meetings/*` answered 500) or loads a second copy of the module from disk: twins loaded
  that way had their own `db/sqlite.ts`, whose session set called this process's own lease
  holders gone. `__dirname` in the binary is the source file's path in the checkout, and a file
  the binary loads from disk resolves no package names. So `db/sqlite.ts` takes the driver's
  entry file, and the sqlite-vec extension, from `personal-assistant/node_modules` by path when
  the name does not resolve: the backup's snapshot thread loads `db/sqlite.ts` from disk, and
  sqlite-vec's lookup of its platform package resolves from the working directory (a
  generation's is `jarvisd/dist`).
- **SQLite under Bun.** Bun 1.3.13 aborted on `better-sqlite3-multiple-ciphers` (a NAPI fatal
  error). Bun 1.4.4, which `jarvisd/package.json` pins, loads it and `sqlite-vec`. The parity set
  runs the repository contract on SQLite (603 cases) plus `sqliteNotify`, `backupSqlite` and
  `durableSqlite`. CI's jarvisd job runs `test/jarvisdSqlite.test.js` with the compiled binary:
  a generation on an encrypted throwaway store, started outside the checkout, must load
  sqlite-vec, answer the module routes, write the snapshot and the bundle, and deliver an outbox
  row another process wrote to `/api/events`. The worker logs
  `store ready { has_vector }` at start, so a binary that fell back to the JS vector scan says so.

## The supervisor (Z1) and jarvisd generations

The supervisor (`personal-assistant/src/supervisor`, Node builtins only) forks each generation
with `child_process.fork(worker)` and talks to it over IPC (`ready`, `drain`). For jarvisd it
forks the jarvisd entry with `execPath` set to Bun and `serialization: 'json'` (Bun's IPC speaks
Node's JSON protocol; Node generations use JSON too now); the protocol (`PA_SUPERVISED`,
`/healthz`, `drain`, lease release) is unchanged. `PA_RUNTIME=bun` in the supervisor's
environment selects it (`runtimeSpec` in `src/supervisor/index.ts`; Bun from `PA_BUN`, else
jarvisd's pinned npm install), and every generation then runs `jarvisd/src/main.ts` under Bun;
`test/supervisorBun.test.js` starts and rolls Bun generations. The runtime is read when the
supervisor starts, so switching a stack is a supervisor restart (the bootstrap path), and so is
switching back.

**4.4: one executable.** The supervisor is strict TypeScript now
(`personal-assistant/src/supervisor/index.ts`; `index.js` is a two-line shim for `node
src/supervisor`), and the compiled jarvisd carries it:

- `jarvisd supervise [run|roll|rollback|status]` is the supervisor; its generations are the same
  executable, `jarvisd generation` (the default role). A machine runs one jarvisd binary (plus
  `ptyd`). Run from source (`bun src/main.ts supervise`), generations run the source under Bun.
- Which executable a new generation runs is read at every roll: `PA_JARVISD_EXE`, else the file
  named in `current` beside the running binary (or in `jarvisd/dist/`), else the running binary.
  A deploy (`src/supervisor/deploy.js`, when `status.runtime` is `jarvisd`) builds
  `jarvisd-<commit>[.exe]` next to it with `JARVISD_OUT` (Windows will not overwrite a running
  .exe), points `current` at it and rolls; a failed roll points it back. jarvisd/ and schemas/
  changes count as changes for such a deploy.
- `status.source` is the supervisor source's hash, embedded at build (`scripts/build.js` passes
  `--define process.env.PA_SUPERVISOR_SOURCE_BUILT`), so a deploy still knows when the
  supervisor itself changed (exit 4: restart the service onto the new binary).
- `PA_GENERATION_MODULE` makes a generation run a stand-in file instead of the worker; tests use
  it to run the supervisor's fixture workers inside the real executable.
- Tests with the compiled binary (`PA_JARVISD_EXE`, CI's jarvisd job on Windows and Linux):
  `test/supervisorBinary.test.js` (start, roll, rollback, deploy lock, roll to `current`, no
  generation outlives its supervisor) and `test/deployTest.test.js` (the Z6 spare-port deploy
  test with jarvisd as the supervisor, `deployTest.ts --binary`).
- **The launcher.** The pa-worker task runs `windows\pa-launch.ps1` and the unit runs
  `linux/pa-launch.sh` (`exec`s, so systemd supervises the supervisor itself). On every start
  each reads `PA_RUNTIME` (environment, else `personal-assistant/.env`, else the repo's `.env`):
  `node` (default) or `bun` start `node src/supervisor`; `jarvisd` starts the executable
  `jarvisd/dist/current` names (else `jarvisd/dist/jarvisd[.exe]`) as `supervise`, with no
  Node in the process tree. A `jarvisd` setting with nothing built falls back to Node, saying
  so. `-DryRun` / `--dry-run` print the command (`test/launcher.test.js`).
- **Deploys.** `deploy.js` compares `PA_RUNTIME` with the running supervisor's `runtime`: a
  difference is a switch, so it asks for a restart (exit 4) and the launcher starts the other
  one. For `jarvisd` every roll *and* every restart (no supervisor, its own code changed, a
  switch to it) first builds `jarvisd-<commit>` and points `current` at it; the scripts' restart
  then starts the new binary. `windows/redeploy.ps1` also ends the launcher and this repo's
  `jarvisd\dist\` processes when it restarts the task.

### Runbook: switching a stack to jarvisd (and back)

Prerequisites: the checkout is clean on main at a commit with this section, `npm ci` has run in
`jarvisd/` and `personal-assistant/`, and `node scripts/build.js --only jarvisd` builds. The
build compiles with the pinned Bun (`JARVISD_BUN`, else `jarvisd/.bun/<pin>/`, which a deploy
installs, else `jarvisd/node_modules`) and refuses any other version: an executable built on
Bun 1.3.13 aborts when the PA opens its SQLite store.

Windows (work stack):

1. Once, from an **elevated** PowerShell, point the task at the launcher (a normal shell cannot
   change a task registered elevated; nothing else changes, Node keeps running):
   `powershell -NoProfile -ExecutionPolicy Bypass -File C:\repos\dev-tools\personal-assistant\windows\redeploy.ps1 -From (git -C C:\repos\dev-tools rev-parse HEAD)`
   It prints "pa-worker task now runs windows\pa-launch.ps1" and restarts the task (still Node).
   Check: `Get-ScheduledTask pa-worker | % { $_.Actions.Arguments }` names `pa-launch.ps1`.
2. Dry run the switch: set `PA_RUNTIME=jarvisd` in `personal-assistant\.env`, then
   `powershell -File personal-assistant\windows\pa-launch.ps1 -DryRun` (expect the Node
   fallback until a binary exists) and `... redeploy.ps1 -DryRun` (expect "PA_RUNTIME is
   jarvisd but the supervisor runs node: restart" and "build a new jarvisd executable").
3. Switch: `powershell -File personal-assistant\windows\redeploy.ps1 -From (git rev-parse HEAD)`.
   It builds `jarvisd\dist\jarvisd-<commit>.exe`, points `current` at it, restarts the task; the
   launcher starts `jarvisd supervise`.
4. Verify: `node personal-assistant\src\supervisor status` shows `"runtime": "jarvisd"` and
   `"exe"` under `jarvisd\dist\`; `Get-CimInstance Win32_Process -Filter "Name LIKE 'jarvisd%'"`
   lists the supervisor and one generation; `http://127.0.0.1:7300/healthz` is ready and
   `/api/version` reports HEAD. Then a normal deploy rolls to a new binary, and the Z6 test
   (`node src\e2e\deployTest.ts --live --deploy -- --from HEAD~1`) passes.
5. Roll back: set `PA_RUNTIME=node` (or delete the line) and run `redeploy.ps1 -From (git rev-parse HEAD)`:
   the runtime differs, so it restarts the task and the launcher starts `node src\supervisor`.

Linux (personal stack): the same, without step 1's elevation:
1. `bash personal-assistant/linux/redeploy.sh "$(git rev-parse HEAD)"` re-renders the unit
   (`ExecStart=/bin/sh .../linux/pa-launch.sh`, `Environment=PA_NODE=...`), daemon-reloads and
   restarts it (still Node). Check: `systemctl --user cat pa-worker | grep pa-launch`.
2. `PA_RUNTIME=jarvisd` in `personal-assistant/.env`; `sh personal-assistant/linux/pa-launch.sh --dry-run`;
   `bash personal-assistant/linux/redeploy.sh HEAD --dry-run`.
3. `bash personal-assistant/linux/redeploy.sh "$(git rev-parse HEAD)"`: builds
   `jarvisd/dist/jarvisd-<commit>`, restarts the unit onto it.
4. Verify as on Windows (`pgrep -af 'jarvisd.* (supervise|generation)'`).
5. Roll back: `PA_RUNTIME=node`, then `redeploy.sh "$(git rev-parse HEAD)"`.

A compiled jarvisd reads files beside its source path at run time (`sql/`, pages, scripts):
it must run on the machine and checkout that built it, which a deploy always does.

### Switching a stack to Bun (and back)

The runtime is read when the supervisor starts, so a switch is one supervisor restart (the same
short gap as the bootstrap), not a roll. On the work laptop (the pa-worker task runs
`node src\supervisor` in `personal-assistant/`):

1. `git -C C:\repos\dev-tools pull --ff-only`, then `npm ci` in `C:\repos\dev-tools\jarvisd`
   (installs the pinned Bun; `jarvisd\node_modules\bun\bin\bun.exe --version` says 1.4.4).
2. Check the graph loads: `C:\repos\dev-tools\jarvisd\node_modules\bun\bin\bun.exe
   C:\repos\dev-tools\jarvisd\src\main.ts --check` prints `jarvisd ok`.
3. Add `PA_RUNTIME=bun` to `personal-assistant\.env` (the supervisor reads it there; `PA_BUN`
   names another Bun if wanted).
4. `powershell -File C:\repos\dev-tools\personal-assistant\windows\redeploy.ps1 -Restart`. Not
   `Stop-ScheduledTask`/`Start-ScheduledTask` alone: the task runs elevated, so stopping it leaves
   the old supervisor (and its generations) running, and the new one cannot take the port.
   `redeploy.ps1`'s restart ends the supervisor and its generations by command line (node.exe and,
   on Bun, bun.exe running `jarvisd\src\main.ts`), then starts the task and waits for
   `/api/version`. `-Restart` forces that restart when a roll would otherwise do (a runtime
   switch changes no code). Tried live on the work stack 2026-11-08 (see Status).
5. Verify: `node src\supervisor status` (in `personal-assistant/`) shows `"runtime": "bun"` and a
   generation; the supervisor log says `spawned generation ... runtime: bun`; the dashboard,
   `/api/events` and a factory job behave as before. `pa doctor` should be unchanged.

Rollback: delete the `PA_RUNTIME=bun` line (or set `node`) and run step 4 again.
Deploys (`windows\redeploy.ps1`) keep working either way. On a stack that uses jarvisd,
`deploy.js` installs the Bun version `jarvisd/package.json` pins into its own directory,
`jarvisd/.bun/<version>/`, once (`bunInstallPlan`), and the supervisor prefers that Bun (after
`PA_BUN`) at its next start. It never runs `npm ci` in `jarvisd/`: on Windows the running
generation's `bun.exe` is locked, and npm ci, which deletes `node_modules` first, failed the
2d7fdbf deploy with EPERM.

### Runbook: switching a stack's termhub to jarvisd front and ptyd (and back)

Two independent switches, each one line in `termhub/.env` (gitignored; the environment or the
repo's `.env` also work), read by `termhub/lib/launch.ts` and `lib/ptyHost.ts`:

- `TERMHUB_FRONT=jarvisd`: the front runs as `bun jarvisd/src/main.ts front` on the pinned Bun,
  installed into `jarvisd/.bun/<pin>/` by the update (`node termhub/lib/launch.js ensure-bun`;
  never `jarvisd/node_modules`, whose Bun may be another version and which a running front
  would lock). A front swap costs a reconnect; no terminal ends. Without its Bun the front falls
  back to Node and the update says so.
- `TERMHUB_PTYD=1`: the PTYs live in ptyd, a long-lived process of its own (the `termhub-ptyd`
  logon task on Windows, `termhub-ptyd.service` on Linux) running an installed copy
  (`<dataDir>/bin/ptyd-<hash>`). It takes effect at sessiond's next start, which ends the live
  terminals one last time (they come back Restorable); after that, sessiond restarts, and on
  Linux every update, keep them. The update scripts build ptyd when its sources are newer
  (cargo; MSVC on Windows), install it, keep its task or unit in place, and never restart a
  running ptyd.

`node termhub/lib/launch.js` prints both decisions. Do the front first (cheap, reversible),
then ptyd. Proven on spare ports 2026-11-08: the scripted front swap from Node to jarvisd and
back with a terminal kept, `server.js` running the jarvisd front as a respawned child, ptyd's
`-Run` wrapper and `-Remove`, and the dry runs; `frontSwap.test.js` (Node and jarvisd fronts),
`ptydBackend.test.js` and `ptydConformance.test.js` with `PTYD_REQUIRED=1`.

Windows (work stack), in `C:\repos\dev-tools\termhub`:

1. Update to a commit with this section, still on Node and node-pty:
   `powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\update.ps1`.
2. `Add-Content .\.env "TERMHUB_FRONT=jarvisd"` and `Add-Content .\.env "TERMHUB_PTYD=1"`.
3. Dry run: `powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\update.ps1 -DryRun`.
   Expect `next: jarvisd (TERMHUB_FRONT=jarvisd in termhub\.env ...)`, `would install Bun 1.4.4
   into ...\jarvisd\.bun\1.4.4`, ptyd `would build` / `would install` / `would register the
   termhub-ptyd logon task` / `would start`, and `pty host next start: ptyd`.
4. `powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\update.ps1`. It installs Bun,
   builds and installs ptyd, registers and starts `termhub-ptyd` (ptyd on 127.0.0.1:7020, no
   terminals yet), and swaps the front onto jarvisd (terminals survive; sessiond is untouched).
   Check: `(Invoke-RestMethod http://127.0.0.1:7000/api/health).self.pid` is a `bun.exe` whose
   command line ends in `main.ts front` (`Get-CimInstance Win32_Process -Filter "Name='bun.exe'"`);
   the UI, a terminal and voice work; `Invoke-RestMethod http://127.0.0.1:7020/api/ping` says
   `entry: ptyd`; `Get-ScheduledTask termhub-ptyd` exists.
5. Move the terminals into ptyd, from a normal PowerShell window (not a termhub terminal):
   `.\windows\restart-sessiond.ps1`. This ends the live terminals once. Check: `node
   lib\ptyHost.js` says `running: ptyd`; open a terminal, start something long, run
   `.\windows\restart-sessiond.ps1 -Force` again: the terminal is still there with its output.

Rollback, Windows: the front: `TERMHUB_FRONT=node` in `termhub\.env` (or delete the line), then
`update.ps1` (a front swap; terminals survive). ptyd: `TERMHUB_PTYD=0`, then
`.\windows\restart-sessiond.ps1` (sessiond back on node-pty; ptyd's terminals come back
Restorable), then `.\windows\ptyd.ps1 -Remove` (stops ptyd, unregisters the task). Every
`ptyd.ps1` action takes `-DryRun`; `-Restart` moves a running ptyd onto a newer installed build
and ends its terminals, so only on purpose.

Linux (personal stack), in the checkout's `termhub/`:

1. Update to a commit with this section: the Update button, or `bash linux/update.sh`.
2. `printf 'TERMHUB_FRONT=jarvisd\nTERMHUB_PTYD=1\n' >> .env`
3. Dry run: `bash linux/update.sh --dry-run` (the same expectations as on Windows, with
   `termhub-ptyd.service` in place of the task).
4. `bash linux/update.sh`. Before its restart it builds and installs ptyd, points
   `termhub-ptyd.service` at the installed copy and starts it, and installs Bun; the restart of
   `termhub.service` (which ends the terminals this one last time) brings `server.js` up with
   sessiond on ptyd and the front as a `bun ... main.ts front` child. Check: `tail
   ~/.local/termhub/logs/update.log` ends `OK`; `systemctl --user status termhub-ptyd`;
   `pgrep -af 'main.ts front'`; `node lib/ptyHost.js` says `running: ptyd`. Run the update once
   more: the terminals now survive it.

Rollback, Linux: the front: `TERMHUB_FRONT=node`, then `bash linux/update.sh` (terminals
survive on ptyd). ptyd: `TERMHUB_PTYD=0`, then `bash linux/update.sh` (back on node-pty; ptyd's
terminals come back Restorable), then `bash linux/ptyd-unit.sh --remove`.

## Design: the in-process front (Exit 4; not built)

Target: one jarvisd per machine owns both public ports, termhub's 7000 and the dashboard's
7300, plus ptyd and agent runs as children. Today the supervisor already is a reverse proxy in
front of rolling generations on 7300 (flip, drain, a standby for rollback), and the front is a
separate process the termhub scripts swap with a 1 to 2 s gap. So the front moves into the
**generation**, not the supervisor: the supervisor stays the small, rarely restarted process,
and front code rolls with every deploy at no gap, under the same flip and rollback.

Steps, each behind `PA_TERMHUB_FRONT=inproc` (off by default):

1. **Generation.** With the flag, the generation (`jarvisd generation`) also runs termhub's
   `createFront({ sessiondPort })` on `127.0.0.1:0` and reports `frontPort` in its `ready`
   message. The front's `/pa/` proxy goes straight to the generation's own dashboard.
2. **Supervisor.** A second listener on termhub's publish port and bind (`PA_TERMHUB_PORT`, 7000;
   `127.0.0.1` behind Serve, or the tailnet IP in plain-HTTP mode) proxies HTTP and upgrades to
   the current generation's `frontPort`. Routing state stays one value, the current generation,
   so a flip or rollback moves both ports together.
3. **Drain.** Terminal and voice WebSockets never go idle, so at the flip the old generation's
   front closes them (as the dashboard's SSE streams are closed now); browsers reconnect
   through the new one and sessiond replays the screen. A roll then costs what a front swap
   costs today, with no refused connections.
4. **termhub's scripts.** `TERMHUB_FRONT=pa` (a third value in `lib/launch.ts`): `update.ps1` and
   `restart-front.ps1` start no front and only verify that 7000 serves the expected commit
   (the PA redeploy that follows the pull rolls it); `Start-VerifiedFront`'s pid check accepts
   the generation's pid. On Linux `server.js` runs sessiond only. The watchdog's front-down
   remedies restart pa-worker instead of starting `node front.js`.
5. **Tests.** A supervisor test whose fixture generation serves a front port: a WebSocket
   through 7000 survives a roll by reconnecting, and a rollback flips both ports. Then
   `frontSwap.test.js` with the front in a supervised generation (no ticks lost across a roll),
   and the Z6 deploy test checking 7000 as well as 7300.
6. **Rehearsal, then the stacks.** On spare ports (supervisor 7399 owning a spare front port,
   a scratch sessiond), then each stack by one line in `personal-assistant/.env`; rollback is
   deleting it and `TERMHUB_FRONT=jarvisd` (or `node`) in `termhub/.env`.

Risks:

- **Privilege.** `/api/exec` and the transcript reader run in the front. The work stack's
  pa-worker task runs elevated, so in-process they would run elevated. That has to be settled
  before step 1: move `/api/exec` to sessiond, or run the PA task with limited rights.
- **Shared fate.** A supervisor crash or restart (its own code changed, a runtime switch) now
  takes termhub's UI down with the dashboard. Terminals survive in sessiond and ptyd, but the
  way back runs through the PA's task, which the watchdog has to know.
- **Interrupted streams.** Every PA deploy closes the terminal and voice sockets once. Today
  every update already swaps the front, so the count is the same, but a dictation in progress
  is cut at a roll.
- **Bind and Serve.** The supervisor binds loopback today; plain-HTTP mode needs it on the
  tailnet IP, and single-port mode needs Serve re-asserted by the PA's deploy, not termhub's.
- **Two owners in transition.** While both layouts exist, a node front and the supervisor
  can race for 7000. The switch must stop termhub's front first, as the runbook above does.

## Build

`node scripts/build.js --only jarvisd` runs `bun build --compile jarvisd/src/main.ts`: one
executable with the Bun runtime and the worker's whole module graph (791 modules, npm packages
included) bundled; ~116 MB on Windows. `jarvisd --check` loads the graph and exits (CI's smoke
test). Bun comes from npm (`jarvisd/package.json` pins it), so `npm ci` in `jarvisd/` is the only
setup; T7's cargo and Bun caches apply.

## Status

- [x] Stage 1: host, Bun parity, compiled build, CI on Windows and Linux.
- [x] Supervisor runs jarvisd generations (`PA_RUNTIME=bun`), tested with the fixture worker.
- [ ] The work stack on Bun. Switched 2026-11-08 and rolled back to Node the same day: on Bun,
  Talk's transcription came back empty (Bun reset the half-closed socket to whisper; fixed in
  2aad672, now covered by the Bun parity set). Next try after that fix is deployed.
- [x] The PA on SQLite (encrypted, sqlite-vec) under jarvisd, proven 2026-11-08 on a scratch
  store: a generation from source on Bun 1.4.4 and from the compiled executable, and `jarvisd
  supervise` (compiled and source) through a roll, each with `/healthz`, `/api/version`,
  `/api/events` (an event written by another process), the module routes, the vector index and
  an encrypted backup that restores. `test/jarvisdSqlite.test.js` repeats the compiled run in
  CI; the SQLite contract and backend tests are in the parity set.
- [x] Leaves in strict TS: `events/bus`, `util/{text,exclusive,scheduler,when}`, `policy`.
- [x] Stage 2, the repository layer: every aggregate in `repo/` and its SQLite twin in
  `repo/sqlite/` is strict TS (`repo/index.js` and `repo/_sql.js` stay JS for now; `db` next).
- [x] Stage 6, first part: the dashboard's server modules (`dashboard/*.ts`, with the types-only
  `dashboard/types.ts`: `Ctx`, `Req`/`Res`, `HttpError`) and the MCP server (`mcp/server.ts`,
  `mcp/chatTools.ts`). Files the browser loads (`*.client.js`, `nav.js`, `talk.core.js`,
  `talk.page.js`, `voiceCapture.js`, ...) stay JS. `mcp/server.js` stays as the entry Claude
  Code and the chat start, and runs `server.ts`. JSON a JS producer hands over (board cards,
  factory views, tool arguments) is a documented loose `Json` record until that producer is TS.
- [x] Stage 2's rest: `repo/index.ts` and `db/*.ts` (`index.js` shims for both directories).
- [x] Stages 3 to 5 for the root modules (config, log, llm, budget, models, backup, the worker
  itself: `worker.js` is the entry shim), chat, cli and the supervisor's deploy; chunks A to D
  (util, events, telemetry, platform, auth, secrets, notify, search, recall; ingest, distill,
  memory, projects, repos, brief; commitments, ledger, proposals, draft, meetings, routines,
  eval; dispatch, durable, e2e, audio: `dispatch/index.js` and `durable/index.js` are the
  directory shims) by parallel agents. Values a JS producer hands over are
  `any`/`Json` until it switches to ES exports. `test/requiresResolve.test.js` fails on a
  relative require that resolves to no file (Node never adds `.ts`).
- [x] The one typed router (`dashboard/router.ts`, the `ROUTES` table in `server.ts`).
- [x] The termhub front in jarvisd (`jarvisd front`), under the parity set, on Bun 1.4.4.
- [x] termhub's front, `lib/`, sessiond and server in strict TS (b524295, 6bad58b, 6edacc5); entries
  `front.js`, `sessiond.js`, `server.js`, `lib/ptyHost.js` stay JS (started by path).
- [x] The switch to `jarvisd front` and ptyd prepared for both stacks: `TERMHUB_FRONT` and
  `TERMHUB_PTYD` in `termhub/.env`, read by the update scripts (`-DryRun` / `--dry-run`), ptyd
  as a logon task / user unit from an installed copy (runbook above).
- [ ] Left: switch the stacks (the lead does it, from the runbook above); then the in-process
  front (one jarvisd process owns 7000 and 7300, Exit 4; designed above, *Design: the in-process
  front*; settle `/api/exec`'s privilege first); modules to ES exports (then `Repos`,
  `Config` and `Json` get real types); `pa` as a thin client of jarvisd's API.
- [x] `test/supervisor.test.js` under load (92a25c8): it slept a fixed 300 to 600 ms before
  asserting the clients had followed a roll, and a failed assert then hung in `close()` behind
  the open WebSocket until the 150 s watchdog. It now waits for each generation and stops its
  clients before closing; 15 loaded runs passed. The supervisor's `close()` still waits on an
  open upgraded socket (a stop would too).
