'use strict';

// The one way a commitment's status changes (DURABLE.md §2.1).
//
//   transition({commitmentId, to, actor, reason, evidenceId, from}, client?)
//   undo(transitionId)       put back what one change overwrote
//   history(commitmentId)    every change, newest first
//
// Every closer — you on the dashboard or `pa done`, a reply of yours, a merged
// PR, a self-note expiring, the reconciler, the dispatcher — calls this, and
// every call leaves a `ledger_transition` row with the columns it replaced.
// That is what makes it safe for the assistant to close things on its own:
// each such close is visible, has its reason, and can be undone.
//
// Pass a transaction client to make the change part of a larger write (the
// reply-close judgement and its close commit together); without one it runs
// in its own transaction. The row is locked, so a hand edit in between wins.

const { withTx, rows } = require('../db');
const { logger } = require('../log');
const L = require('./core');

const log = logger('ledger');

async function inTx(client, fn) {
  return client ? fn(client) : withTx(fn);
}

/**
 * @returns {Promise<{changed: boolean, skip?: string, transitionId?: number, set?: object}>}
 */
async function transition({ commitmentId, to, actor, reason = null, evidenceId = null, from = null, now = new Date() }, client = null) {
  if (!actor) throw new Error('a transition needs an actor');
  return inTx(client, async (c) => {
    const cur = (
      await c.query('select id, status, closed_at, closed_reason, touched_at from commitment where id = $1 for update', [commitmentId])
    ).rows[0];
    const p = L.plan(cur, { to, actor, reason, now, from });
    if (p.skip) return { changed: false, skip: p.skip };
    const cols = Object.keys(p.set);
    await c.query(
      `update commitment set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`,
      [commitmentId, ...cols.map((k) => p.set[k])]
    );
    const t = (
      await c.query(
        `insert into ledger_transition (commitment_id, from_status, to_status, actor, reason, evidence_id, before, at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [commitmentId, cur.status, to, actor, reason, evidenceId, p.before, p.set.closed_at || L.iso(now)]
      )
    ).rows[0];
    return { changed: true, transitionId: Number(t.id), set: p.set };
  });
}

/**
 * Puts back the columns one transition overwrote, unless the commitment has
 * changed since (then it is left alone, and says so). The undo is itself
 * recorded on the transition, so an assistant close that was taken back is
 * evidence the next judgement can learn from.
 */
async function undo(transitionId) {
  let result = 'undone';
  const t = await withTx(async (c) => {
    const row = (await c.query('select * from ledger_transition where id = $1 for update', [transitionId])).rows[0];
    if (!row) {
      result = `no transition #${transitionId}`;
      return null;
    }
    if (row.undone_at) {
      result = 'already undone';
      return row;
    }
    const cur = (
      await c.query('select id, status, closed_at, closed_reason from commitment where id = $1 for update', [row.commitment_id])
    ).rows[0];
    const after = {
      status: row.to_status,
      closed_reason: L.CLOSED.has(row.to_status) ? row.reason : null,
      closed_at: L.CLOSED.has(row.to_status) ? row.at : null,
    };
    if (!cur) result = 'the commitment is gone';
    else if (L.changedSince(cur, after)) result = 'changed since; left as it is';
    else {
      const cols = Object.keys(row.before);
      await c.query(
        `update commitment set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`,
        [row.commitment_id, ...cols.map((k) => row.before[k])]
      );
    }
    await c.query('update ledger_transition set undone_at = now(), undo = $2 where id = $1', [transitionId, result]);
    return row;
  });
  if (t) log.info('transition undone', { transition: transitionId, commitment: Number(t.commitment_id), result });
  return { ok: result === 'undone', result, commitmentId: t ? Number(t.commitment_id) : null };
}

/** The newest change of a commitment that is not undone — what "Reopen" takes back. */
async function latest(commitmentId) {
  return (
    await rows(
      `select * from ledger_transition where commitment_id = $1 and undone_at is null order by at desc, id desc limit 1`,
      [commitmentId]
    )
  )[0] || null;
}

async function history(commitmentId) {
  return rows(
    `select t.*, e.quote, e.source_item_id, e.confidence
       from ledger_transition t left join ledger_evidence e on e.id = t.evidence_id
      where t.commitment_id = $1 order by t.at desc, t.id desc`,
    [commitmentId]
  );
}

module.exports = { transition, undo, latest, history };
