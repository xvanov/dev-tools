'use strict';

// lib/ptyHost.js: the persistent PTY-host setting that the Exit 5 cutover and its
// rollback turn on. Pure resolution plus the settings file round trip.
//
// The property that matters most: with nothing configured, a machine stays on
// node-pty even when a release ptyd binary is sitting right there. Building
// ptyd (a deploy, a test run) must never switch the host by itself, because the
// next sessiond restart would end every live terminal. Only `ptyd` (or opt-in
// `auto`) switches.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolve, readMode, writeMode, releaseBinary, DEFAULT_MODE } = require('../lib/ptyHost.ts');

const BIN = '/x/ptyd';

// The default is node-pty, and it ignores a present binary.
assert.strictEqual(DEFAULT_MODE, 'node-pty');
assert.strictEqual(resolve({ mode: 'node-pty', bin: BIN }).ptyd, false, 'a built binary must not switch the default');
assert.strictEqual(resolve({ mode: undefined, bin: BIN }).ptyd, false, 'unset resolves like the default');
assert.match(resolve({ mode: 'node-pty', bin: BIN }).reason, /the default; switch with/);
// The explicit cutover.
assert.strictEqual(resolve({ mode: 'ptyd', bin: null }).ptyd, true);
// auto stays available, opt-in: ptyd only with a release binary present.
assert.strictEqual(resolve({ mode: 'auto', bin: BIN }).ptyd, true);
assert.strictEqual(resolve({ mode: 'auto', bin: null }).ptyd, false);
assert.match(resolve({ mode: 'auto', bin: null }).reason, /no release ptyd binary/);
// The environment wins, both ways.
assert.strictEqual(resolve({ envValue: '1', mode: 'node-pty', bin: null }).ptyd, true);
assert.strictEqual(resolve({ envValue: '0', mode: 'ptyd', bin: BIN }).ptyd, false);

// Settings file: default node-pty, round trip, other keys kept, bad values refused.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhost-'));
try {
  assert.strictEqual(readMode(dir), 'node-pty', 'no settings file reads as node-pty');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ other: 1, ptyHost: 'bogus' }));
  assert.strictEqual(readMode(dir), 'node-pty', 'an unknown value reads as the default');
  for (const m of ['ptyd', 'auto', 'node-pty']) {
    writeMode(m, dir);
    assert.strictEqual(readMode(dir), m);
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).other, 1, 'other settings kept');
  assert.throws(() => writeMode('rust', dir), /one of/);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{broken');
  assert.strictEqual(readMode(dir), 'node-pty');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Binary lookup: an explicit path first; debug builds never count.
assert.strictEqual(releaseBinary({ TERMHUB_PTYD_BIN: '/opt/ptyd' }, (p) => p === '/opt/ptyd'), '/opt/ptyd');
assert.strictEqual(releaseBinary({}, (p) => /[\\/]debug[\\/]/.test(p)), null);
assert.ok(/release/.test(releaseBinary({}, (p) => /[\\/]release[\\/]/.test(p))));

console.log('ptyHost ok');
