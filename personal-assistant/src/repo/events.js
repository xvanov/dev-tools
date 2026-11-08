'use strict';

// Aggregate: events. Table: event_outbox (sql/036, plan 1.4), written only by
// the pa_notify_event trigger in the writer's own transaction; the sequence
// pa_event_seq numbers it (sql/035). Callers: src/events (the listener's
// baseline and backfill) and src/dashboard/events.js (Last-Event-ID replay).

/**
 * @typedef {object} OutboxEvent
 * @property {string} seq      the global number, as a string (bigint)
 * @property {string} topic
 * @property {object} payload  {table, op, id, seq, <the trigger's columns>}
 * @property {Date} at
 */

function create(db) {
  return {
    /**
     * The sequence's value now: every event numbered at or under it was
     * numbered before this call (null before sql/035).
     * @returns {Promise<string|null>}
     */
    async head() {
      const r = await db.one('select last_value, is_called from pa_event_seq');
      if (!r) return null;
      return String(r.is_called ? BigInt(r.last_value) : BigInt(r.last_value) - 1n);
    },

    /**
     * Events numbered after `seq`, oldest first, at most `limit`, on `topics`
     * only when given. `more` says whether more than `limit` were waiting.
     * @returns {Promise<{events: OutboxEvent[], more: boolean}>}
     */
    async after(seq, { topics = null, limit = 1000 } = {}) {
      const list = await db.rows(
        `select seq::text as seq, topic, payload, at from event_outbox
          where seq > $1::bigint and ($2::text[] is null or topic = any($2::text[]))
          order by seq limit $3`,
        [String(seq), topics && topics.length ? topics : null, limit + 1]
      );
      return { events: list.slice(0, limit), more: list.length > limit };
    },

    /**
     * LISTENs on `channel` (on a backend over one dedicated connection:
     * clientBackend(client)); the connection then emits `notification`.
     */
    async listen(channel) {
      if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`bad channel "${channel}"`);
      await db.query(`listen ${channel}`);
    },

    /** The oldest seq still kept, or null when the outbox is empty. */
    async oldest() {
      const r = await db.one('select min(seq)::text as seq from event_outbox');
      return r && r.seq != null ? r.seq : null;
    },
  };
}

module.exports = { create };
