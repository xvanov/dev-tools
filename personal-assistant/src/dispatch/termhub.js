'use strict';

// The termhub client. termhub is the session substrate for every dispatched
// run, for one reason: it is the only one you can *attach to* from a phone.
// ACP runs can be steered but never joined; OpenClaw's native subagents can be
// neither.
//
// Creating a session is REST, and so is typing into one:
// `POST /api/sessions/:id/input` was added to termhub for exactly this. The
// websocket path below stays as a fallback for a machine running an older
// termhub, because a dispatcher that cannot steer a stuck agent is worse than
// one that has two ways to do it.
//
// One client per termhub. The module itself is this machine's
// (PA_TERMHUB_URL); `forMachine(name)` is the client for a machine named in
// PA_MACHINES, whose runs live in that machine's termhub (src/dispatch/remote.js).

const os = require('os');
const WebSocket = require('ws');
const { config } = require('../config');
const { logger } = require('../log');

const log = logger('termhub');

function client(baseUrl) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function api(path, { method = 'GET', body, timeoutMs = 15_000 } = {}) {
    const res = await fetch(root + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
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
      const info = await api('/api/health', { timeoutMs: 5000 });
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

  // Types text at a live session. `submit: false` fills the prompt without
  // pressing return, so text a model wrote can wait for you to read it.
  //
  // Return goes as its own keystroke a moment after the text. Sent in the same
  // write, Claude Code reads text-plus-return as one paste and the return is
  // swallowed: the brief prompt sat typed and unsent in every local run.
  async function say(id, text, { submit = true, timeoutMs = 5000 } = {}) {
    try {
      const input = (data, pressReturn) =>
        api(`/api/sessions/${encodeURIComponent(id)}/input`, { method: 'POST', body: { data, submit: pressReturn } });
      if (text && submit) {
        await input(text, false);
        await new Promise((r) => setTimeout(r, 600));
        await input('', true);
      } else {
        await input(text, submit);
      }
      return true;
    } catch (err) {
      if (err.status === 404 && /no such session/i.test(err.message)) throw err;
      // 404 on the *route* (an older termhub) is indistinguishable here from a
      // missing session, so fall through to the socket and let it decide.
      log.debug('input route unavailable, falling back to the PTY socket', { message: err.message });
      return sayOverSocket(id, text, { submit, timeoutMs });
    }
  }

  function sayOverSocket(id, text, { submit = true, timeoutMs = 5000 } = {}) {
    const url = root.replace(/^http/, 'ws') + `/ws/term/${encodeURIComponent(id)}`;

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

  // The session's recent screen as plain text (termhub's replay buffer with
  // escape sequences stripped) — how the dispatcher sees a prompt it must
  // answer, such as Claude's folder-trust question.
  function screen(id, { tailChars = 6000, timeoutMs = 5000 } = {}) {
    const url = root.replace(/^http/, 'ws') + `/ws/term/${encodeURIComponent(id)}`;
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const done = (text) => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        resolve(text);
      };
      const timer = setTimeout(() => done(''), timeoutMs);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type !== 'replay') return;
        const text = String(msg.data || '')
          .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
          .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
          .replace(/\x1b[@-_]/g, '')
          .replace(/\r/g, '');
        done(text.slice(-tailChars));
      });
      ws.on('error', () => done(''));
    });
  }

  // Directories under `dir` on that termhub's machine — how a remote dispatch
  // checks a repo is there, and that its worktree appeared, without a shell.
  async function dirs(dir) {
    const payload = await api(`/api/dirs?path=${encodeURIComponent(dir)}`);
    return payload?.dirs || [];
  }

  // That machine's Claude Code transcripts, read-only (termhub's
  // lib/transcripts.js) — how sessions on other machines reach the store
  // (src/ingest/remoteSessions.js). An older termhub answers 404 on the route.
  async function claudeTranscripts({ limit = 100 } = {}) {
    const payload = await api(`/api/claude/transcripts?limit=${encodeURIComponent(limit)}`);
    return payload?.transcripts || [];
  }

  // One transcript, verbatim. Text, not JSON — it is JSON Lines.
  async function claudeTranscript(id, { timeoutMs = 60_000 } = {}) {
    const path = `/api/claude/transcript?id=${encodeURIComponent(id)}`;
    const res = await fetch(root + path, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`termhub ${res.status} on ${path}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.text();
  }

  // The URL to open in a browser. termhub publishes an HTTPS address over
  // Tailscale Serve; fall back to the configured base when it cannot say.
  async function sessionUrl(id) {
    let origin = root;
    try {
      const secure = await api('/api/secure-url');
      if (secure?.secureUrl) origin = secure.secureUrl.replace(/\/+$/, '');
    } catch {
      /* single-port mode, or an older termhub */
    }
    return `${origin}/#session=${encodeURIComponent(id)}`;
  }

  return { base: root, api, reachable, listSessions, createSession, killSession, say, screen, dirs, sessionUrl, claudeTranscripts, claudeTranscript };
}

