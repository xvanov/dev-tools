'use strict';

// SQLite twin of src/repo/durable.js. The durable task queue on Postgres is
// the vendored Absurd schema (sql/019), driven by absurd-sdk on the pool; it
// has no SQLite engine yet (phase 3 open item), so there are no task tables
// here. Until it does: stats() counts nothing, and commitmentsWithoutChase()
// cannot see existing chase tasks, so it returns every candidate (the chase
// spawner's idempotency key is what still prevents a second chase).

const { DAY, sinceMs } = require('./_sql');

function create(db) {
  return {
    /** Counts per task and state, for `pa doctor`: none on SQLite (no Absurd queue). */
    async stats(queue) {
      if (!/^[a-z0-9_]+$/i.test(queue)) throw new Error(`bad queue name "${queue}"`);
      return [];
    },

    /**
     * Open asks owed to me by a person, from chat or mail no older than
     * maxAgeDays (at most 50). No chase-task filter on SQLite (see above).
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
      limit 50`,
        [sinceMs(Number(maxAgeDays) * DAY)]
      );
    },
  };
}

module.exports = { create };
