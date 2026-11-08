'use strict';

// The deploy test (docs/native/PLAN.md, Z6): while a real roll happens, hammer
// the dashboard, hold an event stream and a terminal, and prove nothing broke:
//
//   requests   N loops of GET /api/version — zero failures allowed
//   events     GET /api/events?topics=deploytest, reconnecting with
//              Last-Event-ID the way EventSource does, while a producer emits
//              numbered events — every one received exactly once, in order,
//              and no `resync` (a resync is a client told it lost events)
//   terminal   a termhub session printing `tick N`, one WebSocket on it — the
//              socket never drops and no tick goes missing
//
//   node src/e2e/deployTest.js                  spare: a supervisor on a free port with
//                                               test/fixtures/deployWorker.js (no
//                                               Postgres), a throwaway termhub; CI-safe
//   node src/e2e/deployTest.js --live           the running stack: PA on
//        [--pa http://127.0.0.1:7300]           PA_DISPATCH_PORT, termhub on :7000; events
//        [--termhub http://127.0.0.1:7000]      via pg_notify with pa_event_seq (sql/035);
//        [--deploy [-- <deploy.js args>]]       the roll is the control socket's, or with
//                                               --deploy a real `src/supervisor/deploy.js`
//   --rolls N (spare, default 2)  --json  --no-terminal
//
// Exit 0 when every assertion holds; 1 otherwise, with the report.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PA_DIR = path.join(__dirname, '..', '..');
const TERMHUB_DIR = path.join(PA_DIR, '..', 'termhub');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);

function parseArgs(argv) {
  const o = { live: false, deploy: false, deployArgs: [], pa: null, termhub: null, rolls: 2, json: false, terminal: true, hammers: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      o.deployArgs = argv.slice(i + 1);
      break;
    }
    if (a === '--live') o.live = true;
    else if (a === '--deploy') o.deploy = true;
    else if (a === '--pa') o.pa = argv[++i];
    else if (a === '--termhub') o.termhub = argv[++i];
    else if (a === '--rolls') o.rolls = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--json') o.json = true;
    else if (a === '--no-terminal') o.terminal = false;
    else if (a === '--verbose') o.verbose = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

// ---- the three clients ----

function hammer(base, { loops = 4, timeoutMs = 10_000, onStuck = null } = {}) {
  const u = new URL(base);
  const agent = new http.Agent({ keepAlive: true, maxSockets: loops });
  const r = { ok: 0, failures: [], latencies: [], slow: [], stuck: [] };
  let running = true;
  const one = () =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const at = stamp();
      // A request still waiting after 3 s: what the supervisor holds then.
      const stuck = onStuck && setTimeout(() => r.stuck.push({ at, seen: onStuck() }), 3000);
      const req = http.get({ host: u.hostname, port: u.port, path: '/api/version', agent, timeout: timeoutMs }, (res) => {
        res.resume();
        res.on('end', () => {
          clearTimeout(stuck);
          const ms = Date.now() - t0;
          r.latencies.push(ms);
          if (ms > 2000) r.slow.push({ at, ms });
          if (res.statusCode === 200) r.ok++;
          else r.failures.push({ at, error: `HTTP ${res.statusCode}` });
          resolve();
        });
      });
      req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
      req.on('error', (e) => {
        clearTimeout(stuck);
        r.failures.push({ at, error: e.message });
        resolve();
      });
    });
  const loopsDone = Array.from({ length: loops }, async () => {
    while (running) {
      await one();
      await sleep(25);
    }
  });
  return {
    result: r,
    stop: async () => {
      running = false;
      await Promise.all(loopsDone);
      agent.destroy();
    },
  };
}

function sseClient(base, topic) {
  const u = new URL(base);
  const s = { received: [], ids: [], resyncs: 0, hellos: 0, connects: 0, failures: [], lastId: null };
  let helloed;
  s.ready = new Promise((r) => (helloed = r));
  let running = true;
  let req = null;
  const open = () => {
    if (!running) return;
    s.connects++;
    const headers = s.lastId ? { 'Last-Event-ID': s.lastId } : {};
    req = http.get({ host: u.hostname, port: u.port, path: `/api/events?topics=${topic}`, headers }, (res) => {
      if (res.statusCode !== 200) {
        s.failures.push({ at: stamp(), error: `HTTP ${res.statusCode}` });
        res.resume();
        return setTimeout(open, 200);
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c.replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /^id: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (!data) continue;
          let e;
          try {
            e = JSON.parse(data[1]);
          } catch {
            continue;
          }
          if (id) s.lastId = id[1];
          if (e.topic === 'resync') s.resyncs++;
          else if (e.topic === 'hello') {
            s.hellos++;
            helloed();
          }
          else if (e.topic === topic) {
            s.received.push(e.payload.n);
            s.ids.push(e.id);
          }
        }
      });
      // A clean end is a roll closing the stream: reconnect, like EventSource.
      res.on('end', () => setTimeout(open, 200));
      res.on('error', () => {});
    });
    req.on('error', (e) => {
      if (!running) return;
      s.failures.push({ at: stamp(), error: e.message });
      setTimeout(open, 500);
    });
  };
  open();
  return {
    result: s,
    stop: () => {
      running = false;
      if (req) req.destroy();
    },
  };
}

