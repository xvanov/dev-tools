# Cutover runbook: Postgres to SQLite (plan 3.5)

The store of one stack moves from Postgres to one SQLite file (D2). Do the personal stack
first, then the work stack (3.5).

**Done on both stacks, 2026-11-08** (see "The cutover on 2026-11-08" at the end). Both run with
`PA_DB=sqlite`; their Postgres databases are as they were at the cutover, for the rollback.

What is ready, and where it was proven:

| Piece | What | Proof |
|---|---|---|
| Backend | `src/db/sqlite.js`, `sql-sqlite/`, `src/repo/sqlite/*` (3.1) | contract: 1206 cases green on both stores, CI Linux + Windows |
| Durable tasks | own queue on SQLite, same interface as Absurd (D19) | `test/durableSqlite.test.js` |
| Export | `pa db export --to sqlite <file>` (3.3) | work stack: 51 tables match, vectors identical, 105 s |
| Comparison | `pa db compare --sqlite <file>` (3.4) | board reads identical; SQLite hit@10 0.771 vs 0.625 |
| Backups | `pa backup`, `pa backup restore --to <file>`, `pa restore` on SQLite | work-stack size: snapshot 6 s, bundle 10 s, drill PASS |

Postgres is never written by any of this. It stays as it was at the cutover, which is what
makes the rollback (below) a config change.

## The day before

On the stack being moved, from its `personal-assistant` checkout (`git pull` on `main`, the
deploy already done):

1. The driver is installed: `node -e "require('better-sqlite3-multiple-ciphers'); require('sqlite-vec')"`
   prints nothing. (Both are optional dependencies with prebuilt binaries; `.npmrc` keeps npm
   from trying to build them.)
2. A store key, kept out of files: `pa secret set PA_SQLITE_KEY` (the OS vault; the
   environment or `.env` also work). Use a long random value, and keep a copy where the backup
   key is kept: a backup cannot be read without both.
3. A backup key exists: `pa backup key init` (says so if one is already set).
4. Room on disk: about the size of the Postgres database again (the work stack: 908 MB in
   Postgres, 453 MB as SQLite), plus a few snapshots in `PA_BACKUP_DIR`. Put `PA_BACKUP_DIR` on
   a synced or network folder if the snapshots should survive the disk.
5. A rehearsal, with the stack running (Postgres is only read):
   ```
   pa db export --to sqlite <scratch dir>/pa-rehearsal.sqlite
   pa db compare --sqlite <scratch dir>/pa-rehearsal.sqlite
   ```
   Expect every line `ok`, `exported to ...`, and in the comparison: board reads `same order`
   or `same rows` (the stack kept writing between the two, so a few rows may differ), vector
   overlap above 0.95, no errors. Time the export: it is most of the downtime below. Delete
   the scratch file after.

6. Optional, and done once on the work laptop on 2026-11-08 (below): a worker rehearsal on that
   scratch file, which touches no outside service and no person.

### Worker rehearsal on a scratch copy

A second worker, on a copy, on a spare port, with only the local passes. Set, for that process
only:

```
PA_NO_SUPERVISOR=1  PA_DB=sqlite  PA_SQLITE_PATH=<scratch>.sqlite  PA_SQLITE_KEY=<its key>
PA_DATABASE_URL=postgres://pa:pa@127.0.0.1:1/blocked     # any stray Postgres path fails, never reaches the live one
PA_DATA_DIR=<scratch>/data  PA_BACKUP_DIR=<scratch>/backups  PA_BACKUP_KEY=<a scratch key>
PA_DISPATCH_PORT=7399  PA_TOASTS=0  PA_NTFY=off  PA_CHAT_NUDGE=0  PA_FACTORY_MACHINE=none
PA_M365=0 PA_TEAMS_CACHE=0 PA_SESSIONS=0 PA_GITHUB=0 PA_JIRA=0 PA_AUDIO_ENABLED=0
PA_AUDIO_MEETING_GATE=0 PA_BRIEFS=0 PA_REPOS=0 PA_PLANNER=0 PA_CARD_CONTEXT=0 PA_FAST_LANE=0
PA_REPLY_CLOSE=0 PA_DEDUPE=0 PA_BLOCKS=0 PA_RECONCILE=0
PA_ONLY_PASSES=memory-extract,memory-consolidate,memory-pages,memory-dream,routines,durable,durable-worker,backup,retention
```

and run `node src/worker.js`. `PA_ONLY_PASSES` is what makes it safe: several passes have no
switch of their own, and they shell out to logged-in `claude -p` and `gh`. The factory pacer
stays off because its poll can submit or cancel jobs on the live factory. The board can be
refreshed read-only, once, with `refreshBoard()` (`factory job list`).

Result on the work laptop, 2026-11-08, on a fresh export (453 MB, encrypted):
- Start: migrations, the lease (a row in `lease`), the durable worker, and the dashboard on
  :7399, all within a second.
