'use strict';

// Talking to an opencode TUI over its own HTTP API.
//
// opencode's TUI accepts `--port`/`--hostname` and, when given them, serves the
// same API `opencode serve` does — for *that running instance*. That single fact
// is what lets termhub treat an opencode session the way it treats a Claude one,
// and it is a much better deal than the Claude side gets:
//
//   | | Claude Code | opencode |
//   |---|---|---|
//   | which conversation is this? | pin `--session-id` at launch and hope | ask `/api/session/active` |
//   | which model? | parse the newest transcript JSONL | `session.model` |
//   | is a turn finished? | infer from `stop_reason` in the transcript | `session.idle` event |
//   | is it asking me something? | **unknowable** — see AGENT.md | `question.asked`, with the text |
//
// The last row is the one that matters. AGENT.md documents at length that a
// Claude session parked on a question writes *nothing* to its transcript until
// you answer, so termhub has to guess from 12s of PTY silence and can never say
// what is being asked. opencode publishes the question, its header and its
// options, the moment it asks.
//
// This replaces lib/opencodeModel.js's approach — `opencode export` in a
// subprocess, ~1.4s a call, behind a 10s cache, plus a polling loop to *discover*
// which session the TUI had created. That module stays for sessions launched
// before this build, and as the fallback when a TUI won't give up a port.

const http = require('http');
const net = require('net');
const path = require('path');

const HOST = '127.0.0.1';

// Ask the OS for a free port by binding one and letting go. There is a race
// between here and opencode's own bind, and it is unavoidable — opencode has no
// "bind any port and tell me which" mode we can read back (`--port 0` picks one
// but only prints it to the TUI's own log). The window is milliseconds and the
// failure is loud and recoverable: the TUI exits, the PTY shows why, and the
// session degrades to the subprocess path rather than breaking.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Minimal JSON GET. Deliberately not `fetch`: this runs inside sessiond, which
// owns every live PTY, and an undici connection pool holding sockets open to a
// dozen short-lived TUI servers is a worse neighbour than one socket per ask.
function getJson(port, path, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} for ${path}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Is the server on this port up *and* an opencode? Checked by shape, not just by
// "something answered": ports get reused, and a stranger returning 200 to
// /global/health would otherwise be adopted as this session's agent.
async function health(port) {
  try {
    const j = await getJson(port, '/global/health', 1500);
    return j && j.healthy === true ? { ok: true, version: j.version || null } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// opencode's server is listening within ~1s of launch (measured), but the TUI
// still has to boot behind it. Polling beats a fixed sleep because the cost of
// being wrong is asymmetric: too short and the session never gets its API.
async function waitReady(port, timeoutMs = 20000, isAborted = () => false) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isAborted()) return null;
    const h = await health(port);
    if (h.ok) return h;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Which session is the TUI on. Two sources, and the order matters.
//
// `/api/session/active` reads like the obvious answer and is a trap: measured
// against 1.18.15 it answers `{"data":{}}` even with a conversation open and
// even when the TUI was launched with `--session <id>`. It is asked first
// anyway, cheaply, in case a later version starts populating it — but nothing
// depends on it.
//
// So the real seed is `/session`, filtered to this working directory and to
// sessions created since we launched. That last guard is what stops us adopting
// an *older* conversation that happens to live in the same directory, which
// would show the wrong model until the user typed something. It is the same
// judgement lib/opencodeModel.js's discovery loop makes, minus the 1.4s
// subprocess — and unlike that loop it is only ever a seed, because the event
// stream then names the session exactly (see _startOpencodeApi in session.js).
//
// Answers null before the first prompt, and that is correct rather than an
// error: opencode creates a session lazily, on the first message, not at launch.
const CREATED_SKEW_MS = 5000; // opencode's own timestamp can lag our spawn call

async function activeSession(port, { cwd, since } = {}) {
  try {
    const j = await getJson(port, '/api/session/active');
    if (j && j.data && j.data.id) return j.data;
  } catch { /* fall through to the listing */ }

  let list;
  try { list = await getJson(port, '/session'); } catch { return null; }
  if (!Array.isArray(list)) return null;

  const candidates = list.filter((s) => {
    if (!s || !s.id) return false;
    if (cwd && s.directory && path.resolve(s.directory) !== path.resolve(cwd)) return false;
    if (since && s.time && s.time.created && s.time.created < since - CREATED_SKEW_MS) return false;
    return true;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0));
  return candidates[0];
}

async function session(port, sessionId) {
  try { return await getJson(port, `/session/${encodeURIComponent(sessionId)}`); } catch { return null; }
}

// The assistant's most recent finished turn, flattened to text.
//
// A message's visible answer is spread over its `parts`, and only `text` parts
// belong in a spoken summary: `reasoning` is thinking, `tool` is machinery, and
// a `synthetic` text part is opencode talking to itself rather than to you.
// `finish` being set is what makes the turn *finished* — mid-stream it is absent,
// and announcing then would read half a sentence aloud.
async function lastAssistantTurn(port, sessionId) {
  let msgs;
  try { msgs = await getJson(port, `/session/${encodeURIComponent(sessionId)}/message`); } catch { return null; }
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const info = m && m.info;
    if (!info || info.role !== 'assistant') continue;
    const text = (m.parts || [])
      .filter((p) => p && p.type === 'text' && !p.synthetic && !p.ignored && p.text)
      .map((p) => p.text)
      .join('\n')
      .trim();
    return {
      id: info.id,
      finished: !!info.finish || !!(info.time && info.time.completed),
      error: info.error || null,
      model: info.modelID || null,
      providerID: info.providerID || null,
      text,
    };
  }
  return null;
}

