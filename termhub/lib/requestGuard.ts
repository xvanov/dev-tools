'use strict';

// The browser-facing guard for every termhub request (both tiers).
//
// termhub's trust model is the tailnet ACL: whoever can reach it can open a
// shell (see AGENT.md, *Security notes*). What termhub must not offer is a way
// in for someone who CANNOT reach it, and a browser is the one thing that can
// be steered into reaching it on their behalf:
//
//   - CSRF: a page on another origin POSTs here from your browser. A plain
//     `<form>` or a `fetch` with `text/plain` needs no preflight, and nothing
//     stops it from carrying a JSON-looking body. So a state-changing request
//     needs a custom `X-Termhub: 1` header, which forces a CORS preflight that
//     termhub never answers, and may not use a preflight-free Content-Type
//     (`POST /api/exec` goes further and demands application/json). An
//     `Origin` that is not this request's own host is refused outright.
//   - Cross-site WebSocket hijacking: WebSockets ignore the same-origin policy
//     and cannot carry custom headers, so `/ws/*` upgrades are judged on
//     `Origin` (and `Host`) alone.
//   - DNS rebinding: a page on evil.example re-points its own name at your
//     tailnet address, and is then same-origin with it — headers and all. The
//     only thing that still differs is `Host`, which still says evil.example.
//     So `Host` must name this machine: loopback, an IP literal (rebinding
//     needs a name), this machine's own name (hostname / TERMHUB_MACHINE, full
//     or first label), this machine's OWN MagicDNS name as `tailscale status`
//     reports it (`Self.DNSName`), or one listed in TERMHUB_ALLOWED_HOSTS.
//     Every name is an EXACT match (case-insensitive, port and trailing dot
//     ignored) — never a suffix. `*.ts.net` used to be accepted wholesale,
//     which let any MagicDNS / Funnel name (someone else's tailnet included)
//     through.
//
// Pure apart from reading env, the hostname and the learned tailnet name, so
// it is tested directly.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const os = require('os');
const net = require('net');
const { execFile } = require('child_process');

