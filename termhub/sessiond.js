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
const { setClipboardImage, clipboardTarget } = require('./lib/clipboard');
const { saveUploadedFile, saveImageAttachment } = require('./lib/uploads');

// A pasted/dropped image, base64-inflated in transit — cap comfortably above a
// full-screen screenshot (a few MB as PNG) while still bounding memory use.
const MAX_CLIPBOARD_IMAGE_BYTES = 15 * 1024 * 1024;

// Generic dropped/pasted files (PDFs, docs, …) run bigger than screenshots.
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;

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

// Raw binary body reader for image uploads — readBody's 1MB cap and JSON parse
// are too small/wrong-shaped for a pasted screenshot.
function readBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error('image too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Refuse an oversized upload from its Content-Length instead of reading the
// whole thing first: the streaming guard in readBinaryBody has to destroy the
// request to stop it, which takes the response down with it and leaves the
// browser with an unexplained network error. Answering up front means the user
// gets a real message — and a phone doesn't spend two minutes uploading a file
// that was always going to be rejected.
function oversizeError(req, maxBytes) {
  const len = Number(req.headers['content-length']);
  if (!Number.isFinite(len) || len <= maxBytes) return null;
  const mb = (n) => (n / (1024 * 1024)).toFixed(1);
  return `${mb(len)} MB is over the ${mb(maxBytes)} MB limit`;
}

// The browser sends the filename URI-encoded (headers are latin-1 only, and
// filenames are routinely not). A malformed one is not worth failing over.
function uploadedName(req, fallback) {
  try {
    if (req.headers['x-file-name']) return decodeURIComponent(req.headers['x-file-name']);
  } catch {
    // malformed header — fall back to the default name
  }
  return fallback;
}

// Build the command used to bring a Claude session back: keep whatever it was
// started with, but ensure it resumes a prior conversation and stays
// non-interactive on permissions. When we tracked the original conversation's
// real UUID (see lib/session.js), resume that exact one directly; otherwise
// fall back to a bare `--resume`, which makes Claude show its resume picker
// scoped to the cwd — the most we can target without knowing the id.
function restoreClaudeCommand(command, agentSessionId) {
  let cmd = (command && String(command).trim()) || 'claude';
  if (!/--dangerously-skip-permissions\b/.test(cmd)) cmd += ' --dangerously-skip-permissions';
  if (agentSessionId) {
    if (!/(^|\s)(--resume|-r)(\s|$)/.test(cmd)) cmd += ` --resume ${agentSessionId}`;
  } else if (!/(^|\s)(--resume|-r|--continue|-c)(\s|$)/.test(cmd)) {
    cmd += ' --resume';
  }
  return cmd;
}

// Same idea for opencode: resume the exact tracked session with `--session
// <id>` when we discovered it (see lib/opencodeModel.js); otherwise fall back
// to `--continue` (opencode's closest equivalent — there's no interactive
// picker like Claude's bare `--resume` to fall back to).
function restoreOpencodeCommand(command, agentSessionId) {
  let cmd = (command && String(command).trim()) || 'opencode';
  if (agentSessionId) {
    if (!/(^|\s)(--session|-s)(\s|$)/.test(cmd)) cmd += ` --session ${agentSessionId}`;
  } else if (!/(^|\s)(--continue|-c|--session|-s)(\s|$)/.test(cmd)) {
    cmd += ' --continue';
  }
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
        // `clipboardImage` and `limits` let the UI tell the user what will happen
        // BEFORE a slow upload: whether a pasted image will land on this host's
        // clipboard or as a file, and whether the file is too big to bother
        // sending at all.
        return sendJson(res, 200, {
          machine: MACHINE_NAME,
          platform: process.platform,
          home: os.homedir(),
          clipboardImage: clipboardTarget().available,
          limits: { imageBytes: MAX_CLIPBOARD_IMAGE_BYTES, fileBytes: MAX_UPLOAD_FILE_BYTES },
        });
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

        let command = null;
        if (entry.kind === 'claude') command = restoreClaudeCommand(entry.command, entry.agentSessionId);
        else if (entry.kind === 'opencode') command = restoreOpencodeCommand(entry.command, entry.agentSessionId);
        const session = new Session({
          cwd: entry.cwd, command, title: entry.title, cols: body.cols, rows: body.rows,
          agentSessionId: (entry.kind === 'claude' || entry.kind === 'opencode') ? entry.agentSessionId : null,
        });
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

      // Stage a browser-pasted/dropped image onto THIS machine's OS clipboard, so
      // the Claude session running in this PTY can pick it up via its own
      // clipboard-image paste hotkey (Alt+V on Windows, Ctrl+V on Linux/macOS).
      //
      // On a host with no clipboard to stage it on (headless Linux — see
      // lib/clipboard.js), and equally when the clipboard write fails on a host
      // that looked capable, save the image as a file instead and tell the
      // client so: `kind` decides whether it fires the paste hotkey or types the
      // path. Either way the image reaches the agent; the old behaviour here was
      // to fail with a yellow warning the user could do nothing about.
      const clipboardImageMatch = /^\/api\/sessions\/([^/]+)\/clipboard-image$/.exec(pathname);
      if (req.method === 'POST' && clipboardImageMatch) {
        const id = decodeURIComponent(clipboardImageMatch[1]);
        const session = sessions.get(id);
        if (!session) return sendJson(res, 404, { error: 'no such session' });
        const oversize = oversizeError(req, MAX_CLIPBOARD_IMAGE_BYTES);
        if (oversize) {
          session.notice(`\x1b[33m[termhub] image not sent — ${oversize}\x1b[0m`);
          return sendJson(res, 413, { error: `image ${oversize}` });
        }
        let buffer;
        try {
          buffer = await readBinaryBody(req, MAX_CLIPBOARD_IMAGE_BYTES);
        } catch (e) {
          return sendJson(res, 413, { error: e.message });
        }
        const mimeType = (req.headers['content-type'] || 'image/png').split(';')[0].trim();

        const target = clipboardTarget();
        // Only worth naming the cause when a host that looked capable failed
        // anyway; "this box has no display" is not news worth a line of terminal.
        let failure = null;
        if (target.available) {
          try {
            await setClipboardImage(buffer, mimeType);
            session.notice('[termhub] image copied to clipboard');
            return sendJson(res, 200, { ok: true, kind: 'clipboard' });
          } catch (e) {
            failure = e && e.message ? e.message : String(e);
          }
        }
        try {
          const saved = await saveImageAttachment(uploadedName(req, null), mimeType, buffer);
          const why = failure ? `clipboard failed (${failure})` : 'no clipboard on this host';
          session.notice(`[termhub] ${why} — saved image to ${saved.path}`);
          return sendJson(res, 200, { ok: true, kind: 'file', path: saved.path, name: saved.name });
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          session.notice(`\x1b[33m[termhub] couldn't save the image: ${msg}\x1b[0m`);
          return sendJson(res, 502, { error: msg });
        }
      }

      // Save a browser-dropped/pasted non-image file (PDF, .md, .txt, …) into
      // this session's own working directory — same idea as clipboard-image
      // above, but for files that have no "paste hotkey" a running agent can
      // pick up. The client inserts the returned path into the terminal input,
      // same as a native OS file drag-drop would.
      const uploadFileMatch = /^\/api\/sessions\/([^/]+)\/upload-file$/.exec(pathname);
      if (req.method === 'POST' && uploadFileMatch) {
        const id = decodeURIComponent(uploadFileMatch[1]);
        const session = sessions.get(id);
        if (!session) return sendJson(res, 404, { error: 'no such session' });
        const rawName = uploadedName(req, 'upload');
        const oversize = oversizeError(req, MAX_UPLOAD_FILE_BYTES);
        if (oversize) {
          session.notice(`\x1b[33m[termhub] ${rawName} not sent — ${oversize}\x1b[0m`);
          return sendJson(res, 413, { error: `${rawName} ${oversize}` });
        }
        let buffer;
        try {
          buffer = await readBinaryBody(req, MAX_UPLOAD_FILE_BYTES);
        } catch (e) {
          return sendJson(res, 413, { error: e.message });
        }
        try {
          const { path: savedPath, name } = await saveUploadedFile(session.cwd, rawName, buffer);
          session.notice(`[termhub] saved ${name} to ${session.cwd}`);
          return sendJson(res, 200, { ok: true, kind: 'file', path: savedPath, name });
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          session.notice(`\x1b[33m[termhub] couldn't save ${rawName}: ${msg}\x1b[0m`);
          return sendJson(res, 502, { error: msg });
        }
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
