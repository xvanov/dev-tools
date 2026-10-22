'use strict';

// /pa/* -> the personal assistant's dashboard (personal-assistant/, loopback
// 127.0.0.1:7300 by default). See "The PA proxy" in AGENT.md for why this
// exists and why it adds no capability to anyone who can already reach termhub.
//
// What it has to get right:
//   - **Host is rewritten to the target's host:port.** The PA dashboard refuses
//     any non-loopback Host (its anti-DNS-rebinding guard). Passing the
//     browser's `<machine>.ts.net:7000` through would get every request a 403;
//     relaxing the PA's check instead would weaken direct access for nothing.
//   - **Headers pass through**, `X-PA` in particular: the PA demands `X-PA: 1`
//     on every POST, and that guard still means something here, because termhub
//     answers no CORS preflight — a foreign page can't attach a custom header to
//     a request at this origin any more than at the PA's own.
//   - **A PA that isn't running answers at once**, with a 502 — a page for a
//     browser, JSON for a script — never a hang. Loopback refusal is immediate;
//     the connect timeout covers a port that accepts nothing.
//   - **No response timeout.** Some PA actions run a model for minutes; cutting
//     them off at the proxy would turn a slow answer into a lost one.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_PA_URL = 'http://127.0.0.1:7300';
const PREFIX = '/pa';
const CONNECT_TIMEOUT_MS = 5000;

// `TERMHUB_PA_URL` unset -> the default; set to the empty string -> disabled.
// Anything unparseable also disables it rather than guessing.
function resolvePaUrl(env = process.env) {
  const raw = env.TERMHUB_PA_URL === undefined ? DEFAULT_PA_URL : String(env.TERMHUB_PA_URL).trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

// Same convention as front.js: once headers are out, the only honest move left
// is to cut the connection.
function sendJson(res, status, body) {
  if (res.headersSent) return res.destroy();
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  return res.end(data);
}

function sendDown(req, res, status, message) {
  if (res.headersSent) return res.destroy();
  const wantsHtml = req.method === 'GET' && /text\/html/.test(req.headers.accept || '');
  if (!wantsHtml) return sendJson(res, status, { error: message });
  const page = '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>PA not running</title>'
    + '<style>body{background:#15171c;color:#d7dae0;font:15px/1.5 system-ui,sans-serif;'
    + 'margin:0;padding:32px 16px;max-width:560px}code{color:#6aa9ff}a{color:#6aa9ff}</style>'
    + '</head><body><h1 style="font-size:20px">PA not running</h1>'
    + `<p>termhub couldn't reach the personal assistant's dashboard: <code>${escapeHtml(message)}</code></p>`
    + '<p>Start the PA on this machine, then <a href="">reload</a>. <a href="/">Back to termhub</a></p>'
    + '</body></html>';
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(page) });
  return res.end(page);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Returns a handler `(req, res) => boolean` — true when it took the request.
// `target` is a URL from resolvePaUrl, or null for "disabled".
function createPaProxy(target) {
  return function handlePa(req, res) {
    const qAt = req.url.indexOf('?');
    const pathname = qAt === -1 ? req.url : req.url.slice(0, qAt);
    const search = qAt === -1 ? '' : req.url.slice(qAt);
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;

    if (!target) {
      sendJson(res, 404, { error: 'PA proxy disabled (TERMHUB_PA_URL is empty)' });
      return true;
    }

    // `/pa` -> `/pa/`: the dashboard uses relative URLs (`api/...`), which only
    // resolve under the prefix when the page's own URL ends in a slash.
    if (pathname === PREFIX) {
      res.writeHead(302, { Location: `${PREFIX}/${search}`, 'Content-Length': 0 });
      res.end();
      return true;
    }

    const base = target.pathname.replace(/\/+$/, '');
    const upstreamPath = `${base}${pathname.slice(PREFIX.length)}${search}`;
    const headers = { ...req.headers, host: target.host };
    const mod = target.protocol === 'https:' ? https : http;

    const proxyReq = mod.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: upstreamPath,
      headers,
    }, (proxyRes) => {
      proxyRes.on('error', () => res.destroy());
      const out = { ...proxyRes.headers };
      // A path-absolute redirect from the PA means a path on the PA; keep it
      // inside the prefix so the browser doesn't land on termhub's own page.
      if (typeof out.location === 'string' && /^\/(?!\/)/.test(out.location)) {
        out.location = `${PREFIX}${out.location}`;
      }
      res.writeHead(proxyRes.statusCode, out);
      proxyRes.pipe(res);
    });

    proxyReq.on('socket', (sock) => {
      if (!sock.connecting) return;
      const t = setTimeout(() => proxyReq.destroy(new Error('connect timed out')), CONNECT_TIMEOUT_MS);
      sock.once('connect', () => clearTimeout(t));
      sock.once('close', () => clearTimeout(t));
    });
    proxyReq.on('error', (e) => sendDown(req, res, 502, `PA not running at ${target.origin}: ${e.code || e.message}`));
    req.on('error', () => proxyReq.destroy());
    res.on('close', () => { if (!res.writableFinished) proxyReq.destroy(); });
    req.pipe(proxyReq);
    return true;
  };
}

module.exports = { resolvePaUrl, createPaProxy, DEFAULT_PA_URL };
