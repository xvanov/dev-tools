'use strict';

// Which durable tasks should exist, as a query (the worker's 'durable' pass).
//
// Absurd has no cron and no triggers of its own. Rather than spawn from every
// place a commitment can be created (distill, debrief, a hand edit), this pass
// asks the store which commitments want a task and have none, and spawns it
// with an idempotency key — so running it twice, or after a crash, starts
// nothing twice.

const { rows } = require('../db');
const { logger } = require('../log');
const C = require('./tasks/chaseCore');

const log = logger('durable');

async function chases() {
  const due = await rows(
    `select c.id from commitment c
       join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
      where c.status = 'open' and c.direction = 'owed_to_me' and c.superseded_by is null
        and c.counterparty_person_id is not null and not coalesce(per.is_me, false)
        and si.source in ('graph_chat', 'graph_mail')
        and si.occurred_at > now() - interval '${C.MAX_AGE_DAYS} days'
        and not exists (select 1 from absurd.t_pa t where t.idempotency_key = 'chase:' || c.id)
      limit 50`
  );
  const durable = require('./index');
  for (const { id } of due) await durable.spawn('chase', { commitmentId: Number(id) }, { key: `chase:${id}` });
  if (due.length) log.info('chases scheduled', { count: due.length });
  return due.length;
}

async function pass() {
  const n = await chases();
  await require('../proposals').expire();
  return { chases: n };
}

module.exports = { pass, chases };
