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
    drainTimeoutMs: 5000,
    stopGraceMs: 3000,
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
    await Promise.all(hammers);

    assert.deepStrictEqual(failures, [], `failed requests during rolls:\n${failures.slice(0, 10).join('\n')}`);
    assert.ok(ok > 100, `only ${ok} requests made`);
    for (const g of ['gen-1', 'gen-2', 'gen-3', 'gen-4']) assert.ok(commits.has(g), `no request served by ${g}: ${[...commits]}`);
    // The stream followed every roll and resumed from the last id it had.
    assert.ok(sse.connects >= 4, `stream connected ${sse.connects} times`);
    assert.ok(sse.gens.has('4'), `stream never reached generation 4: ${[...sse.gens]}`);
    for (const r of sse.resumes) assert.strictEqual(r.seen, r.sent, 'Last-Event-ID did not reach the worker');
    assert.ok(wsOpen >= 4 && wsSeen.has('gen-4'), `websocket: ${wsOpen} opens, saw ${[...wsSeen]}`);

    // ---- the serving generation crashes: a new one replaces it ----
    const dead = sup.status().pid;
    process.kill(dead);
    for (let i = 0; i < 100 && (sup.status().generation === 4 || !sup.status().pid || sup.status().pid === dead); i++) await sleep(100);
    await sleep(100);
    assert.strictEqual((await call('GET', '/api/version')).commit, `gen-${sup.status().generation}`);
    assert.ok(sup.status().generation > 4);

    agent.destroy();
    for (const p of pids) assert.ok(!alive(p));
    console.log(`supervisor ok: ${ok} requests, 0 failed, ${sse.events} stream events over ${sse.connects} connections, ${wsOpen} websocket opens`);
  } finally {
    const last = sup.status().generations.map((g) => g.pid);
    await sup.close();
    for (const p of last) assert.ok(!alive(p), `pid ${p} outlived the supervisor`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- the real dashboard's /healthz: ready only once marked ----
  {
    const dash = require('../src/dashboard/server');
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
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'supervisor', 'index.js'), 'utf8');
    const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepStrictEqual(reqs.filter((r) => r.startsWith('.')), [], 'the supervisor requires local modules');
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