// ---- event producers ----

// Spare mode's stand-in for NOTIFY: a loopback feed every generation of
// test/fixtures/deployWorker.js listens to. A listener first gets
// {baseline: <last seq>}, then every event, in order — as each worker
// generation's LISTEN connection does.
async function feedProducer() {
  const listeners = new Set();
  let n = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ baseline: n }) + '\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/listen`,
    emit: async () => {
      n++;
      const line = JSON.stringify({ seq: n, topic: 'deploytest', n }) + '\n';
      for (const res of listeners) res.write(line);
      return n;
    },
    close: async () => {
      for (const res of listeners) res.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

async function pgProducer() {
  const { config } = require('../config');
  const { Client } = require('pg');
  const c = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10_000 });
  await c.connect();
  // As the row triggers do (sql/036): number the event, write it to the
  // outbox, NOTIFY — one transaction, so a generation that replays from the
  // outbox (plan 1.4) finds it. A stack without the outbox yet: NOTIFY only.
  const OUTBOX = `with s as (select nextval('pa_event_seq') as seq),
    o as (insert into event_outbox (seq, topic, payload) select seq, 'deploytest', jsonb_build_object('n', $1::int, 'seq', seq) from s returning seq)
    select pg_notify('pa_events', json_build_object('topic', 'deploytest', 'n', $1::int, 'seq', (select seq from o))::text)`;
  const NOTIFY_ONLY = "select pg_notify('pa_events', json_build_object('topic', 'deploytest', 'n', $1::int, 'seq', nextval('pa_event_seq'))::text)";
  let sql = OUTBOX;
  let n = 0;
  return {
    emit: async () => {
      n++;
      try {
        await c.query(sql, [n]);
      } catch (err) {
        if (sql !== OUTBOX || !/event_outbox/.test(err.message)) throw err;
        sql = NOTIFY_ONLY;
        await c.query(sql, [n]);
      }
      return n;
    },
    close: () => c.end(),
  };
}

// ---- the terminal ----

async function terminal({ spare, termhubBase, durationTicks }) {
  const th = require(path.join(TERMHUB_DIR, 'test', 'spareTermhub.js'));
  const WebSocket = require('ws');
  let port;
  let host = '127.0.0.1';
  let command;
  let cwd;
  let cleanup = async () => {};
  if (spare) {
    const s = await th.startSpareTermhub();
    const front = await s.startFront();
    port = front.port;
    command = s.counterCommand(durationTicks, 100);
    cwd = s.dir;
    cleanup = () => s.close();
  } else {
    const tu = new URL(termhubBase);
    port = Number(tu.port) || 80;
    host = tu.hostname;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-deploytest-'));
    const script = path.join(cwd, 'counter.js');
    fs.writeFileSync(script, `let i = 0; const t = setInterval(() => { console.log('tick ' + (++i)); if (i >= ${durationTicks}) { clearInterval(t); console.log('counter done'); } }, 100);\n`);
    command = `node "${script}"`;
    cleanup = async () => fs.rmSync(cwd, { recursive: true, force: true });
  }
  const created = await th.getJson(port, '/api/sessions', { host, method: 'POST', timeoutMs: 20_000, body: { command, cwd, title: 'deploy test (Z6)', cols: 100, rows: 40 } });
  if (created.status !== 201) throw new Error(`termhub would not start a session: ${created.status} ${created.text}`);
  const id = created.body.id;
  const t = th.watchTerminal(WebSocket, `ws://${host}:${port}/ws/term/${encodeURIComponent(id)}`);
  await t.opened;
  await th.waitFor(() => t.ticks().length >= 3, 30_000, 'the first ticks');
  return {
    t,
    report: () => {
      const ticks = t.ticks();
      const lo = Math.min(...ticks);
      const hi = Math.max(...ticks);
      const missing = [];
      const have = new Set(ticks);
      for (let i = lo; i <= hi; i++) if (!have.has(i)) missing.push(i);
      return { closed: t.closed, error: t.error, first: lo, last: hi, missing: missing.slice(0, 20), missingCount: missing.length };
    },
    stop: async () => {
      await t.close();
      await th.getJson(port, `/api/sessions/${encodeURIComponent(id)}`, { host, method: 'DELETE', timeoutMs: 20_000 }).catch(() => {});
      await cleanup();
    },
  };
}

