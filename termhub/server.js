'use strict';

// termhub — single standalone server per machine. Serves the web UI and hosts
// this machine's terminals. Run one of these on every machine you want to reach,
// then open http://<machine-tailscale-ip>:7000 in a browser tab per machine.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const { Session } = require('./lib/session');
const recents = require('./lib/recents');
const { resolveBindAddress } = require('./lib/bind');

const PORT = Number(process.env.TERMHUB_PORT) || 7000;
const MACHINE_NAME = process.env.TERMHUB_MACHINE || os.hostname();
const WEB_DIR = path.join(__dirname, 'web');

const sessions = new Map();

function listSessions() {
  return [...sessions.values()].map((s) => s.info());
}

// ---- helpers --------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\.\.+/g, ''); // basic traversal guard
  const file = path.join(WEB_DIR, rel);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- HTTP routes ----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/api/info') {
      return sendJson(res, 200, { machine: MACHINE_NAME, platform: process.platform, home: os.homedir() });
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      return sendJson(res, 200, { machine: MACHINE_NAME, sessions: listSessions() });
    }

    if (req.method === 'POST' && pathname === '/api/sessions') {
      const body = await readBody(req);
      const session = new Session({ cwd: body.cwd, command: body.command, title: body.title, cols: body.cols, rows: body.rows });
      sessions.set(session.id, session);
      if (body.cwd) recents.add(body.cwd);
      return sendJson(res, 201, session.info());
    }

    const killMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
    if (req.method === 'DELETE' && killMatch) {
      const id = decodeURIComponent(killMatch[1]);
      const session = sessions.get(id);
      if (!session) return sendJson(res, 404, { error: 'no such session' });
      session.kill();
      sessions.delete(id);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/recents') {
      return sendJson(res, 200, { recents: recents.list() });
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    return serveStatic(res, pathname);
  } catch (err) {
    return sendJson(res, 400, { error: String(err && err.message ? err.message : err) });
  }
});

// ---- terminal WebSocket ---------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const match = /^\/ws\/term\/([^/]+)$/.exec(url.pathname);
  if (!match) return socket.destroy();
  const id = decodeURIComponent(match[1]);
  const session = sessions.get(id);
  if (!session) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => bindTerminal(ws, session));
});

function bindTerminal(ws, session) {
  const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
  const detach = session.attach(send);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input') session.write(msg.data);
    else if (msg.type === 'resize') session.resize(Number(msg.cols) || session.cols, Number(msg.rows) || session.rows);
  });
  ws.on('close', () => detach());
  ws.on('error', () => detach());
}

// ---- start ----------------------------------------------------------------

const host = resolveBindAddress();
server.listen(PORT, host, () => {
  console.log(`[termhub] ${MACHINE_NAME} listening on http://${host}:${PORT}`);
  if (host === '127.0.0.1' && !process.env.TERMHUB_BIND) {
    console.log('[termhub] no Tailscale address detected — bound to loopback only.');
    console.log('[termhub] set TERMHUB_BIND to this machine\'s tailnet IP (see `tailscale ip -4`).');
  }
});
