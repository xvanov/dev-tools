'use strict';

// A throwaway two-tier termhub for tests: sessiond and a front, each its own
// process (as in production, where the updater swaps the front and leaves
// sessiond and its PTYs alone), on free loopback ports, with a temp data dir.
// Used by test/frontSwap.test.js (plan Z5) and by the PA's deploy test
// (personal-assistant/src/e2e/deployTest.js, Z6). Not a test file itself.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// tls: true speaks HTTPS (a Linux termhub serves TLS on its tailnet port); the
// certificate is verified as usual — NODE_EXTRA_CA_CERTS adds a private CA.
function getJson(port, p, { method = 'GET', body, timeoutMs = 10_000, host = '127.0.0.1', tls = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = (tls ? https : http).request({
      host, port, path: p, method, timeout: timeoutMs,
      headers: { 'X-Termhub': '1', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: j, text: b });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

async function waitFor(fn, timeoutMs = 20_000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function proc(code, env) {
  const child = spawn(process.execPath, ['-e', code], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  child.output = () => out;
  child.exited = new Promise((r) => child.once('exit', r));
  return child;
}

// jarvisd's front role from source, under the pinned Bun (jarvisd/package.json).
function jarvisdFront(port, sessiondPort, env) {
  const jd = path.join(ROOT, '..', 'jarvisd');
  const bun = path.join(jd, 'node_modules', 'bun', 'bin', 'bun.exe');
  const child = spawn(bun, [path.join(jd, 'src', 'main.ts'), 'front', '--port', String(port), '--sessiond-port', String(sessiondPort), '--host', '127.0.0.1'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  child.output = () => out;
  child.exited = new Promise((r) => child.once('exit', r));
  return child;
}

async function startSpareTermhub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-spare-'));
  const env = { ...process.env, TERMHUB_DATA_DIR: dir };
  delete env.TERMHUB_BIND;
  const sessiondPort = await freePort();
  const sessiond = proc(`require('./sessiond').startSessiond({ port: ${sessiondPort}, entry: 'sessiond' })`, env);
  await waitFor(async () => (await getJson(sessiondPort, '/api/ping')).status === 200, 60_000, 'sessiond');

  const fronts = [];
  async function startFront() {
    const port = await freePort();
    // TERMHUB_FRONT_JARVISD=1: the front runs in jarvisd under Bun (plan 4.1); sessiond stays on Node.
    const front = process.env.TERMHUB_FRONT_JARVISD === '1'
      ? jarvisdFront(port, sessiondPort, env)
      : proc(`require('./front').startFront({ port: ${port}, sessiondPort: ${sessiondPort}, host: '127.0.0.1' })`, env);
    front.port = port;
    await waitFor(async () => (await getJson(port, '/api/health')).status === 200, 60_000, 'front');
    fronts.push(front);
    return front;
  }

  async function stopFront(front) {
    front.kill();
    await front.exited;
  }

  // A script that prints `tick 1` … `tick n`, one every `everyMs`: the long
  // command a session runs while things around it restart.
  function counterCommand(n, everyMs = 100) {
    const script = path.join(dir, 'counter.js');
    fs.writeFileSync(script, `let i = 0; const t = setInterval(() => { console.log('tick ' + (++i)); if (i >= ${n}) { clearInterval(t); console.log('counter done'); } }, ${everyMs});\n`);
    return `node "${script}"`;
  }

  async function close() {
    for (const f of fronts) f.kill();
    sessiond.kill();
    await Promise.all([sessiond.exited, ...fronts.map((f) => f.exited)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { dir, sessiondPort, sessiond, startFront, stopFront, counterCommand, close, getJson };
}

// A terminal client: one WebSocket on a session, everything it is sent, and
// the `tick N` numbers seen in it (ANSI and CR stripped).
function watchTerminal(WebSocket, url) {
  const ws = new WebSocket(url);
  const t = { ws, text: '', replays: 0, outputs: 0, closed: false, exit: null, error: null };
  t.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'replay') {
      t.replays++;
      t.text += m.data || '';
    } else if (m.type === 'output') {
      t.outputs++;
      t.text += m.data || '';
    } else if (m.type === 'exit') t.exit = m.code;
  });
  ws.on('close', () => (t.closed = true));
  ws.on('error', (e) => (t.error = e.message));
  t.ticks = () => ticksIn(t.text);
  t.close = () => new Promise((r) => {
    if (ws.readyState === WebSocket.CLOSED) return r();
    ws.once('close', r);
    ws.close();
  });
  return t;
}

/** The distinct `tick N` numbers in terminal text, in order of first sight. */
function ticksIn(text) {
  const plain = String(text).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  const seen = new Set();
  for (const m of plain.matchAll(/tick (\d+)/g)) seen.add(Number(m[1]));
  return [...seen];
}

/** Pure: the numbers 1..max that are missing from `ticks`. */
function missingTicks(ticks, max) {
  const have = new Set(ticks);
  const out = [];
  for (let i = 1; i <= max; i++) if (!have.has(i)) out.push(i);
  return out;
}

module.exports = { startSpareTermhub, freePort, getJson, waitFor, watchTerminal, ticksIn, missingTicks };
