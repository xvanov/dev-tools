'use strict';

// Aggregate: factoryBoard. Tables: factory_board (one row: the last `job list`
// the worker took from the factory, and the last error doing so).
// Callers: src/dispatch/factory.js.

function create(db) {
  return {
    /**
     * The stored list: {jobs, polled_at, error, error_at}, or null before the first poll.
     */
    async row() {
      return db.one('select jobs, polled_at, error, error_at from factory_board where id = 1');
    },

    /** Records that taking the list failed (the jobs and their time are kept). */
    async recordError(message) {
      await db.query(
        `insert into factory_board (id, error, error_at) values (1, $1, now())
       on conflict (id) do update set error = excluded.error, error_at = now()`,
        [message]
      );
    },

    /** Stores a fresh list (an array of jobs) and clears the error. */
    async store(jobs) {
      await db.query(
        `insert into factory_board (id, jobs, polled_at, error, error_at) values (1, $1::jsonb, now(), null, null)
     on conflict (id) do update set jobs = excluded.jobs, polled_at = now(), error = null, error_at = null`,
        [JSON.stringify(jobs)]
      );
    },

    /**
     * Merges `patch` into one job of the stored list when its state would change.
     * @param {string} jobId
     * @param {object} patch  fields to merge
     * @param {string|undefined} state  patch.state
     * @returns {Promise<number>} rows changed (0 or 1)
     */
    async patchJob(jobId, patch, state) {
      const r = await db.query(
        `update factory_board set jobs = (
         select coalesce(jsonb_agg(case when j->>'job_id' = $1 then j || $2::jsonb else j end order by n), '[]'::jsonb)
           from jsonb_array_elements(jobs) with ordinality as e(j, n))
        where id = 1 and exists (select 1 from jsonb_array_elements(jobs) j where j->>'job_id' = $1 and j->>'state' is distinct from $3)`,
        [jobId, JSON.stringify(patch), state]
      );
      return r.rowCount || 0;
    },

    /** Wakes the pacer: a factory push arrived for these jobs. */
    async notifyPush(jobIds) {
      await db.query(`select pg_notify('pa_events', $1)`, [JSON.stringify({ topic: 'factory', table: 'push', op: 'push', jobs: jobIds })]);
    },
  };
}

module.exports = { create };