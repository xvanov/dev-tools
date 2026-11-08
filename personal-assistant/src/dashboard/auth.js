'use strict';

// Passkey sign-in for the dashboard (plan 7.1). Everything here is inert unless
// PA_PASSKEYS=on; with it off server.js never calls gate() and the routes
// answer 404, so the access path is exactly what it was.
//
// With the flag ON:
//   - gate() runs after the Host check. A request needs a live passkey session
//     (cookie `pa_session`), except: /api/auth/* (which guard themselves), the
//     sign-in page and its script, the shared theme, /healthz (the supervisor's
//     readiness probe) and /api/version.
//   - NEVER LOCKED OUT: while no passkey is registered, the gate stays open, so
//     the first visit can register one. `pa passkeys reset` (local console)
//     returns to that state. See AGENT.md "Passkey sessions".
//   - the existing guards (loopback Host, X-PA on POST, page tokens) still apply
//     on top; a passkey session adds to them, it does not replace them.
//
// Endpoints (POST ones need X-PA: 1 like every other POST):
//   GET  /api/auth/status             {enabled, registered, signedIn, rpId}
//   GET  /api/auth/check              200 when this cookie is a live session (or the gate is
//                                     open), else 401: termhub's front asks this
//   POST /api/auth/register/options   first passkey: open; later ones: a session
//   POST /api/auth/register/verify    {ceremonyId, response, label}; the first one signs you in
//   POST /api/auth/login/options
//   POST /api/auth/login/verify       {ceremonyId, response}; sets the cookie
//   POST /api/auth/logout
//   POST /api/auth/stepup/options     {approvalId}; needs a session
//   POST /api/auth/stepup/verify      {ceremonyId, approvalId, response}; records the grant

const fs = require('fs');
const path = require('path');
const { enabled } = require('../auth/settings');
const session = require('../auth/session');
const { createCeremonies, AuthError } = require('../auth/ceremony');

const APPROVAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PUBLIC = new Set(['/login', '/login.js', '/theme.css', '/nav.js', '/healthz', '/api/version']);
const FAIL_WINDOW_MS = 60_000;
const FAIL_MAX = 10;

let ceremonies = null; // one per process: challenges live in memory
let injected = null; // tests: a stand-in repository set
const fails = [];

function repos() {
  return injected || require('../repo');
}

function ceremony() {
  return (ceremonies ||= createCeremonies({ repos: repos() }));
}

/** Test hook: a fresh ceremony store (and an injected repo). */
function reset(deps) {
  injected = deps ? deps.repos : null;
  ceremonies = deps ? createCeremonies(deps) : null;
  fails.length = 0;
}

const isSecure = (req) => /^https:/i.test(String(req.headers.origin || '')) || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';

function tooMany(now = Date.now()) {
  while (fails.length && now - fails[0] > FAIL_WINDOW_MS) fails.shift();
  return fails.length >= FAIL_MAX;
}

/** Runs the check, and counts a failure against the sign-in rate limit. */
async function guarded(fn) {
  if (tooMany()) throw new AuthError('too many failed attempts; wait a minute', 429);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuthError && err.status !== 409) fails.push(Date.now());
    throw err;
  }
}

async function sessionOf(req, res) {
  const s = await session.validate(repos(), req, { secure: isSecure(req) });
  if (s && s.setCookie) res.setHeader('Set-Cookie', s.setCookie);
  return s;
}

/**
 * The gate for every request when passkeys are on. Resolves true when it
 * answered the request (refused it), false to let it through.
 */
