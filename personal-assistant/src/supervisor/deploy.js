'use strict';

// The deploy command (docs/native/PLAN.md, Z4): bring the running PA to the
// checked-out commit without a moment where nothing answers.
//
//   node src/supervisor/deploy.js [--pull] [--from <commit>] [--dry-run] [--json]
//                                 [--watch-seconds 60]
//
//   1. --pull: `git fetch`, then the signature check on what was fetched
//      (signing.js), then `git merge --ff-only` (the commit before it becomes
//      --from). termhub's updater has already pulled and passes --from
//      instead; the same check runs on from..HEAD and refuses the roll.
//      Until a trusted-signers file exists a missing signature only warns
//      (--require-signed / PA_REQUIRE_SIGNED=1 makes it refuse regardless).
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
//   1  failed: the roll was refused (N still serves) or rolled back, or the
//      pulled commits are not signed by a trusted key (nothing was rolled)
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
const signed = require('./signing');

const PA_DIR = path.join(__dirname, '..', '..');
const WATCH_SECONDS = 60;
const PROBE_EVERY_MS = 2000;
const FAILS_IN_A_ROW = 3;

/**
 * What to do. changed: files changed since `from` (repo-relative), or null
 * when there is no `from` (treat everything as changed). supervisor: its
 * status, or null if none answers. sourceOnDisk: hash of
 * src/supervisor/index.ts now. hasBuild: package.json has scripts.build.
 * A supervisor that is a compiled jarvisd (status.runtime 'jarvisd', plan 4.4)
 * rolls to a newly built executable: jarvisd/ and schemas/ changes count too,
 * and the plan says `binary` (deploy.js builds it beside the running one).
 */
function plan({ from, changed, supervisor, sourceOnDisk, hasBuild = false, prefix = 'personal-assistant/', want = null }) {
  const reasons = [];
  // want: the runtime the stack is set to (PA_RUNTIME: node, bun or jarvisd).
  // A running supervisor of another runtime means a switch (or a rollback of
  // one): restart the service, whose launcher starts the runtime asked for.
  const running = supervisor ? supervisor.runtime || 'node' : null;
  const switching = !!(supervisor && want && want !== running);
  const binary = want === 'jarvisd' || (!want && running === 'jarvisd');
  const pa = changed === null ? null : changed.filter((f) => f.startsWith(prefix) || (binary && (f.startsWith('jarvisd/') || f.startsWith('schemas/'))));
  const touched = pa === null || pa.length > 0;
  const deps = pa === null || pa.some((f) => /(^|\/)package(-lock)?\.json$/.test(f.slice(prefix.length)) && !f.slice(prefix.length).includes('/'));
  const install = deps;
  const build = hasBuild && touched;
  let action;
  if (switching) {
    action = 'restart';
    reasons.push(`PA_RUNTIME is ${want} but the supervisor runs ${running}: restart the service (its launcher starts ${want})`);
  } else if (!touched) {
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
  // A jarvisd stack runs a newly built executable after a roll or a restart
  // (the launcher starts the one jarvisd/dist/current names).
  const buildBinary = binary && (action === 'roll' || action === 'restart');
  if (buildBinary) reasons.push(`build a new jarvisd executable and ${action} to it`);
  return { action, install, build, binary: buildBinary, reasons };
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

const JARVISD_DIR = path.join(__dirname, '..', '..', '..', 'jarvisd');

/** The Bun version jarvisd/package.json pins, or null. */
function pinnedBun(jarvisdDir = JARVISD_DIR) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(jarvisdDir, 'package.json'), 'utf8'));
    const v = String((pkg.devDependencies || {}).bun || (pkg.dependencies || {}).bun || '');
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Where a pinned Bun lives: jarvisd/.bun/<version>/ (its own directory per version). */
function bunDir(version, jarvisdDir = JARVISD_DIR) {
  const dir = path.join(jarvisdDir, '.bun', version);
  return { dir, exe: path.join(dir, 'node_modules', 'bun', 'bin', 'bun.exe') };
}

/**
 * Whether a deploy installs Bun (plan 4.1). Never `npm ci` in jarvisd/: on
 * Windows the running generation's bun.exe is locked, and npm ci, which deletes
 * node_modules first, fails with EPERM (the 2d7fdbf deploy). Instead each
 * pinned version gets its own directory, installed once; a new pin installs
 * beside the running one, and the supervisor picks it up at its next start
 * (supervisor runtimeSpec). Only on a stack that uses jarvisd (it has
 * jarvisd/node_modules or jarvisd/.bun). Pure but for existsSync.
 */
