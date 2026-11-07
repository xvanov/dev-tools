'use strict';

// The supervisor: owns the dashboard's public port so the worker can be
// replaced without a moment where nothing answers (docs/native/PLAN.md, Z1).
//
//   client ──▶ supervisor 127.0.0.1:PA_DISPATCH_PORT ──▶ generation N on 127.0.0.1:<port 0>
//
// A roll spawns generation N+1 beside N, waits for its GET /healthz to say
// ready, flips routing, sends N `drain`, closes N's long-lived streams (SSE,
// WebSocket) so their clients reconnect — to N+1 — waits for N's ordinary
// in-flight requests (30 s at most), then sends `stop` and kills it if it
// lingers. A generation that never gets ready is killed and N keeps serving.
//
// Why a proxy and not socket handoff: Node cannot pass a listening socket
// between unrelated processes on Windows. A reverse proxy is portable, and the
// extra loopback hop costs well under a millisecond.
//
// Rules for this file: node builtins only, and it never requires worker code —
// it is the one process that must not change on a deploy, so it must not load
// what a deploy changes. It reads only PA_DISPATCH_PORT / PA_DISPATCH_HOST
// (from the environment, else the same `.env` files config.js reads).
//
// Worker protocol (src/worker.js, PA_SUPERVISED=1):
//   child → supervisor  {type: 'listening', port}   its private port
//   supervisor → child  {type: 'drain'}              routing has moved away
//   supervisor → child  {type: 'stop'}               exit now (in-flight done)
//   GET /healthz        200 {ready: true} once startup has completed
//
// Control (a deploy script, Z4): a local socket — a named pipe on Windows, a
// unix socket elsewhere — taking one JSON line, `{"cmd":"roll"}` or
// `{"cmd":"status"}`, and answering one JSON line. `node src/supervisor roll`.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');

const DEFAULT_PORT = 7300;
const DRAIN_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 180_000;
const STOP_GRACE_MS = 10_000;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

function log(level, message, fields) {
  const line = [new Date().toISOString(), level.toUpperCase().padEnd(5), '[supervisor]', message, fields ? JSON.stringify(fields) : ''].join(' ').trimEnd();
  (level === 'info' ? process.stdout : process.stderr).write(line + '\n');
}

// PA_DISPATCH_* without loading config.js: real env, then the tool's .env,
// then the repo root's (config.js's precedence).
function envSetting(name, fallback) {
  if (process.env[name]) return process.env[name];
  const toolDir = path.join(__dirname, '..', '..');
  for (const file of [path.join(toolDir, '.env'), path.join(toolDir, '..', '.env')]) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\\r\\n#]*)`, 'm'));
      if (m && m[1].trim()) return m[1].trim();
    } catch {
      /* no such file */
    }
  }
  return fallback;
}

