#!/usr/bin/env node
// Shared parallel test runner for tools that keep plain `node test/<name>.test.js` files.
//
//   node ../scripts/run-tests.js [--jobs N] [--timeout SECONDS] [--list] [--changed [--since REF]] [name-substring ...]
//
// Run from (or pass cwd as) a tool directory; it globs ./test/*.test.js, runs each file in its own
// child process through a pool of (cores - 1) workers, never stops early, prints a per-file
// pass/fail/time table plus the output of failing files, and exits non-zero on any failure.
//
// --changed runs only the test files that (transitively, by a static require/import graph) reach a
// file changed against HEAD, staged or not, untracked included; see changed-tests.js.
// `npm test -- --changed`. --since REF compares against REF instead of HEAD (CI). Nothing changed
// means nothing runs and exit 0.
//
// Per-tool lists live in <tool>/test/runner.config.js (module.exports = ...):
//   skip:    [{ file: 'x.test.js', reason: '...' }]                      // not run at all
//   skip:    [{ file: 'z.test.js', reason: '...', platform: 'linux' }]   // run ONLY on that process.platform
//   ciOnly:  [{ file: 'u.test.js', reason: '...' }]                      // runs only when CI is set; skipped locally and in pre-commit
//   serial:  [{ file: 'y.test.js', reason: '...' }]                      // run alone, after the pool
//   env:     { NAME: 'value' }                                           // added to every test's environment
//   touches: { 'w.test.js': ['src/'] }                                   // --changed: directories a test walks
//   narrow:  { 'u.test.js': ['src/x/'] }                                 // --changed: slow test, selected only by these paths
//   shards:  { 'v.test.js': 3 }                                          // run v.test.js as 3 parallel processes;
//                                                                        // its blocks use `owns()` from ./shard.js
// Every skip/serial entry needs a reason. Dependency-free on purpose.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const o = { jobs: Math.max(1, os.cpus().length - 1), timeout: 180, list: false, changed: false, since: 'HEAD', filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jobs') o.jobs = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--timeout') o.timeout = Math.max(1, parseInt(argv[++i], 10) || 180);
    else if (a === '--list') o.list = true;
    else if (a === '--changed') o.changed = true;
    else if (a === '--since') { o.changed = true; o.since = argv[++i] || 'HEAD'; }
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
  return { skip: norm(cfg.skip, 'skip'), serial: norm(cfg.serial, 'serial'), env: cfg.env || {}, touches: cfg.touches || {}, ciOnly: norm(cfg.ciOnly, 'ciOnly'), narrow: cfg.narrow || {}, shards: cfg.shards || {} };
}