// Pure: what Claude's screen is asking for. 'trust' is the first-run "do you
// trust this folder" question (every new worktree is a folder it has never
// seen); 'ready' is its input box; null is still starting.
// The replay keeps what scrolled past, so whichever appeared *last* wins: an
// answered trust question is still in the buffer above the input box.
// Matched with all whitespace removed: termhub's replay of a full-screen
// prompt often loses its spaces ("Isthisaprojectyoucreated", "❯No,exit").
const squash = (text) => String(text || '').replace(/\s+/g, '');
const TRUST = /trust(thefilesin)?thisfolder|Doyoutrust|Isthisaprojectyou(created|trust)|Yes,proceed/gi;
const READY = /bypasspermissions|\?forshortcuts|shift\+tabtocycle|Try"/gi;

function lastIndex(re, text) {
  let at = -1;
  for (const m of text.matchAll(re)) at = m.index;
  return at;
}

// Pure: the keys that accept the trust question on this screen. Newer Claude
// Code puts the cursor on "No, exit", where Enter alone quits Claude — run #8
// stopped there — so the cursor moves down to "Yes" first.
function trustKeys(text) {
  const tail = squash(text).slice(-1200);
  const no = tail.lastIndexOf('❯No,exit');
  return no >= 0 && no > tail.lastIndexOf('❯Yes') ? ['\x1b[B', ''] : [''];
}

function claudeScreenState(text) {
  const tail = squash(text);
  const trust = lastIndex(TRUST, tail);
  const ready = lastIndex(READY, tail);
  if (trust < 0 && ready < 0) return null;
  return trust > ready ? 'trust' : 'ready';
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a freshly started Claude Code to be at its prompt — answering the
 * folder-trust question with its default (proceed) on the way — then types
 * `prompt` and makes sure it was taken: if termhub still sees the session idle
 * a few seconds later, return is pressed once more. Returns what happened.
 */
async function briefClaude(hub, id, prompt, { timeoutMs = 90_000 } = {}) {
  const until = Date.now() + timeoutMs;
  let trusted = false;
  let state = null;
  while (Date.now() < until) {
    const text = await hub.screen(id);
    state = claudeScreenState(text);
    if (state === 'trust') {
      for (const key of trustKeys(text)) {
        await hub.say(id, key, { submit: key === '' });
        await pause(300);
      }
      trusted = true;
      await pause(2500);
      continue;
    }
    if (state === 'ready') break;
    await pause(1500);
  }
  await hub.say(id, prompt);
  await pause(6000);
  const s = (await hub.listSessions().catch(() => [])).find((x) => x.id === id);
  let nudged = false;
  if (s && s.idleState && s.idleState !== 'working') {
    await hub.say(id, '', { submit: true });
    nudged = true;
  }
  return { ready: state === 'ready', trusted, nudged };
}

const local = client(config.termhub.url);

// True for this machine: no name, its hostname, or any name PA_MACHINES does
// not list (runs recorded before machines existed carry the hostname).
function isLocal(name) {
  return !name || name === os.hostname() || !config.termhub.machines[name];
}

function forMachine(name) {
  return isLocal(name) ? local : client(config.termhub.machines[name].url);
}

module.exports = { ...local, client, forMachine, isLocal, briefClaude, claudeScreenState, trustKeys };
