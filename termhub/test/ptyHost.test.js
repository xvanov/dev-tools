'use strict';

// lib/ptyHost.js: the persistent PTY-host setting that the Exit 5 cutover and its
// rollback turn on. Pure resolution plus the settings file round trip.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolve, readMode, writeMode, releaseBinary } = require('../lib/ptyHost');

// Environment wins, both ways.
assert.strictEqual(resolve({ envValue: '1', mode: 'node-pty', bin: null }).ptyd, true);
assert.strictEqual(resolve({ envValue: '0', mode: 'ptyd', bin: '/x/ptyd' }).ptyd, false);
// The setting.
assert.strictEqual(resolve({ mode: 'node-pty', bin: '/x/ptyd' }).ptyd, false, 'rollback holds even with a binary');
assert.strictEqual(resolve({ mode: 'ptyd', bin: null }).ptyd, true);
// auto: only with a release binary present.
assert.strictEqual(resolve({ mode: 'auto', bin: '/x/ptyd' }).ptyd, true);
assert.strictEqual(resolve({ mode: 'auto', bin: null }).ptyd, false);
assert.match(resolve({ mode: 'auto', bin: null }).reason, /no release ptyd binary/);

// Settings file: default auto, round trip, other keys kept, bad values refused.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyhost-'));
try {
  assert.strictEqual(readMode(dir), 'auto');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ other: 1, ptyHost: 'bogus' }));
  assert.strictEqual(readMode(dir), 'auto', 'unknown value reads as auto');
  writeMode('node-pty', dir);
  assert.strictEqual(readMode(dir), 'node-pty');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).other, 1, 'other settings kept');
  assert.throws(() => writeMode('rust', dir), /one of/);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{broken');
  assert.strictEqual(readMode(dir), 'auto');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Binary lookup: an explicit path first; debug builds never count.
assert.strictEqual(releaseBinary({ TERMHUB_PTYD_BIN: '/opt/ptyd' }, (p) => p === '/opt/ptyd'), '/opt/ptyd');
assert.strictEqual(releaseBinary({}, (p) => /[\\/]debug[\\/]/.test(p)), null);
assert.ok(/release/.test(releaseBinary({}, (p) => /[\\/]release[\\/]/.test(p))));

console.log('ptyHost ok');
