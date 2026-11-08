# Cutover runbook: Postgres to SQLite (plan 3.5)

The store of one stack moves from Postgres to one SQLite file (D2). Everything the move needs
is on `main` and switched off: `PA_DB` is unset, so both stacks run on Postgres until this
runbook flips it. Do the personal stack first, then the work stack (3.5).

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
  generation during a roll) reach the dashboard within 0.5 s (an outbox poll), not at commit.
- Integers come back as numbers where Postgres gave bigints as strings; every caller already
  converts.
