'use strict';

// sessiond's PTY backend (plan 5.1, Exit 5): terminals live in ptyd, the Rust
// terminal host (../ptyd). It is the only host. sessiond keeps everything else
// it does (the screen mirror, voice, idle tracking, uploads, the archive) and
// talks to ptyd over the same session protocol it serves itself, which
// termhub/test/ptydConformance.test.js holds both to.
//
// What it buys: ptyd is its own process, so a sessiond restart no longer ends
// the terminals. On start, sessiond adopts the sessions ptyd still has
// (adoptSessions in sessiond.js) and their screens come back from ptyd's replay.
//
// RemotePty is the PTY Session drives (onData, onExit, write, resize, kill,
// pid). Creation is asynchronous (an HTTP call): writes, resizes and notices
// made before ptyd has answered are queued and replayed in order.
//
// Environment:
//   TERMHUB_PTYD=1        required. Production sets it (lib/ptyHost.js). Anything
//                         else is not a host: Session refuses to spawn.
//   TERMHUB_PTYD_PORT     its loopback port (default 7020; tests use a spare one)
//   TERMHUB_PTYD_BIN      the binary to start when none answers (default: the
//                         installed copy, dist/<os>-<arch>/, then
//                         ptyd/target/{release,local,debug}/ptyd[.exe])
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_PTYD_PORT = 7020;
const EXE = process.platform === 'win32' ? 'ptyd.exe' : 'ptyd';

function enabled(env: Record<string, string | undefined> = process.env) {
  return env.TERMHUB_PTYD === '1';
}

function port(env: Record<string, string | undefined> = process.env) {
  return Number(env.TERMHUB_PTYD_PORT) || DEFAULT_PTYD_PORT;
}

function request(method: any, p: any, body?: any, { timeoutMs = 10_000 }: { timeoutMs?: number | undefined } = {}) {
  return new Promise<any>((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port(), path: p, method, timeout: timeoutMs,
      headers: { 'X-Termhub': '1', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res: any) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c: any) => (b += c));
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

function findBinary(env: Record<string, string | undefined> = process.env) {
  if (env.TERMHUB_PTYD_BIN) return env.TERMHUB_PTYD_BIN;
  const release = require('./ptyHost.ts').releaseBinary(env);
  if (release) return release;
  for (const profile of ['release', 'local', 'debug']) {
    const p = path.join(__dirname, '..', '..', 'ptyd', 'target', profile, EXE);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Started detached so it outlives this sessiond: that is the point of it.
function launch(bin: any, logDir: any) {
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

let readyPromise: any = null;

/**
 * Make sure a ptyd answers on TERMHUB_PTYD_PORT, starting one if it does not
 * and a binary is at hand. Resolves to its /api/ping body, or rejects. Every
 * RemotePty waits on this before its first request.
 */
function ensure({ logDir }: { logDir?: any } = {}) {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    let live = await ping();
    if (live) return live;
    const bin = findBinary();
    if (!bin || !fs.existsSync(bin)) {
      throw new Error(`ptyd is the only PTY host, nothing answers on 127.0.0.1:${port()}, and no ptyd binary was found `
        + '(node scripts/build.js --only ptyd, or set TERMHUB_PTYD_BIN). node-pty was retired; there is no fallback.');
    }
    launch(bin, logDir || path.join(require('./paths.ts').dataDir(), 'logs'));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      live = await ping();
      if (live) return live;
      await new Promise<any>((r) => setTimeout(r, 100));
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
  declare remote: any;
  declare id: any;
  declare pid: any;
  declare rcSkipped: any;
  declare _data: any;
  declare _exit: any;
  declare _queue: any;
  declare _ws: any;
  declare _exited: any;
  declare _killed: any;
  declare ready: any;
  declare info: any;
  /**
   * @param {{id: string, create?: object}} opts  `create` is the POST body for a
   *   new session; without it, an existing ptyd session is adopted.
   */
  constructor({ id, create }: { id?: any; create?: any }) {
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
    this.ready.catch((err: any) => {
      this._emitData(`\x1b[31m[termhub] ptyd: ${String(err && err.message || err)}\x1b[0m\r\n`);
      this._emitExit(null);
    });
  }

  async _start(create: any) {
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
    return new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port()}/ws/term/${encodeURIComponent(this.id)}`);
      this._ws = ws;
      ws.once('open', () => {
        for (const frame of this._queue) ws.send(frame);
        this._queue = [];
        resolve(undefined);
      });
      ws.once('unexpected-response', (_req: any, res: any) => reject(new Error(`attach refused (${res.statusCode})`)));
      ws.on('message', (raw: any) => {
        let m;
        try { m = JSON.parse(String(raw)); } catch { return; }
        if ((m.type === 'replay' || m.type === 'output') && m.data) this._emitData(m.data);
        else if (m.type === 'exit') this._emitExit(m.code ?? null);
      });
      ws.on('error', (err: any) => { if (ws.readyState !== WebSocket.OPEN) reject(err); });
      // ptyd went away (or dropped us): there is no PTY behind this any more
      // as far as this sessiond can tell. Report it as an exit rather than
      // leave a session that silently swallows input.
      ws.on('close', () => this._emitExit(null));
    });
  }

  _emitData(d: any) { for (const cb of this._data) { try { cb(d); } catch { /* a listener must not break the stream */ } } }

  _emitExit(code: any) {
    if (this._exited) return;
    this._exited = true;
    for (const cb of this._exit) { try { cb({ exitCode: code }); } catch { /* ditto */ } }
  }

  onData(cb: any) { this._data.push(cb); }

  onExit(cb: any) { this._exit.push(cb); }

  _send(msg: any) {
    const frame = JSON.stringify(msg);
    if (this._ws && this._ws.readyState === 1) this._ws.send(frame);
    else this._queue.push(frame);
  }

  write(data: any) { this._send({ type: 'input', data }); }

  resize(cols: any, rows: any) { this._send({ type: 'resize', cols, rows }); }

  /** Print into the terminal and its replay in ptyd, not into the shell. */
  notice(text: any) {
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
