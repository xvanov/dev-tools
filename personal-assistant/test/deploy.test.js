'use strict';

// The deploy command's decisions (src/supervisor/deploy.js; docs/native/PLAN.md
// Z4), and a --dry-run of the real thing, which must change nothing. The roll
// and rollback themselves are exercised in test/supervisor.test.js.

const assert = require('assert');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { plan, verdict, parseArgs } = require('../src/supervisor/deploy');

const PA = path.join(__dirname, '..');
const live = { ok: true, generation: 3, pid: 10, source: 'aaaaaaaaaaaa' };

// ---- Bun for jarvisd (plan 4.1) ----
// The 2d7fdbf deploy ran `npm ci` in jarvisd/ on a stack running on Bun: npm
// deletes node_modules first, the running generation's bun.exe is locked on
// Windows, EPERM. A deploy now installs each pinned version into its own
// directory, once, and never touches one a generation may be running.
{
  const fs = require('fs');
  const os = require('os');
  const D = require('../src/supervisor/deploy');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-deploy-bun-'));
  const write = (pin) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { bun: pin } }));
  try {
    write('1.3.13');
    assert.strictEqual(D.pinnedBun(dir), '1.3.13');
    assert.strictEqual(D.bunInstallPlan({ jarvisdDir: dir }).install, false, 'a stack without jarvisd installed installs nothing');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    const p1 = D.bunInstallPlan({ jarvisdDir: dir });
    assert.strictEqual(p1.install, true);
    assert.strictEqual(p1.dir, path.join(dir, '.bun', '1.3.13'), 'its own versioned directory, not jarvisd/node_modules');
    fs.mkdirSync(path.dirname(p1.exe), { recursive: true });
    fs.writeFileSync(p1.exe, '');
    assert.strictEqual(D.bunInstallPlan({ jarvisdDir: dir }).install, false, 'installed once');
    write('1.3.14');
    const p2 = D.bunInstallPlan({ jarvisdDir: dir });
    assert.deepStrictEqual([p2.install, p2.version], [true, '1.3.14'], 'a new pin installs beside the running one');
    assert.notStrictEqual(p2.dir, p1.dir);
    write('^1.3');
    assert.strictEqual(D.bunInstallPlan({ jarvisdDir: dir }).install, false, 'only an exact pin installs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // deploy.js never runs npm ci in jarvisd/.
  const src = fs.readFileSync(path.join(PA, 'src', 'supervisor', 'deploy.js'), 'utf8');
  assert.ok(!/['"]ci['"]/.test(src), 'no npm ci in deploy.js');
}

// ---- plan ----
{
  const p = (o) => plan({ from: 'abc', sourceOnDisk: 'aaaaaaaaaaaa', supervisor: live, ...o });

  let r = p({ changed: ['termhub/front.js', 'docs/x.md'] });
  assert.strictEqual(r.action, 'none');
  assert.strictEqual(r.install, false);

  r = p({ changed: ['personal-assistant/src/worker.js'] });
  assert.strictEqual(r.action, 'roll');
  assert.strictEqual(r.install, false);
  assert.strictEqual(r.build, false);

  r = p({ changed: ['personal-assistant/package-lock.json'] });
  assert.strictEqual(r.action, 'roll');
  assert.strictEqual(r.install, true);
  r = p({ changed: ['personal-assistant/test/fixtures/package.json'] });
  assert.strictEqual(r.install, false, 'only the tool-level package files mean npm install');

  r = p({ changed: ['personal-assistant/src/x.js'], hasBuild: true });
  assert.strictEqual(r.build, true);

  // No previous commit: everything counts as changed.
  r = p({ from: '', changed: null });
  assert.strictEqual(r.action, 'roll');
  assert.strictEqual(r.install, true);

  // No supervisor: the service must restart (that is the bootstrap) — unless nothing changed.
  r = p({ changed: ['personal-assistant/src/x.js'], supervisor: null });
  assert.strictEqual(r.action, 'restart');
  assert.match(r.reasons[0], /no supervisor/);
  assert.strictEqual(p({ changed: [], supervisor: null }).action, 'none');

  // The supervisor's own code changed: it cannot roll itself.
  r = p({ changed: ['personal-assistant/src/supervisor/index.ts'], sourceOnDisk: 'bbbbbbbbbbbb' });
  assert.strictEqual(r.action, 'restart');
  assert.match(r.reasons[0], /own code changed/);
  // A supervisor too old to report its source is rolled (it cannot tell).
  assert.strictEqual(p({ changed: ['personal-assistant/src/x.js'], supervisor: { ok: true } }).action, 'roll');

  // PA_RUNTIME (want) against what runs: a switch, either way, is a restart
  // (the launcher starts what the setting says); to jarvisd it builds first.
  r = p({ changed: [], supervisor: live, want: 'jarvisd' });
  assert.deepStrictEqual([r.action, r.binary], ['restart', true], 'node -> jarvisd, even with nothing changed');
  assert.match(r.reasons[0], /PA_RUNTIME is jarvisd but the supervisor runs node/);
  r = p({ changed: [], supervisor: { ...live, runtime: 'jarvisd' }, want: 'node' });
  assert.deepStrictEqual([r.action, r.binary], ['restart', false], 'rolling the switch back: one setting, a restart');
  assert.strictEqual(p({ changed: [], supervisor: { ...live, runtime: 'node' }, want: 'node' }).action, 'none');
  assert.strictEqual(p({ changed: ['personal-assistant/src/x.js'], supervisor: { ok: true, source: 'aaaaaaaaaaaa' }, sourceOnDisk: 'aaaaaaaaaaaa', want: 'node' }).action, 'roll', 'a supervisor too old to say its runtime is Node');
  // jarvisd: its own supervisor changed, or none answers: build, then restart onto it.
  r = p({ changed: ['personal-assistant/src/supervisor/index.ts'], supervisor: { ...live, runtime: 'jarvisd' }, sourceOnDisk: 'bbbbbbbbbbbb', want: 'jarvisd' });
  assert.deepStrictEqual([r.action, r.binary], ['restart', true]);
  r = p({ changed: ['personal-assistant/src/x.js'], supervisor: null, want: 'jarvisd' });
  assert.deepStrictEqual([r.action, r.binary], ['restart', true]);

  // A compiled jarvisd supervising (plan 4.4): a roll builds a new executable
  // first, and changes to jarvisd/ or schemas/ count, as they are in it.
  const bin = { ...live, runtime: 'jarvisd' };
  r = p({ changed: ['personal-assistant/src/x.js'], supervisor: bin });
  assert.deepStrictEqual([r.action, r.binary], ['roll', true]);
  r = p({ changed: ['jarvisd/src/main.ts'], supervisor: bin });
  assert.deepStrictEqual([r.action, r.binary], ['roll', true]);
  assert.strictEqual(p({ changed: ['jarvisd/src/main.ts'], supervisor: live }).action, 'none', 'a Node supervisor runs no jarvisd code');
  assert.strictEqual(p({ changed: ['personal-assistant/src/x.js'], supervisor: live }).binary, false);
  r = p({ changed: ['personal-assistant/src/supervisor/index.ts'], supervisor: bin, sourceOnDisk: 'bbbbbbbbbbbb' });
  assert.deepStrictEqual([r.action, r.binary], ['restart', true], 'its own supervisor changed: build, then restart onto it');
}

// ---- verdict ----
{
  const head = 'f'.repeat(40);
  const ok = { ready: true, commit: head };
  const no = { ready: false, commit: null };
  assert.strictEqual(verdict([ok, ok], { head }).state, 'watching');
  assert.strictEqual(verdict([ok, ok, ok], { head, done: true }).state, 'healthy');
  assert.strictEqual(verdict([ok, no, no, ok, ok], { head, done: true }).state, 'healthy', 'a blip is not a failure');
  const three = verdict([ok, no, no, no], { head });
  assert.strictEqual(three.state, 'unhealthy', 'three failures in a row end the watch early');
  assert.match(three.why, /3 probes in a row/);
  assert.match(verdict([ok, { ready: true, commit: 'e'.repeat(40) }], { head, done: true }).why, /serving eeeeeee/);
  assert.strictEqual(verdict([ok, no], { head, done: true }).state, 'unhealthy');
  assert.strictEqual(verdict([], { head, done: true }).state, 'unhealthy');
}

// ---- `node src/worker.js` from a task or unit is the supervisor ----
// The bootstrap must not depend on rewriting the task (a non-elevated deploy
// cannot): worker.js hands over to the supervisor before loading anything.
{
  const src = require('fs').readFileSync(path.join(PA, 'src', 'worker.js'), 'utf8');
  const hand = src.indexOf("require('./supervisor')");
  assert.ok(hand > 0, 'worker.js starts the supervisor when not supervised');
  assert.ok(hand < src.indexOf("require('./config')"), 'before any worker code is loaded');
  assert.match(src, /PA_SUPERVISED !== '1' && process\.env\.PA_NO_SUPERVISOR !== '1'/);
}

// ---- one deploy at a time ----
async function lockCases() {
  const { acquireDeployLock } = require('../src/supervisor/deploy');
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-deploylock-'));
  const file = path.join(dir, 'deploy.lock');
  try {
    const a = await acquireDeployLock({ file });
    // A second deploy waits while the first holds it, and gets it once released.
    let got = false;
    const b = acquireDeployLock({ file, pollMs: 20, waitMs: 5000 }).then((l) => ((got = true), l));
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(got, false, 'a second deploy ran while the first held the lock');
    a.release();
    const lb = await b;
    assert.strictEqual(got, true);
    lb.release();
    assert.ok(!fs.existsSync(file));
    // A lock left by a dead process is taken over.
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, at: 'then' }));
    const said = [];
    const lc = await acquireDeployLock({ file, pollMs: 20, waitMs: 1000, say: (m) => said.push(m) });
    assert.match(said.join('\n'), /not running/);
    lc.release();
    // A live holder that never lets go: the waiter gives up, saying who.
    const ld = await acquireDeployLock({ file });
    await assert.rejects(acquireDeployLock({ file, pollMs: 20, waitMs: 100 }), /refused: another deploy is running \(pid \d+/);
    // By default a second deploy does not wait: it is refused at once.
    const t0 = Date.now();
    await assert.rejects(acquireDeployLock({ file }), (e) => e.code === 'DEPLOY_LOCKED');
    assert.ok(Date.now() - t0 < 1000);
    ld.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- args ----
assert.deepStrictEqual(parseArgs(['--from', 'abc', '--dry-run', '--watch-seconds', '5']), { pull: false, from: 'abc', dryRun: true, json: false, watchSeconds: 5 });
assert.throws(() => parseArgs(['--frob']), /unknown argument/);

// ---- a dry run changes nothing ----
{
  const git = (args) => execFileSync('git', args, { cwd: PA, encoding: 'utf8', windowsHide: true }).trim();
  let head = null;
  try {
    head = git(['rev-parse', 'HEAD']);
  } catch {
    console.log('deploy: no git here — dry run skipped');
  }
  if (head) {
    const before = git(['status', '--porcelain']);
    // A port nothing listens on, so no live supervisor is ever asked.
    const r = spawnSync(process.execPath, ['src/supervisor/deploy.js', '--from', 'HEAD', '--dry-run', '--json'], {
      cwd: PA,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PA_DISPATCH_PORT: '1' },
    });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(out.dryRun, true);
    assert.strictEqual(out.head, head);
    assert.strictEqual(out.action, 'none', 'from HEAD to HEAD there is nothing to do');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(git(['status', '--porcelain']), before, 'a dry run touched the tree');

    const r2 = spawnSync(process.execPath, ['src/supervisor/deploy.js', '--dry-run', '--json'], {
      cwd: PA,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PA_DISPATCH_PORT: '1' },
    });
    const out2 = JSON.parse(r2.stdout.trim().split('\n').pop());
    assert.strictEqual(out2.action, 'restart', 'no supervisor on port 1: the bootstrap path');
    assert.strictEqual(r2.status, 3);

    // A previous commit this clone lacks (CI's shallow checkout has no HEAD~1):
    // everything counts as changed, never a failed deploy.
    const r3 = spawnSync(process.execPath, ['src/supervisor/deploy.js', '--from', '0123456789abcdef0123', '--dry-run', '--json'], {
      cwd: PA,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PA_DISPATCH_PORT: '1' },
    });
    const out3 = JSON.parse(r3.stdout.trim().split('\n').pop());
    assert.strictEqual(out3.from, null);
    assert.strictEqual(out3.install, true);
    assert.match(r3.stderr, /not in this clone/);

    // The platform wrapper's dry run: says what it would do, changes nothing.
    const env = { ...process.env, PA_DISPATCH_PORT: '1' };
    const w = process.platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join('windows', 'redeploy.ps1'), '-DryRun', '-From', 'HEAD~1'], { cwd: PA, encoding: 'utf8', windowsHide: true, env })
      : spawnSync('bash', [path.join('linux', 'redeploy.sh'), 'HEAD~1', '--dry-run'], { cwd: PA, encoding: 'utf8', env });
    if (w.error) console.log(`deploy: wrapper dry run skipped (${w.error.code})`);
    else {
      assert.strictEqual(w.status, 0, w.stdout + w.stderr);
      assert.match(w.stdout, /deploy: /, w.stdout);
      assert.strictEqual(git(['status', '--porcelain']), before, 'the wrapper dry run touched the tree');
    }
  }
}

lockCases().then(
  () => console.log('deploy ok'),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
