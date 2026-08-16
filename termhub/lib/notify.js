'use strict';

// Push notifications via ntfy — the same mechanism docrag's listing monitor
// uses (POST the body to https://ntfy.sh/<topic>, metadata in headers), for the
// same reason: your phone already has the app, there is no account, no API key
// and no polling, and a notification carries a Click URL that opens straight
// back into the thing that needs you.
//
// Configuration, first hit wins:
//   TERMHUB_NTFY_TOPIC / TERMHUB_NTFY_SERVER   (env — per machine, wins)
//   <dataDir>/notify.json  { "topic": "...", "server": "https://ntfy.sh" }
//
// **The topic IS the secret.** ntfy.sh has no auth: anyone who knows the topic
// can read every notification published to it and publish to it themselves. So
// it is a long random string, it is never logged, and it lives in the data dir
// rather than in the repo. Rotate by editing notify.json.
//
// Delivery is best-effort and silent by design. This runs inside `sessiond`,
// the process holding every terminal on the machine — a DNS failure, a captive
// portal or a 500 from ntfy must cost a missed buzz and nothing else, so
// every path here resolves `false` instead of throwing or retrying.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { dataDir } = require('./paths');

const DEFAULT_SERVER = 'https://ntfy.sh';
const TIMEOUT_MS = 10000;

let cached = null;
let cachedAt = 0;
const CONFIG_TTL_MS = 30000;

function readConfigFile() {
  try {
    const raw = fs.readFileSync(path.join(dataDir(), 'notify.json'), 'utf8');
    // Strip a UTF-8 BOM before parsing. This file is hand-written, and on
    // Windows the obvious way to write it — `... | Out-File -Encoding utf8` in
    // PowerShell 5.1 — emits a BOM, which makes JSON.parse throw. The failure
    // mode is silent (config ignored, notifications simply never arrive), so
    // tolerating the BOM is worth more here than being strict about it.
    const data = JSON.parse(raw.replace(/^﻿/, ''));
    if (data && typeof data === 'object') return data;
  } catch {
    // no config file is the normal state on a machine that hasn't opted in
  }
  return {};
}

// Re-read periodically rather than once at boot: sessiond is the tier that is
// deliberately never restarted, so a config only read at startup would mean
// "turn notifications on" costs you every live terminal.
function config() {
  const now = Date.now();
  if (cached && now - cachedAt < CONFIG_TTL_MS) return cached;
  const file = readConfigFile();
  const topic = String(process.env.TERMHUB_NTFY_TOPIC || file.topic || '').trim();
  const server = String(process.env.TERMHUB_NTFY_SERVER || file.server || DEFAULT_SERVER).trim();
  cached = { topic, server: server.replace(/\/+$/, '') };
  cachedAt = now;
  return cached;
}

function enabled() {
  return !!config().topic;
}

// HTTP headers are latin-1; a title with an emoji or an em-dash in it makes
// Node throw on setHeader, which would take out the caller. Tags carry the
// emoji instead — ntfy renders those itself, from ASCII names.
function headerSafe(value, max = 200) {
  const clean = String(value == null ? '' : value)
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…`.replace(/[^\x20-\x7e]/g, '') : clean;
}

// Post one notification. Resolves true if ntfy accepted it, false for anything
// else — including "not configured", which is not an error but the default.
// NOTE: there is deliberately no "collapse repeats" option. `X-Tags` reads like
// one and is not — ntfy treats it as an alias of `Tags`, so passing a grouping
// key there silently REPLACED the emoji tags with a raw session id in the
// notification. ntfy has no replace-this-notification header; the escalating
// series is kept tolerable by widening the gaps instead (see idleHub).
function send({ title, message, priority, tags, click } = {}) {
  const { topic, server } = config();
  if (!topic) return Promise.resolve(false);
  const body = Buffer.from(String(message == null ? '' : message), 'utf8');

  let url;
  try { url = new URL(`${server}/${encodeURIComponent(topic)}`); } catch { return Promise.resolve(false); }
  const lib = url.protocol === 'http:' ? http : https;

  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length };
  if (title) headers.Title = headerSafe(title);
  if (priority) headers.Priority = String(priority);
  if (tags) headers.Tags = headerSafe(Array.isArray(tags) ? tags.join(',') : tags);
  // Tapping the notification opens this. It is the entire point of the layer:
  // the buzz is only useful if it puts you one tap from the terminal that is
  // waiting — see idleHub's deep link.
  if (click) headers.Click = headerSafe(click, 500);

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const req = lib.request(
      { method: 'POST', hostname: url.hostname, port: url.port || undefined, path: url.pathname, headers },
      (res) => {
        res.resume(); // drain, we don't care about the body
        done(res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
    req.end(body);
  });
}

// For /api/idle: enough for the UI to say "notifications are on, to this topic"
// without a second round-trip. The topic is shown deliberately — it is the only
// thing you need to subscribe a new phone, and this API is loopback/tailnet.
function status() {
  const { topic, server } = config();
  return { enabled: !!topic, server, topic: topic || null };
}

module.exports = { send, enabled, status, config };
