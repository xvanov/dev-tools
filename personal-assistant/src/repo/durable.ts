'use strict';

// Aggregate: durable. Tables: the vendored Absurd queue (schema absurd). The
// queue itself is driven by absurd-sdk on the pool (src/durable/durable.ts);
// these are the reads around it. Callers: src/durable.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

function create(db: Db) {
  return {
    /**
     * Counts per task and state, for `pa doctor`.
     * @param {string} queue  the queue's name (a table suffix: letters, digits, underscore)
     * @returns {Promise<Array<{task_name: string, state: string, n: number}>>}
     */
    async stats(queue: string) {
      if (!/^[a-z0-9_]+$/i.test(queue)) throw new Error(`bad queue name "${queue}"`);
      return db.rows(`select task_name, state, count(*)::int as n from absurd.t_${queue} group by 1, 2 order by 1, 2`);
    },

    /**
     * Open asks owed to me by a person, from chat or mail no older than
     * `maxAgeDays`, that have no chase task yet (at most 50).
     * @param {number} maxAgeDays
     * @returns {Promise<Array<{id: number|string}>>}
     */
    async commitmentsWithoutChase(maxAgeDays: unknown) {
      return db.rows(
        `select c.id from commitment c
       join source_item si on si.id = c.source_item_id
       left join person per on per.id = c.counterparty_person_id
      where c.status = 'open' and c.direction = 'owed_to_me' and c.superseded_by is null
        and c.counterparty_person_id is not null and not coalesce(per.is_me, false)
        and si.source in ('graph_chat', 'graph_mail')
        and si.occurred_at > now() - interval '${Number(maxAgeDays)} days'
        and not exists (select 1 from absurd.t_pa t where t.idempotency_key = 'chase2:' || c.id)
      limit 50`
      );
    },
  };
}

module.exports = { create };