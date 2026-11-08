'use strict';

// SQLite twin of src/repo/workflowLimits.js (workflow_limit).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;

const { NOW } = require('./_sql.ts');

function create(db: Db) {
  return {
    /** Every override. */
    async all() {
      const rows = await db.rows('select workflow, max_usd, updated_at from workflow_limit order by workflow');
      return rows.map((r) => ({ ...r, max_usd: Number(r.max_usd) }));
    },

    /** Sets (or replaces) a workflow's ceiling, in USD (>= 0). */
    async set(workflow: string, maxUsd: unknown) {
      await db.query(
        `insert into workflow_limit (workflow, max_usd) values ($1, $2)
         on conflict (workflow) do update set max_usd = excluded.max_usd, updated_at = ${NOW}`,
        [workflow, maxUsd]
      );
    },

    /** Removes a workflow's override, so the default applies again. */
    async reset(workflow: string) {
      await db.query('delete from workflow_limit where workflow = $1', [workflow]);
    },
  };
}

module.exports = { create };