function hostnameOf(hostHeader: any) {
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

// ---- this machine's own MagicDNS name, learned from `tailscale status` -------
//
// The check is synchronous (it runs on every request), so the name is learned
// in the background: once when a tier starts (learnSelfNames), and again —
// rate-limited — whenever a `.ts.net` Host arrives that is not known, so a
// tailscale that was not up yet at boot heals on the next request instead of
// 403ing until a restart. Until it is learned, the MagicDNS name is refused
// (fail closed); loopback, IPs and configured names keep working.

const LEARN_MIN_INTERVAL_MS = 30_000;
const LEARN_TIMEOUT_MS = 3000;
let learned = new Set();
let lastLearnAt = 0;
let learning: any = null;

/** Pure: `tailscale status --json` → this machine's own names (lowercased, no trailing dot). */
function selfNamesFromStatus(status: any) {
  const names = new Set();
  const self = status && status.Self;
  if (!self || typeof self !== 'object') return names;
  if (self.DNSName) {
    const n = String(self.DNSName).trim().toLowerCase().replace(/\.$/, '');
    if (n) names.add(n);
  }
  return names;
}

function defaultStatus() {
  return new Promise<any>((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: LEARN_TIMEOUT_MS, windowsHide: true }, (err: any, stdout: any) => {
      if (err || !stdout) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

/**
 * Learn this machine's MagicDNS name. `readStatus` is for tests. Resolves to
 * the learned set. A failed read keeps the previous answer.
 */
function learnSelfNames({ readStatus = defaultStatus }: { readStatus?: any } = {}) {
  if (learning) return learning;
  lastLearnAt = Date.now();
  learning = Promise.resolve()
    .then(readStatus)
    .then((status) => {
      const names = selfNamesFromStatus(status);
      if (names.size) learned = names;
      return learned;
    })
    .catch(() => learned)
    .finally(() => { learning = null; });
  return learning;
}

/**
 * Pure. The startup warning when this machine's MagicDNS name could not be
 * learned (no `tailscale` on termhub's PATH, or tailscale down) and nothing
 * stands in for it: the tailnet address then answers 403 until the name is
 * put in TERMHUB_ALLOWED_HOSTS. Null when there is nothing to say.
 */
function selfNamesWarning(names: any, env: Record<string, string | undefined> = process.env) {
  if (names && names.size) return null;
  if (String(env.TERMHUB_ALLOWED_HOSTS || '').split(',').some((n) => /\.ts\.net\.?$/i.test(n.trim()))) return null;
  return '[termhub] could not learn this machine\'s tailnet name (is `tailscale` on termhub\'s PATH, and up?) — ' +
    'requests to https://<machine>.<tailnet>.ts.net will get 403 until that name is in TERMHUB_ALLOWED_HOSTS ' +
    '(comma-separated). Loopback and IP addresses still work.';
}

/** Learn at startup and say so once if it did not work. */
function learnSelfNamesAndWarn(logWarn: any = (m: any) => console.warn(m)) {
  return learnSelfNames().then((names: any) => {
    const w = selfNamesWarning(names);
    if (w) logWarn(w);
    return names;
  });
}

/** Tests: replace the learned names outright (and suppress background learning). */
function setLearnedNames(names: any) {
  learned = new Set([...(names || [])].map((n) => String(n).toLowerCase().replace(/\.$/, '')));
  lastLearnAt = Date.now();
}

function allowedNames(env: Record<string, string | undefined> = process.env) {
  const names = new Set(['localhost', ...learned]);
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
function hostAllowed(hostHeader: any, env: Record<string, string | undefined> = process.env) {
  const host = hostnameOf(hostHeader);
  if (!host) return false;
  if (net.isIP(host)) return true;
  const name = host.replace(/\.$/, '');
  if (allowedNames(env).has(name)) return true;
  // An unknown MagicDNS name: maybe ours, not learned yet. Refuse THIS request,
  // and look again in the background (rate-limited) so the next one can pass.
  if (name.endsWith('.ts.net') && !learning && Date.now() - lastLearnAt > LEARN_MIN_INTERVAL_MS) {
    learnSelfNames();
  }
  return false;
}

// The Origin rule, shared: a request a browser sends on behalf of some page
// carries that page's Origin, and it must be this very host. Non-browser
// clients (curl, the personal assistant, a peer termhub) send none.
function checkOrigin(h: any) {
  if (!h.origin) return null;
  let originHost = null;
  try { originHost = new URL(h.origin).host.toLowerCase(); } catch { /* "null" or junk */ }
  if (originHost !== String(h.host || '').toLowerCase()) {
    return { status: 403, error: 'cross-origin request refused' };
  }
  return null;
}

function checkHostAndOrigin(req: any, env: Record<string, string | undefined>) {
  const h = req.headers || {};
  if (!hostAllowed(h.host, env)) {
    return { status: 403, error: `Host "${h.host || ''}" is not this machine (set TERMHUB_ALLOWED_HOSTS to allow another name)` };
  }
  return checkOrigin(h);
}

/**
 * null when the request may proceed, else {status, error}. `req` needs only
 * `method` and `headers`. The strict form, for a route that is only ever
 * called by programs with a JSON body: `POST /api/exec`.
 */
function checkProgrammaticRequest(req: any, { env = process.env }: { env?: Record<string, string | undefined> } = {}) {
  const h = req.headers || {};
  const refused = checkHostAndOrigin(req, env);
  if (refused) return refused;
  const type = String(h['content-type'] || '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return { status: 415, error: 'Content-Type must be application/json' };
  if (h['x-termhub'] !== '1') return { status: 403, error: 'missing X-Termhub: 1 header' };
  return null;
}

// The content types a cross-site page can send WITHOUT a CORS preflight
// (the Fetch spec's "CORS-safelisted request-header" values for
// Content-Type). Anything else forces a preflight, which termhub never grants.
const SIMPLE_TYPES = new Set(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The guard for every termhub request that is not a static UI file — the whole
 * session API on both tiers, `/pa/*`, and (via checkUpgrade) the websockets.
 * `pathname` decides which rules apply:
 *
 *   - `/api/*`, `/pa`, `/pa/*`: `Host` must name this machine and a present
 *     `Origin` must be this host — for reads too, because a DNS-rebound page
 *     is same-origin and could otherwise READ the session list or a Claude
 *     transcript. OPTIONS is exempt: it changes nothing and no route answers it
 *     with a CORS grant.
 *   - a state-changing `/api/*` request (anything but GET/HEAD/OPTIONS) also
 *     needs `X-Termhub: 1`, and may not carry a "simple" Content-Type
 *     (text/plain, form-urlencoded, multipart). The header alone already forces
 *     a preflight; refusing the simple types too means a body is never parsed
 *     from a request a `<form>` could have sent. A bodyless DELETE or a binary
 *     upload (`image/png`, `application/octet-stream`) is fine.
 *   - `/pa/*` POSTs are left to the PA's own `X-PA: 1` rule; the Host check
 *     here is what the PA's Host check can no longer do once the proxy has
 *     rewritten `Host` to loopback.
 *
 * Returns null to proceed, else {status, error}.
 */
function checkRequest(req: any, pathname: any, { env = process.env }: { env?: Record<string, string | undefined> } = {}) {
  const api = pathname.startsWith('/api/');
  const pa = pathname === '/pa' || pathname.startsWith('/pa/');
  if (!api && !pa) return null;
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') return null;
  const refused = checkHostAndOrigin(req, env);
  if (refused) return refused;
  if (!api || READ_METHODS.has(method)) return null;
  const h = req.headers || {};
  if (h['x-termhub'] !== '1') return { status: 403, error: 'missing X-Termhub: 1 header' };
  const type = String(h['content-type'] || '').split(';')[0]!.trim().toLowerCase();
  if (SIMPLE_TYPES.has(type)) return { status: 415, error: `Content-Type ${type} is not accepted (send application/json)` };
  return null;
}

/**
 * The websocket form. A page on any origin can open a WebSocket to any host —
 * the same-origin policy does not apply to them, and the browser cannot attach
 * a custom header — so `/ws/term/:id` (type into a shell) is guarded by `Host`
 * and `Origin` alone. Browsers always send `Origin` on a WebSocket; programs
 * (the personal assistant's `ws` client) send none and pass.
 */
function checkUpgrade(req: any, { env = process.env }: { env?: Record<string, string | undefined> } = {}) {
  return checkHostAndOrigin(req, env);
}

// Answer a refused websocket upgrade with a plain HTTP status rather than a
// silent reset, so a client (or someone debugging one) can see why.
function refuseUpgrade(socket: any, { status, error }: { status?: any; error?: any }) {
  const body = JSON.stringify({ error });
  const reason = status === 403 ? 'Forbidden' : 'Refused';
  try {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\n`
      + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  } catch {
    socket.destroy();
  }
}

module.exports = {
  selfNamesWarning,
  learnSelfNamesAndWarn,
  checkProgrammaticRequest, checkRequest, checkUpgrade, refuseUpgrade, hostAllowed, hostnameOf,
  learnSelfNames, selfNamesFromStatus, setLearnedNames,
};