// ---- rolls ----

function runDeploy(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PA_DIR, 'src', 'supervisor', 'deploy.js'), ...args], { cwd: PA_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('exit', (code) => resolve({ code, out: out.trim() }));
  });
}

// ---- the run ----

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Pure: the verdict over what the clients saw. */
function judge({ requests, events, produced, terminal: term }) {
  const problems = [];
  if (requests.failures.length) problems.push(`${requests.failures.length} failed request(s): ${requests.failures.slice(0, 5).map((f) => `${f.at} ${f.error}`).join('; ')}`);
  if (requests.ok < 50) problems.push(`only ${requests.ok} requests made`);
  const got = new Map();
  for (const n of events.received) got.set(n, (got.get(n) || 0) + 1);
  const missing = [];
  for (let n = 1; n <= produced; n++) if (!got.has(n)) missing.push(n);
  const dup = [...got].filter(([, c]) => c > 1).map(([n]) => n);
  const order = events.received.every((n, i) => i === 0 || n > events.received[i - 1]);
  if (missing.length) problems.push(`${missing.length} event(s) never arrived: ${missing.slice(0, 10).join(', ')}`);
  if (dup.length) problems.push(`${dup.length} event(s) arrived twice: ${dup.slice(0, 10).join(', ')}`);
  if (!order) problems.push('events arrived out of order');
  if (events.resyncs) problems.push(`${events.resyncs} resync(s): the client was told it lost events`);
  if (events.failures.length) problems.push(`${events.failures.length} event-stream connection failure(s): ${events.failures.slice(0, 3).map((f) => f.error).join('; ')}`);
  if (term) {
    if (term.closed) problems.push(`the terminal's socket dropped${term.error ? ` (${term.error})` : ''}`);
    if (term.missingCount) problems.push(`${term.missingCount} terminal tick(s) missing: ${term.missing.join(', ')}`);
  }
  return problems;
}

