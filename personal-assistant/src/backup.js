'use strict';

// Backups of the store, and the two ways back from losing it.
//
// The database is the only copy of the memory: claims, pages, distilled
// commitments, transcripts whose audio is long deleted, and months of Teams
// and mail that retention-limited connectors will not hand back. So:
//
//  - **dump** — `pg_dump -Fc` of the whole database to a local folder, run
//    nightly by the worker and rotated. pg_dump runs inside the WSL distro
//    that hosts Postgres (no Windows client to install), writing straight to
//    the Windows path through /mnt so the bytes never cross a pipe.
//  - **restore** — `pg_restore --clean` of a dump. Destructive by definition,
//    so it is a CLI command you confirm, never something the worker does.
//  - **reingest** — the fallback with no dump: rewind each source's cursor so
//    the next passes fetch history again. Ingest is an idempotent upsert, so
//    rewinding over data that is still there costs only the fetch.
//
// A dump is written to a temporary name and renamed when pg_dump succeeds:
// a half-written file never looks like the newest good backup.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { config } = require('./config');
const { query } = require('./db');
const { logger } = require('./log');

const exec = promisify(execFile);
const log = logger('backup');

const PATTERN = /^pa-(\d{8}-\d{6})\.dump$/;

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function list(dir = config.backup.dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => PATTERN.test(n))
    .sort()
    .reverse()
    .map((n) => {
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      return { file, name: n, bytes: st.size, at: st.mtime };
    });
}

// Which files a rotation deletes: everything past the newest `keep`.
function toPrune(backups, keep) {
  return backups.slice(Math.max(1, keep));
}

// C:\Users\x\f.dump → /mnt/c/Users/x/f.dump: the distro's view of a Windows
// path, so pg_dump writes the file directly.
function wslPath(winPath) {
  const abs = path.win32.resolve(winPath);
  const m = abs.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) throw new Error(`not a drive path: ${winPath}`);
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

// Runs a program inside the WSL distro. `--exec` skips the distro's shell, so
// a URL or a path with spaces stays one argument.
async function inWsl(program, args, { timeoutMs = 30 * 60_000 } = {}) {
  return exec('wsl.exe', ['-d', config.backup.wslDistro, '--exec', program, ...args], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}

async function dump({ dir = config.backup.dir, keep = config.backup.keep } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `pa-${stamp()}.dump`;
  const final = path.join(dir, name);
  const partial = `${final}.partial`;
  const started = Date.now();
  try {
    await inWsl('pg_dump', [
      '--format=custom',
      '--compress=6',
      `--dbname=${config.databaseUrl}`,
      `--file=${wslPath(partial)}`,
    ]);
    fs.renameSync(partial, final);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw new Error(`pg_dump failed: ${(err.stderr || err.message).trim().slice(0, 300)}`);
  }
  const bytes = fs.statSync(final).size;
  const pruned = toPrune(list(dir), keep);
  for (const old of pruned) fs.rmSync(old.file, { force: true });
  log.info('dumped', { file: final, mb: (bytes / 1e6).toFixed(1), seconds: Math.round((Date.now() - started) / 1000), pruned: pruned.length });
  return { file: final, bytes, pruned: pruned.length };
}

// The worker's nightly pass. It also runs once at worker start, so it skips
// when a recent dump exists rather than writing one per restart.
async function dumpIfDue() {
  const newest = list()[0];
  if (newest && Date.now() - newest.at.getTime() < config.backup.everyHours * 3600_000) return null;
  return dump();
}

// Restores a dump over the current database. --clean --if-exists drops what
// the dump contains first, so a partially broken store comes back whole;
// --no-owner because the dump's role names are this machine's anyway.
//
// Extensions are left out of the restore list: `pa` does not own `vector`,
// so `--clean` cannot drop it, and the restore would abort. Creating one
// needs a superuser, which is what windows/setup-wsl-postgres.sh is for — on
// a rebuilt machine, run that first and it leaves an empty database with
// both extensions, ready for this.
async function restore(file) {
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  const have = await query(`select extname from pg_extension where extname in ('vector','pg_trgm')`);
  if (have.rows.length < 2) {
    throw new Error('the database lacks the vector/pg_trgm extensions — run windows/setup-wsl-postgres.sh first');
  }
  const listFile = `${file}.restore-list`;
  try {
    const { stdout } = await inWsl('pg_restore', ['--list', wslPath(file)]);
    fs.writeFileSync(listFile, restoreList(stdout));
    await inWsl('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--single-transaction',
      `--use-list=${wslPath(listFile)}`,
      `--dbname=${config.databaseUrl}`,
      wslPath(file),
    ]);
  } catch (err) {
    throw new Error(`pg_restore failed: ${(err.stderr || err.message).trim().slice(0, 500)}`);
  } finally {
    fs.rmSync(listFile, { force: true });
  }
  log.info('restored', { file });
}

// A `pg_restore --list` with the extension entries (and their comments)
// commented out.
function restoreList(listing) {
  return listing
    .split(/\r?\n/)
    .map((line) => (/^\d+;.*\b(EXTENSION|COMMENT - EXTENSION)\b/.test(line) ? `;${line}` : line))
    .join('\n');
}

// Rewinds ingest cursors so the next passes fetch `days` of history again.
// Only cursors that keep a `since` are rewound: graph_mail, graph_chat,
// github, jira. The calendar re-reads a fixed window every pass, and Claude
// sessions and audio come from local files that are re-scanned on their own.
// How far back a source can actually go is the source's limit, not ours.
async function reingest({ days, sources = [] }) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const r = await query(
    `update sync_cursor
        set state = jsonb_set(state, '{since}', to_jsonb($1::text)), delta_token = null
      where state ? 'since' and (cardinality($2::text[]) = 0 or source = any($2))
      returning source`,
    [since, sources]
  );
  return { since, sources: r.rows.map((x) => x.source) };
}

module.exports = { dump, dumpIfDue, restore, reingest, list, toPrune, stamp, wslPath, restoreList };
