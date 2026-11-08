'use strict';

// Aggregate: spend. Table: llm_spend (one row per model call: purpose, model,
// backend, cost, tokens, duration, ok). Callers: src/budget.js.

/**
 * @typedef {object} SpendByPurpose
 * @property {string} purpose
 * @property {number} usd
 * @property {number} calls
 */

function create(db) {
  return {
    /**
     * Records one model call. Values are stored as given (budget.record
     * normalises them); null where unknown.
     */
    async record({ purpose, model, backend, costUsd, inputTokens, outputTokens, durationMs, ok }) {
      await db.query(
        `insert into llm_spend (purpose, model, backend, cost_usd, input_tokens, output_tokens, duration_ms, ok)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [purpose, model, backend, costUsd, inputTokens, outputTokens, durationMs, ok]
      );
    },

    /** Dollars recorded at or after `start` (0 when none). @returns {Promise<number>} */
    async totalSince(start) {
      const r = await db.one(`select coalesce(sum(cost_usd), 0)::float8 as usd from llm_spend where at >= $1`, [start]);
      return Number(r?.usd) || 0;
    },

    /** Spend at or after `start` per purpose, most expensive first. @returns {Promise<SpendByPurpose[]>} */
    async byPurposeSince(start) {
      return db.rows(
        `select purpose, coalesce(sum(cost_usd), 0)::float8 as usd, count(*)::int as calls
       from llm_spend where at >= $1
      group by purpose order by usd desc, calls desc`,
        [start]
      );
    },

    /**
     * Spend at or after `since` per local day (in IANA zone `timeZone`) and
     * purpose: {day 'YYYY-MM-DD', purpose, usd, calls, failed, unknown (no cost)}.
     */
    async dailyByPurpose(since, timeZone) {
      return db.rows(
        `select to_char((at at time zone $2)::date, 'YYYY-MM-DD') as day, purpose,
            coalesce(sum(cost_usd), 0)::float8 as usd, count(*)::int as calls,
            count(*) filter (where not ok)::int as failed,
            count(*) filter (where cost_usd is null)::int as unknown
       from llm_spend where at >= $1
      group by 1, 2`,
        [since, timeZone]
      );
    },
  };
}

module.exports = { create };