// One test file, or one shard of it (job = 'x.test.js' or { file, shard, shards }).
function runFile(cwd, job, timeoutMs, baseEnv) {
  const file = typeof job === 'string' ? job : job.file;
  const label = typeof job === 'string' ? job : `${job.file} [${job.shard + 1}/${job.shards}]`;
  const env = typeof job === 'string' ? baseEnv : { ...baseEnv, TEST_SHARD_INDEX: String(job.shard), TEST_SHARD_COUNT: String(job.shards) };
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = [];
    let timedOut = false;
    const child = spawn(process.execPath, [path.join('test', file)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => { chunks.push(Buffer.from(String(e))); });
    // Settle on `exit`, not only `close`: a test that leaves a grandchild alive (a PTY's console agent,
    // a daemon) that inherited our pipes would otherwise hold `close` open until the file timeout.
    // Give the pipes a moment to drain, then let go of them.
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ file, label, code: timedOut ? 124 : code, timedOut, ms: Date.now() - t0, output: Buffer.concat(chunks).toString('utf8') });
    };
    child.on('close', settle);
    child.on('exit', (code) => setTimeout(() => settle(code), 500).unref());
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
  // A skip with `platform` means "only runs there": it is skipped everywhere else.
  const skipped = new Map(cfg.skip.filter((e) => !e.platform || e.platform !== process.platform).map((e) => [e.file, e.reason]));
  // ciOnly: load-sensitive tests that run on CI (CI=true, as GitHub Actions sets it) and nowhere else.
  if (!process.env.CI) for (const e of cfg.ciOnly) skipped.set(e.file, `${e.reason} (CI only)`);
  const serial = new Map(cfg.serial.map((e) => [e.file, e.reason]));
  let all = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort();
  for (const f of [...cfg.skip.map((e) => e.file), ...cfg.ciOnly.map((e) => e.file), ...serial.keys()]) {
    if (!all.includes(f)) { console.error(`runner.config.js names a missing file: ${f}`); process.exit(2); }
  }
  if (opts.filters.length) all = all.filter((f) => opts.filters.some((s) => f.includes(s)));
  let toRun = all.filter((f) => !skipped.has(f));

  if (opts.changed) {
    const { affected } = require('./changed-tests');
    const a = affected({ cwd, testFiles: toRun, touches: cfg.touches, narrow: cfg.narrow, since: opts.since });
    toRun = a.selected;
    if (!opts.list) {
      const why = a.all ? `${a.reason}: running everything` : `${a.changed.length} changed file(s)`;
      console.error(`changed mode: ${why}; ${toRun.length} of ${all.length - skipped.size} test file(s) selected`);
    }
    if (!toRun.length) { if (!opts.list) console.error('nothing to run'); return; }
  }

  // Sharded files go first: they are the long poles, so they should start while the pool is empty.
  const expand = (f) => (cfg.shards[f] > 1 ? Array.from({ length: cfg.shards[f] }, (_, shard) => ({ file: f, shard, shards: cfg.shards[f] })) : [f]);
  const parallel = [...toRun.filter((f) => !serial.has(f) && cfg.shards[f] > 1), ...toRun.filter((f) => !serial.has(f) && !(cfg.shards[f] > 1))].flatMap(expand);
  const serials = toRun.filter((f) => serial.has(f));
  if (opts.list) { for (const f of toRun) console.log(f); return; }

  // A git hook runs us with GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE pointing at the repo being
  // committed to. Tests make their own repos with plain `git init` and `git commit`; inheriting
  // those variables would aim every one of them at the real repo (it happened: a test committed
  // fixture files onto the developer's branch). Tests get a git environment of their own.
  const env = { ...process.env, ...cfg.env };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|QUARANTINE_PATH)$/.test(k)) delete env[k];
  const timeoutMs = opts.timeout * 1000;
  const t0 = Date.now();
  // Slowest-first would need history; the pool is fine with alphabetical order.
  const results = await pool(parallel, opts.jobs, (f) => {
    return runFile(cwd, f, timeoutMs, env).then((r) => { process.stderr.write(r.code === 0 ? '.' : 'F'); return r; });
  });
  for (const f of serials) {
    const r = await runFile(cwd, f, timeoutMs, env);
    process.stderr.write(r.code === 0 ? '.' : 'F');
    results.push(r);
  }
  process.stderr.write('\n');
  const wall = Date.now() - t0;

  const w = Math.max(4, ...results.map((r) => r.label.length));
  console.log(`\n${'file'.padEnd(w)}  result  time`);
  for (const r of results.slice().sort((a, b) => b.ms - a.ms)) {
    const tag = r.code === 0 ? 'pass' : r.timedOut ? 'TIMEOUT' : 'FAIL';
    console.log(`${r.label.padEnd(w)}  ${tag.padEnd(6)}  ${(r.ms / 1000).toFixed(2)}s${serial.has(r.file) ? '  (serial)' : ''}`);
  }
  if (!opts.changed) for (const [f, reason] of skipped) if (all.includes(f)) console.log(`${f.padEnd(w)}  skip    ${reason}`);

  const failed = results.filter((r) => r.code !== 0);
  for (const r of failed) {
    console.log(`\n===== ${r.label} (exit ${r.code}${r.timedOut ? `, timed out after ${opts.timeout}s` : ''}) =====`);
    console.log(r.output.trimEnd());
  }
  const cpu = results.reduce((s, r) => s + r.ms, 0);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${[...skipped.keys()].filter((f) => all.includes(f)).length} skipped` +
    ` in ${(wall / 1000).toFixed(1)}s wall (${(cpu / 1000).toFixed(1)}s of test time, ${opts.jobs} workers)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
