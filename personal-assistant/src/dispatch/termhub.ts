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
// PA_MACHINES, whose runs live in that machine's termhub (src/dispatch/remote.ts).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type ErrorWithCode = import('../types.ts').ErrorWithCode;
type ApiOptions = { method?: string; body?: Json | null | undefined; timeoutMs?: number };
type CheckResult = { ok: boolean; error?: string; info?: unknown };
type SessionSpec = {
  cwd: string;
  command: string;
  title: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string> | null;
  unsetEnv?: string[] | null;
  links?: Json | null;
};
type SayOptions = { submit?: boolean; timeoutMs?: number };
/** A termhub client: the module itself (this machine's), or forMachine(name)'s. */
type Hub = ReturnType<typeof client>;

const os = require('os');
const WebSocket = require('ws');
const { config } = require('../config.ts');
const { logger } = require('../log.ts');

const log = logger('termhub');

const GUARD = { 'X-Termhub': '1' };

const LINK_KEYS = ['card', 'run', 'job', 'step', 'story', 'external', 'pr'];
const LINK_VALUE = /^[A-Za-z0-9_.:@-]{1,128}$/;

/**
 * Pure. A session's `links` for termhub (plan E1): the card, run, job, … it
 * belongs to, as id strings; null and malformed values left out (termhub drops
 * them too). null when there is nothing to send.
 */
