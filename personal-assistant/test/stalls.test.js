'use strict';

// What rolled a healthy deploy back (2026-11-08): a fresh worker generation
// blocked its own event loop for 16 s and then 6 s, one synchronous vault read
// (~0.6 s of PowerShell each) per unset secret name, and /healthz could not
// answer the deploy's watch. Here: unset names cost one vault listing, not one
// process each; the stall detector reports a blocked loop; the supervisor's
// log file rotates. No database, no real vault.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- unset secrets do not each start a process ----
{
  const vault = require('../src/secrets/vault');
  vault.useBackend('windows');
  const ops = [];
  const store = new Map([['PA_TEST_STALL_PRESENT', 'v1']]);
  vault.setRunner((inv) => {
    const req = JSON.parse(Buffer.from(inv.input.trim(), 'base64').toString('utf8'));
    ops.push(req.op);
    const reply = req.op === 'get'
      ? (store.has(req.name) ? { ok: true, found: true, value: store.get(req.name) } : { ok: true, found: false })
      : { ok: true, names: [...store.keys()] };
    return { stdout: JSON.stringify(reply) + '\n', status: 0 };
  });
  const cfg = require('../src/config');
  for (let i = 0; i < 12; i++) assert.strictEqual(cfg.secret(`PA_TEST_STALL_MISSING_${i}`), null);
  assert.deepStrictEqual(ops, ['list'], `twelve unset names cost ${ops.length} vault calls`);
  assert.strictEqual(cfg.secret('PA_TEST_STALL_PRESENT'), 'v1');
  assert.deepStrictEqual(ops, ['list', 'get']);
  // Stored elsewhere, then forgotten here: listed again, found.
  store.set('PA_TEST_STALL_MISSING_0', 'v0');
  cfg.forgetSecret('PA_TEST_STALL_MISSING_0');
  assert.strictEqual(cfg.secret('PA_TEST_STALL_MISSING_0'), 'v0');
  assert.deepStrictEqual(ops, ['list', 'get', 'list', 'get']);
  vault.setRunner(null);
  vault.useBackend(null);
}

// ---- a repo's origin without a git process (projects sync ran ~66 of them) ----
{
  const { gitRemote } = require('../src/projects');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-remote-'));
  try {
    const clone = path.join(dir, 'clone');
    fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
    fs.writeFileSync(path.join(clone, '.git', 'config'), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@x:other/thing.git\n[remote "origin"]\n\turl = git@github-xvanov:xvanov/dev-tools.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
    assert.strictEqual(gitRemote(clone), 'git@github-xvanov:xvanov/dev-tools.git');
    // A linked worktree: .git is a file; the config is the main clone's.
    const wt = path.join(dir, 'wt');
    fs.mkdirSync(path.join(clone, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(clone, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(clone, '.git', 'worktrees', 'wt')}\n`);
    assert.strictEqual(gitRemote(wt), 'git@github-xvanov:xvanov/dev-tools.git');
    // No origin: null, still without git.
    const bare = path.join(dir, 'none');
    fs.mkdirSync(path.join(bare, '.git'), { recursive: true });
    fs.writeFileSync(path.join(bare, '.git', 'config'), '[core]\n\tbare = false\n');
    assert.strictEqual(gitRemote(bare), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- children run below normal; the worker itself does not ----
async function priority() {
  const { lowerChildren } = require('../src/util/childPriority');
  const calls = [];
  lowerChildren({ priority: 10, setPriority: (pid, p) => calls.push([pid, p]) });
  const { execFile } = require('child_process');
  const pid = await new Promise((resolve) => {
    const c = execFile(process.execPath, ['-e', '0'], () => resolve(c.pid));
  });
  assert.deepStrictEqual(calls, [[pid, 10]], 'execFile children are lowered');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.js'), 'utf8');
  assert.ok(!/os'\)\.setPriority\(/.test(src), 'the worker must not lower itself: it serves the dashboard');
  assert.ok(/childPriority'\)\.lowerChildren\(\)/.test(src));
}

// ---- the stall detector names a blocked loop ----
async function lag() {
  const { watchLag } = require('../src/util/lagWatch');
  const seen = [];
  const w = watchLag({ log: { warn: (m, f) => seen.push({ m, f }) }, everyMs: 20, thresholdMs: 150, running: () => ['distill'] });
  await new Promise((r) => setTimeout(r, 60));
  const until = Date.now() + 300;
  while (Date.now() < until) {
    /* block the loop */
  }
  await new Promise((r) => setTimeout(r, 80));
  w.stop();
  assert.strictEqual(seen.length, 1, JSON.stringify(seen));
  assert.strictEqual(seen[0].m, 'event loop blocked');
  assert.ok(seen[0].f.ms >= 250, `measured ${seen[0].f.ms} ms`);
  assert.deepStrictEqual(seen[0].f.running, ['distill']);
}

// ---- the supervisor's log file ----
function logFile() {
  const { createLogFile, defaultLogFile } = require('../src/supervisor');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-suplog-'));
  try {
    const f = createLogFile(path.join(dir, 'logs', 'supervisor.log'), { maxBytes: 100, keep: 2 });
    for (let i = 0; i < 12; i++) f.write(`line ${String(i).padStart(2, '0')} ${'x'.repeat(20)}\n`);
    const files = fs.readdirSync(path.join(dir, 'logs')).sort();
    assert.deepStrictEqual(files, ['supervisor.log', 'supervisor.log.1', 'supervisor.log.2']);
    assert.ok(fs.statSync(path.join(dir, 'logs', 'supervisor.log')).size <= 100);
    assert.match(fs.readFileSync(path.join(dir, 'logs', 'supervisor.log'), 'utf8'), /line 11/);
    assert.match(defaultLogFile(), /personal-assistant[\\/]logs[\\/]supervisor\.log$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

priority()
  .then(lag)
  .then(() => {
    logFile();
    console.log('stalls ok');
    process.exit(0); // config's modules may hold handles open; nothing is left to run
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