// Anything the session is currently blocked on and can't proceed without. Both
// endpoints answer a bare array, and both are session-agnostic (one TUI, one
// conversation), so they're filtered by sessionID rather than trusted wholesale.
async function pendingAsk(port, sessionId) {
  const [questions, permissions] = await Promise.all([
    getJson(port, '/question').catch(() => []),
    getJson(port, '/permission').catch(() => []),
  ]);
  const mine = (arr) => (Array.isArray(arr) ? arr : []).filter((x) => !sessionId || !x.sessionID || x.sessionID === sessionId);
  const q = mine(questions)[0];
  if (q) {
    const first = (q.questions || [])[0] || {};
    return {
      kind: 'question',
      id: q.id,
      // The whole point of having an API instead of a heuristic: we can say what
      // is being asked, not merely that something is.
      text: first.question || first.header || 'a question',
      options: (first.options || []).map((o) => o.label || o.value || '').filter(Boolean),
    };
  }
  const p = mine(permissions)[0];
  if (p) {
    return {
      kind: 'permission',
      id: p.id,
      text: p.permission ? `permission to ${p.permission}` : 'permission',
      options: [],
    };
  }
  return null;
}

// Subscribe to the instance's event stream. Returns a handle with .close().
//
// Reconnects on drop with the same backoff shape the browser's sockets use, and
// for the same reason: the TUI can be restarted under us, and a feed that gave
// up once would leave that session permanently silent with no sign of why.
// `onEvent` is called with `{type, properties}`; it must never throw.
function subscribe(port, onEvent, onError) {
  let req = null;
  let closed = false;
  let attempts = 0;
  let timer = null;

  const connect = () => {
    if (closed) return;
    req = http.get({ host: HOST, port, path: '/event', headers: { accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return retry(); }
      attempts = 0;
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        // SSE frames are separated by a blank line; a frame can carry several
        // `data:` lines, and a chunk can split one mid-way — hence the buffer.
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          try { onEvent(ev); } catch {}
        }
      });
      res.on('end', retry);
      res.on('error', retry);
    });
    req.on('error', (e) => { if (onError) { try { onError(e); } catch {} } retry(); });
  };

  const retry = () => {
    if (closed) return;
    attempts += 1;
    clearTimeout(timer);
    timer = setTimeout(connect, Math.min(5000, 300 * attempts));
  };

  connect();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      try { req && req.destroy(); } catch {}
    },
  };
}

// Human-readable model name. opencode spans 75+ providers with no shared id
// convention, so this is the same deliberately-shallow treatment
// lib/opencodeModel.js gives it — title-case the last path segment, which is
// what opencode's own TUI footer shows.
function formatModelLabel(id) {
  if (!id) return null;
  const tail = String(id).split('/').pop();
  return tail
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

module.exports = {
  HOST, freePort, health, waitReady, activeSession, session,
  lastAssistantTurn, pendingAsk, subscribe, formatModelLabel, getJson,
};
