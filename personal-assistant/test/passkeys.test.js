'use strict';

// Passkeys (plan 7.1): registration and assertion against fixed vectors (a
// software authenticator with a fixed key, test/_webauthn.js), step-up binding
// to one approval id, one-use grants, and expiry of challenges, grants and
// sessions, all on a fixed clock. The SQL itself is covered by
// test/contract/passkeys.contract.js; here the aggregate is an in-memory
// stand-in with the same semantics so the suite runs without Postgres.
//
//   node test/passkeys.test.js

const assert = require('assert');
const crypto = require('crypto');
const wa = require('./_webauthn');

process.env.PA_PASSKEY_ORIGINS = wa.ORIGIN;
process.env.PA_PASSKEY_RP_ID = wa.RP_ID;
process.env.PA_PASSKEYS = 'on';

const { createCeremonies } = require('../src/auth/ceremony');
const session = require('../src/auth/session');
const stepup = require('../src/auth/stepup');
const { settings } = require('../src/auth/settings');

// ---- fixed clock and deterministic randomness -----------------------------
let clock = new Date('2026-11-07T10:00:00Z').getTime();
const now = () => new Date(clock);
const tick = (ms) => { clock += ms; };
let seq = 0;
const rand = (n) => Buffer.alloc(n, (++seq % 250) + 1);

// ---- an in-memory passkeys aggregate (same semantics as src/repo/passkeys.js)
function fakeRepos() {
  const creds = new Map();
  const sessions = new Map();
  const grants = new Map();
  const t = (d) => new Date(d).getTime();
  return {
    passkeys: {
      credentialCount: async () => creds.size,
      listCredentials: async () => [...creds.values()],
      getCredential: async (id) => creds.get(id) || null,
      addCredential: async (c) => { if (creds.has(c.id)) throw new Error('dup'); creds.set(c.id, { counter: 0, transports: [], label: '', lastUsedAt: null, ...c }); },
      touchCredential: async (id, counter, at) => { Object.assign(creds.get(id), { counter, lastUsedAt: at }); },
      deleteCredentials: async () => { const n = creds.size; creds.clear(); return n; },
      createSession: async (s) => { sessions.set(s.tokenHash, { ...s }); },
      getSession: async (h, at) => { const s = sessions.get(h); return s && t(s.expiresAt) > t(at) && t(s.hardExpiresAt) > t(at) ? s : null; },
      renewSession: async (h, at, exp) => { const s = sessions.get(h); if (s && t(s.expiresAt) > t(at)) s.expiresAt = exp; },
      deleteSession: async (h) => { sessions.delete(h); },
      deleteSessions: async () => { const n = sessions.size; sessions.clear(); return n; },
      grantStepUp: async (g) => { grants.set(g.approvalId, { ...g, consumed: false }); },
      hasStepUp: async (id, at) => { const g = grants.get(id); return Boolean(g && !g.consumed && t(g.expiresAt) > t(at)); },
      consumeStepUp: async (id, at) => { const g = grants.get(id); if (!g || g.consumed || t(g.expiresAt) <= t(at)) return false; g.consumed = true; return true; },
      purgeExpired: async () => ({ sessions: 0, stepUps: 0 }),
    },
  };
}

async function registered(repos, c) {
  const { ceremonyId, options } = await c.registrationOptions();
  await c.verifyRegistration({ ceremonyId, response: wa.register({ challenge: options.challenge }), label: 'test' });
}

async function rejects(p, re, what) {
  await assert.rejects(p, re, what);
}

