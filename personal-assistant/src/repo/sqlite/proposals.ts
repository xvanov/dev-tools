'use strict';

// SQLite twin of src/repo/proposals.js (proposal).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const { NOW } = require('./_sql');

function create(db: Db) {
  return {
    /** Inserts one; null when its dedupe key is taken. `options` is stored as JSON text when given. */
    async insert({ kind, commitmentId, runId, title, body, options, payload, dedupeKey, expiresAt }: { kind?: string | null; commitmentId?: number | string | null; runId?: number | string | null; title?: string | null; body?: string | null; options?: unknown; payload?: Row | null; dedupeKey?: unknown; expiresAt?: unknown }) {
      return db.one(
        `insert into proposal (kind, commitment_id, run_id, title, body, options, payload, dedupe_key, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (dedupe_key) do nothing
     returning *`,
        [kind, commitmentId, runId, title, body, options ? JSON.stringify(options) : null, payload, dedupeKey, expiresAt]
      );
    },

    /** Pending and unexpired, newest first, with their commitment's summary. */
    async pending({ limit = 40 }: { limit?: number } = {}) {
      return db.rows(
        `select p.*, c.summary as commitment_summary
       from proposal p left join commitment c on c.id = p.commitment_id
      where p.status = 'pending' and (p.expires_at is null or p.expires_at > ${NOW})
      order by p.created_at desc, p.id desc limit $1`,
        [limit]
      );
    },

    /** One proposal's payload ({payload}), or null. */
    async payloadOf(id: number | string) {
      return db.one('select payload from proposal where id = $1', [id]);
    },

    /** One proposal's status ({status}), or null. */
    async statusOf(id: number | string) {
      return db.one('select status from proposal where id = $1', [id]);
    },

    /** Decides a pending proposal (accepted | rejected). Null when it was not pending. */
    async decide(id: number | string, status: string, answer: string) {
      return db.one(
        `update proposal set status = $2, answer = $3, decided_at = ${NOW}
                        where id = $1 and status = 'pending' returning *`,
        [id, status, answer]
      );
    },

    /** Puts a decided proposal back to pending (its handler failed). */
    async reopen(id: number | string) {
      await db.query(`update proposal set status = 'pending', decided_at = null where id = $1`, [id]);
    },

    /** Expires what is past its expiry, and questions and offers about a closed ask: [{id, payload}]. */
    async expireDue() {
      const r = await db.query(
        `update proposal set status = 'expired'
      where status = 'pending'
        and (expires_at <= ${NOW}
             or (kind in ('question', 'dispatch')
                 and exists (select 1 from commitment c where c.id = proposal.commitment_id and c.status in ('done', 'dropped'))))
      returning id, payload`
      );
      return r.rows || [];
    },

    /** One proposal's kind and payload ({kind, payload}), or null. */
    async kindAndPayload(id: number | string) {
      return db.one('select kind, payload from proposal where id = $1', [id]);
    },
    /** One proposal's fields for the chat's offer view, or null. */
    async rowForChat(id: number | string) {
      return db.one('select id, kind, title, body, payload, status, created_at, commitment_id from proposal where id = $1', [id]);
    },

    /** A commitment's pending proposals (five, newest first). */
    async pendingOfCommitment(commitmentId: number | string) {
      return db.rows(`select id, kind, title, payload from proposal where commitment_id = $1 and status = 'pending' order by created_at desc, id desc limit 5`, [commitmentId]);
    },

    /** The ten newest accepted cadence answers about a person's asks: {answer}. */
    async cadenceAnswers(personId: number | string) {
      return db.rows(
        `select p.answer from proposal p join commitment c on c.id = p.commitment_id
      where json_extract(p.payload, '$.on') = 'cadence' and p.status = 'accepted' and c.counterparty_person_id = $1
      order by p.decided_at desc, p.id desc limit 10`,
        [personId]
      );
    },
  };
}

module.exports = { create };
