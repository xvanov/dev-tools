'use strict';

// The termhub client. termhub is the session substrate for every dispatched
// run, for one reason: it is the only one you can *attach to* from a phone.
// ACP runs can be steered but never joined; OpenClaw's native subagents can be
// neither.
//
// Creating a session is REST. Typing into one is a websocket — termhub's PTY
// stream takes `{type:'input', data}` frames — so `say()` opens a socket, writes
// once, and closes. If a future termhub grows `POST /api/sessions/:id/input`
// (it should, and its own UI would use it), prefer that and delete this.

const WebSocket = require('ws');
const { config } = require('../config');
const { logger } = require('../log');

const log = logger('termhub');

function base() {
  return config.termhub.url.replace(/\/+$/, '');
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(base() + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`termhub ${res.status} on ${path}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function reachable() {
  try {
    const info = await api('/api/health');
    return { ok: true, info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function listSessions() {
  const payload = await api('/api/sessions');
  return payload?.sessions || payload || [];
}

async function createSession({ cwd, command, title, cols = 120, rows = 34 }) {
  const payload = await api('/api/sessions', {
    method: 'POST',
    body: { cwd, command, title, cols, rows },
  });
  // termhub has answered with both shapes across versions; accept either rather
  // than pin a version we would then have to keep in step.
  const id = payload?.id || payload?.session?.id;
  if (!id) throw new Error('termhub did not return a session id');
  return { id, raw: payload };
}

async function killSession(id) {
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

// Types text at a live session. The newline is separate and deliberate: a
// caller that wants to fill the prompt without submitting it (to let you read
// what is about to be sent) passes `submit: false`.
function say(id, text, { submit = true, timeoutMs = 5000 } = {}) {
  const url = base().replace(/^http/, 'ws') + `/ws/term/${encodeURIComponent(id)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out talking to termhub'));
    }, timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'input', data: text }));
      if (submit) ws.send(JSON.stringify({ type: 'input', data: '\r' }));
      // Give the frames a moment to leave before closing; a socket closed in
      // the same tick can drop them.
      setTimeout(() => {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      }, 150);
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`termhub session ${id} unreachable: ${err.message}`));
    });
  });
}

// The URL to open in a browser. termhub publishes an HTTPS address over
// Tailscale Serve; fall back to the configured base when it cannot say.
async function sessionUrl(id) {
  let origin = base();
  try {
    const secure = await api('/api/secure-url');
    if (secure?.secureUrl) origin = secure.secureUrl.replace(/\/+$/, '');
  } catch {
    /* single-port mode, or an older termhub */
  }
  return `${origin}/?session=${encodeURIComponent(id)}`;
}

module.exports = { api, reachable, listSessions, createSession, killSession, say, sessionUrl };
