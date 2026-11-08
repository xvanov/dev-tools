'use strict';

// SQLite twin of src/repo/spend.js (llm_spend).

function create(db) {
  return {
    /** Records one model call (values as given; null where unknown). */
    async record({ purpose, model, backend, costUsd, inputTokens, outputTokens, durationMs, ok }) {
      await db.query(
        `insert into llm_spend (purpose, model, backend, cost_usd, input_tokens, output_tokens, duration_ms, ok)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [purpose, model, backend, costUsd, inputTokens, outputTokens, durationMs, ok]
      );
    },

    /** Dollars recorded at or after `start` (0 when none). */
    async totalSince(start) {
      const r = await db.one('select total(cost_usd) as usd from llm_spend where at >= $1', [start]);
      return Number(r?.usd) || 0;
    },

    /** Spend at or after `start` per purpose, most expensive first. */
    async byPurposeSince(start) {
      return db.rows(
        `select purpose, total(cost_usd) as usd, count(*) as calls
       from llm_spend where at >= $1
      group by purpose order by usd desc, calls desc`,
        [start]
      );
    },

    /** Spend at or after `since` per local day (IANA zone `timeZone`) and purpose. */
    async dailyByPurpose(since, timeZone) {
      return db.rows(
        `select pa_local_day(at, $2) as day, purpose,
            total(cost_usd) as usd, count(*) as calls,
            count(*) filter (where not ok) as failed,
            count(*) filter (where cost_usd is null) as unknown
       from llm_spend where at >= $1
      group by 1, 2`,
        [since, timeZone]
      );
    },

    /** Spend at or after `since` per local day, model and purpose. */
    async dailyBreakdown(since, timeZone) {
      return db.rows(
        `select pa_local_day(at, $2) as day, model, purpose,
            total(cost_usd) as usd, count(*) as calls
       from llm_spend where at >= $1
      group by 1, 2, 3`,
        [since, timeZone]
      );
    },

    /** What headless Claude Code drew from the credit pool at or after `start` (cli and claude_session backends). */
    async claudePoolSince(start) {
      const r = await db.one(
        `select total(cost_usd) as usd, count(*) as calls
       from llm_spend where at >= $1 and backend in ('cli', 'claude_session')`,
        [start]
      );
      return { usd: Number(r?.usd) || 0, calls: Number(r?.calls) || 0 };
    },
  };
}

module.exports = { create };
