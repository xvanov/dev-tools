'use strict';

// lib/archive.js keeps the archive in memory and writes sessions.json off the
// event loop, coalesced. Synchronous writes there (250-1350 ms each on Windows)
// stalled sessiond so that a session create queued behind them for seconds.
//
// What earns a test: changes are visible at once; the file catches up after a
// flush; a burst of changes is ONE write, not one per change; nothing in a burst
// touches the disk synchronously; a fresh process reads back what was flushed;
// flushSync works for exit.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-archive-write-'));
process.env.TERMHUB_DATA_DIR = dir;
const f = path.join(dir, 'sessions.json');
const load = () => {
  delete require.cache[require.resolve('../lib/archive.ts')];
  return require('../lib/archive.ts');
};

(async () => {
  try {
    let archive = load();
    // Count disk writes, sync and async.
    let syncWrites = 0;
    let asyncRenames = 0;
    const origWrite = fs.writeFileSync;
    const origRename = fs.promises.rename;
    fs.writeFileSync = function (...a) { if (String(a[0]).startsWith(dir)) syncWrites++; return origWrite.apply(this, a); };
    fs.promises.rename = function (...a) { if (String(a[0]).startsWith(dir)) asyncRenames++; return origRename.apply(this, a); };

    const t0 = Date.now();
    archive.upsert({ id: 's1', cwd: '/x', history: [] });
    for (let i = 0; i < 50; i++) archive.addHistory('s1', `echo ${i}`);
    archive.patch('s1', { title: 'renamed' });
    archive.upsert({ id: 's2', cwd: '/y' });
    archive.remove('s2');
    const burstMs = Date.now() - t0;

    // Visible at once, in memory.
    const e = archive.get('s1');
    assert.strictEqual(e.title, 'renamed');
    assert.strictEqual(e.history.length, 50);
    assert.strictEqual(archive.get('s2'), null);
    // Callers get copies: mutating one does not reach the archive.
    e.title = 'mutated';
    assert.strictEqual(archive.get('s1').title, 'renamed');

    // Nothing synchronous on the event loop during the burst, and nothing written yet.
    assert.strictEqual(syncWrites, 0, 'no synchronous write during a burst');
    assert.ok(burstMs < 200, `a 54-change burst took ${burstMs} ms`);

    await archive.flush();
    assert.strictEqual(asyncRenames, 1, `a burst is one write, got ${asyncRenames}`);
    const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepStrictEqual(onDisk.map((x) => x.id), ['s1']);
    assert.strictEqual(onDisk[0].history.length, 50);
    assert.deepStrictEqual(fs.readdirSync(dir), ['sessions.json'], 'no temp file left behind');

    // A change while a write is in flight is written after it.
    archive.addHistory('s1', 'late 1');
    await new Promise((r) => setTimeout(r, archive.WRITE_DELAY_MS + 5));
    archive.addHistory('s1', 'late 2');
    await archive.flush();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8'))[0].history.slice(-2), ['late 1', 'late 2']);

    // flushSync (what process exit runs) writes immediately.
    archive.patch('s1', { endedAt: 123 });
    archive.flushSync();
    assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8'))[0].endedAt, 123);

    // A fresh process (module) reads it back.
    fs.writeFileSync = origWrite;
    fs.promises.rename = origRename;
    archive = load();
    assert.strictEqual(archive.get('s1').endedAt, 123);
    // recents.json: same pattern (lib/recents.js). In memory at once, on disk after flush.
    const recents = require('../lib/recents.ts');
    let rSync = 0;
    fs.writeFileSync = function (...a) { if (String(a[0]).startsWith(dir)) rSync++; return origWrite.apply(this, a); };
    for (let i = 0; i < 60; i++) recents.add(`/dir/${i % 7}`);
    fs.writeFileSync = origWrite;
    assert.strictEqual(rSync, 0, 'recents.add writes nothing synchronously');
    assert.strictEqual(recents.list()[0], '/dir/3');
    assert.strictEqual(recents.list().length, 7, 'deduped');
    await recents.flush();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'recents.json'), 'utf8')), recents.list());
    console.log(`archiveWrite ok: 54 changes in ${burstMs} ms, one write; recents async`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
