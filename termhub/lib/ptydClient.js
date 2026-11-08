'use strict';

// sessiond's PTY backend when TERMHUB_PTYD=1 (opt-in; plan 5.1): terminals live
// in ptyd, the Rust terminal host (../ptyd), instead of node-pty inside this
// process. sessiond keeps everything else it does (the screen mirror, voice,
// idle tracking, uploads, the archive) and talks to ptyd over the same session
// protocol it serves itself, which termhub/test/ptydConformance.test.js holds
// both to.
//
// What it buys: ptyd is its own process, so a sessiond restart no longer ends
// the terminals. On start, sessiond adopts the sessions ptyd still has
// (adoptSessions in sessiond.js) and their screens come back from ptyd's replay.
//
// RemotePty mimics the slice of node-pty's IPty that lib/session.js uses
// (onData, onExit, write, resize, kill, pid), so Session needs to know very
// little about where its PTY lives. Creation is asynchronous (an HTTP call)
// while node-pty's spawn is not: writes, resizes and notices made before ptyd
// has answered are queued and replayed in order.
//
// Environment:
//   TERMHUB_PTYD=1        use ptyd (anything else: node-pty, as before)
//   TERMHUB_PTYD_PORT     its loopback port (default 7020)
//   TERMHUB_PTYD_BIN      the binary to start when none answers (default:
//                         ../ptyd/target/release/ptyd[.exe], then debug)

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_PTYD_PORT = 7020;
const EXE = process.platform === 'win32' ? 'ptyd.exe' : 'ptyd';

function enabled(env = process.env) {
  return env.TERMHUB_PTYD === '1';
}

function port(env = process.env) {
  return Number(env.TERMHUB_PTYD_PORT) || DEFAULT_PTYD_PORT;
}

