'use strict';

// Aggregate: ledger. Tables: ledger_transition (every status change of a
// commitment, with the columns it replaced) and ledger_evidence (what a
// close was judged on); it also owns the commitment's status columns, since
// the ledger is the one way they change (DURABLE.md 2.1). Callers:
// src/ledger (index.js, reconcile.js).

// The commitment columns a transition (and its undo) may write: the keys of
// ledger/core.js plan()'s `set` and `before`.
const STATUS_COLUMNS = ['status', 'closed_at', 'closed_reason', 'touched_at'];

function setClause(cols) {
  for (const k of cols) if (!STATUS_COLUMNS.includes(k)) throw new Error(`a transition does not write commitment.${k}`);
  return cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
}

function create(db) {
  return {
    /** A commitment's status columns, locked for update (inside withTx), or null. */
    async lockCommitment(commitmentId) {
      return db.one('select id, status, closed_at, closed_reason, touched_at from commitment where id = $1 for update', [commitmentId]);
    },

    /** Writes a commitment's status columns (`set`: STATUS_COLUMNS only). */
    async setCommitment(commitmentId, set) {
      const cols = Object.keys(set);
      await db.query(`update commitment set ${setClause(cols)} where id = $1`, [commitmentId, ...cols.map((k) => set[k])]);
    },

    /**
     * Records one change. `before` is what it overwrote (plan()'s before).
     * @returns {Promise<number>} the transition id
     */
    async insertTransition({ commitmentId, from, to, actor, reason, evidenceId, before, at }) {
      const t = await db.one(
        `insert into ledger_transition (commitment_id, from_status, to_status, actor, reason, evidence_id, before, at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [commitmentId, from, to, actor, reason, evidenceId, before, at]
      );
      return Number(t.id);
    },

    /** One transition, locked for update (inside withTx), or null. */
    async lockTransition(transitionId) {
      return db.one('select * from ledger_transition where id = $1 for update', [transitionId]);
    },

    /** Marks a transition undone, with what the undo did (`result`). */
    async markUndone(transitionId, result) {
      await db.query('update ledger_transition set undone_at = now(), undo = $2 where id = $1', [transitionId, result]);
    },

    /** The newest change of a commitment that is not undone, or null. */
    async latest(commitmentId) {
      const list = await db.rows(
        `select * from ledger_transition where commitment_id = $1 and undone_at is null order by at desc, id desc limit 1`,
        [commitmentId]
      );
      return list[0] || null;
    },

    /** Every change of a commitment, newest first, with its evidence's quote, item and confidence. */
    async history(commitmentId) {
      return db.rows(
        `select t.*, e.quote, e.source_item_id, e.confidence
       from ledger_transition t left join ledger_evidence e on e.id = t.evidence_id
      where t.commitment_id = $1 order by t.at desc, t.id desc`,
        [commitmentId]
      );
    },

    // --- for agent/planner.js

    /**
     * The reconciler's "progresses" quotes for commitments, newest first.
     * @param {Array<number|string>} commitmentIds
     * @returns {Promise<{commitment_id: number|string, quote: string}[]>}
     */
    async progressQuotes(commitmentIds) {
      return db.rows(
        `select commitment_id, quote from ledger_evidence
        where commitment_id = any($1::bigint[]) and effect = 'progresses' and quote is not null
        order by created_at desc`,
        [commitmentIds]
      );
    },
  };
}

module.exports = { create, STATUS_COLUMNS };
