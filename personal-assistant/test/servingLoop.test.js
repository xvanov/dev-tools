'use strict';

// The serving generation's event loop (plan 8.4.38). micHolders and freeBytes
// used to spawn reg.exe / PowerShell on the passes that run there. They stay
// off spawnSync, and a cached answer does not wait on the process.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PA = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(PA, rel), 'utf8');

const win = read('src/platform/windows.ts');
const gate = read('src/audio/gate.ts');
const dog = read('src/audio/watchdog.ts');
for (const [name, text] of [['windows', win], ['gate', gate], ['watchdog', dog]]) {
  assert.doesNotMatch(text, /spawnSync|execSync|execFileSync/, `${name} must not spawn synchronously`);
}
const mic = win.slice(win.indexOf('async micHolders'), win.indexOf('function freeBytes'));
assert.match(mic, /micHoldersCache/, 'micHolders is cached');
assert.match(win, /cachedAsync\(MIC_HOLDERS_TTL_MS\)/);
assert.match(mic, /exec\('reg\.exe'/, 'micHolders still reads the registry, asynchronously');
const free = win.slice(win.indexOf('function freeBytes'), win.indexOf('const services'));
assert.match(free, /cachedFreeBytes/);
assert.doesNotMatch(free, /powershell|reg\.exe|spawnSync/);

const { cachedAsync } = require('../src/platform/common.ts');

async function main() {
  const cache = cachedAsync(50);
  let calls = 0;
  const fn = () => Promise.resolve(++calls);
  const a = await cache('k', fn);
  const b = await cache('k', fn);
  assert.strictEqual(a, 1);
  assert.strictEqual(b, 1, 'inside the TTL the process does not run again');
  assert.strictEqual(calls, 1);
  await new Promise((r) => setTimeout(r, 60));
  const c = await cache('k', () => new Promise((r) => setTimeout(() => r(++calls), 30)));
  assert.strictEqual(c, 1, 'a stale value is returned without waiting for the refresh');
  await new Promise((r) => setTimeout(r, 50));
  const d = await cache('k', fn);
  assert.strictEqual(d, 2);
  assert.strictEqual(calls, 2);

  const platform = require('../src/platform');
  const t0 = performance.now();
  const bytes = await platform.freeBytes(os.tmpdir());
  const first = performance.now() - t0;
  const t1 = performance.now();
  const again = await platform.freeBytes(os.tmpdir());
  const second = performance.now() - t1;
  assert.ok(Number.isFinite(bytes) && bytes > 0, `free bytes ${bytes}`);
  assert.strictEqual(again, bytes);
  assert.ok(second < 5, `cached freeBytes took ${second.toFixed(1)} ms`);
  assert.ok(first < 50, `freeBytes took ${first.toFixed(1)} ms; a PowerShell drive query was 35-40 ms and is gone`);
  console.log(`freeBytes ${first.toFixed(1)} ms, cached ${second.toFixed(1)} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