- 12 minutes monitored:
  - `/healthz` answered 63 of 63, median 35 ms. One 4.3 s stall is the nightly bundle's
    encryption, which is synchronous, as it is for Postgres dumps.
  - 0 sockets to Postgres, 0 pass failures, 0 errors. Memory held at 89 MB.
- Passes:
  - memory wrote 3 pages; routines had nothing due.
  - The durable queue took the 10 chases copied from Absurd as sleeping and due, within a
    second of start; 7 completed and 3 are asleep until their time.
  - The backup pass wrote `pa-latest.sqlite` (9 s, off the event loop) and the nightly
    `.pabak` (20 s).
  - `pa backup restore --to` on that bundle: PASS, 79 tables, row counts match.
- Live feed:
  - An insert from another process reached `/api/events` as `g6702` within the poll.
  - `Last-Event-ID: g6690` replayed the 12 events after it.
  - The board, `/factory` and `/architecture` pages load (54-430 ms).
  - The factory board refreshed read-only from `factory serve`: 10 jobs.
- What the first tries found, all fixed before this run:
  - The pages pass held the event loop for 69 s; it now takes 324 ms.
  - The hourly snapshot blocked for 6+ s; it now runs on a worker thread.
  - The live-feed listener opened a Postgres connection to `PA_DATABASE_URL` (read-only
    LISTEN on the live store during those first tries); on SQLite it now uses a session of
    the store.
  - Statements over 250 ms are now logged: 24 in this run, 250-413 ms each.

## The cutover

There is no delta to replay: writers are stopped for the few minutes the export takes, so the
file is exactly what Postgres holds.

| Stack | Stop the worker | Start the worker |
|---|---|---|
| work (Windows) | `Stop-ScheduledTask pa-worker` | `Start-ScheduledTask pa-worker` |
| personal (Linux) | `systemctl --user stop pa-worker` | `systemctl --user start pa-worker` |

1. **Note the time.** Everything written after this is on SQLite only.
2. **Stop every writer.**
   - Stop the worker (table above). It also serves the dashboard and the chat, so they go
     down with it.
   - End Claude sessions that have the `pa` MCP server loaded, and don't run `pa` verbs
     until step 7.
   - The factory may keep running: its calls to the PA fail while the worker is down and are
     retried.
3. **A last Postgres backup:** `pa backup` (the nightly kind, run now).
4. **Export.** Use the path the store will live at; the default is `<PA_DATA_DIR>/pa.sqlite`,
   or set `PA_SQLITE_PATH` first.
   ```
   pa db export --to sqlite <path>
   ```
   Every line must say `ok`, and the last one `exported to <path>`. Anything `BAD`: stop here,
   start the worker again on Postgres (nothing has changed), and look at what it says.
5. **Compare.** `pa db compare --sqlite <path>`. With writers stopped, the six board reads must
   be `same order` or `same rows`, with no `DIFFER` and no errors.
6. **Switch.** Add to the stack's `personal-assistant/.env`:
   ```
   PA_DB=sqlite
   PA_SQLITE_PATH=<path>        # only if not the default
   ```
   (`PA_SQLITE_KEY` comes from the vault, step 2 of the day before.)
7. **Start the worker** (table above). At start it migrates the file (nothing to do, the
   export did it) and takes its lease from the `lease` table.
8. **Verify.**
   - `pa doctor`: `sqlite <path> · encrypted`, `sqlite-vec loaded`.
   - The dashboard loads the board. Open it in two browser tabs and move or snooze a card in
     one: the other follows within a second (the live feed). Events from other processes
     reach it through the outbox poll (`test/sqliteNotify.test.js`).
   - `pa search <a word you know>` finds things; `pa inbox` lists open asks.
   - `pa e2e`: the golden path on the stack (Track E), green.
   - `pa backup`, then `pa backup restore --to <scratch dir>/pa-drill.sqlite`: `PASS`, row
     counts match the manifest.
9. **Watch the first hour.** Look for `SQLITE_BUSY` or `database is locked` in the worker log,
   and for pass timings in Meter that are slower than they were on Postgres.

## Rollback

Any time, in the same few minutes as the cutover:

1. Stop the worker.
2. Remove `PA_DB=sqlite` from `.env` (or set `PA_DB=postgres`).
3. Start the worker. It is on Postgres as it was at step 1 of the cutover.

What is lost: whatever was written on SQLite since the cutover. Ingested mail, chat and the
rest come back on their own, since the sync cursors in Postgres are where they were and ingest
fetches again from there. Things done by hand do not come back: drafts sent, proposals
answered, cards moved, notes. So decide within the first day. After that, roll forward by
fixing on SQLite instead. Keep the SQLite file either way, for a look at what went wrong.

## Afterwards

