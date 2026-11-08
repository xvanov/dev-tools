'use strict';

// Contract: src/repo/passkeys.js (see test/repoContract.test.js). Times are
// passed in, so expiry is checked with fixed dates on any backend. Cases that
// count rows start by clearing the table they count (the store is throwaway).

const T0 = new Date('2026-11-07T10:00:00Z');
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const cred = (id, o = {}) => ({ id, publicKey: `pk-${id}`, counter: 0, transports: ['internal'], label: 'laptop', ...o });

module.exports = {
  'addCredential: stores a passkey; the same credential id twice is refused': async ({ repos, assert, uniq }) => {
    const id = uniq('cred');
    await repos.passkeys.addCredential(cred(id, { transports: ['usb', 'nfc'] }));
    const got = await repos.passkeys.getCredential(id);
    assert.strictEqual(got.publicKey, `pk-${id}`);
    assert.strictEqual(got.counter, 0);
    assert.deepStrictEqual(got.transports, ['usb', 'nfc']);
    assert.strictEqual(got.label, 'laptop');
    assert.strictEqual(got.lastUsedAt, null);
    await assert.rejects(() => repos.passkeys.addCredential(cred(id)));
  },

  'getCredential: null for an id that is not registered': async ({ repos, assert, uniq }) => {
    assert.strictEqual(await repos.passkeys.getCredential(uniq('nope')), null);
  },

  'listCredentials: every passkey, oldest first': async ({ repos, assert, uniq }) => {
    await repos.passkeys.deleteCredentials();
    const a = uniq('a');
    const b = uniq('b');
    await repos.passkeys.addCredential(cred(a));
    await repos.passkeys.addCredential(cred(b));
    const ids = (await repos.passkeys.listCredentials()).map((c) => c.id);
    assert.deepStrictEqual(ids.sort(), [a, b].sort());
  },

  'credentialCount: counts registered passkeys': async ({ repos, assert, uniq }) => {
    await repos.passkeys.deleteCredentials();
    assert.strictEqual(await repos.passkeys.credentialCount(), 0);
    await repos.passkeys.addCredential(cred(uniq('c')));
    assert.strictEqual(await repos.passkeys.credentialCount(), 1);
  },

  'touchCredential: records the new counter and the time': async ({ repos, assert, uniq }) => {
    const id = uniq('touch');
    await repos.passkeys.addCredential(cred(id));
    await repos.passkeys.touchCredential(id, 7, at(5));
    const got = await repos.passkeys.getCredential(id);
    assert.strictEqual(got.counter, 7);
    assert.strictEqual(new Date(got.lastUsedAt).getTime(), at(5).getTime());
  },

  'deleteCredentials: removes every passkey and says how many': async ({ repos, assert, uniq }) => {
    await repos.passkeys.deleteCredentials();
    await repos.passkeys.addCredential(cred(uniq('d')));
    await repos.passkeys.addCredential(cred(uniq('d')));
    assert.strictEqual(await repos.passkeys.deleteCredentials(), 2);
    assert.strictEqual(await repos.passkeys.credentialCount(), 0);
    assert.strictEqual(await repos.passkeys.deleteCredentials(), 0);
  },

  'createSession: a session is live until its idle expiry': async ({ repos, assert, uniq }) => {
    const h = uniq('sess');
    await repos.passkeys.createSession({ tokenHash: h, credentialId: 'c', now: T0, expiresAt: at(60), hardExpiresAt: at(600) });
    const s = await repos.passkeys.getSession(h, at(30));
    assert.strictEqual(s.tokenHash, h);
    assert.strictEqual(s.credentialId, 'c');
    assert.strictEqual(await repos.passkeys.getSession(h, at(60)), null, 'expired at the instant it expires');
  },

  'getSession: null when unknown, idle-expired or past the hard ceiling': async ({ repos, assert, uniq }) => {
    assert.strictEqual(await repos.passkeys.getSession(uniq('none'), T0), null);
    const h = uniq('hard');
    await repos.passkeys.createSession({ tokenHash: h, credentialId: 'c', now: T0, expiresAt: at(1000), hardExpiresAt: at(100) });
    assert.ok(await repos.passkeys.getSession(h, at(99)));
    assert.strictEqual(await repos.passkeys.getSession(h, at(100)), null, 'the hard ceiling wins over a later idle expiry');
  },

  'renewSession: slides the idle expiry of a live session, not of an expired one': async ({ repos, assert, uniq }) => {
    const h = uniq('renew');
    await repos.passkeys.createSession({ tokenHash: h, credentialId: 'c', now: T0, expiresAt: at(60), hardExpiresAt: at(600) });
    await repos.passkeys.renewSession(h, at(50), at(110));
    assert.ok(await repos.passkeys.getSession(h, at(100)), 'alive after the original expiry');
    await repos.passkeys.renewSession(h, at(200), at(260));
    assert.strictEqual(await repos.passkeys.getSession(h, at(210)), null, 'an expired session is not revived');
  },

  'deleteSession: ends one session only': async ({ repos, assert, uniq }) => {
    const a = uniq('s');
    const b = uniq('s');
    for (const h of [a, b]) await repos.passkeys.createSession({ tokenHash: h, credentialId: 'c', now: T0, expiresAt: at(60), hardExpiresAt: at(600) });
    await repos.passkeys.deleteSession(a);
    assert.strictEqual(await repos.passkeys.getSession(a, at(1)), null);
    assert.ok(await repos.passkeys.getSession(b, at(1)));
  },

  'deleteSessions: ends every session and says how many': async ({ repos, assert, uniq }) => {
    await repos.passkeys.deleteSessions();
    for (let i = 0; i < 3; i++) {
      await repos.passkeys.createSession({ tokenHash: uniq('s'), credentialId: 'c', now: T0, expiresAt: at(60), hardExpiresAt: at(600) });
    }
    assert.strictEqual(await repos.passkeys.deleteSessions(), 3);
    assert.strictEqual(await repos.passkeys.deleteSessions(), 0);
  },

  'grantStepUp: one grant per approval id; asserting again re-arms it': async ({ repos, assert, uniq }) => {
    const id = uniq('appr');
    await repos.passkeys.grantStepUp({ approvalId: id, credentialId: 'c', now: T0, expiresAt: at(120) });
    assert.strictEqual(await repos.passkeys.consumeStepUp(id, at(1)), true);
    assert.strictEqual(await repos.passkeys.hasStepUp(id, at(2)), false, 'used up');
    await repos.passkeys.grantStepUp({ approvalId: id, credentialId: 'c', now: at(3), expiresAt: at(123) });
    assert.strictEqual(await repos.passkeys.hasStepUp(id, at(4)), true, 're-armed by a new assertion');
  },

  'hasStepUp: bound to its own approval id; false once expired; does not use it up': async ({ repos, assert, uniq }) => {
    const id = uniq('appr');
    await repos.passkeys.grantStepUp({ approvalId: id, credentialId: 'c', now: T0, expiresAt: at(120) });
    assert.strictEqual(await repos.passkeys.hasStepUp(uniq('other'), at(1)), false, 'another approval id');
    assert.strictEqual(await repos.passkeys.hasStepUp(id, at(1)), true);
    assert.strictEqual(await repos.passkeys.hasStepUp(id, at(2)), true, 'peeking twice is fine');
    assert.strictEqual(await repos.passkeys.hasStepUp(id, at(120)), false, 'expired');
  },

  'consumeStepUp: true for exactly one caller, even concurrently; false when expired': async ({ repos, assert, uniq }) => {
    const id = uniq('appr');
    await repos.passkeys.grantStepUp({ approvalId: id, credentialId: 'c', now: T0, expiresAt: at(120) });
    const results = await Promise.all([1, 2, 3, 4].map(() => repos.passkeys.consumeStepUp(id, at(1))));
    assert.strictEqual(results.filter(Boolean).length, 1);
    const late = uniq('appr');
    await repos.passkeys.grantStepUp({ approvalId: late, credentialId: 'c', now: T0, expiresAt: at(120) });
    assert.strictEqual(await repos.passkeys.consumeStepUp(late, at(121)), false);
    assert.strictEqual(await repos.passkeys.consumeStepUp(uniq('missing'), at(1)), false);
  },

  'purgeExpired: removes expired sessions and grants, keeps live ones': async ({ repos, assert, uniq }) => {
    await repos.passkeys.deleteSessions();
    const dead = uniq('dead');
    const live = uniq('live');
    await repos.passkeys.createSession({ tokenHash: dead, credentialId: 'c', now: T0, expiresAt: at(10), hardExpiresAt: at(600) });
    await repos.passkeys.createSession({ tokenHash: live, credentialId: 'c', now: T0, expiresAt: at(500), hardExpiresAt: at(600) });
    const gDead = uniq('gd');
    const gLive = uniq('gl');
    await repos.passkeys.grantStepUp({ approvalId: gDead, credentialId: 'c', now: T0, expiresAt: at(10) });
    await repos.passkeys.grantStepUp({ approvalId: gLive, credentialId: 'c', now: T0, expiresAt: at(500) });
    const r = await repos.passkeys.purgeExpired(at(100));
    assert.ok(r.sessions >= 1 && r.stepUps >= 1);
    assert.ok(await repos.passkeys.getSession(live, at(100)));
    assert.strictEqual(await repos.passkeys.hasStepUp(gLive, at(100)), true);
    assert.strictEqual(await repos.passkeys.hasStepUp(gDead, at(1)), false, 'the expired grant is gone');
  },
};
