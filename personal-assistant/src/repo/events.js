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

// As the row triggers do (sql/036): number the event, write it to the outbox,
// NOTIFY: one statement, so a generation that replays from the outbox (plan
// 1.4) finds it. A stack without the outbox yet: NOTIFY only.
const PROBE_OUTBOX = `with s as (select nextval('pa_event_seq') as seq),
    o as (insert into event_outbox (seq, topic, payload) select seq, 'deploytest', jsonb_build_object('n', $1::int, 'seq', seq) from s returning seq)
    select pg_notify('pa_events', json_build_object('topic', 'deploytest', 'n', $1::int, 'seq', (select seq from o))::text)`;
const PROBE_NOTIFY_ONLY = "select pg_notify('pa_events', json_build_object('topic', 'deploytest', 'n', $1::int, 'seq', nextval('pa_event_seq'))::text)";

function create(db) {
  let probeNotifyOnly = false;
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

    // --- for src/e2e/deployTest.js

    /**
     * Publishes a `deploytest` event numbered `n`: sequence, outbox row and
     * NOTIFY in one statement. A store without the outbox yet gets the NOTIFY
     * only (and keeps doing so).
     * @param {number} n
     */
    async publishProbe(n) {
      if (!probeNotifyOnly) {
        try {
          await db.query(PROBE_OUTBOX, [n]);
          return;
        } catch (err) {
          if (!/event_outbox/.test(err.message)) throw err;
          probeNotifyOnly = true;
        }
      }
      await db.query(PROBE_NOTIFY_ONLY, [n]);
    },
  };
}

module.exports = { create };
