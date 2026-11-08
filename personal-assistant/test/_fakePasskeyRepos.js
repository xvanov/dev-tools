'use strict';

// An in-memory stand-in for src/repo/passkeys.js with the same semantics
// (test/contract/passkeys.contract.js is the oracle for the real one), so the
// auth tests run without Postgres. Times are the Dates callers pass in.

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

module.exports = { fakeRepos };
