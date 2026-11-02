'use strict';

// The browser-facing guard for a route meant for programs, not pages.
//
// termhub's trust model is the tailnet ACL: whoever can reach it can open a
// shell (see AGENT.md, *Security notes*). A route a program calls — today
// `POST /api/exec` — adds no capability to that. What it must not add is a way
// in for someone who CANNOT reach termhub, and a browser is the one thing that
// can be steered into reaching it on their behalf:
//
//   - CSRF: a page on another origin POSTs here from your browser. A plain
//     `<form>` or a `fetch` with `text/plain` needs no preflight, and nothing
//     stops it from carrying a JSON-looking body. So the route demands
//     `Content-Type: application/json` AND a custom `X-Termhub: 1` header —
//     either one forces a CORS preflight, and termhub answers none. An
//     `Origin` that is not this request's own host is refused outright.
//   - DNS rebinding: a page on evil.example re-points its own name at your
//     tailnet address, and is then same-origin with it — headers and all. The
//     only thing that still differs is `Host`, which still says evil.example.
//     So `Host` must name this machine: loopback, an IP literal (rebinding
//     needs a name), a MagicDNS name (`*.ts.net`), this machine's own name, or
//     one listed in TERMHUB_ALLOWED_HOSTS.
//
// Pure apart from reading env and the hostname, so it is tested directly.

const os = require('os');
const net = require('net');

function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) { // [::1]:7000
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h.slice(1);
  }
  const colon = h.lastIndexOf(':');
  // An unbracketed host with several colons is a bare IPv6 literal, no port.
  if (colon > 0 && h.indexOf(':') === colon) return h.slice(0, colon);
  return h;
}

function allowedNames(env = process.env) {
  const names = new Set(['localhost']);
  for (const n of [os.hostname(), env.TERMHUB_MACHINE]) {
    if (!n) continue;
    names.add(String(n).toLowerCase());
    names.add(String(n).toLowerCase().split('.')[0]);
  }
  for (const n of String(env.TERMHUB_ALLOWED_HOSTS || '').split(',')) {
    if (n.trim()) names.add(n.trim().toLowerCase());
  }
  return names;
}

/** True when `Host` names this machine rather than someone's rebound domain. */
function hostAllowed(hostHeader, env = process.env) {
  const host = hostnameOf(hostHeader);
  if (!host) return false;
  if (net.isIP(host)) return true;
  if (host.endsWith('.ts.net')) return true;
  return allowedNames(env).has(host.replace(/\.$/, ''));
}

/**
 * null when the request may proceed, else {status, error}. `req` needs only
 * `method` and `headers`.
 */
function checkProgrammaticRequest(req, { env = process.env } = {}) {
  const h = req.headers || {};
  if (!hostAllowed(h.host, env)) {
    return { status: 403, error: `Host "${h.host || ''}" is not this machine (set TERMHUB_ALLOWED_HOSTS to allow another name)` };
  }
  if (h.origin) {
    let originHost = null;
    try { originHost = new URL(h.origin).host.toLowerCase(); } catch { /* "null" or junk */ }
    if (originHost !== String(h.host || '').toLowerCase()) {
      return { status: 403, error: 'cross-origin request refused' };
    }
  }
  const type = String(h['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return { status: 415, error: 'Content-Type must be application/json' };
  if (h['x-termhub'] !== '1') return { status: 403, error: 'missing X-Termhub: 1 header' };
  return null;
}

module.exports = { checkProgrammaticRequest, hostAllowed, hostnameOf };
