'use strict';

// Backups when the store is SQLite (PA_DB=sqlite; plan 3.5 prep). src/backup.js
// hands over to this module; the bundle, its encryption (PA_BACKUP_KEY), the
// rotation and the manifest checks are the same as for Postgres.
//
// Why not Litestream: it reads the database with its own SQLite build to
// checkpoint and to track its position, so it cannot open a store encrypted
// with PA_SQLITE_KEY (SQLCipher), and it has no supported Windows build. What
// this does instead, on Windows and Linux alike:
//
//  - **snapshot**: `VACUUM INTO` on a separate read-only connection. It is a
//    consistent copy of one moment (a WAL read transaction), the writer keeps
//    writing meanwhile, the copy is compacted, and it stays encrypted with the
//    store's key when there is one. Written under a temporary name, renamed
//    when complete.
//  - **rolling snapshot**: `pa-latest.sqlite` in the backup dir, refreshed by
//    the worker's hourly backup pass when older than PA_SQLITE_SNAPSHOT_MINUTES
//    (60): the most a disk loss costs is that much (RPO). Point PA_BACKUP_DIR
//    at a synced or network folder to keep it off the machine.
//  - **nightly bundle**: `pa-<stamp>.pabak` (manifest with row counts, the
//    snapshot as `pa.sqlite`, the factory state), encrypted, PA_BACKUP_KEEP kept.
//  - **drill** (`pa backup restore --to <new file>`): restores a bundle or a
//    snapshot into a scratch file and proves it: integrity_check, the FTS
//    index's integrity-check, foreign_key_check, row counts against the
//    manifest (or the live store, for a snapshot), a keyword search.
//  - **restore** (`pa restore`): the worker stopped, the current file is moved
//    aside (`<file>.before-restore-<stamp>`), the backup put in its place.

const fs = require('fs');
const path = require('path');

const { config } = require('./config');
const { logger } = require('./log');
const crypt = require('./backupCrypto');

const log = logger('backup');
const LATEST = 'pa-latest.sqlite';

const backup = () => require('./backup');
const sqlite = () => require('./db/sqlite');

function rmFile(f) {
  for (const x of ['', '-wal', '-shm']) fs.rmSync(`${f}${x}`, { force: true });
}

/**
 * VACUUM INTO on a worker thread: better-sqlite3 is synchronous, and copying
 * the work stack's 450 MB takes ~6 s, which on the worker's own thread is 6 s
 * of a dashboard that does not answer (found by the 3.5 rehearsal).
 */
function snapshotOffThread(src, dest, key) {
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const w = new Worker(
      "const { workerData: d } = require('worker_threads'); require(d.mod).snapshotFile(d.src, d.dest, { key: d.key });",
      { eval: true, workerData: { mod: require.resolve('./db/sqlite'), src, dest, key } }
    );
    w.once('error', reject);
    w.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`the snapshot thread exited with ${code}`))));
  });
}

/** A consistent copy of the store at `dest` (a new file), encrypted as the store is. */
async function snapshot(dest, { src = config.sqlitePath, key = config.sqliteKey || null } = {}) {
  const partial = `${dest}.partial`;
  rmFile(partial);
  const started = Date.now();
  await snapshotOffThread(src, partial, key);
  fs.renameSync(partial, dest);
  return { file: dest, bytes: fs.statSync(dest).size, seconds: (Date.now() - started) / 1000 };
}

/** The rolling snapshot, refreshed when older than `minutes`. Resolves it, or null when fresh enough. */
async function refreshLatest({ dir = config.backup.dir, minutes = config.backup.snapshotMinutes } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LATEST);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < minutes * 60_000) return null;
  const r = await snapshot(file);
  log.info('snapshot', { file, mb: (r.bytes / 1e6).toFixed(1), seconds: r.seconds.toFixed(1) });
  return r;
}

/** The nightly bundle (as src/backup.js dump(), with the SQLite snapshot inside). */
async function dump({ dir = config.backup.dir, keep = config.backup.keep, plain = false } = {}) {
  const b = backup();
  fs.mkdirSync(dir, { recursive: true });
  const id = b.stamp();
  const snap = path.join(dir, `pa-${id}.sqlite.partial`);
  const started = Date.now();
  await snapshot(snap);
  const k = plain ? null : b.backupKey({ create: true });
  let final;
  if (k) {
    final = path.join(dir, `pa-${id}.pabak`);
    try {
      await b.bundle({ dumpFile: snap, out: final, key: k.key, entry: 'pa.sqlite' });
    } catch (err) {
      fs.rmSync(final, { force: true });
      throw new Error(`encrypting the backup failed: ${String(err.stderr || err.message).trim().slice(0, 300)}`);
    } finally {
      rmFile(snap);
    }
  } else {
    // No key and no keychain: the snapshot itself, as a plain backup (still
    // encrypted at rest when the store has PA_SQLITE_KEY).
    final = path.join(dir, `pa-${id}.dump`);
    fs.renameSync(snap, final);
    if (!plain) log.warn('backup written without a bundle key: no PA_BACKUP_KEY and no keychain (pa backup key init)');
  }
  const bytes = fs.statSync(final).size;
  const pruned = b.toPrune(b.list(dir), keep);
  for (const old of pruned) fs.rmSync(old.file, { force: true });
  log.info('dumped', { file: final, mb: (bytes / 1e6).toFixed(1), seconds: Math.round((Date.now() - started) / 1000), pruned: pruned.length });
  return { file: final, bytes, pruned: pruned.length };
}

