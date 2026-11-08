'use strict';

// SQLite twin of src/repo/factoryBoard.js (factory_board: one row, the last
// `job list` taken from the factory and the last error doing so). Its event
// triggers are in sql-sqlite/003.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const { NOW } = require('./_sql');

function create(db: Db) {
  const tx = <T>(fn: (q: Pick<Db, 'query'>) => Promise<T>): Promise<T> => (db.inTx ? fn(db) : db.withTx(fn));

  return {
    /** The stored list: {jobs, polled_at, error, error_at}, or null before the first poll. */
    async row() {
      return db.one('select jobs, polled_at, error, error_at from factory_board where id = 1');
    },

    /** Records that taking the list failed (the jobs and their time are kept). */
    async recordError(message: string) {
      await db.query(
        `insert into factory_board (id, error, error_at) values (1, $1, ${NOW})
       on conflict (id) do update set error = excluded.error, error_at = ${NOW}`,
        [message]
      );
    },

    /** Stores a fresh list (an array of jobs) and clears the error. */
    async store(jobs: unknown) {
      await db.query(
        `insert into factory_board (id, jobs, polled_at, error, error_at) values (1, $1, ${NOW}, null, null)
     on conflict (id) do update set jobs = excluded.jobs, polled_at = ${NOW}, error = null, error_at = null`,
        [JSON.stringify(jobs)]
      );
    },

    /**
     * Merges `patch` into one job of the stored list when its state would
     * change (pg's jsonb ||, one level deep). Resolves rows changed (0 or 1).
     * Read, merge and write share a transaction.
     */
    async patchJob(jobId: number | string, patch: Row, state: string) {
      return tx(async (q) => {
        const { rows } = await q.query('select jobs from factory_board where id = 1');
        const jobs: Row[] | null = rows[0] && Array.isArray(rows[0].jobs) ? (rows[0].jobs as Row[]) : null;
        if (!jobs) return 0;
        const want = state == null ? null : String(state);
        const hit = jobs.some((j) => j && String(j.job_id) === String(jobId) && (j.state == null ? null : String(j.state)) !== want);
        if (!hit) return 0;
        const next = jobs.map((j) => (j && String(j.job_id) === String(jobId) ? { ...j, ...patch } : j));
        const r = await q.query('update factory_board set jobs = $1 where id = 1', [JSON.stringify(next)]);
        return r.rowCount || 0;
      });
    },

    /**
     * Wakes the pacer: a factory push arrived for these jobs. Postgres sends a
     * NOTIFY on pa_events with no outbox row; SQLite has no NOTIFY, so this
     * hands the same body to the backend's in-process notify when it has one
     * (db.notify), and is a no-op otherwise.
     */
    async notifyPush(jobIds: unknown[]) {
      const payload = JSON.stringify({ topic: 'factory', table: 'push', op: 'push', jobs: jobIds });
      if (typeof db.notify === 'function') await db.notify('pa_events', payload);
    },
  };
}

module.exports = { create };
