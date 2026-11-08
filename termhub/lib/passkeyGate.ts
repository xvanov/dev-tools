'use strict';

// Passkey sessions at termhub's front (plan 7.1). OFF unless PA_PASSKEYS=on in
// the front's environment: then every /api/* and /ws/* request must carry a
// live passkey session, or termhub answers 401 and the page shows the sign-in
// at /pa/login. termhub holds no passkeys and no sessions itself: it asks the
// personal assistant's dashboard (GET /api/auth/check, loopback, with the
// browser's Cookie header), which owns both. So there is one sign-in, one
// cookie, and /pa/* needs no gate here because the dashboard gates itself.
//
// Never locked out:
//   - a request that comes straight from this machine (loopback peer AND no
//     X-Forwarded-For / Tailscale-* header, which Tailscale Serve always adds
//     and a tailnet peer cannot remove) is let through: the local console is
//     the recovery path, and it is how you restart a PA that is down;
//   - while the PA has no passkey registered its check says ok, so the first
//     visit can register one;
//   - if the PA cannot be reached, a REMOTE request is refused (503): a gate
//     that fails open is not a gate.
//
// Pure apart from the injected `check` (an HTTP call in production).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const CACHE_MS = 10_000;
const TIMEOUT_MS = 3000;
// What stays reachable without a session: health and version probes (the
// updater's and the pages' own), and the PA proxy (the dashboard gates itself).
const OPEN = [/^\/api\/health$/, /^\/api\/version$/, /^\/pa(\/|$)/];

function isRemote(req: any) {
  const h = req.headers || {};
  const addr = String((req.socket && req.socket.remoteAddress) || '');
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const forwarded = Boolean(h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-forwarded-proto'] || Object.keys(h).some((k) => k.startsWith('tailscale-')));
  return !loopback || forwarded;
}

function guarded(pathname: any) {
  if (OPEN.some((re) => re.test(pathname))) return false;
  return pathname.startsWith('/api/') || pathname.startsWith('/ws/');
}

/** GET <pa>/api/auth/check with the browser's cookie. Resolves 'ok' | 'no' | 'down'. */
function httpCheck(target: any, cookie: any) {
  return new Promise<any>((resolve) => {
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: `${target.pathname.replace(/\/+$/, '')}/api/auth/check`,
      headers: { host: target.host, cookie: cookie || '' },
      timeout: TIMEOUT_MS,
    }, (res: any) => {
      res.resume();
      resolve(res.statusCode === 200 ? 'ok' : res.statusCode === 401 ? 'no' : 'down');
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve('down'));
    req.end();
  });
}

/**
 * @param {{env?: object, paUrl?: URL|null, check?: (cookie:string)=>Promise<'ok'|'no'|'down'>, now?: ()=>number}} [opts]
 * @returns {{enabled: boolean, verdict: (req: object, pathname: string) => Promise<{ok: true}|{ok: false, status: number, error: string}>}}
 */
function createPasskeyGate({ env = process.env, paUrl = null, check, now = Date.now }: { env?: Record<string, string | undefined>; paUrl?: any | null | undefined; check?: any; now?: any } = {}) {
  const enabled = String(env.PA_PASSKEYS || 'off').trim().toLowerCase() === 'on';
  const ask = check || ((cookie: any) => (paUrl ? httpCheck(paUrl, cookie) : Promise.resolve('down')));
  const cache = new Map(); // sha256(cookie) -> expires (positive answers only)

  async function verdict(req: any, pathname: any) {
    if (!enabled || !guarded(pathname) || !isRemote(req)) return { ok: true };
    const cookie = String((req.headers && req.headers.cookie) || '');
    const key = crypto.createHash('sha256').update(cookie).digest('hex');
    const t = now();
    for (const [k, exp] of cache) if (exp <= t) cache.delete(k);
    if (cache.has(key)) return { ok: true };
    const answer = await ask(cookie);
    if (answer === 'ok') {
      if (cache.size > 200) cache.clear();
      cache.set(key, t + CACHE_MS);
      return { ok: true };
    }
    if (answer === 'no') return { ok: false, status: 401, error: 'passkey sign-in required: open /pa/login' };
    return { ok: false, status: 503, error: 'passkey check unavailable (the personal assistant is not answering)' };
  }

  return { enabled, verdict };
}

module.exports = { createPasskeyGate, isRemote, guarded };
