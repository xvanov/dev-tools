'use strict';

// Closing the loop on a commitment by hand. One implementation, shared by the
// CLI (`pa done`) and the dashboard's buttons, per AGENT.md.
//
// `dispatched` is not settable here: only the dispatcher knows a run exists.

const { one, rows } = require('./db');

const SETTABLE = new Set(['open', 'done', 'dropped']);

// Closing records who closed it and when, so "Closed recently" can show it
// and offer it back; reopening clears both.
async function setStatus(id, status) {
  if (!SETTABLE.has(status)) throw new Error(`status must be one of ${[...SETTABLE].join(', ')}`);
  const row = await one(
    `update commitment
        set status = $2,
            closed_at = case when $2 = 'open' then null else now() end,
            closed_reason = case when $2 = 'open' then null
                                 when $2 = 'done' then 'you marked it done'
                                 else 'you dismissed it' end
      where id = $1 returning id, status, summary`,
    [id, status]
  );
  if (!row) throw new Error(`no commitment #${id}`);
  return row;
}

// Closed in the last few days, newest first — by you or by the assistant.
async function recentlyClosed({ days = 3, limit = 40 } = {}) {
  return rows(
    `select c.id, c.summary, c.status, c.closed_reason, c.closed_at, si.source,
            coalesce(si.raw->>'webUrl', si.thread_external_id) as url
       from commitment c join source_item si on si.id = c.source_item_id
      where c.closed_at > now() - ($1 || ' days')::interval
      order by c.closed_at desc limit $2`,
    [String(days), limit]
  );
}

module.exports = { setStatus, recentlyClosed, SETTABLE };
