'use strict';

// The deploy command (docs/native/PLAN.md, Z4): bring the running PA to the
// checked-out commit without a moment where nothing answers.
//
//   node src/supervisor/deploy.js [--pull] [--from <commit>] [--dry-run] [--json]
//                                 [--watch-seconds 60]
//
//   1. --pull: `git pull --ff-only` (the commit before it becomes --from).
//      termhub's updater has already pulled and passes --from instead.
//   2. npm install, when package.json / package-lock.json changed (or no --from).
//   3. build: `npm run build` when package.json has one (none yet: T7).
//   4. roll: the supervisor (src/supervisor) starts generation N+1, flips to
//      it once ready and keeps N drained as the standby.
//   5. watch: GET /healthz and /api/version on the public port for 60 s. Not
//      ready three probes running, or not serving the new commit at the end:
//      roll back (the supervisor flips to N again) and exit 1.
//
// Exit codes, for the wrappers (windows/redeploy.ps1, linux/redeploy.sh):
//   0  deployed, or nothing under personal-assistant/ changed
//   1  failed: the roll was refused (N still serves) or rolled back
//   3  no supervisor answers: restart the service (the bootstrap path)
//   4  the supervisor's own code changed: restart the service (brief gap)
//
// Node builtins only, like the supervisor: it must run when node_modules is
// what is broken. The decisions are pure functions (plan, verdict), tested in
// test/deploy.test.js; --dry-run prints them and changes nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');
const sup = require('./index');

const PA_DIR = path.join(__dirname, '..', '..');
const WATCH_SECONDS = 60;
const PROBE_EVERY_MS = 2000;
const FAILS_IN_A_ROW = 3;

/**
 * What to do. changed: files changed since `from` (repo-relative), or null
 * when there is no `from` (treat everything as changed). supervisor: its
 * status, or null if none answers. sourceOnDisk: hash of
 * src/supervisor/index.js now. hasBuild: package.json has scripts.build.
 */
function plan({ from, changed, supervisor, sourceOnDisk, hasBuild = false, prefix = 'personal-assistant/' }) {
  const reasons = [];
  const pa = changed === null ? null : changed.filter((f) => f.startsWith(prefix));
  const touched = pa === null || pa.length > 0;
  const deps = pa === null || pa.some((f) => /(^|\/)package(-lock)?\.json$/.test(f.slice(prefix.length)) && !f.slice(prefix.length).includes('/'));
  const install = deps;
  const build = hasBuild && touched;
  let action;
  if (!touched) {
    action = 'none';
    reasons.push(`nothing under ${prefix} changed since ${from}`);
  } else if (!supervisor) {
    action = 'restart';
    reasons.push('no supervisor answers on the control socket: restart the service (bootstraps the supervisor)');
  } else if (sourceOnDisk && supervisor.source && sourceOnDisk !== supervisor.source) {
    action = 'restart';
    reasons.push(`the supervisor's own code changed (${supervisor.source} running, ${sourceOnDisk} on disk): restart the service`);
  } else {
    action = 'roll';
    reasons.push(pa === null ? 'no previous commit given: roll' : `${pa.length} file(s) under ${prefix} changed: roll`);
  }
  if (install) reasons.push(pa === null ? 'npm install (no previous commit to compare)' : 'npm install (package files changed)');
  if (build) reasons.push('npm run build');
  return { action, install, build, reasons };
}

/**
 * The health watch's verdict on probes [{ready, commit}] taken in order:
 * 'unhealthy' as soon as FAILS_IN_A_ROW in a row were not ready, or (once
 * done) the last one does not serve `head`; else 'healthy' when done, or
 * 'watching'.
 */
function verdict(probes, { head, done = false, failsInARow = FAILS_IN_A_ROW } = {}) {
  let run = 0;
  for (const p of probes) {
    run = p.ready ? 0 : run + 1;
    if (run >= failsInARow) return { state: 'unhealthy', why: `not ready ${run} probes in a row` };
  }
  if (!done) return { state: 'watching' };
  const last = probes[probes.length - 1];
  if (!last) return { state: 'unhealthy', why: 'no probe answered' };
  if (!last.ready) return { state: 'unhealthy', why: 'not ready at the end of the watch' };
  if (head && last.commit !== head) return { state: 'unhealthy', why: `serving ${String(last.commit).slice(0, 7)}, not ${head.slice(0, 7)}` };
  return { state: 'healthy' };
}

// ---- effects ----

function git(args, opts = {}) {
  return execFileSync('git', ['-C', PA_DIR, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts }).trim();
}

