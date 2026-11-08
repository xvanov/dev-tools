'use strict';

// Aggregate: workflowLimits. Table: workflow_limit (a user-edited cost ceiling
// per architecture.json workflow; no row means the JSON's default applies).
// Callers: src/dashboard/workflowLimits.js.

function create(db) {
  return {
    /**
     * Every override.
     * @returns {Promise<{workflow: string, max_usd: number, updated_at: Date}[]>}
     */
    async all() {
      const rows = await db.rows('select workflow, max_usd, updated_at from workflow_limit order by workflow');
      return rows.map((r) => ({ ...r, max_usd: Number(r.max_usd) }));
    },

    /** Sets (or replaces) a workflow's ceiling, in USD (>= 0). */
    async set(workflow, maxUsd) {
      await db.query(
        `insert into workflow_limit (workflow, max_usd) values ($1, $2)
         on conflict (workflow) do update set max_usd = excluded.max_usd, updated_at = now()`,
        [workflow, maxUsd]
      );
    },

    /** Removes a workflow's override, so the default applies again. */
    async reset(workflow) {
      await db.query('delete from workflow_limit where workflow = $1', [workflow]);
    },
  };
}

module.exports = { create };
