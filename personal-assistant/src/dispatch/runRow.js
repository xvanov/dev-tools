'use strict';

// Inserting a run row: one live run per commitment, race-free.
//
// dispatch.start checks for a live run first (for a friendly message), but a
// double click, the dashboard and the CLI at once, or the planner and a card
// accept can both pass that check before either inserts. So the insert itself
// runs in a transaction holding an advisory lock on the commitment, re-checks
// under it, and refuses. `again` (`pa do --again`) skips the check: a second
// run on purpose.

const { one, withTx } = require('../db');

const LOCK_SPACE = 7301;
const LIVE = "('starting','running','waiting')";

class LiveRunError extends Error {
  constructor(commitmentId, runId) {
    super(`#${commitmentId} already has run #${runId} — attach to it (pa attach ${runId}), or drop it first`);
    this.code = 'live_run';
  }
}

/**
 * @param {string} sql     an `insert into run … returning *`
 * @param {Array} params
 * @param {{commitmentId?: number|null, again?: boolean}} o
 */
async function insertRun(sql, params, { commitmentId = null, again = false } = {}) {
  if (!commitmentId || again) return one(sql, params);
  return withTx(async (c) => {
    await c.query('select pg_advisory_xact_lock($1, $2)', [LOCK_SPACE, Number(commitmentId)]);
    const live = await c.query(`select id from run where commitment_id = $1 and status in ${LIVE} order by started_at desc limit 1`, [commitmentId]);
    if (live.rows && live.rows.length) throw new LiveRunError(commitmentId, live.rows[0].id);
    const r = await c.query(sql, params);
    return r.rows[0];
  });
}

module.exports = { insertRun, LiveRunError, LOCK_SPACE };
