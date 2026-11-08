'use strict';

// Backups of a SQLite store (src/backupSqlite.js, through src/backup.js with
// PA_DB=sqlite): the nightly encrypted bundle, the rolling snapshot, the drill
// into a scratch file (and that it catches a damaged backup), and a restore
// that moves the current file aside. On a throwaway encrypted store; skips
// without the optional driver.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sqlite-backup-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_store.sqlite');
process.env.PA_SQLITE_KEY = 'backup-test-store-key';
process.env.PA_BACKUP_DIR = path.join(dir, 'backups');
process.env.PA_BACKUP_KEY = crypto.randomBytes(32).toString('base64');
process.env.PA_FACTORY_MACHINE = 'none'; // no factory state to bundle

const { available } = require('../src/db/sqlite');

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP backupSqlite: no SQLite driver');
  }
  const db = require('../src/db');
  const repo = require('../src/repo');
  const backup = require('../src/backup');
  const bs = require('../src/backupSqlite');
  const { config } = require('../src/config');
  try {
    assert.strictEqual(db.dialect, 'sqlite');
    await require('../src/db/migrate').migrate();
    for (let i = 0; i < 25; i++) await repo.notifications.insert({ kind: 'info', title: `n${i}`, body: 'quarterly figures', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });

    // The nightly bundle: encrypted, with pa.sqlite and a manifest.
    const d = await backup.dump();
    assert.match(path.basename(d.file), /^pa-\d{8}-\d{6}\.pabak$/);
    const u = backup.unpack(d.file);
    try {
      assert.strictEqual(path.basename(u.dumpFile), 'pa.sqlite');
      assert.strictEqual(u.manifest.counts.notification, 25);
    } finally {
      fs.rmSync(u.dir, { recursive: true, force: true });
    }

    // The rolling snapshot: written once, then fresh enough to skip.
    const latest = await bs.refreshLatest();
    assert.ok(latest && fs.existsSync(latest.file));
    assert.strictEqual(await bs.refreshLatest(), null, 'fresh: not rewritten');
    const raw = new (require('better-sqlite3-multiple-ciphers'))(latest.file, { readonly: true });
    try {
      assert.throws(() => raw.prepare('select 1 from notification').get(), /not a database/, 'the snapshot keeps the store encryption');
    } finally {
      raw.close();
    }

    // The drill, on the bundle and on the snapshot.
    const to = path.join(dir, 'pa_test_drill.sqlite');
    const r1 = await backup.drill({ file: d.file, to });
    assert.ok(r1.ok, JSON.stringify(r1.problems));
    assert.strictEqual(r1.against, 'manifest');
    assert.ok(!fs.existsSync(to), 'the scratch file is removed');
    const r2 = await backup.drill({ file: latest.file, to });
    assert.ok(r2.ok && r2.against === 'live store', JSON.stringify(r2));
    await assert.rejects(backup.drill({ file: d.file, to: config.sqlitePath }), /live store/);

    // A damaged snapshot fails the drill.
    const bad = path.join(dir, 'damaged.sqlite');
    fs.copyFileSync(latest.file, bad);
    const fd = fs.openSync(bad, 'r+');
    fs.writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, 8192);
    fs.closeSync(fd);
    let failed = false;
    try {
      const r3 = await backup.drill({ file: bad, to });
      failed = !r3.ok;
    } catch {
      failed = true;
    }
    assert.ok(failed, 'a damaged backup does not pass the drill');

    // Restore: rows written after the bundle are gone, the old file is kept aside.
    await repo.notifications.insert({ kind: 'info', title: 'after the backup', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    const r = await backup.restore(d.file);
    assert.ok(fs.existsSync(r.aside), 'the replaced store is kept');
    const n = await repo.backupDrill.tableCounts();
    assert.strictEqual(n.notification, 25);
    console.log('backupSqlite: ok');
  } finally {
    await db.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
