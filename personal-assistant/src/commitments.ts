'use strict';

// Closing the loop on a commitment by hand. One implementation, shared by the
// CLI (`pa done`) and the dashboard's buttons, per AGENT.md.
//
// `dispatched` is not settable here: only the dispatcher knows a run exists.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('./repo/types.ts').Row;
type Db = import('./repo/types.ts').Db;

const repo = require('./repo');
const ledger = require('./ledger');

const SETTABLE = new Set(['open', 'done', 'dropped']);

// Closing records who closed it and when, so "Closed recently" can show it
// and offer it back; reopening clears both. It goes through the ledger like
// every other change, so your own decisions are in the same history as the
// assistant's.
const REASON: Record<string, string | null> = { open: null, done: 'you marked it done', dropped: 'you dismissed it' };

async function setStatus(id: number | string, status: string) {
  if (!SETTABLE.has(status)) throw new Error(`status must be one of ${[...SETTABLE].join(', ')}`);
  const r = await ledger.transition({ commitmentId: id, to: status, actor: 'you', reason: REASON[status] ?? null });
  if (!r.changed && r.skip === 'commitment not found') throw new Error(`no commitment #${id}`);
  // A close covers the whole duplicate group: closing one copy of a restated
  // ask left its twin open on the board, so "Done" looked like it did nothing.
  if (status !== 'open') await closeGroup(id, status, REASON[status] ?? null);
  return repo.commitments.summaryRow(id);
}

/** Closes the open rest of `id`'s duplicate group the same way. Returns their ids. */
async function closeGroup(id: number | string, status: string, reason: string | null) {
  const ids: number[] = (await repo.commitments.openDuplicatesOf(id)).map((r: { id: unknown }) => Number(r.id));
  for (const other of ids) {
    await ledger.transition({ commitmentId: other, to: status, actor: 'you', reason: `${reason} (duplicate of #${id})` });
  }
  return ids;
}

// Closed in the last few days, newest first — by you or by the assistant.
async function recentlyClosed({ days = 3, limit = 40 }: { days?: number; limit?: number } = {}) {
  return repo.commitments.recentlyClosed(String(days), limit);
}

module.exports = { setStatus, closeGroup, recentlyClosed, SETTABLE };
