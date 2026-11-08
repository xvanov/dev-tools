'use strict';

// Passkey sessions (plan 7.1): an opaque random cookie, HttpOnly and
// SameSite=Strict, whose SHA-256 is the row key in passkey_session (a leaked
// database does not hand out live cookies). Short idle lifetime that slides
// while the page is used, capped by a hard ceiling so a session cannot be
// renewed forever. Only a passkey assertion creates one (src/auth/ceremony.js).

const crypto = require('crypto');
const { settings } = require('./settings');

const COOKIE = 'pa_session';

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieValue(req) {
  const v = parseCookies(req.headers && req.headers.cookie)[COOKIE];
  return v && /^[A-Za-z0-9_-]{20,128}$/.test(v) ? v : null;
}

/** Set-Cookie value. `secure` is true when the browser reached us over https. */
function setCookie(token, maxAgeSec, secure) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}${secure ? '; Secure' : ''}`;
}

const clearCookie = (secure) => setCookie('', 0, secure);

/**
 * Opens a session for `credentialId` and returns the cookie to set.
 * @returns {Promise<{token: string, setCookie: string, expiresAt: Date}>}
 */
async function issue(repos, credentialId, { now = new Date(), secure = false, rand = crypto.randomBytes } = {}) {
  const s = settings();
  const token = rand(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + s.idleMs);
  const hardExpiresAt = new Date(now.getTime() + s.hardMs);
  await repos.passkeys.createSession({ tokenHash: hash(token), credentialId, now, expiresAt, hardExpiresAt });
  return { token, setCookie: setCookie(token, Math.min(s.idleMs, s.hardMs) / 1000, secure), expiresAt };
}

/**
 * The live session behind a request's cookie, or null. A session used past
 * the half of its idle window is renewed (never beyond its hard ceiling), and
 * the result says so, so the caller can re-issue the cookie with the new age.
 * @returns {Promise<{credentialId: string, tokenHash: string, renewed: boolean, setCookie: string|null}|null>}
 */
async function validate(repos, req, { now = new Date(), secure = false } = {}) {
  const token = cookieValue(req);
  if (!token) return null;
  const tokenHash = hash(token);
  const row = await repos.passkeys.getSession(tokenHash, now);
  if (!row) return null;
  const s = settings();
  const expires = new Date(row.expiresAt).getTime();
  const hard = new Date(row.hardExpiresAt).getTime();
  let renewed = false;
  let cookie = null;
  if (expires - now.getTime() < s.idleMs / 2) {
    const next = Math.min(now.getTime() + s.idleMs, hard);
    await repos.passkeys.renewSession(tokenHash, now, new Date(next));
    renewed = true;
    cookie = setCookie(token, (next - now.getTime()) / 1000, secure);
  }
  return { credentialId: row.credentialId, tokenHash, renewed, setCookie: cookie };
}

/** Ends the session behind a request's cookie (logout). */
async function end(repos, req) {
  const token = cookieValue(req);
  if (token) await repos.passkeys.deleteSession(hash(token));
}

module.exports = { COOKIE, hash, parseCookies, cookieValue, setCookie, clearCookie, issue, validate, end };
