'use strict';

// SQLite twin of src/repo/events.js. event_outbox and pa_event_seq are
// written by the triggers in sql-sqlite/003_events.sql.

function create(db) {
  return {
    /** The counter's value now: every event numbered at or under it was numbered before this call. */
    async head() {
      const r = await db.one('select last_value from pa_event_seq where id = 1');
      return r ? String(r.last_value) : null;
    },

    /** Events numbered after `seq`, oldest first, at most `limit`, on `topics` only when given. */
    async after(seq, { topics = null, limit = 1000 } = {}) {
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
    async listen(channel) {
      if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`bad channel "${channel}"`);
      if (!db.session) throw new Error('events.listen needs a session (pool.connect()), not the pool');
      db.session.listen(channel);
    },

    /** The oldest seq still kept, or null when the outbox is empty. */
    async oldest() {
      const r = await db.one('select cast(min(seq) as text) as seq from event_outbox');
      return r && r.seq != null ? r.seq : null;
    },
  };
}

module.exports = { create };
