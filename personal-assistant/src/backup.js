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
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

const { config } = require('./config.ts');
const repo = require('./repo');
const { logger } = require('./log.ts');
const crypt = require('./backupCrypto.ts');

const exec = promisify(execFile);
const log = logger('backup');

// PA_DB=sqlite: the same verbs on a SQLite file (src/backupSqlite.js); Postgres is unchanged.
const sqliteStore = () => repo.backend.dialect === 'sqlite';

// `.pabak` is the encrypted bundle (pg_dump + factory state + a manifest, see
// bundle() below); `.dump` is a bare pg_dump, what older versions wrote and
// what a machine with no keychain still writes.
const PATTERN = /^pa-(\d{8}-\d{6})\.(dump|pabak)$/;
const KEY_NAME = 'PA_BACKUP_KEY';

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
      return { file, name: n, bytes: st.size, at: st.mtime, encrypted: n.endsWith('.pabak') };
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

// Pure: the store's URL without its password, and the password. The password
// travels as PGPASSWORD in the tool's environment, never on its command line
// (which `ps` shows to every user on the machine).
function splitPassword(url) {
  const u = new URL(url);
  const password = u.password ? decodeURIComponent(u.password) : null;
  u.password = '';
  return { url: u.toString(), password };
}

// Pure: the process that runs `program args` against the store for this
// mode. Paths among the args must already be in the program's view of the
// filesystem (the distro's /mnt path, the container's /tmp copy). With a
// `password`, it reaches the program as PGPASSWORD: in this process's env for
// a native tool, named (no value) with `docker exec -e` so the docker CLI
// passes its own copy, and through WSLENV into the distro.
function toolCommand(tools, program, args, { password = null } = {}) {
  const env = password ? { PGPASSWORD: password } : null;
  if (tools.mode === 'wsl') {
    const wslenv = env ? { ...env, WSLENV: [process.env.WSLENV, 'PGPASSWORD/u'].filter(Boolean).join(':') } : null;
    return withEnv({ cmd: 'wsl.exe', args: ['-d', tools.distro, '--exec', program, ...args] }, wslenv);
  }
  if (tools.mode === 'docker') {
    return withEnv({ cmd: 'docker', args: ['exec', ...(env ? ['-e', 'PGPASSWORD'] : []), tools.container, program, ...args] }, env);
  }
  return withEnv({ cmd: program, args }, env);
}

function withEnv(command, env) {
  return env ? { ...command, env } : command;
}

// Pure: the dump step. The docker one prints the archive on stdout, which is
// streamed to `file`; the others write `file` themselves.
function dumpCommand(tools, { url, file }) {
  const base = ['--format=custom', '--compress=6'];
  if (tools.mode === 'docker') {
    const c = splitPassword(containerUrl(url));
    return { ...toolCommand(tools, 'pg_dump', [...base, `--dbname=${c.url}`], c), stdoutFile: file };
  }
  const target = tools.mode === 'wsl' ? wslPath(file) : file;
  const c = splitPassword(url);
  return toolCommand(tools, 'pg_dump', [...base, `--dbname=${c.url}`, `--file=${target}`], c);
}

// Runs one command; with `stdoutFile`, its stdout goes to that file.
function runTool({ cmd, args, stdoutFile, env }, { timeoutMs = 30 * 60_000 } = {}) {
  const childEnv = env ? { ...process.env, ...env } : process.env;
  if (!stdoutFile) {
    return exec(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: childEnv });
  }
  return new Promise((resolve, reject) => {
    const outFile = fs.createWriteStream(stdoutFile);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv });
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

// ------------------------------------------------------------ encryption --

// The backup key: 32 random bytes, base64, the PA_BACKUP_KEY secret (env, the
// OS keychain labelled by stack, or .env: config.secret). With `create`, a
// missing key is generated into the keychain. Never into .env: a key beside
// the backups protects nothing. Returns null when there is none and none can
// be stored, and the caller decides (a dump then stays plain and says so).
function backupKey({ create = false } = {}) {
  const cfg = require('./config.ts');
  const have = cfg.secret(KEY_NAME);
  if (have) return { key: crypt.parseKey(have), created: false };
  if (!create) return null;
  const vault = require('./secrets/vault');
  if (!vault.available()) return null;
  const key = crypt.generateKey();
  vault.set(KEY_NAME, key.toString('base64'));
  cfg.forgetSecret(KEY_NAME);
  return { key, created: true };
}

// The factory's state dir, when the factory runs on this machine.
function factoryStateDir() {
  const f = config.factory;
  if (!f.path || f.machine) return null;
  const dir = path.join(f.path, 'state');
  return fs.existsSync(dir) ? dir : null;
}

