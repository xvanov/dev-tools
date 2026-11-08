#!/usr/bin/env node
// Shared parallel test runner for tools that keep plain `node test/<name>.test.js` files.
//
//   node ../scripts/run-tests.js [--jobs N] [--timeout SECONDS] [--list] [name-substring ...]
//
// Run from (or pass cwd as) a tool directory; it globs ./test/*.test.js, runs each file in its own
// child process through a pool of (cores - 1) workers, never stops early, prints a per-file
// pass/fail/time table plus the output of failing files, and exits non-zero on any failure.
//
// Per-tool lists live in <tool>/test/runner.config.js (module.exports = ...):
//   { "skip":   [{ "file": "x.test.js", "reason": "..." }],   // not run at all
//     "serial": [{ "file": "y.test.js", "reason": "..." }] }  // run alone, after the pool
// Every entry needs a reason. Dependency-free on purpose.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const o = { jobs: Math.max(1, os.cpus().length - 1), timeout: 180, list: false, filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jobs') o.jobs = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--timeout') o.timeout = Math.max(1, parseInt(argv[++i], 10) || 180);
    else if (a === '--list') o.list = true;
    else o.filters.push(a);
  }
  return o;
}

function loadConfig(testDir) {
  const p = path.join(testDir, 'runner.config.js');
  const cfg = fs.existsSync(p) ? require(p) : {};
  const norm = (list, name) => (list || []).map((e) => {
    if (!e || !e.file || !e.reason) throw new Error(`${name} entries need {file, reason}: ${JSON.stringify(e)}`);
    return e;
  });
  return { skip: norm(cfg.skip, 'skip'), serial: norm(cfg.serial, 'serial') };
}

function runFile(cwd, file, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = [];
    let timedOut = false;
    const child = spawn(process.execPath, [path.join('test', file)], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => { chunks.push(Buffer.from(String(e))); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, code: timedOut ? 124 : code, timedOut, ms: Date.now() - t0, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

async function pool(items, n, fn) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const testDir = path.join(cwd, 'test');
  const cfg = loadConfig(testDir);
  const skipped = new Map(cfg.skip.map((e) => [e.file, e.reason]));
  const serial = new Map(cfg.serial.map((e) => [e.file, e.reason]));
  let all = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort();
  for (const f of [...skipped.keys(), ...serial.keys()]) {
    if (!all.includes(f)) { console.error(`runner.config.js names a missing file: ${f}`); process.exit(2); }
  }
  if (opts.filters.length) all = all.filter((f) => opts.filters.some((s) => f.includes(s)));
  const toRun = all.filter((f) => !skipped.has(f));
  const parallel = toRun.filter((f) => !serial.has(f));
  const serials = toRun.filter((f) => serial.has(f));
  if (opts.list) { for (const f of toRun) console.log(f); return; }

  const timeoutMs = opts.timeout * 1000;
  const t0 = Date.now();
  // Slowest-first would need history; the pool is fine with alphabetical order.
  const results = await pool(parallel, opts.jobs, (f) => {
    return runFile(cwd, f, timeoutMs).then((r) => { process.stderr.write(r.code === 0 ? '.' : 'F'); return r; });
  });
  for (const f of serials) {
    const r = await runFile(cwd, f, timeoutMs);
    process.stderr.write(r.code === 0 ? '.' : 'F');
    results.push(r);
  }
  process.stderr.write('\n');
  const wall = Date.now() - t0;

  const w = Math.max(4, ...results.map((r) => r.file.length));
  console.log(`\n${'file'.padEnd(w)}  result  time`);
  for (const r of results.slice().sort((a, b) => b.ms - a.ms)) {
    const tag = r.code === 0 ? 'pass' : r.timedOut ? 'TIMEOUT' : 'FAIL';
    console.log(`${r.file.padEnd(w)}  ${tag.padEnd(6)}  ${(r.ms / 1000).toFixed(2)}s${serial.has(r.file) ? '  (serial)' : ''}`);
  }
  for (const [f, reason] of skipped) if (all.includes(f)) console.log(`${f.padEnd(w)}  skip    ${reason}`);

  const failed = results.filter((r) => r.code !== 0);
  for (const r of failed) {
    console.log(`\n===== ${r.file} (exit ${r.code}${r.timedOut ? `, timed out after ${opts.timeout}s` : ''}) =====`);
    console.log(r.output.trimEnd());
  }
  const cpu = results.reduce((s, r) => s + r.ms, 0);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${[...skipped.keys()].filter((f) => all.includes(f)).length} skipped` +
    ` in ${(wall / 1000).toFixed(1)}s wall (${(cpu / 1000).toFixed(1)}s of test time, ${opts.jobs} workers)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
