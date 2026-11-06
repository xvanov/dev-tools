'use strict';

// Closing the loop on a commitment by hand. One implementation, shared by the
// CLI (`pa done`) and the dashboard's buttons, per AGENT.md.
//
// `dispatched` is not settable here: only the dispatcher knows a run exists.

const { one, rows } = require('./db');
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
  return one('select id, status, summary from commitment where id = $1', [id]);
}

// Every commitment folded into the same survivor as `id` (superseded_by
// chains), `id` itself excluded. `union`, not `union all`: a cycle ends.
const DUPLICATE_SET_SQL = `
  with recursive up as (
         select id, superseded_by from commitment where id = $1
         union select c.id, c.superseded_by from commitment c join up on c.id = up.superseded_by),
       root as (select id from up where superseded_by is null limit 1),
       down as (
         select id from root
         union select c.id from commitment c join down on c.superseded_by = down.id)
  select d.id from down d join commitment c on c.id = d.id
   where d.id <> $1 and c.status in ('open', 'dispatched')`;

/** Closes the open rest of `id`'s duplicate group the same way. Returns their ids. */
async function closeGroup(id, status, reason) {
  const ids = (await rows(DUPLICATE_SET_SQL, [id])).map((r) => Number(r.id));
  for (const other of ids) {
    await ledger.transition({ commitmentId: other, to: status, actor: 'you', reason: `${reason} (duplicate of #${id})` });
  }
  return ids;
}

// Closed in the last few days, newest first — by you or by the assistant.
async function recentlyClosed({ days = 3, limit = 40 } = {}) {
  return rows(
    `select c.id, c.summary, c.status, c.closed_reason, c.closed_at, si.source,
            coalesce(si.raw->>'webUrl', si.thread_external_id) as url,
            (select t.actor from ledger_transition t where t.commitment_id = c.id and t.undone_at is null
              order by t.at desc, t.id desc limit 1) as actor
       from commitment c join source_item si on si.id = c.source_item_id
      where c.closed_at > now() - ($1 || ' days')::interval
      order by c.closed_at desc limit $2`,
    [String(days), limit]
  );
}

module.exports = { setStatus, closeGroup, recentlyClosed, SETTABLE };
