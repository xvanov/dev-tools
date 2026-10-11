'use strict';

// Closing the loop on a commitment by hand. One implementation, shared by the
// CLI (`pa done`) and the dashboard's buttons, per AGENT.md.
//
// `dispatched` is not settable here: only the dispatcher knows a run exists.

const { one } = require('./db');

const SETTABLE = new Set(['open', 'done', 'dropped']);

async function setStatus(id, status) {
  if (!SETTABLE.has(status)) throw new Error(`status must be one of ${[...SETTABLE].join(', ')}`);
  const row = await one('update commitment set status = $2 where id = $1 returning id, status, summary', [id, status]);
  if (!row) throw new Error(`no commitment #${id}`);
  return row;
}

module.exports = { setStatus, SETTABLE };
