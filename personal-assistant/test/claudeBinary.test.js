'use strict';

// claudeBinary() (src/config.ts, 8.4.43): the `claude` a check runs where
// PATH lacks ~/.local/bin (termhub's /api/exec, a systemd unit), found the
// way the factory's claude_binary() finds it. No real binary is touched.

const assert = require('assert');
const { claudeBinary } = require('../src/config.ts');

const at = (...files) => (p) => files.includes(p);
const linux = { platform: 'linux', home: '/home/me' };

// On PATH: the bare name, as before.
assert.strictEqual(claudeBinary('claude', { ...linux, env: { PATH: '/usr/bin:/opt/bin' }, exists: at('/opt/bin/claude') }), 'claude');
// Not on PATH (the exec's PATH): the installer's place.
assert.strictEqual(claudeBinary('claude', { ...linux, env: { PATH: '/usr/local/bin:/usr/bin' }, exists: at('/home/me/.local/bin/claude') }), '/home/me/.local/bin/claude');
assert.strictEqual(claudeBinary('claude', { ...linux, env: { PATH: '/usr/bin' }, exists: at('/home/me/.claude/local/claude') }), '/home/me/.claude/local/claude');
// Nowhere: the name as given, so the error still says what was run.
assert.strictEqual(claudeBinary('claude', { ...linux, env: { PATH: '/usr/bin' }, exists: at() }), 'claude');
// PA_CLAUDE_BIN as a path is taken as it is.
assert.strictEqual(claudeBinary('/srv/claude/bin/claude', { ...linux, env: { PATH: '' }, exists: at() }), '/srv/claude/bin/claude');
// Windows: PATH is ;-separated and the binary has an extension.
const win = { platform: 'win32', home: 'C:\\Users\\me' };
assert.strictEqual(claudeBinary('claude', { ...win, env: { Path: 'C:\\Windows;C:\\tools' }, exists: at('C:\\tools\\claude.exe') }), 'claude');
assert.strictEqual(claudeBinary('claude', { ...win, env: { Path: 'C:\\Windows' }, exists: at('C:\\Users\\me\\.local\\bin\\claude.exe') }), 'C:\\Users\\me\\.local\\bin\\claude.exe');

console.log('claudeBinary.test.js ok');
