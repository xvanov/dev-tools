'use strict';

// Which durable tasks should exist, as a query (the worker's 'durable' pass).
//
// Absurd has no cron and no triggers of its own. Rather than spawn from every
// place a commitment can be created (distill, debrief, a hand edit), this pass
// asks the store which commitments want a task and have none, and spawns it
// with an idempotency key — so running it twice, or after a crash, starts
// nothing twice. The key carries a version: `chase2:` since a chase first asks
// me for its cadence; the `chase:` tasks before it were cancelled.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../types.ts').Json;

const repo = require('../repo');
const { logger } = require('../log.ts');
const C = require('./tasks/chaseCore.ts');

const log = logger('durable');

async function chases() {
  const due = await repo.durable.commitmentsWithoutChase(C.MAX_AGE_DAYS);
  const durable = require('./index');
  for (const { id } of due) await durable.spawn('chase', { commitmentId: Number(id) }, { key: `chase2:${id}` });
  if (due.length) log.info('chases scheduled', { count: due.length });
  return due.length;
}

async function pass() {
  const n = await chases();
  await require('../proposals').expire();
  return { chases: n };
}

module.exports = { pass, chases };