- Backups on SQLite:
  - The hourly backup pass refreshes `pa-latest.sqlite` in `PA_BACKUP_DIR` when it is older
    than `PA_SQLITE_SNAPSHOT_MINUTES` (60). That is the most a lost disk costs.
  - The nightly `.pabak` bundle is as before, encrypted with `PA_BACKUP_KEY`, with the
    snapshot inside.
  - Run `pa backup restore --to <scratch file>` now and then: it is the drill.
  - Not Litestream: it cannot read a file encrypted with `PA_SQLITE_KEY` and has no
    supported Windows build. The snapshots are `VACUUM INTO` copies, consistent and still
    encrypted.
- A restore (`pa restore [file]`, worker stopped) checks the backup, moves the current file
  aside as `<path>.before-restore-<stamp>`, and puts the backup in its place.
- Postgres stays installed and untouched until 3.6 retires it (and WSL on the work laptop).
  Don't drop it before both stacks have run on SQLite for a while.

## Known differences on SQLite

These are stated in each `src/repo/sqlite/*.js` file and measured in PLAN 3.4. None of them
changes a result a user would rely on.

- Keyword ranking is FTS5's bm25 with porter stemming and Postgres's English stop words, not
  ts_rank. It scores better on the eval set: hit@10 0.771 vs 0.625.
- Vector search ranks every vector's sign bits first, then the best 400 by exact cosine:
  40-80 ms over 31k chunks (Postgres's approximate index: ~20 ms).
- `lower()` and `like` fold ASCII letters only. A regex that Postgres ran in SQL is run in JS.
  Timestamps keep milliseconds, not microseconds, so ties are broken by id.
- Live-feed events written by another process (the `pa` CLI, the MCP server, the other worker
  generation during a roll) reach the dashboard within 0.1 s (an outbox poll), not at commit.
- Integers come back as numbers where Postgres gave bigints as strings; every caller already
  converts.
- A statement runs on the event loop, so it holds the loop for as long as it takes (anything over
  `PA_SQLITE_SLOW_MS`, 250 ms, is logged as `slow statement`). A pass's run of statements gives
  the loop a turn once they have held it for 50 ms, but not inside a transaction.
- Text length tests (`length(x) >= n`) read the length from the record header where they can
  (`atLeastChars`, src/repo/sqlite/_sql.ts). Reading the column itself would load the text,
  which sits on overflow pages. The result is the same, in characters.

## The cutover on 2026-11-08

- **Personal stack** (14:53Z). The keyring (Secret Service) is locked for headless processes
  there, so `pa secret set PA_SQLITE_KEY --env-file` and `PA_BACKUP_KEY` likewise (there was
  no backup key before: backups were plain). The store was near empty (one chunk), so the export
  and the comparison took seconds; the six board reads were the same order. Doctor:
  `sqlite ... encrypted`, `sqlite-vec loaded`; the worker holds no Postgres socket. Drill PASS
  (79 tables).
- **Work stack** (15:01Z). `pa backup key init` and `PA_SQLITE_KEY` into Windows Credential
  Manager first (no backup key there either). Export 90 s, comparison 3.5 min (its 171 queries
  run on Postgres too), board reads same order (the inbox same rows, other order); about 5 min
  down in all. Drill PASS: 79 tables in 18 s, bundle 462 MB.
- Found on the way: a first attempt was rolled back by the operator's own script, because
  PowerShell wraps a native command's stderr (the `slow statement` warnings) as
  `NativeCommandError` text and the script took that for an error. Redirect through
  `cmd /c "... > file 2>&1"` when scripting these steps in PowerShell. Nothing was lost: the
  stack started on Postgres again and the second export was fresh.
- **Found afterwards: deploys rolled back.** On the work store (31k chunks, 10k claims, 7k items)
  a new generation's first passes blocked the event loop for up to 20 s, and it failed its health
  checks. The serving generation also blocked for 4-10 s every few minutes. The cause was scans
  that tested one narrow column but read every wide row to reach it: a chunk or claim carries a
  6 KB vector, and an item carries its body and raw JSON. Each scan took 0.2-0.9 s, and 12-60 s
  while the hourly snapshot was reading the file. Several of them ran back to back as one chain
  of microtasks.
  - The fix: the indexes in sql-sqlite/008, id-first reads, and the turn every 50 ms (above).
  - The result on a scratch copy of the work store: the pass reads take 0-170 ms. The
    dashboard's memory stats still take about 350 ms. A worker
    rehearsal answered every `/healthz` within 0.6 s for its first 2 minutes, nightly bundle
    included (before: 24 probes over 1 s, up to 5.7 s).
  - The nightly bundle no longer blocks either. Its manifest counted each keyword index by
    reading every chunk (2.5 s each), and it sealed the file on the event loop (2.5 s). Each
    index's count now comes from its content table, which gives the same number, and the
    sealing runs on a thread.
  - The first start on 008 builds its indexes in one migration, holding the write lock for about
    5 s. Writes from the serving generation wait for it (up to `busy_timeout`, 10 s).
