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
  return one('select id, status, summary from commitment where id = $1', [id]);
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

module.exports = { setStatus, recentlyClosed, SETTABLE };