function sessionLinks(o: unknown): Record<string, string> | null {
  if (!o || typeof o !== 'object') return null;
  const src = o as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of LINK_KEYS) {
    if (src[k] == null) continue;
    const v = String(src[k]);
    if (LINK_VALUE.test(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Pure. A doctor line for a termhub reached by its tailnet (MagicDNS) name:
 * null when the URL is not a tailnet name; otherwise ok, or — on the 403 a
 * termhub gives a Host it does not know — the fix, naming
 * TERMHUB_ALLOWED_HOSTS (termhub learns its own name from `tailscale status`,
 * so a `tailscale` missing from its PATH lands here).
 */
function tailnetCheck(url: unknown, result: CheckResult): { ok: boolean; detail: string } | null {
  let host: string;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!/\.ts\.net$/.test(host)) return null;
  if (result.ok) return { ok: true, detail: `${host} answers by its tailnet name` };
  if (/\b403\b/.test(String(result.error))) {
    return { ok: false, detail: `${host} refused its own tailnet name (403) — on that machine put \`tailscale\` on termhub's PATH, or add ${host} to TERMHUB_ALLOWED_HOSTS` };
  }
  return { ok: false, detail: `${host} unreachable by its tailnet name — ${String(result.error).slice(0, 120)}` };
}

function client(baseUrl: string) {
  const root = String(baseUrl).replace(/\/+$/, '');

  // termhub's JSON, read key by key (its shapes differ across versions).
  async function api(path: string, { method = 'GET', body, timeoutMs = 15_000 }: ApiOptions = {}): Promise<Json | null> {
    const res = await fetch(root + path, {
      method,
      // X-Termhub on every call: termhub refuses a state-changing request
      // without it (termhub/lib/requestGuard.js, its CSRF guard). An older
      // termhub ignores the header.
      headers: body ? { 'Content-Type': 'application/json', ...GUARD } : { ...GUARD },
      body: body ? JSON.stringify(body) : null,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: ErrorWithCode = new Error(`termhub ${res.status} on ${path}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json() as Promise<Json>;
  }

  async function reachable(): Promise<CheckResult> {
    try {
      const info = await api('/api/health', { timeoutMs: 5000 });
      return { ok: true, info };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async function listSessions(): Promise<Json[]> {
    const payload = await api('/api/sessions');
    return payload?.sessions || payload || [];
  }

  // `env` / `unsetEnv` change the session's environment from termhub's own
  // (a no-push run starts without push credentials, src/dispatch/remote.ts).
  // `envApplied` is true only when termhub says it applied them: an older
  // termhub ignores the fields, and the caller must not take that on trust.
  async function createSession({ cwd, command, title, cols = 120, rows = 34, env = null, unsetEnv = null, links = null }: SessionSpec): Promise<{ id: string; raw: Json | null; envApplied: boolean }> {
    const body: Json = { cwd, command, title, cols, rows };
    if (env) body.env = env;
    if (unsetEnv) body.unsetEnv = unsetEnv;
    // What the session belongs to (card, run, job; termhub lib/sessionLinks.js).
    // An older termhub ignores it; Run then falls back to the title.
    const l = sessionLinks(links);
    if (l) body.links = l;
    const payload = await api('/api/sessions', { method: 'POST', body });
    // termhub has answered with both shapes across versions; accept either rather
    // than pin a version we would then have to keep in step.
    const id = payload?.id || payload?.session?.id;
    if (!id) throw new Error('termhub did not return a session id');
    const applied = payload?.envApplied || payload?.session?.envApplied;
    return { id, raw: payload, envApplied: Boolean((env || unsetEnv) && applied === true) };
  }

  async function killSession(id: string): Promise<boolean> {
    try {
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return true;
    } catch (err) {
      if ((err as ErrorWithCode).status === 404) return false;
      throw err;
    }
  }

  // Types text at a live session. `submit: false` fills the prompt without
  // pressing return, so text a model wrote can wait for you to read it.
  //
  // Return goes as its own keystroke a moment after the text. Sent in the same
  // write, Claude Code reads text-plus-return as one paste and the return is
  // swallowed: the brief prompt sat typed and unsent in every local run.
  async function say(id: string, text: string, { submit = true, timeoutMs = 5000 }: SayOptions = {}): Promise<boolean> {
    try {
      const input = (data: string, pressReturn: boolean) =>
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
      const e = err as ErrorWithCode;
      if (e.status === 404 && /no such session/i.test(e.message)) throw err;
      // 404 on the *route* (an older termhub) is indistinguishable here from a
      // missing session, so fall through to the socket and let it decide.
      log.debug('input route unavailable, falling back to the PTY socket', { message: e.message });
      return sayOverSocket(id, text, { submit, timeoutMs });
    }
  }

  function sayOverSocket(id: string, text: string, { submit = true, timeoutMs = 5000 }: SayOptions = {}): Promise<boolean> {
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

      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`termhub session ${id} unreachable: ${err.message}`));
      });
    });
  }

  // The session's recent screen as plain text (termhub's replay buffer with
  // escape sequences stripped) — how the dispatcher sees a prompt it must
  // answer, such as Claude's folder-trust question.
  function screen(id: string, { tailChars = 6000, timeoutMs = 5000 }: { tailChars?: number; timeoutMs?: number } = {}): Promise<string> {
    const url = root.replace(/^http/, 'ws') + `/ws/term/${encodeURIComponent(id)}`;
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const done = (text: string): void => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        resolve(text);
      };
      const timer = setTimeout(() => done(''), timeoutMs);
      ws.on('message', (raw: unknown) => {
        let msg: { type?: unknown; data?: unknown };
        try { msg = JSON.parse(String(raw)); } catch { return; }
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
  async function dirs(dir: string): Promise<string[]> {
    const payload = await api(`/api/dirs?path=${encodeURIComponent(dir)}`);
    return payload?.dirs || [];
  }

  // That machine's Claude Code transcripts, read-only (termhub's
  // lib/transcripts.js) — how sessions on other machines reach the store
  // (src/ingest/remoteSessions.js). An older termhub answers 404 on the route.
  async function claudeTranscripts({ limit = 100 }: { limit?: number } = {}): Promise<Json[]> {
    const payload = await api(`/api/claude/transcripts?limit=${encodeURIComponent(limit)}`);
    return payload?.transcripts || [];
  }

  // One transcript, verbatim. Text, not JSON — it is JSON Lines.
  async function claudeTranscript(id: string, { timeoutMs = 60_000 }: { timeoutMs?: number } = {}): Promise<string> {
    const path = `/api/claude/transcript?id=${encodeURIComponent(id)}`;
    const res = await fetch(root + path, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: ErrorWithCode = new Error(`termhub ${res.status} on ${path}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.text();
  }

  // The URL to open in a browser. termhub publishes an HTTPS address over
  // Tailscale Serve; fall back to the configured base when it cannot say.
  async function sessionUrl(id: string): Promise<string> {
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
const squash = (text: unknown): string => String(text || '').replace(/\s+/g, '');
const TRUST = /trust(thefilesin)?thisfolder|Doyoutrust|Isthisaprojectyou(created|trust)|Yes,proceed/gi;
const READY = /bypasspermissions|\?forshortcuts|shift\+tabtocycle|Try"/gi;

function lastIndex(re: RegExp, text: string): number {
  let at = -1;
  for (const m of text.matchAll(re)) at = m.index;
  return at;
}

// Pure: the keys that accept the trust question on this screen. Newer Claude
// Code puts the cursor on "No, exit", where Enter alone quits Claude — run #8
// stopped there — so the cursor moves down to "Yes" first.
function trustKeys(text: unknown): string[] {
  const tail = squash(text).slice(-1200);
  const no = tail.lastIndexOf('❯No,exit');
  return no >= 0 && no > tail.lastIndexOf('❯Yes') ? ['\x1b[B', ''] : [''];
}

function claudeScreenState(text: unknown): 'trust' | 'ready' | null {
  const tail = squash(text);
  const trust = lastIndex(TRUST, tail);
  const ready = lastIndex(READY, tail);
  if (trust < 0 && ready < 0) return null;
  return trust > ready ? 'trust' : 'ready';
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a freshly started Claude Code to be at its prompt — answering the
 * folder-trust question with its default (proceed) on the way — then types
 * `prompt` and makes sure it was taken: if termhub still sees the session idle
 * a few seconds later, return is pressed once more. Returns what happened.
 */
async function briefClaude(
  hub: Pick<Hub, 'screen' | 'say' | 'listSessions'>,
  id: string,
  prompt: string,
  { timeoutMs = 90_000 }: { timeoutMs?: number } = {}
): Promise<{ ready: boolean; trusted: boolean; nudged: boolean }> {
  const until = Date.now() + timeoutMs;
  let trusted = false;
  let state: 'trust' | 'ready' | null = null;
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
  const s = (await hub.listSessions().catch((): Json[] => [])).find((x) => x.id === id);
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
function isLocal(name: string | null | undefined): boolean {
  return !name || name === os.hostname() || !config.termhub.machines[name];
}

function forMachine(name: string | null | undefined): Hub {
  return isLocal(name) ? local : client(config.termhub.machines[name as string].url);
}

module.exports = { ...local, client, tailnetCheck, forMachine, isLocal, briefClaude, claudeScreenState, trustKeys, sessionLinks };
