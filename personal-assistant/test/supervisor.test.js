'use strict';

// The zero-downtime supervisor (src/supervisor, docs/native/PLAN.md Z1):
// generations roll while clients hammer it, hold an event stream and a
// WebSocket, and not one request fails. Port 0, a temp dir and a private
// control socket, so it runs beside any other test and any live worker.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { createSupervisor, request } = require('../src/supervisor');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// What the test is doing, so a stall on a loaded machine says where instead of timing out blind.
let phase = 'start';
const WATCHDOG_MS = 150_000;
const watchdog = setTimeout(() => {
  console.error('supervisor.test.js: stalled for ' + WATCHDOG_MS / 1000 + ' s in phase: ' + phase);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-supervisor-'));
  const controlPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\pa-supervisor-test-${process.pid}-${Date.now()}`
    : path.join(dir, 'control.sock');
  const sup = createSupervisor({
    worker: path.join(__dirname, 'fixtures', 'supervisorWorker.js'),
    port: 0,
    controlPath,
    env: { DUMMY_DIR: dir },
    drainTimeoutMs: 30000,
    stopGraceMs: 10000,
    readyTimeoutMs: 60000,
    holdMs: 0, // no standby here: the rollback section below keeps one
    silent: true,
  });

  try {
    const first = await sup.start();
    assert.strictEqual(first.generation, 1);
    const port = first.port;
    assert.ok(port > 0);

    // ---- clients ----
    const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
    const call = (method, p, body) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: p, agent, headers: body ? { 'Content-Type': 'text/plain' } : {} }, (res) => {
          let b = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (b += c));
          res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(b)) : reject(new Error(`${p}: HTTP ${res.statusCode} ${b}`))));
          res.on('error', reject);
        });
        req.on('error', reject);
        // A request that is never answered must fail with its name, not hang the file until the watchdog.
        req.setTimeout(20000, () => req.destroy(new Error(`${p}: no answer in 20 s (${method}, generation now ${sup.status().generation})`)));
        req.end(body);
      });

    let running = true;
    let ok = 0;
    const failures = [];
    const commits = new Set();
    const hammer = async (i) => {
      for (let k = 0; running; k++) {
        try {
          const r = k % 3 === 0 ? await call('GET', '/api/version')
            : k % 3 === 1 ? await call('GET', '/api/slow?ms=120')
            : await call('POST', '/api/echo', `hello ${i}/${k}`);
          if (k % 3 === 2) assert.strictEqual(r.body, `hello ${i}/${k}`);
          commits.add(r.commit);
          ok++;
        } catch (err) {
          failures.push(err.message);
        }
      }
    };
    const hammers = Array.from({ length: 8 }, (_, i) => hammer(i));

    // An event stream, reconnecting the way EventSource does: on a clean end,
    // again with Last-Event-ID. An error or a non-200 is a failure.
    const sse = { gens: new Set(), resumes: [], events: 0, connects: 0, lastId: null };
    const openStream = () => {
      if (!running) return;
      sse.connects++;
      const headers = sse.lastId ? { 'Last-Event-ID': sse.lastId } : {};
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers }, (res) => {
        if (res.statusCode !== 200) failures.push(`stream: HTTP ${res.statusCode}`);
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const id = /^id: (.*)$/m.exec(block);
            const data = /^data: (.*)$/m.exec(block);
            if (!data) continue;
            const d = JSON.parse(data[1]);
            if (/^event: hello$/m.test(block)) sse.resumes.push({ sent: headers['Last-Event-ID'] || null, seen: d.lastEventId });
            else {
              sse.events++;
              sse.gens.add(d.gen);
            }
            if (id) sse.lastId = id[1];
          }
        });
        res.on('end', () => setTimeout(openStream, 20));
        res.on('error', (err) => failures.push(`stream: ${err.message}`));
      });
      req.on('error', (err) => failures.push(`stream: ${err.message}`));
    };
    openStream();

    // A WebSocket through the Upgrade pass-through, reconnecting on close.
    const wsSeen = new Set();
    let wsOpen = 0;
    const openWs = () => {
      if (!running) return;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      let t;
      ws.on('open', () => {
        wsOpen++;
        t = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 40);
      });
      ws.on('message', (m) => wsSeen.add(String(m).split(':')[0]));
      ws.on('close', () => {
        clearInterval(t);
        setTimeout(openWs, 20);
      });
      ws.on('error', (err) => failures.push(`ws: ${err.message}`));
    };
    openWs();

    await sleep(400);

    // A request in flight at the flip finishes on the generation it started on.
    const slow = call('GET', '/api/slow?ms=1500');
    await sleep(50);

    phase = 'rolls';
    // ---- three rolls through the control socket ----
    const pids = [];
    for (let n = 2; n <= 4; n++) {
      const before = sup.status();
      pids.push(before.pid);
      const r = await request(controlPath, { cmd: 'roll' });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.generation, n);
      assert.notStrictEqual(r.pid, before.pid);
      assert.ok(!alive(before.pid), `generation ${n - 1} (pid ${before.pid}) still runs after the roll`);
      await sleep(300);
    }
    assert.strictEqual((await slow).commit, 'gen-1', 'the in-flight request was cut or moved');

    phase = 'never-ready generation';
    // ---- a generation that never gets ready: the old one keeps serving ----
    fs.writeFileSync(path.join(dir, 'fail-next'), '');
    const bad = await request(controlPath, { cmd: 'roll' });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /did not become ready/);
    assert.strictEqual(bad.generation, 4);
    assert.strictEqual((await call('GET', '/api/version')).commit, 'gen-4');

    // ---- status ----
    const st = await request(controlPath, { cmd: 'status' });
    assert.strictEqual(st.generation, 4);
    assert.strictEqual(st.generations.length, 1);

    await sleep(300);
    running = false;
    phase = 'waiting for the clients to finish';
    await Promise.all(hammers);

    assert.deepStrictEqual(failures, [], `failed requests during rolls:\n${failures.slice(0, 10).join('\n')}`);
    assert.ok(ok > 20, `only ${ok} requests made`); // volume depends on the machine; the claim is that none failed
    for (const g of ['gen-1', 'gen-2', 'gen-3', 'gen-4']) assert.ok(commits.has(g), `no request served by ${g}: ${[...commits]}`);
    // The stream followed every roll and resumed from the last id it had.
    assert.ok(sse.connects >= 4, `stream connected ${sse.connects} times`);
    assert.ok(sse.gens.has('4'), `stream never reached generation 4: ${[...sse.gens]}`);
    for (const r of sse.resumes) assert.strictEqual(r.seen, r.sent, 'Last-Event-ID did not reach the worker');
    assert.ok(wsOpen >= 4 && wsSeen.has('gen-4'), `websocket: ${wsOpen} opens, saw ${[...wsSeen]}`);

    phase = 'crash replacement';
    // ---- the serving generation crashes: a new one replaces it ----
    const dead = sup.status().pid;
    process.kill(dead);
    for (let i = 0; i < 300 && (sup.status().generation === 4 || !sup.status().pid || sup.status().pid === dead); i++) await sleep(100);
    await sleep(100);
    assert.strictEqual((await call('GET', '/api/version')).commit, `gen-${sup.status().generation}`);
    assert.ok(sup.status().generation > 4);

    agent.destroy();
    // (Each retired pid was checked dead right after its roll. Checking again here is unsound: Windows
    // reuses pids within seconds, and a reused one reads as "alive".)
    void pids;
    console.log(`supervisor ok: ${ok} requests, 0 failed, ${sse.events} stream events over ${sse.connects} connections, ${wsOpen} websocket opens`);
  } finally {
    const last = sup.status().generations.map((g) => g.pid);
    await sup.close();
    for (const p of last) assert.ok(!alive(p), `pid ${p} outlived the supervisor`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- rollback (Z4): the replaced generation is kept, drained, and comes back ----
  phase = 'rollback';
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-supervisor-rb-'));
    const cp2 = process.platform === 'win32'
      ? `\\\\.\\pipe\\pa-supervisor-test-rb-${process.pid}-${Date.now()}`
      : path.join(dir2, 'control.sock');
    const sup2 = createSupervisor({
      worker: path.join(__dirname, 'fixtures', 'supervisorWorker.js'),
      port: 0,
      controlPath: cp2,
      env: { DUMMY_DIR: dir2, KEEPALIVE_MS: '300' },
      drainTimeoutMs: 10000,
      stopGraceMs: 10000,
      readyTimeoutMs: 60000,
      holdMs: 6000, // the steps up to the expiry check must finish inside it, even on a loaded machine
      silent: true,
    });
    const version = (port) =>
      new Promise((resolve, reject) =>
        http.get({ host: '127.0.0.1', port, path: '/api/version' }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(JSON.parse(b).commit));
        }).on('error', reject)
      );
    try {
      const s1 = await sup2.start();
      const g1pid = s1.pid;

      // The worker closes idle keep-alive sockets (300 ms here, 5 s for real)
      // while the supervisor's pool still holds them: a GET that lands on one
      // is resent, never a 502 (found on the first live deploy).
      for (let i = 0; i < 12; i++) {
        assert.strictEqual(await version(s1.port), 'gen-1');
        await sleep(280 + (i % 4) * 15);
      }
      const nothing = await request(cp2, { cmd: 'rollback' });
      assert.strictEqual(nothing.ok, false, 'no standby before the first roll');

      const r2 = await request(cp2, { cmd: 'roll' });
      assert.strictEqual(r2.generation, 2);
      assert.deepStrictEqual(r2.standby, { generation: 1, pid: g1pid });
      assert.ok(alive(g1pid), 'generation 1 is kept for a rollback');
      assert.strictEqual(await version(s1.port), 'gen-2');
      const g2pid = r2.pid;

      const back = await request(cp2, { cmd: 'rollback' });
      assert.strictEqual(back.ok, true, JSON.stringify(back));
      assert.strictEqual(back.generation, 1);
      assert.strictEqual(back.pid, g1pid, 'the same process serves again');
      assert.strictEqual(back.standby, null);
      assert.strictEqual(await version(s1.port), 'gen-1');
      for (let i = 0; i < 200 && alive(g2pid); i++) await sleep(100);
      assert.ok(!alive(g2pid), 'the rolled-back generation is stopped');

      // The serving generation dies with a standby kept: the standby serves.
      const r3 = await request(cp2, { cmd: 'roll' });
      assert.strictEqual(r3.standby.pid, g1pid);
      process.kill(r3.pid);
      for (let i = 0; i < 200 && sup2.status().pid !== g1pid; i++) await sleep(100);
      assert.strictEqual(sup2.status().pid, g1pid, 'a crash falls back to the standby');
      assert.strictEqual(await version(s1.port), 'gen-1');

      // The hold expires: the standby is stopped.
      const r4 = await request(cp2, { cmd: 'roll' });
      assert.ok(r4.standby);
      // Poll past the hold instead of sleeping a guessed time: stopping it takes longer on a loaded machine.      for (let i = 0; i < 300 && alive(r4.standby.pid); i++) await sleep(100);
      assert.ok(!alive(r4.standby.pid), 'the standby is stopped once its hold expires');
      assert.strictEqual(sup2.status().standby, null);
      assert.strictEqual((await request(cp2, { cmd: 'rollback' })).ok, false);
      assert.match(sup2.status().source, /^[0-9a-f]{12}$/);
      // The deploy lock: while one deploy holds it, another's roll, rollback
      // or lock is refused with who holds it; its own go through.
      const genBefore = sup2.status().generation;
      const held = await request(cp2, { cmd: 'lock', owner: 'deploy A' });
      assert.strictEqual(held.ok, true, JSON.stringify(held));
      assert.strictEqual(held.deployLock.owner, 'deploy A');
      for (const msg of [{ cmd: 'roll' }, { cmd: 'roll', owner: 'deploy B' }, { cmd: 'rollback', owner: 'deploy B' }, { cmd: 'lock', owner: 'deploy B' }]) {
        const r = await request(cp2, msg);
        assert.strictEqual(r.ok, false, `${JSON.stringify(msg)} went through a held lock`);
        assert.match(r.error, /refused: another deploy holds the supervisor \(deploy A/);
      }
      assert.strictEqual(sup2.status().generation, genBefore, 'a refused roll changed nothing');
      // Two rolls at once from the holder: the second is refused, not merged.
      const [ra, rb] = await Promise.all([request(cp2, { cmd: 'roll', owner: 'deploy A' }), request(cp2, { cmd: 'roll', owner: 'deploy A' })]);
      assert.deepStrictEqual([ra.ok, rb.ok].sort(), [false, true]);
      assert.match((ra.ok ? rb : ra).error, /a roll is already in progress/);
      assert.strictEqual((await request(cp2, { cmd: 'unlock', owner: 'deploy A' })).deployLock, null);
      // The lock expires: a deploy that died cannot wedge the supervisor.
      await request(cp2, { cmd: 'lock', owner: 'dead deploy', ttlMs: 1000 });
      await sleep(1200);
      assert.strictEqual(sup2.status().deployLock, null);
    } finally {
      const last = sup2.status().generations.map((g) => g.pid);
      await sup2.close();
      for (const p of last) assert.ok(!alive(p), `pid ${p} outlived the supervisor`);
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  }

  // ---- the real dashboard's /healthz: ready only once marked ----
  {
    const dash = require('../src/dashboard/server.ts');
    const server = await dash.start({ port: 0 });
    const p = server.address().port;
    const get = () =>
      new Promise((resolve, reject) =>
        http.get({ host: '127.0.0.1', port: p, path: '/healthz' }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
        }).on('error', reject)
      );
    assert.strictEqual((await get()).status, 503);
    dash.markReady();
    const r = await get();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ready, true);
    dash.markDraining();
    assert.strictEqual((await get()).status, 503);
    await new Promise((res) => server.close(res));
  }

  // The supervisor must not load worker code (it is what a deploy must not change).
  {
    // index.ts is the supervisor (plan 4.4); index.js only re-exports it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'supervisor', 'index.ts'), 'utf8');
    const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepStrictEqual(reqs.filter((r) => r.startsWith('.')), [], 'the supervisor requires local modules');
    const shim = fs.readFileSync(path.join(__dirname, '..', 'src', 'supervisor', 'index.js'), 'utf8');
    assert.deepStrictEqual([...shim.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]), ['./index.ts'], 'index.js is only the shim');
  }

  console.log('supervisor tests ok');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