function bunInstallPlan({ jarvisdDir = JARVISD_DIR, exists = fs.existsSync } = {}) {
  const version = pinnedBun(jarvisdDir);
  if (!version) return { install: false, reason: 'jarvisd pins no Bun' };
  const { dir, exe } = bunDir(version, jarvisdDir);
  if (!exists(path.join(jarvisdDir, 'node_modules')) && !exists(path.join(jarvisdDir, '.bun'))) return { install: false, version, dir, exe, reason: 'this stack does not use jarvisd' };
  if (exists(exe)) return { install: false, version, dir, exe, reason: `Bun ${version} is installed` };
  return { install: true, version, dir, exe, reason: `Bun ${version} is pinned and not installed yet` };
}

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
    else if (a === '--require-signed') o.requireSigned = true;
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
    // Meter's deploy hop (plan 7.5): timed from the lock to the verdict; flushed before a short-lived process exits.
    const t = require('../telemetry');
    try {
      return await t.span('deploy', 'deploy', {}, () => deployUnlocked(argv, opts));
    } finally {
      await t.flush();
    }
  } finally {
    lock.release();
  }
}

/** PA_RUNTIME as the stack is set (env, else .env): node (default), bun or jarvisd. */
function wantRuntime() {
  const v = String(sup.envSetting('PA_RUNTIME', 'node')).trim();
  return v === 'bun' || v === 'jarvisd' ? v : 'node';
}