const cases = {
  async 'registration: a valid create() result stores the passkey with its COSE key'() {
    const repos = fakeRepos();
    const c = createCeremonies({ repos, now, rand });
    const { ceremonyId, options } = await c.registrationOptions();
    assert.strictEqual(options.rp.id, 'localhost');
    assert.strictEqual(options.authenticatorSelection.userVerification, 'required');
    assert.strictEqual(options.attestation, 'none');
    const out = await c.verifyRegistration({ ceremonyId, response: wa.register({ challenge: options.challenge }), label: 'work laptop' });
    assert.strictEqual(out.id, wa.b64(wa.CRED_ID));
    const stored = await repos.passkeys.getCredential(out.id);
    assert.strictEqual(stored.label, 'work laptop');
    assert.strictEqual(stored.counter, 0);
    assert.ok(Buffer.from(stored.publicKey, 'base64url').length > 60, 'a COSE EC2 key');
  },

  async 'registration: wrong origin, wrong rp id, no user verification, wrong challenge are all refused'() {
    for (const [what, resp] of [
      ['origin', (ch) => wa.register({ challenge: ch, origin: 'https://evil.example' })],
      ['rp id', (ch) => wa.register({ challenge: ch, rpId: 'evil.example' })],
      ['user verification', (ch) => wa.register({ challenge: ch, uv: false })],
      ['challenge', () => wa.register({ challenge: wa.b64(Buffer.alloc(32, 9)) })],
    ]) {
      const repos = fakeRepos();
      const c = createCeremonies({ repos, now, rand });
      const { ceremonyId, options } = await c.registrationOptions();
      await rejects(c.verifyRegistration({ ceremonyId, response: resp(options.challenge) }), /registration refused/, what);
      assert.strictEqual(await repos.passkeys.credentialCount(), 0, `nothing stored for a bad ${what}`);
    }
  },

  async 'registration: a ceremony is single use and expires after two minutes'() {
    const repos = fakeRepos();
    const c = createCeremonies({ repos, now, rand });
    const a = await c.registrationOptions();
    await c.verifyRegistration({ ceremonyId: a.ceremonyId, response: wa.register({ challenge: a.options.challenge }) });
    await rejects(c.verifyRegistration({ ceremonyId: a.ceremonyId, response: wa.register({ challenge: a.options.challenge }) }), /unknown or expired/, 'replay');
    const b = await c.registrationOptions();
    tick(settings().challengeMs + 1);
    await rejects(c.verifyRegistration({ ceremonyId: b.ceremonyId, response: wa.register({ challenge: b.options.challenge }) }), /unknown or expired/, 'expired');
    await rejects(c.verifyRegistration({ ceremonyId: 'never-issued', response: {} }), /unknown or expired/, 'unknown');
  },

  async 'assertion: sign-in verifies the signature, then the counter moves forward only'() {
    const repos = fakeRepos();
    const c = createCeremonies({ repos, now, rand });
    await registered(repos, c);
    let a = await c.authenticationOptions();
    assert.strictEqual(a.options.userVerification, 'required');
    const ok = await c.verifyAuthentication({ ceremonyId: a.ceremonyId, response: wa.assert({ challenge: a.options.challenge, counter: 5 }) });
    assert.strictEqual(ok.credentialId, wa.b64(wa.CRED_ID));
    assert.strictEqual(ok.approvalId, null);
    assert.strictEqual((await repos.passkeys.getCredential(ok.credentialId)).counter, 5);
    // a clone replaying an older counter is refused
    a = await c.authenticationOptions();
    await rejects(c.verifyAuthentication({ ceremonyId: a.ceremonyId, response: wa.assert({ challenge: a.options.challenge, counter: 3 }) }), /assertion refused/, 'counter went back');
  },

  async 'assertion: another key, wrong challenge, wrong origin, no user verification, unknown credential are refused'() {
    for (const [what, resp, re] of [
      ['signature from another key', (ch) => wa.assert({ challenge: ch, key: { ...wa.otherKey() } }), /assertion refused/],
      ['challenge', () => wa.assert({ challenge: wa.b64(Buffer.alloc(32, 7)) }), /assertion refused/],
      ['origin', (ch) => wa.assert({ challenge: ch, origin: 'https://evil.example' }), /assertion refused/],
      ['user verification', (ch) => wa.assert({ challenge: ch, uv: false }), /assertion refused/],
      ['credential', (ch) => ({ ...wa.assert({ challenge: ch }), id: 'bm9wZQ', rawId: 'bm9wZQ' }), /unknown passkey/],
    ]) {
      const repos = fakeRepos();
      const c = createCeremonies({ repos, now, rand });
      await registered(repos, c);
      const a = await c.authenticationOptions();
      await rejects(c.verifyAuthentication({ ceremonyId: a.ceremonyId, response: resp(a.options.challenge) }), re, what);
    }
  },

  async 'assertion: no passkey registered is a 409, not a crash'() {
    const c = createCeremonies({ repos: fakeRepos(), now, rand });
    await assert.rejects(c.authenticationOptions(), (e) => e.status === 409);
  },

  async 'step-up: the challenge commits to the approval id, and the grant is for that id only'() {
    const repos = fakeRepos();
    const c = createCeremonies({ repos, now, rand });
    await registered(repos, c);
    const a = await c.authenticationOptions({ approvalId: 'appr-A' });
    const prefix = crypto.createHash('sha256').update('x').digest().length; // 32-byte digest
    assert.strictEqual(Buffer.from(a.options.challenge, 'base64url').length, prefix);
    const out = await c.verifyAuthentication({ ceremonyId: a.ceremonyId, approvalId: 'appr-A', response: wa.assert({ challenge: a.options.challenge, counter: 1 }) });
    assert.strictEqual(out.approvalId, 'appr-A');
    await c.grantStepUp(out);
    assert.deepStrictEqual(await stepup.hasStepUp('appr-A', { repos, now: now() }), { ok: true, reason: 'passkey step-up' });
    assert.strictEqual((await stepup.hasStepUp('appr-B', { repos, now: now() })).ok, false, 'a different approval id has no grant');
  },

  async 'step-up: an assertion opened for A cannot be spent on B, nor a sign-in used as a step-up'() {
    const repos = fakeRepos();
    const c = createCeremonies({ repos, now, rand });
    await registered(repos, c);
    const a = await c.authenticationOptions({ approvalId: 'appr-A' });
    await rejects(c.verifyAuthentication({ ceremonyId: a.ceremonyId, approvalId: 'appr-B', response: wa.assert({ challenge: a.options.challenge, counter: 1 }) }), /another approval/, 'A -> B');
    const login = await c.authenticationOptions();
    await rejects(c.verifyAuthentication({ ceremonyId: login.ceremonyId, approvalId: 'appr-C', response: wa.assert({ challenge: login.options.challenge, counter: 2 }) }), /unknown or expired/, 'login ceremony as step-up');
    const stepCeremony = await c.authenticationOptions({ approvalId: 'appr-D' });
    await rejects(c.verifyAuthentication({ ceremonyId: stepCeremony.ceremonyId, response: wa.assert({ challenge: stepCeremony.options.challenge, counter: 3 }) }), /unknown or expired/, 'step-up ceremony as sign-in');
    assert.strictEqual((await stepup.hasStepUp('appr-A', { repos, now: now() })).ok, false, 'a refused assertion grants nothing');
  },

  async 'step-up: a grant is used up by the action, and expires'() {
    const repos = fakeRepos();
    const c = createCeremonies({ repos, now, rand });
    await registered(repos, c);
    const grant = async (id, counter) => {
      const a = await c.authenticationOptions({ approvalId: id });
      await c.grantStepUp(await c.verifyAuthentication({ ceremonyId: a.ceremonyId, approvalId: id, response: wa.assert({ challenge: a.options.challenge, counter }) }));
    };
    await grant('appr-1', 1);
    assert.strictEqual((await stepup.hasStepUp('appr-1', { repos, now: now() })).ok, true, 'looking does not use it');
    assert.strictEqual((await stepup.hasStepUp('appr-1', { repos, now: now(), consume: true })).ok, true);
    assert.strictEqual((await stepup.hasStepUp('appr-1', { repos, now: now(), consume: true })).ok, false, 'one use');
    await grant('appr-2', 2);
    tick(settings().stepUpMs - 1);
    assert.strictEqual((await stepup.hasStepUp('appr-2', { repos, now: now() })).ok, true, 'still inside its window');
    tick(1);
    assert.strictEqual((await stepup.hasStepUp('appr-2', { repos, now: now(), consume: true })).ok, false, 'expired');
    assert.strictEqual((await stepup.hasStepUp('', { repos })).ok, false);
    assert.strictEqual((await stepup.hasStepUp(undefined, { repos })).ok, false);
  },

  async 'step-up: required only for merge, push to main and secret reveal, and only when the flag is on'() {
    for (const k of ['merge', 'push_main', 'secret_reveal']) assert.strictEqual(stepup.requiresStepUp(k), true, k);
    for (const k of ['read', 'draft', 'push_branch', 'toString']) assert.strictEqual(stepup.requiresStepUp(k), false, k);
    process.env.PA_PASSKEYS = 'off';
    try {
      for (const k of stepup.HIGH_RISK) assert.strictEqual(stepup.requiresStepUp(k), false, `${k} with the flag off`);
    } finally { process.env.PA_PASSKEYS = 'on'; }
    delete process.env.PA_PASSKEYS;
    assert.strictEqual(stepup.enabled(), false, 'unset means off');
    process.env.PA_PASSKEYS = 'on';
  },

  async 'session: issued on sign-in, HttpOnly + SameSite=Strict, only its hash is stored'() {
    const repos = fakeRepos();
    const s = await session.issue(repos, 'cred', { now: now(), rand });
    assert.match(s.setCookie, /^pa_session=[A-Za-z0-9_-]{20,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=1800$/);
    assert.ok(!/Secure/.test(s.setCookie), 'no Secure over plain loopback http');
    assert.match((await session.issue(repos, 'cred', { now: now(), secure: true, rand })).setCookie, /; Secure$/);
    const req = { headers: { cookie: `x=1; pa_session=${s.token}` } };
    const v = await session.validate(repos, req, { now: now() });
    assert.strictEqual(v.credentialId, 'cred');
    assert.strictEqual(await repos.passkeys.getSession(s.token, now()), null, 'the raw cookie is not the row key');
    assert.strictEqual(await session.validate(repos, { headers: { cookie: 'pa_session=garbage' } }, { now: now() }), null);
    assert.strictEqual(await session.validate(repos, { headers: {} }, { now: now() }), null);
  },

  async 'session: idle expiry slides with use, the hard ceiling does not, logout ends it'() {
    const repos = fakeRepos();
    const cfg = settings();
    const s = await session.issue(repos, 'cred', { now: now(), rand });
    const req = { headers: { cookie: `pa_session=${s.token}` } };
    tick(cfg.idleMs * 0.4);
    assert.strictEqual((await session.validate(repos, req, { now: now() })).renewed, false, 'early use does not write');
    tick(cfg.idleMs * 0.4); // 0.8 of the window gone: renew
    const r = await session.validate(repos, req, { now: now() });
    assert.strictEqual(r.renewed, true);
    assert.match(r.setCookie, /^pa_session=.*Max-Age=1800/);
    tick(cfg.idleMs * 0.9);
    assert.ok(await session.validate(repos, req, { now: now() }), 'alive past the original expiry because it was used');
    // idle past the window: gone
    tick(cfg.idleMs + 1);
    assert.strictEqual(await session.validate(repos, req, { now: now() }), null, 'idle expired');
    // the ceiling: keep using it and it still ends at hardMs
    const s2 = await session.issue(repos, 'cred', { now: now(), rand });
    const req2 = { headers: { cookie: `pa_session=${s2.token}` } };
    const born = clock;
    let alive = true;
    while (clock - born < cfg.hardMs - 1) {
      tick(Math.min(cfg.idleMs * 0.6, cfg.hardMs - 1 - (clock - born)));
      alive = Boolean(await session.validate(repos, req2, { now: now() }));
      if (!alive) break;
    }
    assert.ok(alive, 'kept alive by use up to the ceiling');
    tick(2);
    assert.strictEqual(await session.validate(repos, req2, { now: now() }), null, 'hard ceiling');
    const s3 = await session.issue(repos, 'cred', { now: now(), rand });
    const req3 = { headers: { cookie: `pa_session=${s3.token}` } };
    await session.end(repos, req3);
    assert.strictEqual(await session.validate(repos, req3, { now: now() }), null, 'logged out');
  },

  async 'errorBody: carries needsStepUp and the approval id only when the error says so'() {
    assert.deepStrictEqual(stepup.errorBody(new Error('boom')), { error: 'boom' });
    assert.deepStrictEqual(stepup.errorBody(Object.assign(new Error('needs a tap'), { needsStepUp: true, approvalId: 'appr-7' })), { error: 'needs a tap', needsStepUp: true, approvalId: 'appr-7' });
    assert.deepStrictEqual(stepup.errorBody(Object.assign(new Error('x'), { needsStepUp: true })), { error: 'x' }, 'no id, no button');
  },

  async 'cookie parsing never trusts a malformed value'() {
    assert.deepStrictEqual(session.parseCookies('a=1; b=2=3; ; c'), { a: '1', b: '2=3' });
    assert.strictEqual(session.cookieValue({ headers: { cookie: 'pa_session=short' } }), null);
    assert.strictEqual(session.cookieValue({ headers: { cookie: `pa_session=${'a'.repeat(200)}` } }), null);
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(cases)) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}\n     ${String(err.stack || err).split('\n').slice(0, 6).join('\n     ')}`);
    }
  }
  console.log(`passkeys: ${Object.keys(cases).length - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
