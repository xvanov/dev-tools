'use strict';

// SQLite twin of src/repo/events.js. event_outbox and pa_event_seq are
// written by the triggers in sql-sqlite/003_events.sql.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

function create(db: Db) {
  return {
    /** The counter's value now: every event numbered at or under it was numbered before this call. */
    async head() {
      const r = await db.one('select last_value from pa_event_seq where id = 1');
      return r ? String(r.last_value) : null;
    },

    /** Events numbered after `seq`, oldest first, at most `limit`, on `topics` only when given. */
    async after(seq: unknown, { topics = null, limit = 1000 }: { topics?: unknown[] | null; limit?: number } = {}) {
      const list = await db.rows(
        `select cast(seq as text) as seq, topic, payload, at from event_outbox
          where seq > $1 and ($2 is null or topic in (select value from json_each($2)))
          order by seq limit $3`,
        [Number(String(seq)), topics && topics.length ? topics : null, limit + 1]
      );
      return { events: list.slice(0, limit), more: list.length > limit };
    },

    /**
     * LISTENs on `channel` on a session (db.pool.connect()): the session then
     * emits `notification` ({channel, payload}) for events committed in this
     * process (src/db/sqlite.js).
     */
    async listen(channel: string) {
      if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`bad channel "${channel}"`);
      if (!db.session) throw new Error('events.listen needs a session (pool.connect()), not the pool');
      db.session.listen(channel);
    },

    /**
     * The deploy test's probe event n: numbered from pa_event_seq and written
     * to the outbox in one transaction (topic deploytest, payload {n, seq}),
     * as the Postgres twin does. The backend hands outbox rows to LISTENing
     * sessions after the commit, so the probe is also the wake-up (in-process).
     */
    async publishProbe(n: number) {
      const write = async (q: Pick<Db, 'query'>) => {
        await q.query('update pa_event_seq set last_value = last_value + 1 where id = 1');
        await q.query(
          `insert into event_outbox (seq, topic, payload)
           select last_value, 'deploytest', json_object('n', $1, 'seq', last_value) from pa_event_seq where id = 1`,
          [Number(n) | 0]
        );
      };
      await (db.inTx ? write(db) : db.withTx(write));
    },

    /** The oldest seq still kept, or null when the outbox is empty. */
    async oldest() {
      const r = await db.one('select cast(min(seq) as text) as seq from event_outbox');
      return r && r.seq != null ? r.seq : null;
    },
  };
}

module.exports = { create };