function defaultControlPath(port) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\pa-supervisor-${port}`
    : path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `pa-supervisor-${port}.sock`);
}

function probe(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let j = {};
        try {
          j = JSON.parse(body);
        } catch {
          /* not JSON: not ready */
        }
        resolve(res.statusCode === 200 && j.ready === true);
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createSupervisor({
  worker = path.join(__dirname, '..', 'worker.js'),
  port = Number(envSetting('PA_DISPATCH_PORT', DEFAULT_PORT)),
  host = envSetting('PA_DISPATCH_HOST', '127.0.0.1'),
  controlPath,
  env = {},
  readyTimeoutMs = READY_TIMEOUT_MS,
  drainTimeoutMs = DRAIN_TIMEOUT_MS,
  stopGraceMs = STOP_GRACE_MS,
  respawn = true,
  silent = false,
} = {}) {
  const say = silent ? () => {} : log;
  let seq = 0;
  let current = null; // the generation routing points at
  let rolling = null; // the roll in progress, a promise
  let closing = false;
  let crashes = 0;
  const gens = new Set();

  // ---- generations ----

  function spawnGeneration() {
    const n = ++seq;
    const child = fork(worker, [], {
      cwd: path.dirname(worker),
      env: { ...process.env, ...env, PA_SUPERVISED: '1', PA_SUPERVISOR_GENERATION: String(n) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    const gen = {
      n,
      child,
      pid: child.pid,
      port: null,
      inflight: 0,
      streams: new Set(),
      agent: new http.Agent({ keepAlive: true }),
      exited: false,
      startedAt: Date.now(),
      onIdle: null,
    };
    gen.exit = new Promise((resolve) => child.once('exit', (code, signal) => {
      gen.exited = true;
      gen.agent.destroy();
      gens.delete(gen);
      resolve({ code, signal });
      if (gen === current && !closing) {
        current = null;
        say('warn', 'serving generation exited', { generation: n, code, signal });
        if (respawn) setTimeout(() => roll().catch(() => {}), Math.min(60_000, 1000 * 2 ** Math.min(crashes++, 6)));
      }
    }));
    child.on('message', (m) => {
      if (m && m.type === 'listening' && Number.isInteger(m.port)) gen.port = m.port;
    });
    child.on('error', (err) => say('warn', 'generation error', { generation: n, message: err.message }));
    gens.add(gen);
    say('info', 'spawned generation', { generation: n, pid: child.pid });
    return gen;
  }

  async function waitReady(gen) {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline && !gen.exited) {
      if (gen.port && (await probe(gen.port))) return true;
      await sleep(gen.port ? 200 : 100);
    }
    return false;
  }

  function send(gen, msg) {
    try {
      if (gen.child.connected) gen.child.send(msg);
    } catch {
      /* already gone */
    }
  }

  async function stopGeneration(gen) {
    if (gen.exited) return;
    send(gen, { type: 'stop' });
    const t = setTimeout(() => gen.child.kill(), stopGraceMs);
    await gen.exit;
    clearTimeout(t);
  }

  // Routing has moved off `gen`: end its streams (their clients reconnect and
  // land on the new one), wait for the rest of its requests, then stop it.
  async function retire(gen) {
    send(gen, { type: 'drain' });
    for (const end of gen.streams) end();
    if (gen.inflight > 0) {
      await Promise.race([new Promise((r) => (gen.onIdle = r)), sleep(drainTimeoutMs)]);
      if (gen.inflight > 0) say('warn', 'drain timed out', { generation: gen.n, inflight: gen.inflight });
    }
    // A request in flight at the flip may have turned into a stream since.
    for (const end of gen.streams) end();
    await stopGeneration(gen);
    say('info', 'retired generation', { generation: gen.n });
  }

  // Start N+1, flip to it once ready, retire N. One roll at a time; a roll
  // asked for during one shares its result.
  function roll() {
    if (closing) return Promise.reject(new Error('supervisor is closing'));
    if (rolling) return rolling;
    rolling = (async () => {
      const next = spawnGeneration();
      const ready = await waitReady(next);
      if (!ready) {
        say('warn', 'generation never became ready', { generation: next.n, exited: next.exited });
        await stopGeneration(next);
        throw new Error(`generation ${next.n} did not become ready${next.exited ? ' (it exited)' : ''}`);
      }
      const prev = current;
      current = next;
      crashes = 0;
      say('info', 'routing to generation', { generation: next.n, port: next.port, previous: prev ? prev.n : null });
      if (prev) await retire(prev);
    })()
      .finally(() => {
        rolling = null;
      })
      .then(() => status());
    return rolling;
  }

  function status() {
    return {
      ok: true,
      port: publicPort(),
      generation: current ? current.n : null,
      pid: current ? current.pid : null,
      workerPort: current ? current.port : null,
      rolling: !!rolling,
      generations: [...gens].map((g) => ({ n: g.n, pid: g.pid, port: g.port, inflight: g.inflight, streams: g.streams.size })),
    };
  }

  // ---- the proxy ----

  function done(gen) {
    gen.inflight--;
    if (gen.inflight === 0 && gen.onIdle) gen.onIdle();
  }

  function forwardHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
    return out;
  }

  const server = http.createServer((req, res) => {
    const gen = current;
    if (!gen) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      return res.end(JSON.stringify({ error: 'starting' }));
    }
    // 'request' (holds the drain) → 'stream' (does not) → 'done'.
    let state = 'request';
    let endStream = null;
    gen.inflight++;
    const release = () => {
      if (state === 'request') done(gen);
      else if (state === 'stream') gen.streams.delete(endStream);
      state = 'done';
    };
    const upstream = http.request(
      { host: '127.0.0.1', port: gen.port, method: req.method, path: req.url, headers: forwardHeaders(req.headers), agent: gen.agent },
      (ures) => {
        res.writeHead(ures.statusCode, ures.statusMessage, forwardHeaders(ures.headers));
        res.flushHeaders();
        // An event stream never finishes by itself, so it must not hold a
        // drain: retire() ends it cleanly and the client's reconnect (with
        // Last-Event-ID) lands on the new generation.
        if (state === 'request' && /^text\/event-stream/i.test(String(ures.headers['content-type'] || ''))) {
          done(gen);
          state = 'stream';
          endStream = () => {
            release();
            ures.unpipe(res);
            res.end();
            upstream.destroy();
          };
          gen.streams.add(endStream);
        }
        ures.on('error', () => state !== 'done' && res.destroy());
        ures.pipe(res);
      }
    );
    upstream.on('error', (err) => {
      if (state === 'done') return;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'worker unreachable', message: err.message }));
      } else res.destroy();
      release();
    });
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
      release();
    });
    req.pipe(upstream);
  });
  // WebSocket (and any other Upgrade): a byte pipe to the generation. It is a
  // stream: a roll closes it and the client reconnects.
  server.on('upgrade', (req, socket, head) => {
    const gen = current;
    if (!gen) return socket.destroy();
    const up = net.connect(gen.port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => {
      gen.streams.delete(end);
      socket.end();
      up.end();
    };
    gen.streams.add(end);
    const gone = () => {
      gen.streams.delete(end);
      socket.destroy();
      up.destroy();
    };
    up.on('error', gone);
    socket.on('error', gone);
    up.on('close', gone);
    socket.on('close', gone);
  });
  server.keepAliveTimeout = 5000;

  function publicPort() {
    const a = server.address();
    return a && typeof a === 'object' ? a.port : port;
  }

  // ---- control ----

  let control = null;
  let controlFile = null;

  function serveControl(where) {
    return new Promise((resolve, reject) => {
      control = net.createServer((sock) => {
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('error', () => {});
        sock.on('data', async (chunk) => {
          buf += chunk;
          const nl = buf.indexOf('\n');
          if (nl < 0) return;
          let cmd;
          try {
            cmd = JSON.parse(buf.slice(0, nl)).cmd;
          } catch {
            return sock.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n');
          }
          let reply;
          try {
            if (cmd === 'roll') reply = await roll();
            else if (cmd === 'status') reply = status();
            else reply = { ok: false, error: `unknown command ${cmd}` };
          } catch (err) {
            reply = { ...status(), ok: false, error: err.message };
          }
          sock.end(JSON.stringify(reply) + '\n');
        });
      });
      control.once('error', reject);
      control.listen(where, () => resolve(where));
    });
  }

  async function start() {
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new Error(`refusing to bind ${host}: loopback only`);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const where = controlPath || defaultControlPath(publicPort());
    if (process.platform !== 'win32') {
      // A socket file left by a killed supervisor: remove it, unless one answers.
      if (fs.existsSync(where) && !(await request(where, { cmd: 'status' }, 1000).then(() => true, () => false))) fs.unlinkSync(where);
      controlFile = where;
    }
    await serveControl(where);
    say('info', 'listening', { url: `http://${host}:${publicPort()}/`, control: where });
    await roll();
    return status();
  }

  async function close() {
    closing = true;
    await new Promise((r) => {
      server.close(r);
      server.closeAllConnections();
    });
    if (control) await new Promise((r) => control.close(r));
    if (controlFile) fs.rmSync(controlFile, { force: true });
    await Promise.all([...gens].map((g) => stopGeneration(g)));
  }

  return { start, roll, status, close, server, controlPath: () => (control ? control.address() : null) };
}