async function deployUnlocked(argv, { say } = {}) {
  const o = parseArgs(argv);
  // With --json, stdout carries only the JSON.
  if (!say) say = (m) => (o.json ? process.stderr : process.stdout).write(`deploy: ${m}\n`);
  const port = Number(sup.envSetting('PA_DISPATCH_PORT', sup.DEFAULT_PORT));
  const control = sup.defaultControlPath(port);

  let from = o.from;
  let signing = null;
  if (o.pull) {
    from = git(['rev-parse', 'HEAD']);
    if (o.dryRun) say(`would run: git pull --ff-only (from ${from.slice(0, 7)})`);
    else {
      // `git pull --ff-only` as its two halves, so the signatures are checked
      // on what was fetched BEFORE the checkout moves to it.
      say('git fetch');
      git(['fetch'], { stdio: ['ignore', 'inherit', 'inherit'] });
      let upstream = null;
      try {
        upstream = git(['rev-parse', '--verify', '--quiet', '@{u}']);
      } catch {
        /* no upstream: the merge below fails the way pull would */
      }
      if (upstream && upstream !== from) {
        signing = signed.verifyPulled({ range: `${from}..${upstream}`, git: (a) => git(a), say, require: o.requireSigned || undefined });
        if (signing.state === 'refused') return { code: 1, result: { head: from, from, signing } };
      }
      say('git merge --ff-only');
      git(['merge', '--ff-only', '@{u}'], { stdio: ['ignore', 'inherit', 'inherit'] });
    }
  }
  const head = git(['rev-parse', 'HEAD']);
  // Pulled by someone else (termhub's updater, `--from`): the checkout has
  // already moved, so the most this can do is refuse to roll to it.
  if (!signing && head !== from) {
    signing = signed.verifyPulled({ range: from && resolves(from) ? `${from}..${head}` : `${head}^!`, git: (a) => git(a), say, require: o.requireSigned || undefined });
    if (signing.state === 'refused') {
      say(`the checkout is at ${head.slice(0, 7)} and was not deployed; nothing was rolled`);
      return { code: 1, result: { head, from: from || null, signing } };
    }
  }
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
    sourceOnDisk: sup.sourceHash(path.join(__dirname, 'index.ts')),
    hasBuild: !!(pkg.scripts && pkg.scripts.build),
    want: wantRuntime(),
  });
  const result = { head, from: from || null, port, ...p, signing: signing ? { state: signing.state, mode: signing.mode, total: signing.total } : null, supervisor: supervisor ? { generation: supervisor.generation, pid: supervisor.pid, source: supervisor.source || null } : null };
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
  // jarvisd (plan 4.1): a stack that uses jarvisd gets the Bun pinned in
  // jarvisd/package.json, in its own versioned directory (bunInstallPlan).
  const bp = bunInstallPlan({ jarvisdDir: JARVISD_DIR });
  if (bp.install) {
    say(`installing Bun ${bp.version} into ${path.relative(path.join(PA_DIR, '..'), bp.dir)} (${bp.reason})`);
    fs.mkdirSync(bp.dir, { recursive: true });
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', bp.dir, `bun@${bp.version}`], { cwd: bp.dir, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
    if (r.status !== 0 || !fs.existsSync(bp.exe)) {
      fs.rmSync(bp.dir, { recursive: true, force: true });
      throw new Error(`installing Bun ${bp.version} failed (npm exited ${r.status})`);
    }
  }

  if (p.action === 'none') return { code: 0, result };
  if (p.action === 'restart') {
    // A jarvisd stack restarts onto a new executable: build it and point
    // jarvisd/dist/current at it first (the launcher runs what it names).
    if (p.binary) {
      try {
        buildJarvisd(head, say);
      } catch (err) {
        say(`jarvisd build failed: ${err.message} - not restarting`);
        return { code: 1, result: { ...result, build: err.message } };
      }
    }
    return { code: supervisor ? 4 : 3, result };
  }

  // The supervisor's deploy lock, for the roll and the whole health watch:
  // a roll or rollback from anyone else meanwhile is refused (index.js). A
  // supervisor too old to know the command answers "unknown command": go on.
  const owner = `deploy.js ${os.hostname()} pid ${process.pid} -> ${head.slice(0, 7)}`;
  const locked = await sup.request(control, { cmd: 'lock', owner, ttlMs: 15 * 60_000 }).catch((err) => ({ ok: false, error: err.message }));
  if (!locked.ok && !/unknown command/.test(String(locked.error))) {
    say(locked.error);
    return { code: 5, result: { ...result, refused: locked.error } };
  }
  // A compiled jarvisd: build the new executable beside the running one
  // (Windows will not replace a running .exe) and point jarvisd/dist/current
  // at it; the supervisor starts each generation from that pointer. A failed
  // roll points it back.
  let pointer = null;
  if (p.binary) {
    try {
      pointer = buildJarvisd(head, say);
    } catch (err) {
      say(`jarvisd build failed: ${err.message} - nothing rolled`);
      await sup.request(control, { cmd: 'unlock', owner }).catch(() => {});
      return { code: 1, result: { ...result, build: err.message } };
    }
  }
  try {
    const r = await rollAndWatch({ o, say, control, port, head, result, owner });
    if (r.code !== 0 && pointer) pointer.restore();
    return r;
  } finally {
    await sup.request(control, { cmd: 'unlock', owner }).catch(() => {});
  }
}

/**
 * Builds jarvisd/dist/jarvisd-<commit>[.exe] (scripts/build.js, JARVISD_OUT)
 * and writes its name to jarvisd/dist/current. Returns {file, restore()}.
 */
function buildJarvisd(head, say) {
  const repo = git(['rev-parse', '--show-toplevel']);
  const dist = path.join(repo, 'jarvisd', 'dist');
  const name = `jarvisd-${head.slice(0, 7)}${process.platform === 'win32' ? '.exe' : ''}`;
  const pointerFile = path.join(dist, 'current');
  let before = null;
  try {
    before = fs.readFileSync(pointerFile, 'utf8');
  } catch {
    /* none yet */
  }
  say(`building ${name}`);
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'build.js'), '--only', 'jarvisd'], {
    cwd: repo,
    env: { ...process.env, JARVISD_OUT: path.join(dist, name) },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (r.status !== 0 || !fs.existsSync(path.join(dist, name))) throw new Error(`scripts/build.js exited ${r.status}`);
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(pointerFile, `${name}\n`);
  return {
    file: path.join(dist, name),
    restore: () => {
      if (before === null) fs.rmSync(pointerFile, { force: true });
      else fs.writeFileSync(pointerFile, before);
      say(`jarvisd/dist/current points back at ${before ? before.trim() : 'nothing'}`);
    },
  };
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

module.exports = { plan, wantRuntime, verdict, deploy, parseArgs, acquireDeployLock, bunInstallPlan, bunDir, pinnedBun };
