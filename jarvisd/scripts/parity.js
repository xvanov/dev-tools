#!/usr/bin/env node
'use strict';

// Bun parity (plan 4.1, stage 1): runs a set of the PA's own test files under
// Bun instead of Node, unchanged, with the environment the PA's runner gives
// them (personal-assistant/test/runner.config.js). The set covers what jarvisd
// absorbs first: the repository layer and its contract against a real store,
// the event bus and SSE endpoint, the dashboard, the schemas.
//
//   node scripts/parity.js [name-substring ...]
//
// A file that skips itself (repoContract with no Postgres reachable) passes.

const path = require('path');
const { spawnSync } = require('child_process');

const JARVISD = path.join(__dirname, '..');
const PA = path.join(JARVISD, '..', 'personal-assistant');
const BUN = path.join(JARVISD, 'node_modules', 'bun', 'bin', 'bun.exe');

const FILES = [
  'schemas.test.js',
  'events.test.js',
  'dashboard.test.js',
  'router.test.js',
  'repoBoundary.test.js',
  'repoCalls.test.js',
  // Postgres only: the SQLite backend's native driver (better-sqlite3-multiple-ciphers) crashes
  // Bun 1.3 on load (NAPI fatal error). Under jarvisd SQLite goes through bun:sqlite (JARVISD.md).
  ['repoContract.test.js', { PA_CONTRACT_BACKENDS: 'postgres' }],
  'migrations.test.js',
  'architecture.test.js',
  'lease.test.js',
  // Voice: the transcribe proxy's round trip to a whisper socket server (on Bun 1.3 a half-closed
  // socket was reset and Talk transcribed nothing, 2aad672), the fast lane, the spoken approvals.
  'talk.test.js',
  'fastLane.test.js',
  'chatPermission.test.js',
  // askWhisper's socket exchange: Bun's socket.end() closes instead of half-closing (plan 8.2.1).
  'talkWhisper.test.js',
];

const cfg = require(path.join(PA, 'test', 'runner.config.js'));
const only = process.argv.slice(2);
const env = { ...process.env, ...cfg.env };

let failed = 0;
for (const entry of FILES) {
  const [f, extra] = Array.isArray(entry) ? entry : [entry, {}];
  if (only.length && !only.some((o) => f.includes(o))) continue;
  const t0 = Date.now();
  const r = spawnSync(BUN, [path.join('test', f)], { cwd: PA, env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${f.padEnd(24)} ${ok ? 'pass' : 'FAIL'}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!ok) console.log(`${r.stdout || ''}${r.stderr || ''}${r.error ? String(r.error) : ''}`.split('\n').slice(-40).join('\n'));
}
console.log(failed ? `bun parity: ${failed} failed` : 'bun parity: ok');
process.exit(failed ? 1 : 0);
