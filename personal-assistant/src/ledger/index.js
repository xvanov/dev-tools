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

const repo = require('../repo');
const { logger } = require('../log');
const L = require('./core');

const log = logger('ledger');

// `client`: a repository set from repo.withTx, or (until every caller is
// converted) a raw transaction client; none: a transaction of its own.
async function inTx(client, fn) {
  return client ? fn(repo.on(client)) : repo.withTx(fn);
}

/**
 * @returns {Promise<{changed: boolean, skip?: string, transitionId?: number, set?: object}>}
 */
async function transition({ commitmentId, to, actor, reason = null, evidenceId = null, from = null, now = new Date() }, client = null) {
  if (!actor) throw new Error('a transition needs an actor');
  return inTx(client, async (r) => {
    const cur = await r.ledger.lockCommitment(commitmentId);
    const p = L.plan(cur, { to, actor, reason, now, from });
    if (p.skip) return { changed: false, skip: p.skip };
    await r.ledger.setCommitment(commitmentId, p.set);
    const transitionId = await r.ledger.insertTransition({
      commitmentId, from: cur.status, to, actor, reason, evidenceId, before: p.before, at: p.set.closed_at || L.iso(now),
    });
    return { changed: true, transitionId, set: p.set };
  }).then((r) => {
    // Whatever waits on this commitment closing (a chase, src/durable) wakes.
    // Best effort and after the write: a task re-reads the row before acting,
    // so an event for a change that was rolled back costs nothing.
    if (r.changed && L.CLOSED.has(to)) {
      require('../durable').emit(`closed:${commitmentId}`, { status: to, at: L.iso(now) }).catch(() => {});
    }
    return r;
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
  const t = await repo.withTx(async (r) => {
    const row = await r.ledger.lockTransition(transitionId);
    if (!row) {
      result = `no transition #${transitionId}`;
      return null;
    }
    if (row.undone_at) {
      result = 'already undone';
      return row;
    }
    const cur = await r.ledger.lockCommitment(row.commitment_id);
    const after = {
      status: row.to_status,
      closed_reason: L.CLOSED.has(row.to_status) ? row.reason : null,
      closed_at: L.CLOSED.has(row.to_status) ? row.at : null,
    };
    if (!cur) result = 'the commitment is gone';
    else if (L.changedSince(cur, after)) result = 'changed since; left as it is';
    else {
      await r.ledger.setCommitment(row.commitment_id, row.before);
    }
    await r.ledger.markUndone(transitionId, result);
    return row;
  });
  if (t) log.info('transition undone', { transition: transitionId, commitment: Number(t.commitment_id), result });
  return { ok: result === 'undone', result, commitmentId: t ? Number(t.commitment_id) : null };
}

/** The newest change of a commitment that is not undone — what "Reopen" takes back. */
async function latest(commitmentId) {
  return repo.ledger.latest(commitmentId);
}

async function history(commitmentId) {
  return repo.ledger.history(commitmentId);
}

module.exports = { transition, undo, latest, history };
