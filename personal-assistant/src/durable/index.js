'use strict';

// Durable tasks: work that has a future (DURABLE.md §2.3).
//
//   spawn(name, params, {key})   start a task once per key (idempotent)
//   emit(event, payload)         wake whatever task waits on that event
//   startWorker()                run tasks inside the worker process
//
// Runs on Absurd (sql/019_durable.sql, absurd-sdk pinned to the same 0.5.0):
// a task is a function of checkpointed steps that can sleep for days or wait
// for an event across restarts, all in our own Postgres. Two rules every task
// here follows:
//
//   - Anything with an effect (a draft, a notification, a proposal, a PR) is
//     a `ctx.step`, so a retry after a crash returns the saved result instead
//     of doing it twice; and each such effect is itself idempotent (dedupe
//     keys), for the one case Absurd cannot cover — a crash after the effect
//     and before its checkpoint.
//   - Before acting, a task reads the world again. A commitment may have been
//     closed while it slept; the event that would have woken it is a hint,
//     not the truth.
//
// The worker runs in the assistant's own process with fatalOnLeaseTimeout
// off: Absurd's default ends the process when a task overruns its lease, and
// that process also serves the dashboard and every other pass.

const { Absurd } = require('absurd-sdk');
const db = require('../db');
const { logger } = require('../log');

const log = logger('durable');

const QUEUE = 'pa';
const TASKS = [require('./tasks/chase'), require('./tasks/runReview')];

let app = null;

function client() {
  if (app) return app;
  app = new Absurd({
    db: db.getPool(),
    queueName: QUEUE,
    log: { log: () => {}, info: (...a) => log.debug(String(a[0])), warn: (...a) => log.warn(String(a[0])), error: (...a) => log.warn(String(a[0])) },
  });
  for (const t of TASKS) {
    app.registerTask({ name: t.name, queue: QUEUE, defaultMaxAttempts: t.maxAttempts || 5 }, (params, ctx) => t.run(params, ctx));
  }
  return app;
}

/** Starts `name` once per `key`: a second spawn with the same key is the same task. */
async function spawn(name, params, { key } = {}) {
  if (!key) throw new Error('a durable task needs an idempotency key');
  return client().spawn(name, params, { idempotencyKey: key });
}

/** First emit of an event wins and is kept: a task that starts waiting later still gets it. */
async function emit(event, payload = {}) {
  return client().emitEvent(event, payload);
}

async function startWorker() {
  return client().startWorker({ concurrency: 2, claimTimeout: 600, fatalOnLeaseTimeout: false, pollInterval: 2 });
}

/** Counts per task and state, for `pa doctor`. */
async function stats() {
  return db.rows(`select task_name, state, count(*)::int as n from absurd.t_${QUEUE} group by 1, 2 order by 1, 2`);
}

module.exports = { spawn, emit, startWorker, stats, client, QUEUE };