async function gate(req, res, url, { send }) {
  if (!enabled()) return false;
  if (url.pathname.startsWith('/api/auth/') || PUBLIC.has(url.pathname)) return false;
  let count;
  try {
    count = await repos().passkeys.credentialCount();
  } catch (err) {
    // The store is unreachable: fail OPEN rather than lock the owner out of the
    // page that could tell them why. Every other guard still applies.
    return false;
  }
  if (count === 0) return false; // nothing registered yet: the way in is registering the first one
  if (await sessionOf(req, res)) return false;
  if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '') && !url.pathname.startsWith('/api/')) {
    res.writeHead(302, { Location: 'login', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  send(res, 401, { error: 'passkey sign-in required', login: true });
  return true;
}

function bad(res, send, err) {
  if (err instanceof AuthError) return send(res, err.status, { error: err.message });
  if (err && err.message === 'bad json') return send(res, 400, { error: 'bad json' });
  throw err;
}

/** The /api/auth/* routes and the sign-in page. Resolves true when it took the request. */
async function route(req, res, url, { send, readJson }) {
  const p = url.pathname;
  if (p !== '/login' && p !== '/login.js' && !p.startsWith('/api/auth/')) return false;
  if (req.method === 'GET' && p === '/login.js') {
    // The script is inert without the flag (paAuth just defines itself); pages load it unconditionally.
    send(res, 200, fs.readFileSync(path.join(__dirname, 'login.client.js'), 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  if (!enabled()) {
    if (p.startsWith('/api/auth/')) { send(res, 404, { error: 'passkeys are off (PA_PASSKEYS)' }); return true; }
    return false;
  }

  if (req.method === 'GET' && p === '/login') {
    send(res, 200, fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8'), 'text/html; charset=utf-8');
    return true;
  }
  if (req.method === 'GET' && p === '/login.js') {
    send(res, 200, fs.readFileSync(path.join(__dirname, 'login.client.js'), 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }

  const r = repos();
  if (req.method === 'GET' && (p === '/api/auth/status' || p === '/api/auth/check')) {
    const count = await r.passkeys.credentialCount();
    const s = await sessionOf(req, res);
    if (p === '/api/auth/check') {
      if (count === 0 || s) { send(res, 200, { ok: true }); return true; }
      send(res, 401, { error: 'passkey sign-in required', login: true });
      return true;
    }
    send(res, 200, { enabled: true, registered: count, signedIn: Boolean(s), rpId: require('../auth/settings').settings().rpId });
    return true;
  }

  if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return true; }
  if (req.headers['x-pa'] !== '1') { send(res, 403, { error: 'missing X-PA header' }); return true; }

  try {
    if (p === '/api/auth/logout') {
      await session.end(r, req);
      res.setHeader('Set-Cookie', session.clearCookie(isSecure(req)));
      send(res, 200, { ok: true });
      return true;
    }

    const body = await readJson(req);

    if (p === '/api/auth/register/options' || p === '/api/auth/register/verify') {
      // The first passkey needs nothing (the gate is open until it exists); more need a session.
      const count = await r.passkeys.credentialCount();
      const s = count === 0 ? null : await sessionOf(req, res);
      if (count > 0 && !s) { send(res, 401, { error: 'sign in with an existing passkey to add another' }); return true; }
      if (p.endsWith('/options')) { send(res, 200, await ceremony().registrationOptions()); return true; }
      const out = await guarded(() => ceremony().verifyRegistration({ ceremonyId: body.ceremonyId, response: body.response, label: body.label }));
      if (count === 0) {
        const issued = await session.issue(r, out.id, { secure: isSecure(req) });
        res.setHeader('Set-Cookie', issued.setCookie);
      }
      send(res, 200, { ok: true, id: out.id, signedIn: count === 0 || Boolean(s) });
      return true;
    }

    if (p === '/api/auth/login/options') { send(res, 200, await ceremony().authenticationOptions()); return true; }

    if (p === '/api/auth/login/verify') {
      const out = await guarded(() => ceremony().verifyAuthentication({ ceremonyId: body.ceremonyId, response: body.response }));
      const issued = await session.issue(r, out.credentialId, { secure: isSecure(req) });
      res.setHeader('Set-Cookie', issued.setCookie);
      send(res, 200, { ok: true });
      return true;
    }

    if (p === '/api/auth/stepup/options' || p === '/api/auth/stepup/verify') {
      if (!(await sessionOf(req, res))) { send(res, 401, { error: 'passkey sign-in required', login: true }); return true; }
      const approvalId = String(body.approvalId || '');
      if (!APPROVAL_ID.test(approvalId)) { send(res, 400, { error: 'approvalId is required' }); return true; }
      if (p.endsWith('/options')) { send(res, 200, await ceremony().authenticationOptions({ approvalId })); return true; }
      const out = await guarded(() => ceremony().verifyAuthentication({ ceremonyId: body.ceremonyId, response: body.response, approvalId }));
      await ceremony().grantStepUp(out);
      send(res, 200, { ok: true, approvalId });
      return true;
    }
  } catch (err) {
    bad(res, send, err);
    return true;
  }

  send(res, 404, { error: 'unknown auth route' });
  return true;
}

module.exports = { gate, route, reset, PUBLIC };
