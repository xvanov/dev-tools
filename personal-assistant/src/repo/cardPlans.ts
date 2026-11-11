'use strict';

// Aggregate: cardPlans. Tables: card_plan (a proposed set of card changes),
// card_plan_item (one change in it). Callers: src/cardplans.ts. Times are ISO
// text the app writes and `enabled` is 0/1, so the SQL is the same on Postgres
// and SQLite and src/repo/sqlite/cardPlans.ts re-exports this file.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

const PLAN_STATUSES = ['pending', 'applied', 'partly', 'discarded'];
const ITEM_COLUMNS = ['enabled', 'status', 'error', 'result', 'applied_at'];

const iso = (): string => new Date().toISOString();

function create(db: Db) {
  return {
    /** A new pending plan: the row. `sources` is JSON text. */
    async insertPlan(v: { title: string; rationale?: string | null; sources?: string | null; via?: string | null }): Promise<Row> {
      const t = iso();
      const r = await db.query(
        'insert into card_plan (title, rationale, sources, status, via, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$6) returning *',
        [v.title, v.rationale ?? null, v.sources ?? null, 'pending', v.via ?? null, t]
      );
      return r.rows[0] as Row;
    },

    /** One item of a plan, in order (`idx` is its position, from 0): the row. `fields` is JSON text. */
    async insertItem(v: { planId: number | string; idx: number; op: string; commitmentId?: number | null; fields?: string | null; reason?: string | null; enabled?: boolean }): Promise<Row> {
      const r = await db.query(
        'insert into card_plan_item (plan_id, idx, op, commitment_id, fields, reason, enabled) values ($1,$2,$3,$4,$5,$6,$7) returning *',
        [v.planId, v.idx, v.op, v.commitmentId ?? null, v.fields ?? null, v.reason ?? null, v.enabled === false ? 0 : 1]
      );
      return r.rows[0] as Row;
    },

    /** One plan, or null. */
    async planById(id: number | string): Promise<Row | null> {
      return db.one('select * from card_plan where id = $1', [id]);
    },

    /** A plan's items in order. */
    async items(planId: number | string): Promise<Row[]> {
      return db.rows('select * from card_plan_item where plan_id = $1 order by idx', [planId]);
    },

    /** Newest first; `status` keeps one status. */
    async listPlans({ status = null, limit = 20 }: { status?: string | null; limit?: number } = {}): Promise<Row[]> {
      return status
        ? db.rows('select * from card_plan where status = $1 order by id desc limit $2', [status, limit])
        : db.rows('select * from card_plan order by id desc limit $1', [limit]);
    },

    /** How many plans are in a status. */
    async countPlans(status: string): Promise<number> {
      const r = await db.one('select count(*) as n from card_plan where status = $1', [status]);
      return Number(r?.n || 0);
    },

    /** Sets a plan's status (unknown names are refused) and update time; `appliedAt` stamps an apply. Rows changed. */
    async setPlanStatus(id: number | string, status: string, appliedAt: string | null = null): Promise<number> {
      if (!PLAN_STATUSES.includes(status)) throw new Error(`plan status must be one of ${PLAN_STATUSES.join(', ')}`);
      const r = await db.query('update card_plan set status = $2, updated_at = $3, applied_at = coalesce($4, applied_at) where id = $1', [id, status, iso(), appliedAt]);
      return r.rowCount || 0;
    },

    /** Sets the named columns of an item (unknown names are refused). */
    async updateItem(id: number | string, set: Record<string, unknown>): Promise<void> {
      const keys = Object.keys(set);
      const bad = keys.filter((k) => !ITEM_COLUMNS.includes(k));
      if (bad.length || !keys.length) throw new Error(`no settable column: ${bad.join(', ') || '(none given)'}`);
      await db.query(`update card_plan_item set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [id, ...keys.map((k) => set[k])]);
    },

    /** Claims a pending item for running: 1 if it was pending (now `running`), 0 if another run has it or it is done. */
    async claimItem(id: number | string): Promise<number> {
      const r = await db.query(`update card_plan_item set status = 'running' where id = $1 and status = 'pending'`, [id]);
      return r.rowCount || 0;
    },
  };
}

module.exports = { create, PLAN_STATUSES, ITEM_COLUMNS };
