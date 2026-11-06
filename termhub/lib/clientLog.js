'use strict';

// A tiny log of what went wrong IN THE BROWSER, kept on the machine:
//
//   POST /api/client-log  {event, ...fields}   -> 204
//   GET  /api/client-log[?n=50]                -> {entries:[...]} (newest last)
//
// Why it exists: the voice loop runs on a phone, and a phone has no console.
// "The mic gives weird errors" arrived as prose; the recogniser's actual error
// code, the origin, whether the page was a home-screen app — the facts that
// decide which of half a dozen causes it was — never left the device. The page
// now posts one line per failure here, and anyone on the machine can read it
// (`GET /api/client-log`, or the file itself) instead of asking for a
// screenshot of `?voicedebug=1`.
//
// Bounded on purpose, because any page on the tailnet can write to it:
//   - the body is capped (MAX_BODY_BYTES) and must be a JSON object;
//   - every string is clipped, at most MAX_FIELDS keys are kept;
//   - at most RATE_MAX lines per RATE_WINDOW_MS across all clients (excess is
//     counted and dropped, not queued);
//   - the file rolls to `.1` past MAX_FILE_BYTES, so two files is the ceiling.
// The POST goes through the front's usual CSRF guard (X-Termhub + JSON
// Content-Type, lib/requestGuard.js), like every other state-changing route.
//
// Served by the FRONT, for the reason lib/exec.js is: an update swaps the
// front and never restarts sessiond.

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const FILE_NAME = 'client-log.jsonl';
const MAX_BODY_BYTES = 8 * 1024;
const MAX_FIELDS = 24;
const MAX_STRING = 600;
const MAX_FILE_BYTES = 512 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const READ_DEFAULT = 50;
const READ_MAX = 500;

function clip(v) {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
  // Nested values are flattened to a clipped string: this is a log line, not a
  // document store, and it keeps one hostile body from becoming a deep tree.
  try { return clip(JSON.stringify(v)); } catch { return null; }
}

/** Pure: an untrusted body -> the line to store, or null if it isn't one. */
function sanitize(body, { now = Date.now(), ua = '' } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = { ts: new Date(now).toISOString() };
  let n = 0;
  for (const [k, v] of Object.entries(body)) {
    if (n >= MAX_FIELDS) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) || k === 'ts') continue;
    out[k] = clip(v);
    n += 1;
  }
  if (typeof out.event !== 'string' || !out.event) return null;
  if (ua && out.ua === undefined) out.ua = clip(String(ua));
  return out;
}

function createClientLog({ dir = dataDir(), now = () => Date.now() } = {}) {
  const file = path.join(dir, FILE_NAME);
  let windowStart = 0;
  let inWindow = 0;
  let dropped = 0;

  function allow() {
    const t = now();
    if (t - windowStart > RATE_WINDOW_MS) { windowStart = t; inWindow = 0; }
    if (inWindow >= RATE_MAX) { dropped += 1; return false; }
    inWindow += 1;
    return true;
  }

  function append(line) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {}
      if (dropped) { line = { ...line, droppedBefore: dropped }; dropped = 0; }
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function read(n = READ_DEFAULT) {
    const want = Math.max(1, Math.min(READ_MAX, Number(n) || READ_DEFAULT));
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).slice(-want).map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
  }

  function handle(req, res, url, { sendJson }) {
    if (url.pathname !== '/api/client-log') return false;
    if (req.method === 'GET') {
      sendJson(res, 200, { entries: read(url.searchParams.get('n')) });
      return true;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      sendJson(res, 405, { error: 'GET or POST only' });
      req.resume();
      return true;
    }
    let raw = '';
    let over = false;
    req.setEncoding('utf8');
    req.on('data', (c) => {
      if (over) return;
      raw += c;
      if (raw.length > MAX_BODY_BYTES) over = true;
    });
    req.on('end', () => {
      if (over) return sendJson(res, 413, { error: `body is over ${MAX_BODY_BYTES} bytes` });
      let body;
      try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'body is not JSON' }); }
      const line = sanitize(body, { now: now(), ua: req.headers['user-agent'] });
      if (!line) return sendJson(res, 400, { error: 'need a JSON object with an `event` string' });
      if (allow()) append(line);
      res.writeHead(204);
      return res.end();
    });
    req.on('error', () => res.destroy());
    return true;
  }

  return { handle, read, file };
}

module.exports = { createClientLog, sanitize, FILE_NAME, MAX_BODY_BYTES, RATE_MAX };
