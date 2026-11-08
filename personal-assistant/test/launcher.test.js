'use strict';

// The service launchers (plan 4.4): windows/pa-launch.ps1 and linux/pa-launch.sh pick the
// supervisor PA_RUNTIME asks for, on every start. Dry runs against a throwaway repo tree
// (PA_LAUNCH_ROOT): the default is Node; jarvisd runs the executable jarvisd/dist/current
// names, else jarvisd/dist/jarvisd[.exe], else falls back to Node, saying so; the
// environment beats .env. Each script runs where its shell exists (sh via Git for Windows).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensurePosixTools } = require('./_portable');

const PA = path.join(__dirname, '..');
const WIN = process.platform === 'win32';

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-launch-'));
  fs.mkdirSync(path.join(root, 'personal-assistant'), { recursive: true });
  fs.mkdirSync(path.join(root, 'jarvisd', 'dist'), { recursive: true });
  return root;
}
// A stand-in executable: sh's -x test needs a shebang (Git for Windows) or the mode bit.
function exe(root, name) {
  const f = path.join(root, 'jarvisd', 'dist', name);
  fs.writeFileSync(f, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return f;
}

const launchers = [];
if (WIN) {
  launchers.push({
    name: 'pa-launch.ps1',
    run: (env) => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PA, 'windows', 'pa-launch.ps1'), '-DryRun'], { encoding: 'utf8', env, windowsHide: true }),
    exeName: 'jarvisd.exe',
  });
}
if (ensurePosixTools()) {
  launchers.push({
    name: 'pa-launch.sh',
    run: (env) => spawnSync('sh', [path.join(PA, 'linux', 'pa-launch.sh').replace(/\\/g, '/'), '--dry-run'], { encoding: 'utf8', env, windowsHide: true }),
    exeName: 'jarvisd',
  });
}
assert.ok(launchers.length, 'no shell to run a launcher with');

const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();

for (const l of launchers) {
  const root = tree();
  try {
    const env = { ...process.env, PA_LAUNCH_ROOT: root };
    delete env.PA_RUNTIME;
    const go = (extra = {}) => {
      const r = l.run({ ...env, ...extra });
      assert.strictEqual(r.status, 0, `${l.name}: ${r.stderr}`);
      return { out: r.stdout.trim(), err: r.stderr.trim() };
    };

    // No setting: Node.
    let r = go();
    assert.match(r.out, /runtime=node .*command=.*node(\.exe)?"? src[\\/]supervisor$/i, `${l.name}: ${r.out}`);

    // jarvisd in .env, nothing built: Node, with a warning.
    fs.writeFileSync(path.join(root, 'personal-assistant', '.env'), 'PA_DISPATCH_PORT=7300\nPA_RUNTIME=jarvisd\n');
    r = go();
    assert.match(r.out, /src[\\/]supervisor$/, `${l.name}: falls back to Node: ${r.out}`);
    assert.match(r.err + r.out, /no jarvisd executable/, `${l.name}: says why`);

    // The default build output.
    const built = exe(root, l.exeName);
    r = go();
    assert.ok(norm(r.out).endsWith(`${norm(built)} supervise`), `${l.name}: ${r.out}`);

    // `current` names the one a deploy built: it wins.
    const next = exe(root, l.exeName.replace('jarvisd', 'jarvisd-abc1234'));
    fs.writeFileSync(path.join(root, 'jarvisd', 'dist', 'current'), `${path.basename(next)}\n`);
    r = go();
    assert.ok(norm(r.out).endsWith(`${norm(next)} supervise`), `${l.name}: ${r.out}`);
    // ... unless the file it names is gone.
    fs.rmSync(next);
    r = go();
    assert.ok(norm(r.out).endsWith(`${norm(built)} supervise`), `${l.name}: a dangling pointer is ignored: ${r.out}`);

    // The environment beats .env: one setting rolls a switch back.
    r = go({ PA_RUNTIME: 'node' });
    assert.match(r.out, /runtime=node .*src[\\/]supervisor$/, `${l.name}: ${r.out}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(`launcher ok: ${launchers.map((l) => l.name).join(', ')}`);
