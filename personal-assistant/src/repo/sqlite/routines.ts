'use strict';

// SQLite twin of src/repo/routines.js (routine, routine_run).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const { NOW } = require('./_sql.ts');

function create(db: Db) {
  return {
    /** Adds a routine; returns the row. `evidence` is stored as JSON. */
    async insert({ title, description, schedule, action, params, enabled, origin, status, why, evidence, nextRunAt }: { title?: string | null; description?: string | null; schedule?: unknown; action?: unknown; params?: unknown[] | null; enabled?: boolean | null; origin?: string | null; status?: string | null; why?: unknown; evidence?: Row | null; nextRunAt?: unknown }) {
      return db.one(
        `insert into routine (title, description, schedule, action, params, enabled, origin, status, why, evidence, next_run_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [title, description, schedule, action, params, enabled, origin, status, why, JSON.stringify(evidence), nextRunAt]
      );
    },

    /** One routine, or null. */
    async byId(id: number | string) {
      return db.one('select * from routine where id = $1', [id]);
    },

    /**
     * Routines (all, or with these statuses) with their newest run (last_*,
     * running), proposed first, then active, paused, the rest; by id.
     */
    async list({ statuses = null }: { statuses?: unknown[] | null } = {}) {
      const where = statuses ? 'where r.status in (select value from json_each($1))' : '';
      const rows = await db.rows(
        `select r.*, lr.id as last_run_id, lr.ok as last_ok, lr.summary as last_summary, lr.ended_at as last_ended_at,
            lr.dry_run as last_dry_run, (lr.id is not null and lr.ended_at is null) as running
       from routine r
       left join routine_run lr on lr.id = (select x.id from routine_run x where x.routine_id = r.id
                                            order by x.started_at desc, x.id desc limit 1)
       ${where}
      order by case r.status when 'proposed' then 0 when 'active' then 1 when 'paused' then 2 else 3 end, r.id`,
        statuses ? [statuses] : []
      );
      for (const r of rows) r.running = Boolean(r.running);
      return rows;
    },

    /** Runs, newest first, at most `limit`, of one routine or all, with its title and action. */
    async runs({ limit, routineId = null }: { limit?: number | null; routineId?: number | string | null }) {
      return db.rows(
        `select x.*, r.title, r.action from routine_run x join routine r on r.id = x.routine_id
      ${routineId ? 'where x.routine_id = $2' : ''}
      order by x.started_at desc, x.id desc limit $1`,
        routineId ? [limit, Number(routineId)] : [limit]
      );
    },

    /** Moves a routine to `status`, enabled or not, with its next run; returns the row. */
    async setStatus(id: number | string, status: string, enabled: boolean, nextRunAt: unknown) {
      return db.one('update routine set status = $2, enabled = $3, next_run_at = $4 where id = $1 returning *', [id, status, enabled, nextRunAt]);
    },

    /** Marks a suggestion rejected (so it is never proposed again). */
    async reject(id: number | string) {
      await db.query(`update routine set status = 'rejected', enabled = 0, next_run_at = null where id = $1`, [id]);
    },

    /** Deletes a routine. */
    async remove(id: number | string) {
      await db.query('delete from routine where id = $1', [id]);
    },

    /** Closes runs a crash left open. */
    async closeInterrupted() {
      await db.query(
        `update routine_run set ended_at = ${NOW}, ok = 0, summary = 'interrupted (the process running it stopped)'
          where ended_at is null`
      );
    },

    /** Opens a run; returns the row. */
    async startRun(routineId: number | string, dryRun: boolean) {
      return db.one('insert into routine_run (routine_id, dry_run) values ($1, $2) returning *', [routineId, dryRun]);
    },

    /** Ends a run with its verdict, summary and detail; returns the row. */
    async endRun(runId: number | string, ok: boolean, summary: string, detail: string) {
      return db.one(`update routine_run set ended_at = ${NOW}, ok = $2, summary = $3, detail = $4 where id = $1 returning *`, [runId, ok, summary, detail]);
    },

    /** Stamps a routine's last run time now. */
    async touchLastRun(id: number | string) {
      await db.query(`update routine set last_run_at = ${NOW} where id = $1`, [id]);
    },

    /** Active, enabled routines whose next run is due, soonest first: {id, schedule, next_run_at}. */
    async due() {
      return db.rows(
        `select id, schedule, next_run_at from routine
      where status = 'active' and enabled and next_run_at is not null and next_run_at <= ${NOW}
      order by next_run_at`
      );
    },

    /** Pauses a routine whose schedule never runs again. */
    async pauseForever(id: number | string) {
      await db.query(`update routine set status = 'paused', enabled = 0, next_run_at = null where id = $1`, [id]);
    },

    /** Claims a due run: moves next_run_at from `expected` to `next` only if nobody else has. */
    async claimNext(id: number | string, next: unknown, expected: unknown) {
      return db.one('update routine set next_run_at = $2 where id = $1 and next_run_at = $3 returning id', [id, next, expected]);
    },

    /** Puts next_run_at back (a claimed run that did not happen). */
    async setNextRun(id: number | string, nextRunAt: unknown) {
      await db.query('update routine set next_run_at = $2 where id = $1', [id, nextRunAt]);
    },

    /** Every routine's title, schedule, action, params and status. */
    async summaries() {
      return db.rows('select id, title, schedule, action, params, status from routine');
    },
  };
}

module.exports = { create };
