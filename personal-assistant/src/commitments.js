'use strict';

// Closing the loop on a commitment by hand. One implementation, shared by the
// CLI (`pa done`) and the dashboard's buttons, per AGENT.md.
//
// `dispatched` is not settable here: only the dispatcher knows a run exists.

const repo = require('./repo');
const ledger = require('./ledger');

const SETTABLE = new Set(['open', 'done', 'dropped']);

// Closing records who closed it and when, so "Closed recently" can show it
// and offer it back; reopening clears both. It goes through the ledger like
// every other change, so your own decisions are in the same history as the
// assistant's.
const REASON = { open: null, done: 'you marked it done', dropped: 'you dismissed it' };

async function setStatus(id, status) {
  if (!SETTABLE.has(status)) throw new Error(`status must be one of ${[...SETTABLE].join(', ')}`);
  const r = await ledger.transition({ commitmentId: id, to: status, actor: 'you', reason: REASON[status] });
  if (!r.changed && r.skip === 'commitment not found') throw new Error(`no commitment #${id}`);
  // A close covers the whole duplicate group: closing one copy of a restated
  // ask left its twin open on the board, so "Done" looked like it did nothing.
  if (status !== 'open') await closeGroup(id, status, REASON[status]);
  return repo.commitments.summaryRow(id);
}

/** Closes the open rest of `id`'s duplicate group the same way. Returns their ids. */
async function closeGroup(id, status, reason) {
  const ids = (await repo.commitments.openDuplicatesOf(id)).map((r) => Number(r.id));
  for (const other of ids) {
    await ledger.transition({ commitmentId: other, to: status, actor: 'you', reason: `${reason} (duplicate of #${id})` });
  }
  return ids;
}

// Closed in the last few days, newest first — by you or by the assistant.
async function recentlyClosed({ days = 3, limit = 40 } = {}) {
  return repo.commitments.recentlyClosed(String(days), limit);
}

module.exports = { setStatus, closeGroup, recentlyClosed, SETTABLE };
