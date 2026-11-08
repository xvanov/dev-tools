'use strict';

// SQLite twin of src/repo/durable.js, plus the queue SQLite runs durable
// tasks on (D19; sql-sqlite/006_durable.sql). Postgres keeps Absurd until the
// 3.5 cutover; there the engine is absurd-sdk and only stats() and
// commitmentsWithoutChase() are repository methods. Here the engine is
// src/durable/sqliteQueue.js, and every statement it runs is below.

const { NOW, DAY, sinceMs } = require('./_sql');

// run_at for a task that waits for an event with no timeout.
const NEVER = '9999-12-31T00:00:00.000Z';

function create(db) {
  return {
    /** Counts per task and state, for `pa doctor`. */
    async stats(queue) {
      if (!/^[a-z0-9_]+$/i.test(queue)) throw new Error(`bad queue name "${queue}"`);
      return db.rows('select task_name, state, count(*) as n from durable_task where queue = $1 group by 1, 2 order by 1, 2', [queue]);
    },

    /**
     * Open asks owed to me by a person, from chat or mail no older than
     * `maxAgeDays`, that have no chase task yet (at most 50).
     */
    async commitmentsWithoutChase(maxAgeDays) {
      return db.rows(
        `select c.id from commitment c
       join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
      where c.status = 'open' and c.direction = 'owed_to_me' and c.superseded_by is null
        and c.counterparty_person_id is not null and not coalesce(per.is_me, 0)
        and si.source in ('graph_chat', 'graph_mail')
        and si.occurred_at > $1
        and not exists (select 1 from durable_task t where t.queue = 'pa' and t.idempotency_key = 'chase2:' || c.id)
      limit 50`,
        [sinceMs(Number(maxAgeDays) * DAY)]
      );
    },

    // ---- the queue (src/durable/sqliteQueue.js) ------------------------------

    /**
     * Starts task `name` once per `key` in `queue`; a second spawn with the key
     * is the same task. `runAt` schedules it (default now).
     * @returns {Promise<{id: number, created: boolean}>}
     */
    async spawnTask({ queue, name, params = {}, key, maxAttempts = 5, runAt = null }) {
      const r = await db.one(
        `insert into durable_task (queue, task_name, params, idempotency_key, max_attempts, run_at)
         values ($1, $2, $3, $4, $5, coalesce($6, ${NOW}))
         on conflict (queue, idempotency_key) do nothing returning id`,
        [queue, name, JSON.stringify(params ?? {}), key, maxAttempts, runAt]
      );
      if (r) return { id: r.id, created: true };
      const had = await db.one('select id from durable_task where queue = $1 and idempotency_key = $2', [queue, key]);
      return { id: had.id, created: false };
    },

    /** One task row, or null. */
    async taskById(id) {
      return db.one('select * from durable_task where id = $1', [id]);
    },

    /**
     * Tasks that may run now: pending or sleeping and due, oldest first, and
     * running ones (whose worker may be gone: the caller's lease decides).
     */
    async runnable(queue, limit) {
      return db.rows(
        `select * from durable_task
          where queue = $1 and (state = 'running' or (state in ('pending', 'sleeping') and run_at <= ${NOW}))
          order by run_at, id limit $2`,
        [queue, limit]
      );
    },

    /** Marks a task running (its worker holds its lease). */
    async markRunning(id) {
      await db.query(`update durable_task set state = 'running', wait_event = null, updated_at = ${NOW} where id = $1`, [id]);
    },

    /** A saved checkpoint `{value}`, or null when there is none. */
    async checkpoint(taskId, name) {
      const r = await db.one('select value from durable_checkpoint where task_id = $1 and name = $2', [taskId, name]);
      return r ? { value: r.value ?? null } : null;
    },

    /** Saves a checkpoint (a step's result, a wake time, a deadline). */
    async saveCheckpoint(taskId, name, value) {
      await db.query(
        `insert into durable_checkpoint (task_id, name, value) values ($1, $2, $3)
         on conflict (task_id, name) do update set value = excluded.value, saved_at = ${NOW}`,
        [taskId, name, JSON.stringify(value === undefined ? null : value)]
      );
    },

    /** An emitted event `{payload}`, or null. */
    async event(queue, name) {
      const r = await db.one('select payload from durable_event where queue = $1 and name = $2', [queue, name]);
      return r ? { payload: r.payload ?? null } : null;
    },

    /**
     * Emits an event: the first emit wins and is kept. Tasks sleeping on it
     * become due now. Resolves whether this emit was the first.
     */
    async emitEvent(queue, name, payload) {
      return db.withTx(async (c) => {
        const ins = await c.query(
          'insert into durable_event (queue, name, payload) values ($1, $2, $3) on conflict (queue, name) do nothing',
          [queue, name, JSON.stringify(payload === undefined ? null : payload)]
        );
        await c.query(`update durable_task set run_at = ${NOW}, updated_at = ${NOW} where queue = $1 and state = 'sleeping' and wait_event = $2`, [queue, name]);
        return ins.rowCount > 0;
      });
    },

    /**
     * Puts a task to sleep until `runAt`, or until `event` is emitted when one
     * is named (null runAt: no timeout). An event already emitted makes it due
     * now, in the same statement, so an emit between the check and here is not lost.
     */
    async suspend(id, runAt, event = null) {
      await db.query(
        `update durable_task set state = 'sleeping', wait_event = $3, updated_at = ${NOW},
            run_at = case when $3 is not null and exists (select 1 from durable_event e where e.queue = durable_task.queue and e.name = $3)
                          then ${NOW} else $2 end
          where id = $1`,
        [id, runAt || NEVER, event]
      );
    },

    /** Marks a task completed with its result. */
    async complete(id, result) {
      await db.query(`update durable_task set state = 'completed', result = $2, error = null, wait_event = null, updated_at = ${NOW} where id = $1`, [
        id,
        JSON.stringify(result === undefined ? null : result),
      ]);
    },

    /** A failed run: back to pending at `runAt` (a retry), or failed for good when `final`. */
    async failRun(id, { error, attempts, runAt, final }) {
      await db.query(
        `update durable_task set state = $2, attempts = $3, error = $4, run_at = coalesce($5, run_at), wait_event = null, updated_at = ${NOW} where id = $1`,
        [id, final ? 'failed' : 'pending', attempts, String(error || '').slice(0, 2000), final ? null : runAt]
      );
    },
  };
}

module.exports = { create, NEVER };
