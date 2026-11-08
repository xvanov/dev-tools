'use strict';

// Encrypted backups (src/backup.js bundle/unpack/compareCounts/keys). The drill
// itself needs a Postgres server and runs in the repository contract tests for
// its SQL and by hand per stack (`pa backup restore --to`); everything around
// it is checked here without one.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const key = crypto.randomBytes(32);
process.env.PA_BACKUP_KEY = key.toString('base64'); // config.secret: the real environment wins

const backup = require('../src/backup');
const crypt = require('../src/backupCrypto');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-bundle-'));
  try {
    // ---- compareCounts ----
    assert.deepStrictEqual(backup.compareCounts({ a: 100, b: 0 }, { a: 101, b: 0, extra: 5 }), { ok: true, checked: 2, problems: [] });
    let c = backup.compareCounts({ a: 100, b: 3, gone: 1 }, { a: 150, b: 3 });
    assert.strictEqual(c.ok, false);
    assert.deepStrictEqual(c.problems.map((p) => p.table), ['a', 'gone']);
    assert.strictEqual(c.problems[1].got, null, 'a missing table is reported as none');
    assert.strictEqual(backup.compareCounts({ big: 100000 }, { big: 101500 }).ok, true, '2% tolerance on big tables');
    assert.strictEqual(backup.compareCounts(null, { a: 1 }).ok, null, 'no manifest: not compared');

    // ---- bundle / unpack ----
    const state = path.join(dir, 'factory', 'state');
    fs.mkdirSync(path.join(state, 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(state, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(state, 'locks'), { recursive: true });
    fs.writeFileSync(path.join(state, 'jobs', 'a.json'), '{"id":"a"}');
    fs.writeFileSync(path.join(state, 'jobs', 'b.json'), '{"id":"b"}');
    fs.writeFileSync(path.join(state, 'logs', 'serve.log'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(state, 'locks', 'serve.lock'), '');
    assert.deepStrictEqual(backup.stateStats(state).files, 2, 'logs and locks are not counted');

    const dumpFile = path.join(dir, 'pa-test.dump.partial');
    const payload = crypto.randomBytes(300_000);
    fs.writeFileSync(dumpFile, payload);
    const out = path.join(dir, 'pa-20260101-000000.pabak');
    const counts = { claim: 12, chunk: 345 };
    const r = await backup.bundle({ dumpFile, out, key, state, counts });
    assert.ok(!fs.existsSync(dumpFile), 'the plain dump is consumed');
    assert.ok(r.bytes > 300_000);
    assert.ok(crypt.isEncrypted(out));
    const raw = fs.readFileSync(out);
    assert.ok(!raw.includes(payload.subarray(1000, 1064)), 'the dump is not readable in the bundle');
    assert.ok(!raw.includes(Buffer.from('"id":"a"')) && !raw.includes(Buffer.from('manifest')), 'nor the state, nor the manifest');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.stage-')), [], 'no staging folder left');

    const u = backup.unpack(out, { key });
    try {
      assert.ok(fs.readFileSync(u.dumpFile).equals(payload), 'the dump comes back byte for byte');
      assert.deepStrictEqual(u.manifest.counts, counts);
      assert.strictEqual(u.manifest.state.files, 2);
      assert.ok(u.manifest.stack === 'work' || u.manifest.stack === 'personal');
      assert.ok(fs.existsSync(path.join(u.stateDir, 'jobs', 'a.json')), 'factory state restored');
      assert.ok(!fs.existsSync(path.join(u.stateDir, 'logs')) && !fs.existsSync(path.join(u.stateDir, 'locks')), 'logs and locks left out');
    } finally {
      fs.rmSync(u.dir, { recursive: true, force: true });
    }

    // The env key is found without being passed.
    const viaEnv = backup.unpack(out);
    fs.rmSync(viaEnv.dir, { recursive: true, force: true });

    // Wrong key and damaged file: refused, nothing left in temp.
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pa-unpack-')).length;
    assert.throws(() => backup.unpack(out, { key: crypto.randomBytes(32) }), /authentication/);
    const damaged = path.join(dir, 'damaged.pabak');
    const bytes = Buffer.from(raw);
    bytes[bytes.length - 100] ^= 1;
    fs.writeFileSync(damaged, bytes);
    assert.throws(() => backup.unpack(damaged, { key }), /authentication/);
    assert.strictEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('pa-unpack-')).length, before, 'no unpack folder left behind');

    // No factory: a bundle without state.
    fs.writeFileSync(dumpFile, 'abc');
    const out2 = path.join(dir, 'pa-20260102-000000.pabak');
    await backup.bundle({ dumpFile, out: out2, key, state: null, counts: null });
    const u2 = backup.unpack(out2, { key });
    assert.strictEqual(u2.stateDir, null);
    assert.strictEqual(u2.manifest.state, null);
    fs.rmSync(u2.dir, { recursive: true, force: true });

    // list(): both kinds, flagged.
    fs.writeFileSync(path.join(dir, 'pa-20260103-000000.dump'), 'plain');
    const l = backup.list(dir);
    assert.deepStrictEqual(l.map((b) => [b.name, b.encrypted]), [['pa-20260103-000000.dump', false], ['pa-20260102-000000.pabak', true], ['pa-20260101-000000.pabak', true]]);

    // Key export: a new file, never overwritten, mode 600 where the OS has modes.
    const keyFile = path.join(dir, 'exported.key');
    const e = backup.keyExport(keyFile);
    assert.strictEqual(e.file, path.resolve(keyFile));
    assert.strictEqual(fs.readFileSync(keyFile, 'utf8').trim(), key.toString('base64'));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
    assert.throws(() => backup.keyExport(keyFile), /EEXIST/);
    assert.strictEqual(backup.keyInit().created, false, 'a key that exists is not replaced');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('backupBundle ok');
})().catch((e) => { console.error(e); process.exit(1); });
