'use strict';

// Pushes over ntfy (https://ntfy.sh, or your own server), for a machine with
// no desktop to show a notification on — a headless Linux box — or for a phone.
// The same mechanism termhub uses (termhub/lib/notify.js).
//
// Opt-in, and cautious by default:
//
//  - **The topic is the secret.** ntfy.sh has no auth: whoever knows the topic
//    reads everything published to it. So `PA_NTFY_TOPIC` is resolved with
//    `config.secret()` (env → OS vault → .env), is never logged, and is never
//    in a URL this module prints.
//  - **Titles only, unless you say otherwise.** A brief or a debrief quotes
//    your mail; on a public server that is your mail on someone else's disk.
//    `PA_NTFY_BODY=1` adds the body's first lines.
//  - `PA_NTFY=fallback` (default) pushes only when the desktop notification
//    did not show; `always` pushes every time; `off` never.
//
// Best effort: a network failure costs a missed push, never a failed pass.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Db = import('../repo/types.ts').Db;

const { config, secret } = require('../config.ts');

const TIMEOUT_MS = 10_000;

function topic() {
  return secret('PA_NTFY_TOPIC');
}

function configured() {
  return config.notify.ntfyMode !== 'off' && Boolean(topic());
}

/**
 * Pure: the JSON publish request (POST to the server root, topic in the body),
 * which carries any title — ntfy's header form cannot take non-ASCII text.
 */
function request({ server, topic: t, title, body, url, includeBody = false }: { server?: unknown; topic?: string | null; title?: string | null | undefined; body?: string | null | undefined; url?: string | null | undefined; includeBody?: boolean }) {
  const message = includeBody
    ? String(body || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 4).join('\n').slice(0, 600)
    : '';
  const payload: Record<string, unknown> = { topic: t, title: String(title ?? '').slice(0, 120), message: message || String(title ?? '').slice(0, 120) };
  // A loopback link (the dashboard) means nothing on the phone that gets it.
  if (/^https?:\/\//.test(url || '') && !/^https?:\/\/(127\.|localhost|\[::1\])/i.test(url as string)) payload.click = url;
  return {
    url: `${String(server || 'https://ntfy.sh').replace(/\/+$/, '')}/`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

async function send({ title, body, url }: { title?: string | null | undefined; body?: string | null | undefined; url?: string | null | undefined }) {
  const t = topic();
  if (!t || config.notify.ntfyMode === 'off') return false;
  const req = request({ server: config.notify.ntfyServer, topic: t, title, body, url, includeBody: config.notify.ntfyBody });
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { request, send, configured };