// One JSON line to a supervisor's control socket; resolves with its answer.
function request(where, msg, timeoutMs = READY_TIMEOUT_MS + DRAIN_TIMEOUT_MS + STOP_GRACE_MS + 10_000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(where);
    let buf = '';
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error('supervisor did not answer'));
    }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
    sock.on('data', (c) => (buf += c));
    sock.on('end', () => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error('bad answer from supervisor'));
      }
    });
    sock.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

async function cli(argv) {
  const cmd = argv[0] || 'run';
  const port = Number(envSetting('PA_DISPATCH_PORT', DEFAULT_PORT));
  if (cmd === 'roll' || cmd === 'status') {
    const r = await request(defaultControlPath(port), { cmd });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd !== 'run') {
    process.stderr.write('usage: node src/supervisor [run | roll | status]\n');
    process.exit(2);
  }
  const sup = createSupervisor();
  const stop = async (signal) => {
    log('info', 'stopping', { signal });
    await sup.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  if (process.platform !== 'win32') process.on('SIGHUP', () => sup.roll().catch((err) => log('warn', 'roll failed', { message: err.message })));
  await sup.start();
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch((err) => {
    log('error', 'supervisor failed', { message: err.message });
    process.exit(1);
  });
}

module.exports = { createSupervisor, request, defaultControlPath, probe };
