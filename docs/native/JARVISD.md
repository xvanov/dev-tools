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
   the contract on Postgres, migrations, architecture, lease) on Windows and Linux.
2. **Contracts and the store.** `schemas` types are imported, not redeclared. `repo` aggregates
   become `.ts` one per commit (each has its contract cases, the oracle), then `db`. SQLite under
   jarvisd goes through `bun:sqlite` (the Node driver's native addon crashes Bun 1.3 on load, see
   below); the twins in `repo/sqlite` move with it.
3. **Core utils, events, policy.** `config`, `log`, `util`, `events/bus`, `policy` (pure modules
   with unit tests), then `llm`, `budget`.
4. **Domain and ingest**, aggregate by aggregate, in the order the repository chunks went
   (meetings, memory/search, commitments, ledger/proposals/drafts/secrets, ingest/repos/routines).
5. **Dispatch** (after 2.1's factory daemon has settled the JOBS-API calls), `durable`, `e2e`.
6. **Surfaces.** Dashboard routes into one typed router, the MCP server and chat tools, `cli`
   (`pa` becomes a thin client of jarvisd's API where it now opens its own pool).
7. **termhub front last**: its HTTP/WebSocket server and the `/pa/` proxy move into jarvisd's
   gateway once `ptyd` (5.1) owns the PTYs; termhub's `server.js` then retires.

How a module moves (the pattern is `personal-assistant/src/events/bus.ts`, the first one):

- `git mv x.js x.ts`; callers `require('./x.ts')` (Node resolves no extension to `.ts`).
- **Erasable syntax only** (no enums, namespaces, parameter properties): Node runs `.ts` by
  stripping types (default since Node 22.18), Bun natively. Both run the file unchanged.
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
  platform loader and the worker's memory passes use literal requires (`personal-assistant/src/
  platform/index.js`, `worker.js`); `repo/index.js`'s SQLite twin loader and `db/sqlite.js`'s
  driver stay dynamic (PA_DB=sqlite under the compiled binary waits for stage 2). The optional
  `better-sqlite3-multiple-ciphers` addon aborts Bun (NAPI fatal error), so parity runs the
  contract on Postgres only.

## The supervisor (Z1) and jarvisd generations

The supervisor (`personal-assistant/src/supervisor`, Node builtins only) forks each generation
with `child_process.fork(worker)` and talks to it over IPC (`ready`, `drain`). For jarvisd it
forks the jarvisd entry with `execPath` set to Bun and `serialization: 'json'` (Bun's IPC speaks
Node's JSON protocol; Node generations use JSON too now); the protocol (`PA_SUPERVISED`,
`/healthz`, `drain`, lease release) is unchanged. `PA_RUNTIME=bun` in the supervisor's
environment selects it (`runtimeSpec` in `src/supervisor/index.js`; Bun from `PA_BUN`, else
jarvisd's pinned npm install), and every generation then runs `jarvisd/src/main.ts` under Bun;
`test/supervisorBun.test.js` starts and rolls Bun generations. The runtime is read when the
supervisor starts, so switching a stack is a supervisor restart (the bootstrap path), and so is
switching back. Phase 4.4 later folds the supervisor into jarvisd itself.

### Switching a stack to Bun (and back)

The runtime is read when the supervisor starts, so a switch is one supervisor restart (the same
short gap as the bootstrap), not a roll. On the work laptop (the pa-worker task runs
`node src\supervisor` in `personal-assistant/`):

1. `git -C C:\repos\dev-tools pull --ff-only`, then `npm ci` in `C:\repos\dev-tools\jarvisd`
   (installs the pinned Bun; `jarvisd\node_modules\bun\bin\bun.exe --version` says 1.3.13).
2. Check the graph loads: `C:\repos\dev-tools\jarvisd\node_modules\bun\bin\bun.exe
   C:\repos\dev-tools\jarvisd\src\main.ts --check` prints `jarvisd ok`.
3. Add `PA_RUNTIME=bun` to `personal-assistant\.env` (the supervisor reads it there; `PA_BUN`
   names another Bun if wanted).
4. `Stop-ScheduledTask pa-worker; Start-ScheduledTask pa-worker`.
5. Verify: `node src\supervisor status` (in `personal-assistant/`) shows `"runtime": "bun"` and a
   generation; the supervisor log says `spawned generation ... runtime: bun`; the dashboard,
   `/api/events` and a factory job behave as before. `pa doctor` should be unchanged.

Rollback: delete the `PA_RUNTIME=bun` line (or set `node`) and restart the task again (step 4).
Deploys (`windows\redeploy.ps1`) keep working either way; `deploy.js` also re-runs `npm ci` in
`jarvisd/` when its package files change.

## Build

`node scripts/build.js --only jarvisd` runs `bun build --compile jarvisd/src/main.ts`: one
executable with the Bun runtime and the worker's whole module graph (791 modules, npm packages
included) bundled; ~116 MB on Windows. `jarvisd --check` loads the graph and exits (CI's smoke
test). Bun comes from npm (`jarvisd/package.json` pins it), so `npm ci` in `jarvisd/` is the only
setup; T7's cargo and Bun caches apply.

## Status

- [x] Stage 1: host, Bun parity, compiled build, CI on Windows and Linux.
- [x] Supervisor runs jarvisd generations (`PA_RUNTIME=bun`), tested with the fixture worker.
- [ ] A live run of the work stack with `PA_RUNTIME=bun`.
- [x] First module in strict TS: `src/events/bus.ts` (the pattern above).
- [ ] Stage 2 onward, as above.
