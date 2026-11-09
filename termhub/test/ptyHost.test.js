'use strict';

// lib/ptyHost.js: ptyd is the only PTY host (Exit 5). With nothing configured
// the next start uses ptyd. node-pty and TERMHUB_PTYD=0 are the removed path:
// they error, they do not select a host, and they do not fall back.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolve, readMode, writeMode, releaseBinary, DEFAULT_MODE, RETIRED } = require('../lib/ptyHost.ts');

const BIN = '/x/ptyd';

assert.strictEqual(DEFAULT_MODE, 'ptyd');
assert.strictEqual(resolve({ mode: undefined, bin: null }).ptyd, true, 'unset is ptyd, even with no binary');
assert.strictEqual(resolve({ mode: undefined, bin: BIN }).ptyd, true);
assert.match(resolve({ mode: undefined, bin: BIN }).reason, /the default/);
assert.strictEqual(resolve({ mode: 'ptyd', bin: null }).ptyd, true);
assert.match(resolve({ mode: 'auto', bin: null }).reason, /fallback is gone/);
assert.strictEqual(resolve({ mode: 'auto', bin: null }).ptyd, true, 'auto no longer falls back');
// The environment: 1 is ptyd (it wins over a stored node-pty). 0 is a refusal.
assert.strictEqual(resolve({ envValue: '1', mode: 'node-pty', bin: null }).ptyd, true);
assert.strictEqual(resolve({ envValue: '1', mode: 'node-pty', bin: null }).error, undefined);
const zero = resolve({ envValue: '0', mode: 'ptyd', bin: BIN });
assert.strictEqual(zero.ptyd, false);
assert.match(zero.error, /retired/);
const stored = resolve({ mode: 'node-pty', bin: BIN });
assert.strictEqual(stored.ptyd, false);
assert.match(stored.error, /ptyHost=node-pty/);
assert.match(RETIRED, /previous commit/);

// Settings file: default ptyd, round trip, other keys kept, the removed values refused.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhost-'));
try {
  assert.strictEqual(readMode(dir), 'ptyd', 'no settings file reads as ptyd');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ other: 1, ptyHost: 'bogus' }));
  assert.strictEqual(readMode(dir), 'ptyd', 'an unknown value reads as ptyd');
  writeMode('ptyd', dir);
  assert.strictEqual(readMode(dir), 'ptyd');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).other, 1, 'other settings kept');
  assert.throws(() => writeMode('node-pty', dir), /retired/);
  assert.throws(() => writeMode('auto', dir), /not a host/);
  assert.throws(() => writeMode('rust', dir), /must be ptyd/);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ other: 1, ptyHost: 'node-pty' }));
  assert.strictEqual(readMode(dir), 'node-pty', 'a stored node-pty stays visible so the next start can refuse it');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ other: 1, ptyHost: 'auto' }));
  assert.strictEqual(readMode(dir), 'auto');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{broken');
  assert.strictEqual(readMode(dir), 'ptyd');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Binary lookup: an explicit path first; debug builds never count.
assert.strictEqual(releaseBinary({ TERMHUB_PTYD_BIN: '/opt/ptyd' }, (p) => p === '/opt/ptyd'), '/opt/ptyd');
assert.strictEqual(releaseBinary({}, (p) => /[\\/]debug[\\/]/.test(p)), null);
assert.ok(/release/.test(releaseBinary({}, (p) => /[\\/]release[\\/]/.test(p))));

console.log('ptyHost ok');
