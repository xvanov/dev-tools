'use strict';

// The session archive (lib/archive.js): `sessions.json` holds every command
// line typed in a shell session, so it must be private to the user.
//
// What earns a test: a fresh file is created 0600; a pre-existing file left
// world-readable by an older termhub is tightened to 0600 the first time the
// archive touches it — by a read alone, and by a write; and the atomic write
// leaves no temp file behind. POSIX only: Windows has no mode bits to check.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'win32') {
  console.log('archive.test.js skipped (no POSIX modes on Windows)');
  process.exit(0);
}

const mode = (f) => fs.statSync(f).mode & 0o777;
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-archive-'));
  process.env.TERMHUB_DATA_DIR = dir;
  delete require.cache[require.resolve('../lib/archive.ts')];
  return { dir, archive: require('../lib/archive.ts'), f: path.join(dir, 'sessions.json') };
};

const dirs = [];
const oldUmask = process.umask(0o022); // the usual umask, which would give 0644
try {
  // A new file.
  {
    const { dir, archive, f } = fresh();
    dirs.push(dir);
    assert.strictEqual(archive.FILE_MODE, 0o600);
    archive.upsert({ id: 'a', cwd: '/', history: [] });
    archive.addHistory('a', 'export TOKEN=hunter2');
    archive.flushSync(); // writes are deferred off the event loop (lib/archive.js)
    assert.strictEqual(mode(f), 0o600, `new sessions.json is 0600, got ${mode(f).toString(8)}`);
    assert.deepStrictEqual(archive.get('a').history, ['export TOKEN=hunter2']);
    assert.deepStrictEqual(fs.readdirSync(dir), ['sessions.json'], 'no temp file left behind');
  }
  // An existing world-readable file, tightened by a READ (sessiond's first touch
  // at startup is restore listing the archive).
  {
    const { dir, archive, f } = fresh();
    dirs.push(dir);
    fs.writeFileSync(f, JSON.stringify([{ id: 'old', cwd: '/' }]), { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    assert.strictEqual(archive.list().length, 1);
    assert.strictEqual(mode(f), 0o600, 'an existing 0644 file is chmod-ed on first read');
  }
  // ... and by a write, whatever the old mode was.
  {
    const { dir, archive, f } = fresh();
    dirs.push(dir);
    fs.writeFileSync(f, '[]');
    fs.chmodSync(f, 0o666);
    archive.upsert({ id: 'b', cwd: '/' });
    archive.flushSync();
    assert.strictEqual(mode(f), 0o600, 'rewritten 0600');
    fs.chmodSync(f, 0o644); // something widened it mid-run
    archive.remove('b');
    archive.flushSync();
    assert.strictEqual(mode(f), 0o600, 'every write re-creates it 0600');
  }
  console.log('archive.test.js ok');
} finally {
  process.umask(oldUmask);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
