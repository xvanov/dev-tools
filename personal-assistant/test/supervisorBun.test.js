'use strict';

// Plan 4.1: the supervisor runs a generation under Bun (PA_RUNTIME=bun, jarvisd)
// over the same IPC protocol as a Node one: it gets ready, serves, rolls to the
// next Bun generation and drains the old one. The worker is the test fixture,
// so no Postgres. Skips where jarvisd's npm install (and so Bun) is missing.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createSupervisor, runtimeSpec } = require('../src/supervisor');

const BUN = path.join(__dirname, '..', '..', 'jarvisd', 'node_modules', 'bun', 'bin', 'bun.exe');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(b)) : reject(new Error(`${p}: ${res.statusCode}`))));
    }).on('error', reject);
  });
}

async function main() {
  // What PA_RUNTIME picks.
  assert.strictEqual(runtimeSpec('node').execPath, process.execPath);
  assert.match(runtimeSpec('node').worker, /worker\.js$/);
  if (!fs.existsSync(BUN)) {
    assert.throws(() => runtimeSpec('bun', { bun: '' }), /no Bun at/);
    console.log('SKIP supervisorBun: no Bun (npm ci in jarvisd/)');
    return;
  }
  const spec = runtimeSpec('bun');
  assert.deepStrictEqual([spec.runtime, path.basename(spec.worker), spec.execPath], ['bun', 'main.ts', BUN]);
  assert.throws(() => runtimeSpec('bun', { bun: path.join(os.tmpdir(), 'no-such-bun') }), /no Bun at/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-supervisor-bun-'));
  const controlPath = process.platform === 'win32' ? `\\\\.\\pipe\\pa-supervisor-bun-${process.pid}-${Date.now()}` : path.join(dir, 'control.sock');
  const sup = createSupervisor({
    runtime: { runtime: 'bun', worker: path.join(__dirname, 'fixtures', 'supervisorWorker.js'), execPath: BUN },
    port: 0,
    controlPath,
    env: { DUMMY_DIR: dir },
    readyTimeoutMs: 60000,
    drainTimeoutMs: 20000,
    stopGraceMs: 10000,
    holdMs: 0,
    silent: true,
  });
  try {
    const first = await sup.start();
    const v1 = await get(first.port, '/api/version');
    assert.strictEqual(v1.commit, 'gen-1');
    assert.strictEqual(sup.status().runtime, 'bun', 'status says what runs the generations');
    await sup.roll();
    const v2 = await get(first.port, '/api/version');
    assert.strictEqual(v2.commit, 'gen-2', 'rolled to the next Bun generation');
    assert.notStrictEqual(v2.pid, v1.pid);
  } finally {
    await sup.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('supervisorBun ok');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
