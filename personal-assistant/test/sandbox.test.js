'use strict';

// PA_SANDBOX (src/dispatch/sandbox.ts): the flag, the mode → broker ceiling
// map, the refusal for modes it cannot cover, the host spec, the wrapped
// command line, and start() against a fake host. No real sandbox here — the
// sandbox itself is tested in software-factory (tests/test_sandbox_*.py).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/dispatch/sandbox.ts');

// --- flag ----------------------------------------------------------------------
assert.strictEqual(S.enabled({}), false, 'default off');
for (const v of ['on', 'ON', '1', 'true', 'yes']) assert.strictEqual(S.enabled({ PA_SANDBOX: v }), true, v);
for (const v of ['off', '0', '', 'nope']) assert.strictEqual(S.enabled({ PA_SANDBOX: v }), false, v);

// --- ceilings mirror factory.sandbox.ceiling_for_mode ---------------------------
assert.deepStrictEqual(
  ['plan', 'local', 'branch', 'mr', 'full', 'weird', undefined].map(S.ceilingFor),
  ['none', 'none', 'push_branch', 'draft_pr', 'draft_pr', 'none', 'none']
);

// --- only plan sessions are sandboxed so far; the rest are refused, not run open --
S.requireSandboxable('plan');
for (const m of ['local', 'branch', 'mr', 'full']) {
  assert.throws(() => S.requireSandboxable(m), (e) => e.code === 'sandbox_mode' && /could not commit/.test(e.message), m);
}

// --- host spec ----------------------------------------------------------------
{
  const spec = S.hostSpec({ runId: 7, workdir: '/w/run-7', stateDir: '/w/run-7.sbx', mode: 'mr', repoPath: '/r/app', branch: 'pa/7-x', claudeBin: '/bin/claude' });
  assert.strictEqual(spec.run_id, 'pa-7');
  assert.strictEqual(spec.ceiling, 'draft_pr');
  assert.strictEqual(spec.trusted_repo, '/r/app', 'push URL read from the trusted repo, not the worktree');
  assert.strictEqual(spec.source, '/w/run-7');
  assert.strictEqual(spec.branch_prefix, 'pa/7-x', 'the broker pushes only the run\'s own branch');
  assert.deepStrictEqual(spec.extra_readable, ['/bin/claude']);
  assert.deepStrictEqual(spec.pass_env, ['CLAUDE_CODE_OAUTH_TOKEN']);
  const plan = S.hostSpec({ runId: 8, workdir: '/w/p', stateDir: '/w/p.sbx', mode: 'plan' });
  assert.strictEqual(plan.ceiling, 'none');
  assert.ok(!('trusted_repo' in plan) && !('branch_prefix' in plan));
}

// --- the command line ---------------------------------------------------------
{
  const wrap = ['/f/.venv/bin/python', '-I', '-X', 'utf8', '-m', 'factory.sandbox.exec', 'run', '--policy', '/s/policy.json', '--'];
  assert.strictEqual(
    S.wrapCommand(wrap, 'claude --model opus'),
    '/f/.venv/bin/python -I -X utf8 -m factory.sandbox.exec run --policy /s/policy.json -- claude --model opus'
  );
  const win = ['C:\\f\\.venv\\Scripts\\python.exe', '-I', '-m', 'factory.sandbox.exec', 'run', '--policy', 'C:\\Run Dir\\policy.json', '--'];
  assert.strictEqual(
    S.wrapCommand(win, 'claude', 'windows'),
    "& C:\\f\\.venv\\Scripts\\python.exe -I -m factory.sandbox.exec run --policy 'C:\\Run Dir\\policy.json' -- claude"
  );
  assert.strictEqual(S.wrapCommand(['/p y'], 'x'), "'/p y' x");
  assert.throws(() => S.wrapCommand([], 'claude'));
}

assert.ok(/sbx push/.test(S.BRIEF_NOTE) && /sbx pr/.test(S.BRIEF_NOTE));
assert.strictEqual(S.factoryPython('/f', 'posix'), path.join('/f', '.venv', 'bin', 'python'));
assert.strictEqual(S.factoryPython('C:\\f', 'windows'), path.join('C:\\f', '.venv', 'Scripts', 'python.exe'));

// --- start(): spawns the host detached and waits for its ready file -------------
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sbx-'));
  try {
    await assert.rejects(S.start({ factoryPath: '', spec: {}, stateDir: dir }), /PA_FACTORY_PATH/);

    let seen = null;
    const fakeSpawn = (cmd, args, opts) => {
      seen = { cmd, args, opts };
      const out = args[args.indexOf('--out') + 1];
      setTimeout(() => fs.writeFileSync(out, JSON.stringify({ wrap: ['py', '--'], policy: 'p.json', pid: 4242 })), 50);
      return { pid: 4242, exitCode: null, unref() {} };
    };
    const ready = await S.start({ factoryPath: '/f', spec: { run_id: 'pa-1' }, stateDir: dir, spawnFn: fakeSpawn, platformId: 'posix' });
    assert.deepStrictEqual(ready, { wrap: ['py', '--'], policy: 'p.json', pid: 4242 });
    assert.strictEqual(seen.cmd, path.join('/f', '.venv', 'bin', 'python'));
    assert.deepStrictEqual(seen.args.slice(0, 4), ['-I', '-m', 'factory.sandbox.host', '--spec']);
    assert.strictEqual(seen.opts.detached, true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'host-spec.json'), 'utf8')), { run_id: 'pa-1' });

    const dead = () => ({ pid: 1, exitCode: 3, unref() {} });
    await assert.rejects(S.start({ factoryPath: '/f', spec: {}, stateDir: dir, spawnFn: dead, platformId: 'posix' }), /exited \(3\)/);
    console.log('sandbox.test.js ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
