'use strict';

// Backups of the store, and the two ways back from losing it.
//
// The database is the only copy of the memory: claims, pages, distilled
// commitments, transcripts whose audio is long deleted, and months of Teams
// and mail that retention-limited connectors will not hand back. So:
//
//  - **dump** — `pg_dump -Fc` of the whole database to a local folder, run
//    nightly by the worker and rotated. Where pg_dump runs follows where the
//    store runs (`config.backup.pgTools`, defaulted by src/platform):
//      wsl:<distro>        Windows. Inside the WSL distro that hosts Postgres
//                          (no Windows client to install), writing straight
//                          to the Windows path through /mnt.
//      native              Linux with a native cluster: the host's pg_dump.
//      docker:<container>  the compose store: the container's own pg_dump,
//                          which always matches the server's version, its
//                          output streamed to the file.
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
const { execFile, spawn } = require('child_process');
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

// 'wsl:Ubuntu' | 'native' | 'docker:pa-postgres' → what it means.
function parseTools(spec) {
  const m = /^(wsl|docker):(.+)$/.exec(String(spec || '').trim());
  if (m) return m[1] === 'wsl' ? { mode: 'wsl', distro: m[2] } : { mode: 'docker', container: m[2] };
  if (String(spec || '').trim() === 'native') return { mode: 'native' };
  throw new Error(`PA_PG_TOOLS: cannot read "${spec}" — want native, docker:<container> or wsl:<distro>`);
}

// Inside the container the server is on its own loopback at 5432, whatever
// port the host maps it to.
function containerUrl(url) {
  const u = new URL(url);
  u.hostname = '127.0.0.1';
  u.port = '5432';
  return u.toString();
}

// Pure: the process that runs `program args` against the store for this
// mode. Paths among the args must already be in the program's view of the
// filesystem (the distro's /mnt path, the container's /tmp copy).
function toolCommand(tools, program, args) {
  if (tools.mode === 'wsl') return { cmd: 'wsl.exe', args: ['-d', tools.distro, '--exec', program, ...args] };
  if (tools.mode === 'docker') return { cmd: 'docker', args: ['exec', tools.container, program, ...args] };
  return { cmd: program, args };
}

// Pure: the dump step. The docker one prints the archive on stdout, which is
// streamed to `file`; the others write `file` themselves.
function dumpCommand(tools, { url, file }) {
  const base = ['--format=custom', '--compress=6'];
  if (tools.mode === 'docker') {
    return { ...toolCommand(tools, 'pg_dump', [...base, `--dbname=${containerUrl(url)}`]), stdoutFile: file };
  }
  const target = tools.mode === 'wsl' ? wslPath(file) : file;
  return toolCommand(tools, 'pg_dump', [...base, `--dbname=${url}`, `--file=${target}`]);
}

// Runs one command; with `stdoutFile`, its stdout goes to that file.
function runTool({ cmd, args, stdoutFile }, { timeoutMs = 30 * 60_000 } = {}) {
  if (!stdoutFile) {
    return exec(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  }
  return new Promise((resolve, reject) => {
    const outFile = fs.createWriteStream(stdoutFile);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.pipe(outFile);
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      outFile.destroy();
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      outFile.close(() => (code === 0 ? resolve({ stdout: '', stderr }) : reject(Object.assign(new Error(`exit ${code}`), { stderr }))));
    });
  });
}

async function dump({ dir = config.backup.dir, keep = config.backup.keep } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `pa-${stamp()}.dump`;
  const final = path.join(dir, name);
  const partial = `${final}.partial`;
  const started = Date.now();
  try {
    await runTool(dumpCommand(parseTools(config.backup.pgTools), { url: config.databaseUrl, file: partial }));
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
// needs a superuser, which is what the provisioners are for
// (windows/setup-wsl-postgres.sh, linux/setup-postgres.sh, or the compose
// container's first start) — on a rebuilt machine, run that first and it
// leaves an empty database with both extensions, ready for this.
async function restore(file) {
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  const have = await query(`select extname from pg_extension where extname in ('vector','pg_trgm')`);
  if (have.rows.length < 2) {
    throw new Error(`the database lacks the vector/pg_trgm extensions — run ${require('./platform').services.dbProvision} first`);
  }
  const tools = parseTools(config.backup.pgTools);
  const listFile = `${file}.restore-list`;
  // The docker tools see the container's filesystem: the dump and the list go
  // in through `docker cp` and are removed after.
  const inside = tools.mode === 'docker' ? `/tmp/pa-restore-${process.pid}-${Date.now()}` : null;
  const view = (p) => (tools.mode === 'wsl' ? wslPath(p) : inside ? `${inside}${p === listFile ? '.list' : '.dump'}` : p);
  try {
    if (inside) await runTool({ cmd: 'docker', args: ['cp', file, `${tools.container}:${view(file)}`] });
    const { stdout } = await runTool(toolCommand(tools, 'pg_restore', ['--list', view(file)]));
    fs.writeFileSync(listFile, restoreList(stdout));
    if (inside) await runTool({ cmd: 'docker', args: ['cp', listFile, `${tools.container}:${view(listFile)}`] });
    await runTool(
      toolCommand(tools, 'pg_restore', [
        '--clean',
        '--if-exists',
        '--no-owner',
        '--single-transaction',
        `--use-list=${view(listFile)}`,
        `--dbname=${tools.mode === 'docker' ? containerUrl(config.databaseUrl) : config.databaseUrl}`,
        view(file),
      ])
    );
  } catch (err) {
    throw new Error(`pg_restore failed: ${(err.stderr || err.message).trim().slice(0, 500)}`);
  } finally {
    fs.rmSync(listFile, { force: true });
    if (inside) await runTool({ cmd: 'docker', args: ['exec', tools.container, 'rm', '-f', view(file), view(listFile)] }).catch(() => {});
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

// For `pa doctor`: a native pg_dump older than the server refuses to dump it
// ("server version mismatch"), which would surface only at 2 a.m.
async function toolsCheck() {
  const tools = parseTools(config.backup.pgTools);
  if (tools.mode !== 'native') return { ok: true, detail: '' };
  const r = await exec('pg_dump', ['--version'], { timeout: 10_000, windowsHide: true }).catch((err) => ({ error: err }));
  if (r.error) return { ok: false, detail: 'pg_dump not found — install postgresql-client, or set PA_PG_TOOLS=docker:<container>' };
  const client = Number((/(\d+)(?:\.\d+)?/.exec(r.stdout) || [])[1]);
  const row = await query(`select current_setting('server_version_num')::int / 10000 as major`).catch(() => null);
  const server = row ? Number(row.rows[0].major) : null;
  if (server && client && client < server) return { ok: false, detail: `pg_dump ${client} is older than the server (${server}) — dumps will fail` };
  return { ok: true, detail: `pg_dump ${client || '?'}` };
}

module.exports = { dump, dumpIfDue, restore, reingest, list, toPrune, stamp, wslPath, restoreList, parseTools, containerUrl, dumpCommand, toolCommand, toolsCheck };
