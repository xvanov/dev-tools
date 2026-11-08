'use strict';

// The compiled jarvisd as its own supervisor (plan 4.4): `jarvisd supervise`
// owns the port and runs generations of the same executable (`jarvisd
// generation`), here with the supervisor's fixture worker standing in for the
// PA (PA_GENERATION_MODULE). Start, roll, rollback, the deploy lock, a roll to
// the executable jarvisd/dist/current points at, and no generation outliving
// its supervisor.
//
// Needs a built binary: PA_JARVISD_EXE=<jarvisd/dist/jarvisd[.exe]> (CI's
// jarvisd job sets it after `node scripts/build.js --only jarvisd`). Without
// it the test says so and passes: a stale binary from an older checkout would
// test the wrong supervisor.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { request } = require('../src/supervisor');

const EXE = process.env.PA_JARVISD_EXE;
if (!EXE) {
  console.log('supervisorBinary: PA_JARVISD_EXE not set (build jarvisd and point it there) - skipped');
  process.exit(0);
}

// Windows paths compare without case (process.execPath may differ from ours).
const samePath = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const version = (port) =>
  new Promise((resolve, reject) =>
    http.get({ host: '127.0.0.1', port, path: '/api/version' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(JSON.parse(b).commit));
    }).on('error', reject)
  );

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-supbin-'));
  // Two copies of the executable in a dist of its own: the supervisor runs the
  // first; a deploy points `current` at the second.
  const ext = process.platform === 'win32' ? '.exe' : '';
  const bin = path.join(dir, 'dist');
  fs.mkdirSync(bin);
  const a = path.join(bin, `jarvisd${ext}`);
  const b = path.join(bin, `jarvisd-next${ext}`);
  fs.copyFileSync(EXE, a);
  fs.copyFileSync(EXE, b);
  if (process.platform !== 'win32') {
    fs.chmodSync(a, 0o755);
    fs.chmodSync(b, 0o755);
  }
  const port = await freePort();
  const control = process.platform === 'win32' ? `\\\\.\\pipe\\pa-supbin-${process.pid}-${Date.now()}` : path.join(dir, 'control.sock');
  const env = {
    ...process.env,
    PA_DISPATCH_PORT: String(port),
    PA_SUPERVISOR_CONTROL: control,
    PA_SUPERVISOR_LOG: path.join(dir, 'supervisor.log'),
    PA_GENERATION_MODULE: path.join(__dirname, 'fixtures', 'supervisorWorker.js'),
    DUMMY_DIR: dir,
  };
  delete env.PA_JARVISD_EXE; // the supervisor must find its generations itself
  delete env.PA_RUNTIME;
  const sup = spawn(a, ['supervise'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  sup.stdout.on('data', (c) => (out += c));
  sup.stderr.on('data', (c) => (out += c));
  const supExit = new Promise((r) => sup.once('exit', r));
  try {
    let st = null;
    for (let i = 0; i < 150 && !(st && st.generation); i++) {
      st = await request(control, { cmd: 'status' }, 1000).catch(() => null);
      if (!(st && st.generation)) await sleep(200);
    }
    assert.ok(st && st.generation === 1, `the compiled supervisor did not start a generation:\n${out}`);
    assert.strictEqual(st.runtime, 'jarvisd');
    assert.strictEqual(samePath(st.exe), samePath(a), 'a generation is this same executable');
    assert.match(st.source, /^[0-9a-f]{12}$/);
    const src = require('../src/supervisor').sourceHash(path.join(__dirname, '..', 'src', 'supervisor', 'index.ts'));
    assert.strictEqual(st.source, src, 'the embedded source hash is this checkout\'s supervisor');
    assert.strictEqual(await version(port), 'gen-1');
    const g1 = st.pid;

    // A roll: the next generation, the first kept as the standby.
    const r2 = await request(control, { cmd: 'roll' });
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    assert.strictEqual(r2.generation, 2);
    assert.strictEqual(r2.standby.pid, g1);
    assert.strictEqual(await version(port), 'gen-2');

    // Rollback to it.
    const back = await request(control, { cmd: 'rollback' });
    assert.strictEqual(back.ok, true, JSON.stringify(back));
    assert.strictEqual(back.pid, g1);

    // The deploy lock holds against anyone else.
    assert.strictEqual((await request(control, { cmd: 'lock', owner: 'deploy A' })).ok, true);
    const refused = await request(control, { cmd: 'roll' });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /refused: another deploy holds the supervisor/);
    await request(control, { cmd: 'unlock', owner: 'deploy A' });

    // A deploy points `current` at another executable: the next roll runs it.
    fs.writeFileSync(path.join(bin, 'current'), `jarvisd-next${ext}\n`);
    const r3 = await request(control, { cmd: 'roll' });
    assert.strictEqual(r3.ok, true, JSON.stringify(r3));
    assert.strictEqual(samePath(r3.exe), samePath(b), 'the roll ran the executable `current` names');

    // The supervisor goes: so do its generations.
    const pids = r3.generations.map((g) => g.pid);
    sup.kill();
    await supExit;
    for (let i = 0; i < 50 && pids.some(alive); i++) await sleep(100);
    for (const p of pids) assert.ok(!alive(p), `generation pid ${p} outlived its supervisor`);
    console.log(`supervisorBinary ok: ${path.basename(EXE)} supervised generations 1-3, rolled, rolled back and rolled to jarvisd-next`);
  } finally {
    if (sup.exitCode === null) sup.kill();
    await supExit;
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