function resolves(rev) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function getJson(port, p, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: timeoutMs }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(b) });
        } catch {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, body: null }));
  });
}

async function probeOnce(port) {
  const h = await getJson(port, '/healthz');
  const ready = h.status === 200 && h.body && h.body.ready === true;
  return { ready, commit: (h.body && h.body.commit) || null, at: Date.now() };
}

function npm(args, say) {
  say(`npm ${args.join(' ')}`);
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: PA_DIR, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
  if (r.status !== 0) throw new Error(`npm ${args[0]} exited ${r.status}`);
}

function parseArgs(argv) {
  const o = { pull: false, from: '', dryRun: false, json: false, watchSeconds: WATCH_SECONDS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pull') o.pull = true;
    else if (a === '--from') o.from = argv[++i] || '';
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--watch-seconds') o.watchSeconds = Math.max(1, Number(argv[++i]) || WATCH_SECONDS);
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

// One deploy at a time per machine. Two agents once deployed the same stack
// within a minute: the second rolled while the first watched, the first saw a
// commit it did not deploy, called that unhealthy and rolled the second one
// back. A lock file beside the supervisor's log, holding the owner's pid; a
// dead owner's lock is taken over. A second deploy is refused (exit 5), saying
// who holds it; the supervisor holds a lock of its own too (index.js, "lock").
function lockPath() {
  return path.join(path.dirname(path.dirname(sup.defaultLogFile())), 'deploy.lock');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function acquireDeployLock({ file = lockPath(), waitMs = 0, pollMs = 2000, say = () => {} } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  let told = false;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return {
        file,
        release: () => {
          try {
            const held = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (held.pid === process.pid) fs.rmSync(file, { force: true });
          } catch {
            /* gone already */
          }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let held = null;
    try {
      held = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* half-written or just removed: try again */
    }
    if (held && !alive(held.pid)) {
      say(`a deploy lock from pid ${held.pid} (not running) - taking it over`);
      fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      const e = new Error(`refused: another deploy is running (pid ${held && held.pid}, since ${held && held.at}); run again once it has finished`);
      e.code = 'DEPLOY_LOCKED';
      throw e;
    }
    if (!told && held) say(`another deploy is running (pid ${held.pid}, since ${held.at}) - waiting for it`);
    told = true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function deploy(argv, opts = {}) {
  const o = parseArgs(argv);
  if (o.dryRun) return deployUnlocked(argv, opts);
  const tell = (m) => (o.json ? process.stderr : process.stdout).write(`deploy: ${m}\n`);
  let lock;
  try {
    lock = await acquireDeployLock({ say: tell });
  } catch (err) {
    if (err.code !== 'DEPLOY_LOCKED') throw err;
    tell(err.message);
    return { code: 5, result: { refused: err.message } };
  }
  try {
    return await deployUnlocked(argv, opts);
  } finally {
    lock.release();
  }
}

async function deployUnlocked(argv, { say } = {}) {
  const o = parseArgs(argv);
  // With --json, stdout carries only the JSON.
  if (!say) say = (m) => (o.json ? process.stderr : process.stdout).write(`deploy: ${m}\n`);
  const port = Number(sup.envSetting('PA_DISPATCH_PORT', sup.DEFAULT_PORT));
  const control = sup.defaultControlPath(port);

  let from = o.from;
  if (o.pull) {
    from = git(['rev-parse', 'HEAD']);
    if (o.dryRun) say(`would run: git pull --ff-only (from ${from.slice(0, 7)})`);
    else {
      say('git pull --ff-only');
      git(['pull', '--ff-only'], { stdio: ['ignore', 'inherit', 'inherit'] });
    }
  }
  const head = git(['rev-parse', 'HEAD']);
  let changed = null;
  // A previous commit this clone does not have (a shallow clone, as CI checks
  // out, or a typo): everything counts as changed. Deploying too much is safe;
  // failing the whole deploy, or skipping the install, is not.
  if (from && !resolves(from)) {
    say(`previous commit ${from} is not in this clone (shallow?) - treating everything as changed`);
    from = null;
  }
  if (from) {
    const repo = git(['rev-parse', '--show-toplevel']);
    changed = execFileSync('git', ['-C', repo, 'diff', '--name-only', from, head], { encoding: 'utf8', windowsHide: true }).split('\n').filter(Boolean);
  }
  const supervisor = await sup.request(control, { cmd: 'status' }, 3000).catch(() => null);
  const pkg = JSON.parse(fs.readFileSync(path.join(PA_DIR, 'package.json'), 'utf8'));
  const p = plan({
    from,
    changed,
    supervisor: supervisor && supervisor.ok ? supervisor : null,
    sourceOnDisk: sup.sourceHash(path.join(__dirname, 'index.js')),
    hasBuild: !!(pkg.scripts && pkg.scripts.build),
  });
  const result = { head, from: from || null, port, ...p, supervisor: supervisor ? { generation: supervisor.generation, pid: supervisor.pid, source: supervisor.source || null } : null };
  for (const r of p.reasons) say(r);

  if (o.dryRun) {
    if (o.json) process.stdout.write(JSON.stringify({ dryRun: true, ...result }) + '\n');
    return { code: p.action === 'restart' ? (supervisor ? 4 : 3) : 0, result };
  }

  if (p.install) {
    npm(['install', '--omit=dev', '--no-audit', '--no-fund'], say);
    try {
      git(['checkout', '--', 'package-lock.json']); // npm's rewrite blocks the next --ff-only pull
    } catch {
      /* nothing to discard */
    }
  }
  if (p.build) npm(['run', 'build'], say);

  if (p.action === 'none') return { code: 0, result };
  if (p.action === 'restart') return { code: supervisor ? 4 : 3, result };

  // The supervisor's deploy lock, for the roll and the whole health watch:
  // a roll or rollback from anyone else meanwhile is refused (index.js). A
  // supervisor too old to know the command answers "unknown command": go on.
  const owner = `deploy.js ${os.hostname()} pid ${process.pid} -> ${head.slice(0, 7)}`;
  const locked = await sup.request(control, { cmd: 'lock', owner, ttlMs: 15 * 60_000 }).catch((err) => ({ ok: false, error: err.message }));
  if (!locked.ok && !/unknown command/.test(String(locked.error))) {
    say(locked.error);
    return { code: 5, result: { ...result, refused: locked.error } };
  }
  try {
    return await rollAndWatch({ o, say, control, port, head, result, owner });
  } finally {
    await sup.request(control, { cmd: 'unlock', owner }).catch(() => {});
  }
}

async function rollAndWatch({ o, say, control, port, head, result, owner }) {
  say(`rolling to ${head.slice(0, 7)}`);
  const rolled = await sup.request(control, { cmd: 'roll', owner }).catch((err) => ({ ok: false, error: err.message }));
  if (!rolled.ok) {
    say(`roll refused: ${rolled.error} - the previous generation keeps serving`);
    return { code: 1, result: { ...result, roll: rolled } };
  }
  say(`generation ${rolled.generation} serving (pid ${rolled.pid}); watching health for ${o.watchSeconds} s`);

  const probes = [];
  const deadline = Date.now() + o.watchSeconds * 1000;
  let v = { state: 'watching' };
  while (v.state === 'watching') {
    probes.push(await probeOnce(port));
    const done = Date.now() >= deadline;
    v = verdict(probes, { head, done });
    if (v.state === 'watching') await new Promise((r) => setTimeout(r, PROBE_EVERY_MS));
  }
  if (v.state === 'healthy') {
    say(`healthy: serving ${head.slice(0, 7)} (generation ${rolled.generation})`);
    return { code: 0, result: { ...result, generation: rolled.generation, verdict: v } };
  }
  say(`unhealthy (${v.why}) - rolling back`);
  const back = await sup.request(control, { cmd: 'rollback', owner }).catch((err) => ({ ok: false, error: err.message }));
  if (back.ok) say(`rolled back to generation ${back.generation} (pid ${back.pid}); the checkout stays at ${head.slice(0, 7)}`);
  else {
    // The supervisor kept the new generation serving (undrained): say what
    // answers now rather than leave "rolled back" to be assumed.
    const now = await probeOnce(port);
    say(`rollback failed: ${back.error}; serving ${now.commit ? String(now.commit).slice(0, 7) : 'nothing'}${now.ready ? '' : ' (not ready)'} (generation ${back.generation ?? '?'})`);
  }
  return { code: 1, result: { ...result, verdict: v, rollback: back } };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  deploy(argv).then(
    ({ code, result }) => {
      if (argv.includes('--json') && !argv.includes('--dry-run')) process.stdout.write(JSON.stringify({ code, ...result }) + '\n');
      process.exit(code);
    },
    (err) => {
      process.stderr.write(`deploy: failed: ${err.message}\n`);
      process.exit(1);
    }
  );
}

module.exports = { plan, verdict, deploy, parseArgs, acquireDeployLock };
