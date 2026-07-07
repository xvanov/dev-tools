'use strict';

// termhub session supervisor (sessiond) — the PERSISTENT tier.
//
// Owns this machine's terminals: the `sessions` Map, the node-pty PTYs, and
// their in-memory scrollback. It hosts the JSON API and the terminal WebSocket
// but does NOT serve the web UI — that's the swappable `front` tier, which
// proxies to this process. Because routine updates only restart the front,
// these PTYs (and the sessions running in them) survive every update.
//
// Binds LOOPBACK ONLY (127.0.0.1) and is never exposed directly; reach it only
// through the front, which is published on the tailnet via Tailscale Serve.
//
//     node sessiond.js            # listens on 127.0.0.1:$TERMHUB_SESSIOND_PORT (7010)

const http = require('http');
const os = require('os');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

const { Session } = require('./lib/session');
const recents = require('./lib/recents');
const archive = require('./lib/archive');
const { DEFAULT_SESSIOND_PORT, claimPidFile } = require('./lib/state');
const { suggestDirs } = require('./lib/dirs');

const MACHINE_NAME = process.env.TERMHUB_MACHINE || os.hostname();

// ---- helpers --------------------------------------------------------------

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

// Build the command used to bring a Claude session back: keep whatever it was
// started with, but ensure it resumes a prior conversation and stays
// non-interactive on permissions. `--resume` with no id makes Claude show its
// resume picker scoped to the cwd, which is the most we can target without
// knowing the conversation id.
function restoreClaudeCommand(command) {
  let cmd = (command && String(command).trim()) || 'claude';
  if (!/--dangerously-skip-permissions\b/.test(cmd)) cmd += ' --dangerously-skip-permissions';
  if (!/(^|\s)(--resume|-r|--continue|-c)(\s|$)/.test(cmd)) cmd += ' --resume';
  return cmd;
}

// Render a shell session's recorded history as a dim, commented block to print
// into a restored terminal — a reminder of what to re-run, not something the
// shell executes.
function renderHistoryNotice(history) {
  const dim = (s) => `\x1b[90m${s}\x1b[0m`;
  const lines = history.slice(-50).map((h) => dim('  ' + h));
  return dim('[termhub] restored — commands from the previous session (re-run as needed):')
    + '\r\n' + lines.join('\r\n');
}

// Wire a session's lifecycle hooks to the on-disk archive.
function trackSession(session) {
  session.onExit = () => archive.patch(session.id, { endedAt: Date.now() });
  session.onInputLine = (line) => archive.addHistory(session.id, line);
}

// ---- server factory -------------------------------------------------------

function createSessiond() {
  const sessions = new Map();
  const listSessions = () => [...sessions.values()].map((s) => s.info());
  // Archived entries whose session isn't currently live = restorable after a
  // reboot. History is trimmed for the list payload (polled every couple secs).
  const listRestorable = () => {
    const liveIds = new Set(sessions.keys());
    return archive.list()
      .filter((e) => !liveIds.has(e.id))
      .map((e) => ({
        id: e.id, title: e.title, cwd: e.cwd, command: e.command, kind: e.kind,
        created: e.created, endedAt: e.endedAt,
        history: Array.isArray(e.history) ? e.history.slice(-30) : [],
      }));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    try {
      // Liveness probe used by the front's /api/health (proves sessiond is up).
      if (req.method === 'GET' && pathname === '/api/ping') {
        return sendJson(res, 200, { ok: true, sessions: sessions.size });
      }

      if (req.method === 'GET' && pathname === '/api/info') {
        return sendJson(res, 200, { machine: MACHINE_NAME, platform: process.platform, home: os.homedir() });
      }

      if (req.method === 'GET' && pathname === '/api/sessions') {
        return sendJson(res, 200, { machine: MACHINE_NAME, sessions: listSessions(), restorable: listRestorable() });
      }

      if (req.method === 'POST' && pathname === '/api/sessions') {
        const body = await readBody(req);
        const session = new Session({ cwd: body.cwd, command: body.command, title: body.title, cols: body.cols, rows: body.rows });
        trackSession(session);
        sessions.set(session.id, session);
        archive.upsert(session.archiveEntry());
        if (body.cwd && !session.cwdFallback) recents.add(body.cwd);
        return sendJson(res, 201, session.info());
      }

      // Re-open a session archived from a previous run (e.g. before a reboot).
      // Claude sessions resume; shell sessions reopen with their history printed.
      const restoreMatch = /^\/api\/sessions\/([^/]+)\/restore$/.exec(pathname);
      if (req.method === 'POST' && restoreMatch) {
        const oldId = decodeURIComponent(restoreMatch[1]);
        const entry = archive.get(oldId);
        if (!entry) return sendJson(res, 404, { error: 'no such session to restore' });
        const body = await readBody(req).catch(() => ({}));

        const command = entry.kind === 'claude' ? restoreClaudeCommand(entry.command) : null;
        const session = new Session({ cwd: entry.cwd, command, title: entry.title, cols: body.cols, rows: body.rows });
        trackSession(session);
        sessions.set(session.id, session);

        if (entry.kind !== 'claude' && Array.isArray(entry.history) && entry.history.length) {
          session.notice(renderHistoryNotice(entry.history));
        }

        archive.remove(oldId);                 // the old dead entry is now superseded
        archive.upsert(session.archiveEntry());
        return sendJson(res, 201, session.info());
      }

      const idMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      if (req.method === 'DELETE' && idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        const session = sessions.get(id);
        if (session) { session.kill(); sessions.delete(id); }
        // Drop it from the archive too: a DELETE means "close it" / "forget it",
        // for both a live session and a restorable one. Idempotent.
        archive.remove(id);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'PATCH' && idMatch) {
        const id = decodeURIComponent(idMatch[1]);
        const session = sessions.get(id);
        if (!session) return sendJson(res, 404, { error: 'no such session' });
        const body = await readBody(req);
        session.rename(body.title);
        archive.patch(id, { title: session.title });
        return sendJson(res, 200, session.info());
      }

      if (req.method === 'GET' && pathname === '/api/recents') {
        return sendJson(res, 200, { recents: recents.list() });
      }

      if (req.method === 'GET' && pathname === '/api/dirs') {
        return sendJson(res, 200, { dirs: suggestDirs(url.searchParams.get('path') || '') });
      }

      return sendJson(res, 404, { error: 'not found' });
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

  return server;
}

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

// Start sessiond on loopback. Always 127.0.0.1 — never honour TERMHUB_BIND here;
// only the front is meant to be reachable.
function startSessiond({ port = DEFAULT_SESSIOND_PORT } = {}) {
  const server = createSessiond();
  server.listen(port, '127.0.0.1', () => {
    console.log(`[sessiond] ${MACHINE_NAME} listening on http://127.0.0.1:${port}`);
  });
  return server;
}

module.exports = { createSessiond, startSessiond };

// Run directly: claim the pid file and start.
if (require.main === module) {
  const port = DEFAULT_SESSIOND_PORT;
  claimPidFile('sessiond', port);
  startSessiond({ port });
}