/** The worker's hourly pass: the rolling snapshot, and the bundle when one is due. */
async function dumpIfDue() {
  await refreshLatest().catch((err) => log.warn('snapshot failed', { message: err.message }));
  const newest = backup().list()[0];
  if (newest && Date.now() - newest.at.getTime() < config.backup.everyHours * 3600_000) return null;
  return dump();
}

/** A backup file as a SQLite file to copy: a bundle is unpacked first. {file, manifest, cleanup()}. */
function open(file) {
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  if (!crypt.isEncrypted(file)) return { file, manifest: null, cleanup: () => {} };
  const u = backup().unpack(file);
  if (!fs.existsSync(path.join(u.dir, 'pa.sqlite'))) {
    fs.rmSync(u.dir, { recursive: true, force: true });
    throw new Error(`${file} holds a Postgres dump, not a SQLite store (restore it with PA_DB=postgres)`);
  }
  return { file: path.join(u.dir, 'pa.sqlite'), manifest: u.manifest, cleanup: () => fs.rmSync(u.dir, { recursive: true, force: true }) };
}

/** Checks a SQLite store file can be trusted. {ok, problems: [...], counts}. */
async function verify(file, { key = config.sqliteKey || null } = {}) {
  const db = sqlite().createSqliteBackend(file, { key });
  try {
    const { createRepos } = require('./repo');
    const repos = createRepos(db);
    const problems = await repos.backupDrill.integrityProblems();
    const counts = await repos.backupDrill.tableCounts();
    // A keyword search, through the repository, as the app would run one.
    await repos.search.lexicalPass('the', 5, {}, false).catch((err) => problems.push(`search: ${err.message}`));
    return { ok: problems.length === 0, problems, counts };
  } finally {
    await db.close();
  }
}

/**
 * The drill: `file` (a bundle, a snapshot, default the newest bundle) restored
 * into `to`, a new file, and checked; removed after unless `keep`.
 */
async function drill({ file = null, to, keep = false, say = () => {} } = {}) {
  const b = backup();
  file = file || (b.list()[0] || {}).file || (fs.existsSync(path.join(config.backup.dir, LATEST)) ? path.join(config.backup.dir, LATEST) : null);
  if (!file) throw new Error(`no backups in ${config.backup.dir}`);
  if (!to) throw new Error('--to wants a path for a new scratch file, e.g. --to C:\\Temp\\pa-drill.sqlite');
  const target = path.resolve(to);
  if (target === path.resolve(config.sqlitePath)) throw new Error('refusing to restore over the live store: give the drill its own scratch file');
  if (fs.existsSync(target)) throw new Error(`${target} exists: the drill only writes a new file`);
  const started = Date.now();
  say(crypt.isEncrypted(file) ? 'decrypting and unpacking' : 'reading a snapshot');
  const src = open(file);
  try {
    say(`restoring into ${target}`);
    fs.copyFileSync(src.file, target);
    say('checking');
    const v = await verify(target);
    // Row counts: the bundle's manifest, or (a bare snapshot) the live store now.
    let expected = src.manifest && src.manifest.counts;
    let against = 'manifest';
    if (!expected && fs.existsSync(config.sqlitePath)) {
      expected = await countsOf(config.sqlitePath);
      against = 'live store';
    }
    const rows = b.compareCounts(expected, v.counts);
    return {
      ok: v.ok && rows.ok !== false,
      file,
      to: target,
      kept: Boolean(keep),
      tables: Object.keys(v.counts).length,
      compared: rows.ok !== null,
      against,
      problems: [...rows.problems, ...v.problems.map((p) => ({ table: 'check', expected: 'ok', got: p }))],
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } finally {
    src.cleanup();
    if (!keep) rmFile(target);
  }
}

async function countsOf(file) {
  const db = sqlite().createSqliteBackend(file, { key: config.sqliteKey || null });
  try {
    return await require('./repo').createRepos(db).backupDrill.tableCounts();
  } finally {
    await db.close();
  }
}

/** `pa restore` on a SQLite store: the worker must be stopped. Moves the current file aside first. */
async function restore(file) {
  const src = open(file);
  const live = path.resolve(config.sqlitePath);
  const incoming = `${live}.restoring`;
  try {
    // Checked as a copy beside the store (opening a file changes it), then swapped in.
    rmFile(incoming);
    fs.copyFileSync(src.file, incoming);
    const v = await verify(incoming);
    if (!v.ok) throw new Error(`refusing to restore ${file}: ${v.problems.join('; ')}`);
    await require('./repo').backend.close(); // the store's connections let go of the file
    const aside = `${live}.before-restore-${backup().stamp()}`;
    if (fs.existsSync(live)) {
      for (const x of ['', '-wal', '-shm']) if (fs.existsSync(`${live}${x}`)) fs.renameSync(`${live}${x}`, `${aside}${x}`);
    }
    for (const x of ['', '-wal', '-shm']) if (fs.existsSync(`${incoming}${x}`)) fs.renameSync(`${incoming}${x}`, `${live}${x}`);
    await backup().rotateInstallId();
    log.info('restored', { file, aside });
    return { aside };
  } finally {
    src.cleanup();
    rmFile(incoming);
  }
}

module.exports = { snapshot, refreshLatest, dump, dumpIfDue, drill, restore, verify, LATEST };
