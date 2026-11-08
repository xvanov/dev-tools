'use strict';

// teams/read_cache.py's choice of tables (plan 8.4.32): new tables are read
// only once the log read last time is gone, and --log-first leaves them for
// the next pass. Runs the real script on placeholder files, so it needs the
// Teams reader venv; without one (CI, Linux) it says so and passes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { config } = require('../src/config.ts');

const SCRIPT = path.join(__dirname, '..', 'teams', 'read_cache.py');
const python = config.teamsCache.python;
const usable = python && fs.existsSync(python) && spawnSync(python, ['-c', 'import ccl_chromium_reader'], { stdio: 'ignore' }).status === 0;
if (!usable) {
  console.log('teamsCacheReader.test.js skipped: no Teams reader venv');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-teams-reader-'));
const src = path.join(dir, 'src');
fs.mkdirSync(src);
fs.writeFileSync(path.join(src, '000010.log'), Buffer.alloc(0));
for (const n of ['000011', '000012']) fs.writeFileSync(path.join(src, `${n}.ldb`), Buffer.from('not a table'));

function status(...extra) {
  const r = spawnSync(python, [SCRIPT, '--src', src, '--work', path.join(dir, 'work'), '--after-ldb', '5', ...extra], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

try {
  let s = status('--log', '000010.log:0');
  assert.deepStrictEqual([s.ldbRead, s.ldbCovered, s.ldbPending, s.maxLdb], [0, 2, 0, 12], 'the log still there: the tables are compactions');

  s = status('--log', '000009.log:0', '--log-first');
  assert.deepStrictEqual([s.ldbRead, s.ldbPending, s.maxLdb], [0, 2, 5], 'rotated, log first: the tables wait, the cursor stays');

  s = status('--log', '000009.log:0');
  assert.deepStrictEqual([s.ldbRead, s.ldbCovered, s.ldbPending, s.maxLdb], [2, 0, 0, 12], 'the next pass reads them');

  s = status('--log', '000009.log:0', '--max-ldb', '1');
  assert.deepStrictEqual([s.ldbRead, s.ldbSkipped], [1, 1], 'still capped');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('teamsCacheReader.test.js ok');
