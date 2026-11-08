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
  r = p({ changed: ['personal-assistant/src/supervisor/index.js'], sourceOnDisk: 'bbbbbbbbbbbb' });
  assert.strictEqual(r.action, 'restart');
  assert.match(r.reasons[0], /own code changed/);
  // A supervisor too old to report its source is rolled (it cannot tell).
  assert.strictEqual(p({ changed: ['personal-assistant/src/x.js'], supervisor: { ok: true } }).action, 'roll');
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

console.log('deploy ok');