async function run(argv, { log = (m) => process.stderr.write(`[deploy-test ${stamp()}] ${m}\n`) } = {}) {
  const o = parseArgs(argv);
  const sup = require('../supervisor');
  let base;
  let producer;
  let roll;
  let teardown = async () => {};
  let statusFn = null;

  if (o.live) {
    const port = Number(sup.envSetting('PA_DISPATCH_PORT', sup.DEFAULT_PORT));
    base = o.pa || `http://127.0.0.1:${port}`;
    producer = await pgProducer();
    const control = sup.defaultControlPath(Number(new URL(base).port));
    roll = async () => {
      if (o.deploy) {
        const r = await runDeploy(o.deployArgs);
        return { ok: r.code === 0, detail: r.out };
      }
      const r = await sup.request(control, { cmd: 'roll' });
      return { ok: r.ok, detail: r.ok ? `generation ${r.generation}` : r.error };
    };
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-deploytest-'));
    producer = await feedProducer();
    const controlPath = process.platform === 'win32' ? `\\\\.\\pipe\\pa-deploytest-${process.pid}-${Date.now()}` : path.join(dir, 'control.sock');
    const s = sup.createSupervisor({
      worker: path.join(PA_DIR, 'test', 'fixtures', 'deployWorker.js'),
      port: 0,
      controlPath,
      env: { DEPLOY_FEED: producer.url },
      drainTimeoutMs: 5000,
      holdMs: 3000,
      stopGraceMs: 3000,
      silent: !o.verbose,
    });
    const st = await s.start();
    statusFn = () => s.status();
    base = `http://127.0.0.1:${st.port}`;
    roll = async () => {
      const r = await s.roll().catch((err) => ({ ok: false, error: err.message }));
      return { ok: r.ok, detail: r.ok ? `generation ${r.generation}` : r.error };
    };
    teardown = async () => {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
  }

  // This process's own stalls: a client that gets no CPU times requests out
  // that the server answered. Recorded so the report can tell them apart.
  const clientStalls = [];
  const lag = require('../util/lagWatch').watchLag({ log: { warn: (m, f) => clientStalls.push({ at: stamp(), ms: f.ms }) }, thresholdMs: 1000 });
  log(`${o.live ? 'live' : 'spare'} stack at ${base}`);
  const rollsPlanned = o.live ? 1 : o.rolls;
  let term = null;
  if (o.terminal) {
    try {
      term = await terminal({ spare: !o.live, termhubBase: o.termhub || 'http://127.0.0.1:7000', durationTicks: 6000 });
      log('terminal attached');
    } catch (err) {
      if (o.live) throw err;
      log(`terminal skipped: ${err.message}`);
    }
  }

  const h = hammer(base, { loops: o.hammers, onStuck: statusFn });
  const sse = sseClient(base, 'deploytest');
  // Subscribed before the first event, so event 1 is owed to it too.
  await Promise.race([sse.result.ready, sleep(10_000)]);
  let produced = 0;
  let producing = true;
  const producing$ = (async () => {
    while (producing) {
      produced = await producer.emit();
      await sleep(50);
    }
  })();

  const rolls = [];
  try {
    await sleep(3000);
    for (let i = 0; i < rollsPlanned; i++) {
      const t0 = Date.now();
      log(`roll ${i + 1}/${rollsPlanned}${o.deploy ? ' (deploy.js)' : ''}`);
      const r = await roll();
      rolls.push({ ...r, ms: Date.now() - t0 });
      log(`roll ${i + 1}: ${r.ok ? 'ok' : 'FAILED'} in ${Date.now() - t0} ms — ${String(r.detail).split('\n').pop()}`);
      await sleep(3000);
    }
    await sleep(2000);
  } finally {
    producing = false;
    await producing$;
    // Let the stream catch up with the last events.
    for (let i = 0; i < 50 && sse.result.received.length < produced; i++) await sleep(100);
    sse.stop();
    await h.stop();
    const termReport = term ? term.report() : null;
    if (term) await term.stop().catch(() => {});
    await producer.close().catch(() => {});
    await teardown();

    lag.stop();
    const lat = [...h.result.latencies].sort((a, b) => a - b);
    const report = {
      mode: o.live ? 'live' : 'spare',
      rolls,
      requests: { ok: h.result.ok, failed: h.result.failures.length, p50: percentile(lat, 50), p99: percentile(lat, 99), max: lat[lat.length - 1] ?? null, slow: h.result.slow.slice(0, 10), stuck: h.result.stuck.slice(0, 4), failures: h.result.failures.slice(0, 10) },
      events: { produced, received: sse.result.received.length, connects: sse.result.connects, resyncs: sse.result.resyncs, failures: sse.result.failures.slice(0, 10) },
      terminal: termReport,
      clientStalls,
    };
    const problems = judge({ requests: h.result, events: sse.result, produced, terminal: termReport });
    for (const r of rolls) if (!r.ok) problems.push(`a roll failed: ${r.detail}`);
    // A starved client times out requests the server answered: then this run
    // proves nothing either way, and says so instead of blaming the deploy.
    const starved = clientStalls.reduce((a, s) => a + s.ms, 0);
    if (starved > 2000) problems.push(`this test itself got no CPU for ${starved} ms in all (largest ${Math.max(...clientStalls.map((s) => s.ms))} ms): its timeouts are not evidence; rerun on a quieter machine`);
    report.ok = problems.length === 0;
    report.problems = problems;
    run.last = report;
  }
  return run.last;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  run(argv).then(
    (report) => {
      if (argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      else {
        const r = report;
        process.stdout.write(
          [
            `deploy test (${r.mode}): ${r.ok ? 'PASS' : 'FAIL'}`,
            `  rolls      ${r.rolls.map((x) => `${x.ok ? 'ok' : 'failed'} ${x.ms} ms`).join(', ')}`,
            `  requests   ${r.requests.ok} ok, ${r.requests.failed} failed; p50 ${r.requests.p50} ms, p99 ${r.requests.p99} ms, max ${r.requests.max} ms${r.requests.slow.length ? `; slow: ${r.requests.slow.map((s) => `${s.at} ${s.ms} ms`).join(', ')}` : ''}`,
            `  events     ${r.events.received}/${r.events.produced} received over ${r.events.connects} connection(s), ${r.events.resyncs} resync(s)`,
            `  terminal   ${r.terminal ? `ticks ${r.terminal.first}..${r.terminal.last}, ${r.terminal.missingCount} missing, socket ${r.terminal.closed ? 'DROPPED' : 'held'}` : 'not run'}`,
            ...r.problems.map((p) => `  PROBLEM    ${p}`),
          ].join('\n') + '\n'
        );
      }
      process.exit(report.ok ? 0 : 1);
    },
    (err) => {
      process.stderr.write(`deploy test failed to run: ${err.stack || err.message}\n`);
      process.exit(1);
    }
  );
}

module.exports = { run, judge, parseArgs };
