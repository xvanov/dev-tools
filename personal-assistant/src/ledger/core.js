'use strict';

// The pure half of the ledger (src/ledger/index.js): what one status change
// would write, and whether an undo may put it back. No database, so every
// rule here is a test away.

const STATUSES = ['open', 'dispatched', 'done', 'dropped'];
const CLOSED = new Set(['done', 'dropped']);

function iso(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * What changing `cur` to `to` writes: {skip} or {set, before}. `before` holds
 * exactly the columns `set` overwrites, so an undo can put them back.
 *
 * A person's change marks the commitment touched (selfNotes measures age from
 * it); the assistant's does not, or every automatic close would reset the clock.
 *
 * @param {object} cur  {status, closed_at, closed_reason, touched_at}
 * @param {object} o    {to, actor, reason, now, from?: string[] — only from these statuses}
 */
function plan(cur, { to, actor, reason = null, now = new Date(), from = null } = {}) {
  if (!cur) return { skip: 'commitment not found' };
  if (!STATUSES.includes(to)) return { skip: `unknown status ${to}` };
  if (from && !from.includes(cur.status)) return { skip: `already ${cur.status}` };
  if (cur.status === to && !(CLOSED.has(to) && reason && reason !== cur.closed_reason)) return { skip: `already ${to}` };
  const at = iso(now);
  const set = {
    status: to,
    closed_at: CLOSED.has(to) ? at : null,
    closed_reason: CLOSED.has(to) ? reason : null,
  };
  const before = { status: cur.status, closed_at: iso(cur.closed_at), closed_reason: cur.closed_reason ?? null };
  if (actor === 'you') {
    set.touched_at = at;
    before.touched_at = iso(cur.touched_at);
  }
  return { set, before };
}

/** Whether the row still holds what a change wrote; if not, an undo must leave it alone. */
function changedSince(cur, set) {
  if (!cur) return true;
  if (cur.status !== set.status) return true;
  if ((cur.closed_reason ?? null) !== (set.closed_reason ?? null)) return true;
  return iso(cur.closed_at) !== iso(set.closed_at);
}

module.exports = { STATUSES, CLOSED, plan, changedSince, iso };
