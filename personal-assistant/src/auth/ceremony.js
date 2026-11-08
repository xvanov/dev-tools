'use strict';

// WebAuthn ceremonies (plan 7.1): registering a passkey, signing in with one,
// and the step-up assertion for one approval. The cryptography is
// @simplewebauthn/server (CBOR/COSE parsing, signature and flag checks, the
// origin and RP id match); this file owns what the library cannot know:
//
//   - a challenge is issued by US, kept in memory, single use, and expires in
//     two minutes; a response for a challenge we did not issue, or that was
//     already used, is refused before the library sees it;
//   - user verification is required (a tap alone is not enough);
//   - a step-up challenge is not random: it is SHA-256("pa-stepup:v1:" +
//     approvalId + ":" + nonce), and the grant is written for the approval id
//     the challenge was issued for. An assertion made for approval A cannot be
//     replayed to approve B, because B's grant is written only from a ceremony
//     opened for B, whose challenge the authenticator signed.
//
// Nothing here reads the request or sets a cookie: src/dashboard/auth.js does.

const crypto = require('crypto');
const { settings } = require('./settings');

const OWNER = { name: 'owner', id: Buffer.from('pa-owner-v1') };
const MAX_OPEN = 50;

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function lib() {
  return require('@simplewebauthn/server');
}

class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{repos: object, now?: () => Date, rand?: (n:number)=>Buffer}} deps
 *   `now` and `rand` are injected by tests (fixed clock, fixed challenges).
 */
function createCeremonies({ repos, now = () => new Date(), rand = crypto.randomBytes }) {
  const open = new Map(); // ceremonyId -> {kind, challenge, approvalId, expires}

  function remember(kind, challenge, extra = {}) {
    const t = now().getTime();
    for (const [id, c] of open) if (c.expires <= t) open.delete(id);
    while (open.size >= MAX_OPEN) open.delete(open.keys().next().value);
    const ceremonyId = b64(rand(16));
    open.set(ceremonyId, { kind, challenge, expires: t + settings().challengeMs, ...extra });
    return ceremonyId;
  }

  /** Takes (and removes) the open ceremony: single use, right kind, not expired. */
  function take(ceremonyId, kind) {
    const c = open.get(String(ceremonyId));
    open.delete(String(ceremonyId));
    if (!c || c.kind !== kind || c.expires <= now().getTime()) throw new AuthError('unknown or expired ceremony');
    return c;
  }

  async function credentialsFor() {
    return repos.passkeys.listCredentials();
  }

  return {
    /** Options for navigator.credentials.create(). */
    async registrationOptions() {
      const s = settings();
      const existing = await credentialsFor();
      const challenge = rand(32);
      const options = await lib().generateRegistrationOptions({
        rpName: s.rpName,
        rpID: s.rpId,
        userName: OWNER.name,
        userID: OWNER.id,
        challenge,
        attestationType: 'none',
        excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      return { ceremonyId: remember('register', options.challenge), options };
    },

    /** Verifies the browser's create() result and stores the passkey. @returns {{id: string}} */
    async verifyRegistration({ ceremonyId, response, label = '' }) {
      const s = settings();
      const c = take(ceremonyId, 'register');
      let v;
      try {
        v = await lib().verifyRegistrationResponse({
          response,
          expectedChallenge: c.challenge,
          expectedOrigin: s.origins,
          expectedRPID: s.rpId,
          requireUserVerification: true,
        });
      } catch (err) {
        throw new AuthError(`registration refused: ${err.message}`);
      }
      if (!v.verified) throw new AuthError('registration refused');
      const cred = v.registrationInfo.credential;
      await repos.passkeys.addCredential({
        id: cred.id,
        publicKey: b64(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports || response.response?.transports || [],
        label: String(label || '').slice(0, 60),
      });
      return { id: cred.id };
    },

    /** Options for navigator.credentials.get(): a sign-in, or a step-up for `approvalId`. */
    async authenticationOptions({ approvalId = null } = {}) {
      const s = settings();
      const creds = await credentialsFor();
      if (!creds.length) throw new AuthError('no passkey is registered', 409);
      const nonce = b64(rand(16));
      const challenge = approvalId
        ? crypto.createHash('sha256').update(`pa-stepup:v1:${approvalId}:${nonce}`).digest()
        : rand(32);
      const options = await lib().generateAuthenticationOptions({
        rpID: s.rpId,
        challenge,
        allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: 'required',
      });
      const ceremonyId = remember(approvalId ? 'stepup' : 'login', options.challenge, { approvalId });
      return { ceremonyId, options };
    },

    /**
     * Verifies the browser's get() result for a sign-in (`approvalId` absent)
     * or a step-up (the approval id the ceremony was opened for, which the
     * caller must also pass: a mismatch is refused).
     * @returns {Promise<{credentialId: string, approvalId: string|null}>}
     */
    async verifyAuthentication({ ceremonyId, response, approvalId = null }) {
      const s = settings();
      const kind = approvalId ? 'stepup' : 'login';
      const c = take(ceremonyId, kind);
      if (kind === 'stepup' && c.approvalId !== approvalId) throw new AuthError('this assertion was made for another approval');
      const stored = await repos.passkeys.getCredential(String(response && response.id));
      if (!stored) throw new AuthError('unknown passkey', 401);
      let v;
      try {
        v = await lib().verifyAuthenticationResponse({
          response,
          expectedChallenge: c.challenge,
          expectedOrigin: s.origins,
          expectedRPID: s.rpId,
          credential: {
            id: stored.id,
            publicKey: Buffer.from(stored.publicKey, 'base64url'),
            counter: Number(stored.counter) || 0,
            transports: stored.transports,
          },
          requireUserVerification: true,
        });
      } catch (err) {
        throw new AuthError(`assertion refused: ${err.message}`, 401);
      }
      if (!v.verified) throw new AuthError('assertion refused', 401);
      await repos.passkeys.touchCredential(stored.id, v.authenticationInfo.newCounter, now());
      return { credentialId: stored.id, approvalId: kind === 'stepup' ? c.approvalId : null };
    },

    /** Records the step-up grant for the approval a verified assertion was made for. */
    async grantStepUp({ credentialId, approvalId }) {
      const t = now();
      await repos.passkeys.grantStepUp({ approvalId, credentialId, now: t, expiresAt: new Date(t.getTime() + settings().stepUpMs) });
    },
  };
}

module.exports = { createCeremonies, AuthError, OWNER };
