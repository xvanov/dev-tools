'use strict';

// SQLite twin of src/repo/spend.js (llm_spend).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;

// The UTC quarter hour an `at` falls in: 'YYYY-MM-DDTHH:' and 0-3 (QUARTER),
// then as an instant (QUARTER_AT). Every zone's offset is a whole number of
// quarter hours, so a quarter hour never straddles a local midnight:
// pa_local_day (a JS call) runs once per quarter hour that had calls, not once
// per row (60k rows a week on the work stack).
const QUARTER = 'substr(at, 1, 14) || (cast(substr(at, 15, 2) as integer) / 15)';
const QUARTER_AT = "substr(q, 1, 14) || printf('%02d', cast(substr(q, 15) as integer) * 15) || ':00Z'";

function create(db: Db) {
  return {
    /** Records one model call (values as given; null where unknown). */
    async record({ purpose, model, backend, costUsd, inputTokens, outputTokens, durationMs, ok }: { purpose?: string; model?: string; backend?: string; costUsd?: unknown; inputTokens?: unknown; outputTokens?: unknown; durationMs?: unknown; ok?: boolean }) {
      await db.query(
        `insert into llm_spend (purpose, model, backend, cost_usd, input_tokens, output_tokens, duration_ms, ok)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [purpose, model, backend, costUsd, inputTokens, outputTokens, durationMs, ok]
      );
    },

    /** Dollars recorded at or after `start` (0 when none). */
    async totalSince(start: Date | string | number) {
      const r = await db.one('select total(cost_usd) as usd from llm_spend where at >= $1', [start]);
      return Number(r?.usd) || 0;
    },

    /** Spend at or after `start` per purpose, most expensive first. */
    async byPurposeSince(start: Date | string | number) {
      return db.rows(
        `select purpose, total(cost_usd) as usd, count(*) as calls
       from llm_spend where at >= $1
      group by purpose order by usd desc, calls desc`,
        [start]
      );
    },

    /** Spend at or after `since` per local day (IANA zone `timeZone`) and purpose. */
    async dailyByPurpose(since: Date | string | number, timeZone: string) {
      return db.rows(
        `select pa_local_day(${QUARTER_AT}, $2) as day, purpose,
            total(usd) as usd, total(calls) as calls, total(failed) as failed, total(unknown) as unknown
       from (select ${QUARTER} as q, purpose,
                    total(cost_usd) as usd, count(*) as calls,
                    count(*) filter (where not ok) as failed,
                    count(*) filter (where cost_usd is null) as unknown
               from llm_spend where at >= $1
              group by 1, 2)
      group by 1, 2`,
        [since, timeZone]
      );
    },

    /** Spend at or after `since` per local day, model and purpose. */
    async dailyBreakdown(since: Date | string | number, timeZone: string) {
      return db.rows(
        `select pa_local_day(${QUARTER_AT}, $2) as day, model, purpose, total(usd) as usd, total(calls) as calls
       from (select ${QUARTER} as q, model, purpose, total(cost_usd) as usd, count(*) as calls
               from llm_spend where at >= $1
              group by 1, 2, 3)
      group by 1, 2, 3`,
        [since, timeZone]
      );
    },

    /** What headless Claude Code drew from the credit pool at or after `start` (cli and claude_session backends). */
    async claudePoolSince(start: Date | string | number) {
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