function request(method, p, body, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port(), path: p, method, timeout: timeoutMs,
      headers: { 'X-Termhub': '1', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`ptyd ${method} ${p} timed out`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function ping() {
  try {
    const r = await request('GET', '/api/ping', undefined, { timeoutMs: 1500 });
    return r.status === 200 && r.body && r.body.entry === 'ptyd' ? r.body : null;
  } catch {
    return null;
  }
}

function findBinary(env = process.env) {
  if (env.TERMHUB_PTYD_BIN) return env.TERMHUB_PTYD_BIN;
  for (const profile of ['release', 'debug']) {
    const p = path.join(__dirname, '..', '..', 'ptyd', 'target', profile, EXE);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Started detached so it outlives this sessiond: that is the point of it.
function launch(bin, logDir) {
  const args = ['--port', String(port())];
  let out = 'ignore';
  try {
    fs.mkdirSync(logDir, { recursive: true });
    out = fs.openSync(path.join(logDir, 'ptyd.out.log'), 'a');
  } catch { /* no log then */ }
  const child = spawn(bin, args, { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  return child.pid;
}

let readyPromise = null;

/**
 * Make sure a ptyd answers on TERMHUB_PTYD_PORT, starting one if it does not
 * and a binary is at hand. Resolves to its /api/ping body, or rejects. Every
 * RemotePty waits on this before its first request.
 */
function ensure({ logDir } = {}) {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    let live = await ping();
    if (live) return live;
    const bin = findBinary();
    if (!bin || !fs.existsSync(bin)) {
      throw new Error(`TERMHUB_PTYD=1 but nothing answers on 127.0.0.1:${port()} and no ptyd binary was found `
        + '(cargo build --release in ptyd/, or set TERMHUB_PTYD_BIN)');
    }
    launch(bin, logDir || path.join(require('./paths').dataDir(), 'logs'));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      live = await ping();
      if (live) return live;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`started ${bin} but it did not answer on 127.0.0.1:${port()}`);
  })();
  readyPromise.catch(() => {});
  return readyPromise;
}

/** Sessions ptyd currently hosts (for re-adoption after a sessiond restart). */
async function listSessions() {
  await ensure();
  const r = await request('GET', '/api/sessions');
  if (r.status !== 200 || !r.body) throw new Error(`ptyd list: ${r.status}`);
  return r.body.sessions || [];
}

class RemotePty {
  /**
   * @param {{id: string, create?: object}} opts  `create` is the POST body for a
   *   new session; without it, an existing ptyd session is adopted.
   */
  constructor({ id, create }) {
    this.remote = true;
    this.id = id;
    this.pid = null;
    this.rcSkipped = null;
    this._data = [];
    this._exit = [];
    this._queue = [];    // ws frames before the socket is open
    this._ws = null;
    this._exited = false;
    this._killed = false;
    this.ready = this._start(create);
    this.ready.catch((err) => {
      this._emitData(`\x1b[31m[termhub] ptyd: ${String(err && err.message || err)}\x1b[0m\r\n`);
      this._emitExit(null);
    });
  }

  async _start(create) {
    await ensure();
    if (create) {
      const r = await request('POST', '/api/sessions', { ...create, id: this.id }, { timeoutMs: 20_000 });
      if (r.status !== 201) throw new Error(`create failed (${r.status}): ${r.body && r.body.error}`);
      this.pid = r.body.pid ?? null;
      if (typeof r.body.rcSkipped === 'boolean') this.rcSkipped = r.body.rcSkipped;
      this.info = r.body;
    }
    if (this._killed) return;
    await this._connect();
  }

  _connect() {
    const WebSocket = require('ws');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port()}/ws/term/${encodeURIComponent(this.id)}`);
      this._ws = ws;
      ws.once('open', () => {
        for (const frame of this._queue) ws.send(frame);
        this._queue = [];
        resolve();
      });
      ws.once('unexpected-response', (_req, res) => reject(new Error(`attach refused (${res.statusCode})`)));
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(String(raw)); } catch { return; }
        if ((m.type === 'replay' || m.type === 'output') && m.data) this._emitData(m.data);
        else if (m.type === 'exit') this._emitExit(m.code ?? null);
      });
      ws.on('error', (err) => { if (ws.readyState !== WebSocket.OPEN) reject(err); });
      // ptyd went away (or dropped us): there is no PTY behind this any more
      // as far as this sessiond can tell. Report it as an exit rather than
      // leave a session that silently swallows input.
      ws.on('close', () => this._emitExit(null));
    });
  }

  _emitData(d) { for (const cb of this._data) { try { cb(d); } catch { /* a listener must not break the stream */ } } }

  _emitExit(code) {
    if (this._exited) return;
    this._exited = true;
    for (const cb of this._exit) { try { cb({ exitCode: code }); } catch { /* ditto */ } }
  }

  onData(cb) { this._data.push(cb); }

  onExit(cb) { this._exit.push(cb); }

  _send(msg) {
    const frame = JSON.stringify(msg);
    if (this._ws && this._ws.readyState === 1) this._ws.send(frame);
    else this._queue.push(frame);
  }

  write(data) { this._send({ type: 'input', data }); }

  resize(cols, rows) { this._send({ type: 'resize', cols, rows }); }

  /** Print into the terminal and its replay in ptyd, not into the shell. */
  notice(text) {
    this.ready.then(() => request('POST', `/api/sessions/${encodeURIComponent(this.id)}/notice`, { text })).catch(() => {});
  }

  /** End the session in ptyd (its whole process tree). Resolves when ptyd has. */
  kill() {
    this._killed = true;
    const done = this.ready
      .catch(() => {})
      .then(() => request('DELETE', `/api/sessions/${encodeURIComponent(this.id)}`, undefined, { timeoutMs: 15_000 }))
      .catch(() => {})
      .then(() => {
        try { if (this._ws) this._ws.close(); } catch { /* already closed */ }
        this._emitExit(null);
      });
    return done;
  }
}

module.exports = { enabled, port, ensure, ping, findBinary, listSessions, RemotePty, DEFAULT_PTYD_PORT };