// What a backup leaves out of the factory state: logs are huge and rebuildable,
// locks are meaningless on another machine.
const STATE_EXCLUDE = ['logs', 'locks'];

function stateStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d, top) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (top && STATE_EXCLUDE.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, false);
      else if (e.isFile()) {
        files += 1;
        bytes += fs.statSync(p).size;
      }
    }
  };
  walk(dir, true);
  return { files, bytes };
}

// Windows ships bsdtar as System32\tar.exe; a `tar` from Git for Windows on
// PATH is GNU tar and reads "C:\..." as host:path. Name the system one.
function tarBin() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

/**
 * The encrypted bundle: `pa.dump` (the pg_dump), `state/` (the factory's state
 * dir, when the factory is local) and `manifest.json` (the table row counts at
 * backup time, which the restore drill checks), in a tar, encrypted with
 * AES-256-GCM (src/backupCrypto.js). Consumes `dumpFile`.
 */
async function bundle({ dumpFile, out, key, state = factoryStateDir(), counts, entry = 'pa.dump' }) {
  const stage = fs.mkdtempSync(path.join(path.dirname(out), '.stage-'));
  try {
    // entry: pa.dump (pg_dump), or pa.sqlite (a SQLite store's snapshot, src/backupSqlite.js).
    fs.renameSync(dumpFile, path.join(stage, entry));
    if (counts === undefined) counts = await require('./repo').backupDrill.tableCounts().catch(() => null);
    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      stack: require('./platform/common').stack(),
      counts,
      state: state ? stateStats(state) : null,
    };
    fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const tarFile = path.join(stage, 'bundle.tar');
    const args = ['-cf', tarFile];
    if (state) args.push(...STATE_EXCLUDE.map((n) => `--exclude=state/${n}`));
    args.push('-C', stage, 'manifest.json', entry);
    if (state) args.push('-C', path.dirname(state), path.basename(state));
    await runTool({ cmd: tarBin(), args });
    return { bytes: crypt.encryptFile(tarFile, out, key), manifest };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Decrypts and unpacks a `.pabak` into a fresh private folder (the caller
 * removes `dir`). Throws, leaving nothing behind, on a wrong key or a damaged
 * file: nothing is extracted from a bundle that failed authentication.
 */
function unpack(file, { key = null } = {}) {
  const k = key || (backupKey() || {}).key;
  if (!k) throw new Error(`${file} is encrypted and there is no ${KEY_NAME} on this machine (keychain, env or .env)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-unpack-'));
  try {
    const tarFile = path.join(dir, 'bundle.tar');
    crypt.decryptFile(file, tarFile, k);
    // Sync, like the decrypt: this is the restore path, not a worker pass.
    const r = require('child_process').spawnSync(tarBin(), ['-xf', tarFile, '-C', dir], { windowsHide: true, encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new Error(`tar could not unpack the backup: ${String(r.stderr || r.error).trim().slice(0, 200)}`);
    fs.rmSync(tarFile, { force: true });
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      /* a bundle without one still restores; the drill says it could not compare */
    }
    const stateDir = path.join(dir, 'state');
    const store = fs.existsSync(path.join(dir, 'pa.sqlite')) ? 'pa.sqlite' : 'pa.dump';
    return { dir, dumpFile: path.join(dir, store), manifest, stateDir: fs.existsSync(stateDir) ? stateDir : null };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

async function dump({ dir = config.backup.dir, keep = config.backup.keep, plain = false } = {}) {
  if (sqliteStore()) return require('./backupSqlite').dump({ dir, keep, plain });
  fs.mkdirSync(dir, { recursive: true });
  const id = stamp();
  const plainFinal = path.join(dir, `pa-${id}.dump`);
  const partial = `${plainFinal}.partial`;
  const started = Date.now();
  try {
    await runTool(dumpCommand(parseTools(config.backup.pgTools), { url: config.databaseUrl, file: partial }));
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw new Error(`pg_dump failed: ${(err.stderr || err.message).trim().slice(0, 300)}`);
  }
  let final = plainFinal;
  const k = plain ? null : backupKey({ create: true });
  if (k) {
    final = path.join(dir, `pa-${id}.pabak`);
    try {
      await bundle({ dumpFile: partial, out: final, key: k.key });
    } catch (err) {
      fs.rmSync(final, { force: true });
      throw new Error(`encrypting the backup failed: ${String(err.stderr || err.message).trim().slice(0, 300)}`);
    } finally {
      fs.rmSync(partial, { force: true });
    }
    if (k.created) {
      log.warn(`a new backup key was stored in the keychain as ${KEY_NAME}; backups cannot be read without it. Copy it off this machine: pa backup key export --to <file>`);
    }
  } else {
    fs.renameSync(partial, plainFinal);
    if (!plain) log.warn(`backup written UNENCRYPTED: no ${KEY_NAME} and no keychain to hold one (pa backup key init)`);
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
  if (sqliteStore()) return require('./backupSqlite').dumpIfDue();
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
//
// `file` may be an encrypted `.pabak` bundle: it is decrypted and unpacked to a
// private temp folder first, and the folder is removed after. With `url` set
// the restore goes there instead (the drill's scratch database): then the
// extensions are the caller's job and the install id is left alone.
async function restore(file, { url = null } = {}) {
  if (sqliteStore()) return require('./backupSqlite').restore(file);
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  if (crypt.isEncrypted(file)) {
    const unpacked = unpack(file);
    try {
      return await restore(unpacked.dumpFile, { url });
    } finally {
      fs.rmSync(unpacked.dir, { recursive: true, force: true });
    }
  }
  const live = !url;
  const target = url || config.databaseUrl;
  if (live) {
    const have = await repo.system.installedExtensions(['vector', 'pg_trgm']);
    if (have.length < 2) {
      throw new Error(`the database lacks the vector/pg_trgm extensions — run ${require('./platform').services.dbProvision} first`);
    }
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
    const db = splitPassword(tools.mode === 'docker' ? containerUrl(target) : target);
    await runTool(
      toolCommand(tools, 'pg_restore', [
        '--clean',
        '--if-exists',
        '--no-owner',
        '--single-transaction',
        `--use-list=${view(listFile)}`,
        `--dbname=${db.url}`,
        view(file),
      ], db)
    );
  } catch (err) {
    throw new Error(`pg_restore failed: ${(err.stderr || err.message).trim().slice(0, 500)}`);
  } finally {
    fs.rmSync(listFile, { force: true });
    if (inside) await runTool({ cmd: 'docker', args: ['exec', tools.container, 'rm', '-f', view(file), view(listFile)] }).catch(() => {});
  }
  if (live) await rotateInstallId();
  log.info('restored', { file, scratch: !live });
}

/**
 * A restored store is a new install (sql/026 pa_install): the dump may be
 * restored next to a live copy of itself, and two stores holding one install
 * id would hand each other's runs the same factory idempotency keys. Runs
 * already submitted keep the key on their row (run.external_id).
 */
async function rotateInstallId(replace = (id) => repo.system.replaceInstallId(id)) {
  const id = require('crypto').randomUUID();
  await replace(id);
  log.info('new install id after restore');
  return id;
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
  return { since, sources: await repo.sources.rewindCursors(since, sources) };
}

// For `pa doctor`: a native pg_dump older than the server refuses to dump it
// ("server version mismatch"), which would surface only at 2 a.m.
async function toolsCheck() {
  const tools = parseTools(config.backup.pgTools);
  if (tools.mode !== 'native') return { ok: true, detail: '' };
  const r = await exec('pg_dump', ['--version'], { timeout: 10_000, windowsHide: true }).catch((err) => ({ error: err }));
  if (r.error) return { ok: false, detail: 'pg_dump not found — install postgresql-client, or set PA_PG_TOOLS=docker:<container>' };
  const client = Number((/(\d+)(?:\.\d+)?/.exec(r.stdout) || [])[1]);
  const server = await repo.system.serverMajor().catch(() => null);
  if (server && client && client < server) return { ok: false, detail: `pg_dump ${client} is older than the server (${server}) — dumps will fail` };
  return { ok: true, detail: `pg_dump ${client || '?'}` };
}

// ------------------------------------------------------------ the drill --

/**
 * Pure: the restored tables against the counts recorded at backup time.
 * Rows move between the dump and the count, so a table passes within
 * max(10, 2%) of what the manifest says; a table the manifest has and the
 * restore lacks always fails.
 * @returns {{ok: boolean|null, checked: number, problems: {table: string, expected: number, got: number|null}[]}}
 */
function compareCounts(expected, got) {
  if (!expected) return { ok: null, checked: 0, problems: [] };
  const problems = [];
  for (const [table, want] of Object.entries(expected)) {
    const have = Object.prototype.hasOwnProperty.call(got, table) ? got[table] : null;
    const tol = Math.max(10, Math.ceil(want * 0.02));
    if (have === null || Math.abs(have - want) > tol) problems.push({ table, expected: want, got: have });
  }
  return { ok: problems.length === 0, checked: Object.keys(expected).length, problems };
}

/**
 * The restore drill (`pa backup restore --to <scratch>`): restores a backup
 * into a throwaway database, checks the row counts against the manifest, and
 * drops the database. Never touches the live one: `to` must not be it, must
 * not exist, and is created and dropped here.
 *
 * Needs a role that may CREATE DATABASE, and the vector/pg_trgm extensions in
 * the new database: either a role allowed to create them (`adminUrl`
 * overrides the connection used for everything, default the store's own URL),
 * or a `template` database that already holds them.
 */
async function drill({ file = (list()[0] || {}).file, to, keep = false, adminUrl = null, template = null, say = () => {} } = {}) {
  if (sqliteStore()) return require('./backupSqlite').drill({ file, to, keep, say });
  if (!file) throw new Error(`no backups in ${config.backup.dir}`);
  if (!require('./repo/backupDrill.ts').NAME_RE.test(String(to || ''))) {
    throw new Error('--to wants a lowercase database name (letters, digits, underscore), e.g. pa_drill');
  }
  const base = new URL(adminUrl || config.databaseUrl);
  const liveName = decodeURIComponent(new URL(config.databaseUrl).pathname.replace(/^\//, ''));
  if (to === liveName || to === 'postgres' || to.startsWith('template')) throw new Error(`refusing to restore into "${to}": give the drill its own scratch database name`);
  const withDb = (name) => {
    const u = new URL(base);
    u.pathname = `/${name}`;
    return u.toString();
  };
  const started = Date.now();
  const admin = repo.openAt(withDb('postgres'), { max: 1 });
  let unpacked = null;
  let scratch = null;
  let created = false;
  try {
    const drillAdmin = admin.backupDrill;
    if (await drillAdmin.databaseExists(to)) throw new Error(`database "${to}" already exists: the drill only ever creates and drops its own`);
    say(crypt.isEncrypted(file) ? 'decrypting and unpacking' : 'reading a plain dump (no manifest to compare against)');
    unpacked = crypt.isEncrypted(file) ? unpack(file) : { dir: null, dumpFile: file, manifest: null, stateDir: null };
    say(`creating ${to}`);
    await drillAdmin.createDatabase(to, { template });
    created = true;
    scratch = repo.openAt(withDb(to), { max: 2 });
    const scratchRepo = scratch.backupDrill;
    try {
      await scratchRepo.ensureExtensions();
    } catch (err) {
      throw new Error(`the scratch database cannot get the vector/pg_trgm extensions (${err.message}). Give the drill a role that may create them (--admin-url postgres://<superuser>@host:port/postgres), or a --template database that already has them`);
    }
    say('restoring');
    await restore(unpacked.dumpFile, { url: withDb(to) });
    const got = await scratchRepo.tableCounts();
    const rows = compareCounts(unpacked.manifest && unpacked.manifest.counts, got);
    const want = unpacked.manifest && unpacked.manifest.state;
    const have = unpacked.stateDir ? stateStats(unpacked.stateDir) : null;
    const stateOk = !want || !want.files ? null : Boolean(have) && Math.abs(have.files - want.files) <= Math.max(10, Math.ceil(want.files * 0.1));
    const restored = Object.keys(got).length;
    const ok = restored > 0 && rows.ok !== false && stateOk !== false;
    return {
      ok,
      file,
      to,
      kept: Boolean(keep),
      tables: restored,
      compared: rows.ok !== null,
      problems: rows.problems,
      state: want ? { expectedFiles: want.files, files: have ? have.files : 0, ok: stateOk } : null,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } finally {
    if (scratch) await scratch.close().catch(() => {});
    if (created && !keep) await admin.backupDrill.dropDatabase(to).catch((err) => log.warn('could not drop the drill database', { to, error: err.message }));
    await admin.close().catch(() => {});
    if (unpacked && unpacked.dir) fs.rmSync(unpacked.dir, { recursive: true, force: true });
  }
}

/** `pa backup key init`: makes sure a key is in the keychain. Never returns it. */
function keyInit() {
  const k = backupKey({ create: true });
  if (!k) throw new Error(`no keychain here to hold the backup key: set ${KEY_NAME} in the environment instead`);
  return { created: k.created };
}

/**
 * `pa backup key export --to <file>`: writes the key to a new file (mode 600,
 * refuses to overwrite) so it can be kept off this machine: without it a
 * backup is unreadable after the keychain is lost. The key is not printed.
 */
function keyExport(to) {
  const k = backupKey();
  if (!k) throw new Error(`no ${KEY_NAME} on this machine yet: run \`pa backup key init\``);
  fs.writeFileSync(to, `${k.key.toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
  return { file: path.resolve(to) };
}

module.exports = {
  compareCounts, drill, keyInit, keyExport, backupKey, bundle, unpack, stateStats,
  rotateInstallId, dump, dumpIfDue, restore, reingest, list, toPrune, stamp, wslPath, restoreList, parseTools, containerUrl, dumpCommand, toolCommand, toolsCheck, splitPassword };
