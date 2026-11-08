'use strict';

// Aggregate: passkeys. Tables: passkey_credential, passkey_session,
// passkey_stepup (sql/038). Callers: src/auth. Every time is passed in by the
// caller (a Date), never read from the database clock, so expiry is tested
// with a fixed clock and means the same on any backend.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

/**
 * @typedef {object} PasskeyCredential
 * @property {string} id            credential id, base64url
 * @property {string} publicKey     COSE public key, base64url
 * @property {number} counter       last signature counter seen
 * @property {string[]} transports
 * @property {string} label
 * @property {Date} createdAt
 * @property {Date|null} lastUsedAt
 */

const CRED = `id, public_key as "publicKey", counter::float8 as counter, transports, label, created_at as "createdAt", last_used_at as "lastUsedAt"`;

function create(db: Db) {
  return {
    /** How many passkeys are registered. @returns {Promise<number>} */
    async credentialCount() {
      const r = await db.one('select count(*)::int as n from passkey_credential');
      return r ? r.n : 0;
    },

    /** Every registered passkey, oldest first. @returns {Promise<PasskeyCredential[]>} */
    listCredentials() {
      return db.rows(`select ${CRED} from passkey_credential order by created_at, id`);
    },

    /** One passkey by credential id, or null. @returns {Promise<PasskeyCredential|null>} */
    getCredential(id: number | string) {
      return db.one(`select ${CRED} from passkey_credential where id = $1`, [id]);
    },

    /** Stores a newly registered passkey. A second registration of the same credential id is refused (throws). */
    async addCredential({ id, publicKey, counter = 0, transports = [], label = '' }: { id?: number | string | null; publicKey?: unknown; counter?: number; transports?: unknown; label?: string }) {
      await db.query(
        `insert into passkey_credential (id, public_key, counter, transports, label)
         values ($1, $2, $3, $4::jsonb, $5)`,
        [id, publicKey, counter, JSON.stringify(transports || []), label]
      );
    },

    /** Records a use: the new signature counter and when. */
    async touchCredential(id: number | string, counter: unknown, now: Date | string | number) {
      await db.query('update passkey_credential set counter = $2, last_used_at = $3 where id = $1', [id, counter, now]);
    },

    /** Removes every passkey (the recovery reset). @returns {Promise<number>} how many */
    async deleteCredentials() {
      const r = await db.query('delete from passkey_credential');
      return r.rowCount || 0;
    },

    /** Opens a session keyed by the hash of its cookie value. */
    async createSession({ tokenHash, credentialId, now, expiresAt, hardExpiresAt }: { tokenHash?: unknown; credentialId?: number | string | null; now?: Date | string | number | null; expiresAt?: unknown; hardExpiresAt?: unknown }) {
      await db.query(
        `insert into passkey_session (token_hash, credential_id, created_at, last_seen_at, expires_at, hard_expires_at)
         values ($1, $2, $3, $3, $4, $5)`,
        [tokenHash, credentialId, now, expiresAt, hardExpiresAt]
      );
    },

    /**
     * The session for `tokenHash` if neither its idle nor its hard expiry has
     * passed at `now`, else null (an expired row is not returned, and is
     * removed by purgeExpired).
     * @returns {Promise<{tokenHash:string, credentialId:string, expiresAt:Date, hardExpiresAt:Date}|null>}
     */
    getSession(tokenHash: unknown, now: Date | string | number) {
      return db.one(
        `select token_hash as "tokenHash", credential_id as "credentialId", expires_at as "expiresAt",
                hard_expires_at as "hardExpiresAt"
           from passkey_session
          where token_hash = $1 and expires_at > $2 and hard_expires_at > $2`,
        [tokenHash, now]
      );
    },

    /** Slides the idle expiry of a live session to `expiresAt` (callers cap it at the hard expiry). */
    async renewSession(tokenHash: unknown, now: Date | string | number, expiresAt: unknown) {
      await db.query(
        'update passkey_session set last_seen_at = $2, expires_at = $3 where token_hash = $1 and expires_at > $2',
        [tokenHash, now, expiresAt]
      );
    },

    /** Ends one session (logout). */
    async deleteSession(tokenHash: unknown) {
      await db.query('delete from passkey_session where token_hash = $1', [tokenHash]);
    },

    /** Ends every session, for every browser. @returns {Promise<number>} how many */
    async deleteSessions() {
      const r = await db.query('delete from passkey_session');
      return r.rowCount || 0;
    },

    /**
     * Records a fresh passkey assertion for ONE approval id, valid until
     * `expiresAt`. Asserting again for the same approval replaces the grant
     * (and makes it usable again).
     */
    async grantStepUp({ approvalId, credentialId, now, expiresAt }: { approvalId?: number | string | null; credentialId?: number | string | null; now?: Date | string | number | null; expiresAt?: unknown }) {
      await db.query(
        `insert into passkey_stepup (approval_id, credential_id, granted_at, expires_at, consumed_at)
         values ($1, $2, $3, $4, null)
         on conflict (approval_id) do update
           set credential_id = excluded.credential_id, granted_at = excluded.granted_at,
               expires_at = excluded.expires_at, consumed_at = null`,
        [approvalId, credentialId, now, expiresAt]
      );
    },

    /** Whether `approvalId` has an unexpired, unused grant at `now`. Does not use it up. */
    async hasStepUp(approvalId: number | string, now: Date | string | number) {
      const r = await db.one(
        'select 1 as ok from passkey_stepup where approval_id = $1 and consumed_at is null and expires_at > $2',
        [approvalId, now]
      );
      return Boolean(r);
    },

    /** Uses the grant up: true for exactly one caller, false for every other and for an expired or missing one. */
    async consumeStepUp(approvalId: number | string, now: Date | string | number) {
      const r = await db.query(
        `update passkey_stepup set consumed_at = $2
          where approval_id = $1 and consumed_at is null and expires_at > $2`,
        [approvalId, now]
      );
      return (r.rowCount || 0) === 1;
    },

    /** Deletes sessions and step-up grants that expired at or before `now`. @returns {Promise<{sessions:number, stepUps:number}>} */
    async purgeExpired(now: Date | string | number) {
      const s = await db.query('delete from passkey_session where expires_at <= $1 or hard_expires_at <= $1', [now]);
      const g = await db.query('delete from passkey_stepup where expires_at <= $1', [now]);
      return { sessions: s.rowCount || 0, stepUps: g.rowCount || 0 };
    },
  };
}

module.exports = { create };
