'use strict';

// Aggregate: notifications. Tables: notification (the feed every proactive
// message lands in), attention_weight (your thumbs, per attention kind) and
// digest (one row per digest slot). The digest's lists read the ledger and
// commitments too: they are this aggregate's read model, kept here so the
// digest is one place. Callers: src/notify (index.js, digest.js, chat.js).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

/**
 * @typedef {object} NotificationRow
 * @property {number|string} id
 * @property {string} kind
 * @property {string} title
 * @property {string} body
 * @property {string|null} url
 * @property {string|null} dedupe_key
 * @property {string} priority    urgent | normal | digest
 * @property {string} delivery    push | digest | feed
 * @property {string[]|null} channel_sent
 * @property {Date|null} toasted_at
 * @property {Date|null} read_at
 * @property {string|null} feedback  up | down | null
 * @property {Date|null} feedback_at
 * @property {Date} created_at
 */

function create(db: Db) {
  return {
    /** Whether a notification with this dedupe key exists. */
    async exists(dedupeKey: unknown) {
      return Boolean(await db.one('select 1 from notification where dedupe_key = $1', [dedupeKey]));
    },

    /** The notification with this dedupe key, or null. */
    async byKey(dedupeKey: unknown) {
      return db.one('select id, kind, priority, delivery, created_at, toasted_at from notification where dedupe_key = $1', [dedupeKey]);
    },

    /**
     * Inserts one; null when its dedupe key is taken (a repeat is a no-op).
     * @returns {Promise<NotificationRow|null>}
     */
    async insert({ kind, title, body, url, dedupeKey, priority, delivery }: { kind?: string | null; title?: string | null; body?: string | null; url?: string | null; dedupeKey?: unknown; priority?: unknown; delivery?: string | null }) {
      return db.one(
        `insert into notification (kind, title, body, url, dedupe_key, priority, delivery)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (dedupe_key) do nothing
     returning *`,
        [kind, title, body, url, dedupeKey, priority, delivery]
      );
    },

    /** Records the channels a push went out on; `toasted` stamps toasted_at. */
    async markSent(id: number | string, channels: unknown, toasted: boolean) {
      await db.query(
        `update notification set channel_sent = $2::text[], toasted_at = case when $3::boolean then now() else toasted_at end where id = $1`,
        [id, channels, toasted]
      );
    },

    /** Pushes (not the digest itself) created at or after `start`. */
    async pushedSince(start: Date | string | number) {
      const r = await db.one(
        `select count(*)::int as n from notification where delivery = 'push' and kind <> 'digest' and created_at >= $1`,
        [start]
      );
      return r ? r.n : 0;
    },

    /** The feed, newest first. @returns {Promise<NotificationRow[]>} */
    async feed({ limit = 30, unreadOnly = false }: { limit?: number; unreadOnly?: boolean } = {}) {
      return db.rows(
        `select * from notification ${unreadOnly ? 'where read_at is null' : ''}
      order by created_at desc limit $1`,
        [limit]
      );
    },

    /** Marks one read (the first read time is kept). */
    async markRead(id: number | string) {
      await db.query('update notification set read_at = coalesce(read_at, now()) where id = $1', [id]);
    },

    /** One notification, locked for update (inside withTx). @returns {Promise<NotificationRow|null>} */
    async lockById(id: number | string) {
      return db.one('select * from notification where id = $1 for update', [id]);
    },

    /** Sets your thumb on one. `value`: up | down | null. */
    async setFeedback(id: number | string, value: string) {
      await db.query('update notification set feedback = $2, feedback_at = now() where id = $1', [id, value]);
    },

    /** The weight of an attention kind, or null when it has none (callers treat that as 1). */
    async weight(kind: string) {
      const r = await db.one('select weight from attention_weight where kind = $1', [kind]);
      return r ? Number(r.weight) : null;
    },

    /** weight(), locked for update (inside withTx). */
    async lockWeight(kind: string) {
      const r = await db.one('select weight from attention_weight where kind = $1 for update', [kind]);
      return r ? Number(r.weight) : null;
    },

    /** Sets an attention kind's weight. */
    async setWeight(kind: string, weight: number) {
      await db.query(
        `insert into attention_weight (kind, weight, updated_at) values ($1, $2, now())
       on conflict (kind) do update set weight = excluded.weight, updated_at = now()`,
        [kind, weight]
      );
    },

    /** Every attention weight, lowest first. */
    async weights() {
      return db.rows('select kind, weight, updated_at from attention_weight order by weight, kind');
    },

    /** Unread pushes from the last `hours` hours, newest first, at most `limit` (the chat's INBOX.md). */
    async unreadPushes(hours: number, limit: number) {
      return db.rows(
        `select id, kind, priority, title, body, url, created_at from notification
      where delivery = 'push' and read_at is null and created_at > now() - ($1 || ' hours')::interval
      order by created_at desc limit $2`,
        [String(hours), limit]
      );
    },

    // ---- the digest (src/notify/digest.js) -------------------------------------

    /** The newest digest's {slot, created_at}, or null. */
    async lastDigest() {
      return db.one('select slot, created_at from digest order by slot desc limit 1');
    },

    /**
     * Writes the digest for `slot`; null when that slot already has one
     * (another process wrote it). `items`: {closed, proposals, waiting, held} ids.
     */
    async insertDigest(slot: string, body: string, items: unknown[]) {
      return db.one(
        `insert into digest (slot, body, items) values ($1, $2, $3)
     on conflict (slot) do nothing returning *`,
        [slot, body, JSON.stringify(items)]
      );
    },

    /** Marks held notifications as delivered by digest `digestId` (ones not in a digest yet). */
    async attachToDigest(digestId: number | string, notificationIds: unknown[]) {
      await db.query('update notification set digest_id = $1 where id = any($2::bigint[]) and digest_id is null', [digestId, notificationIds]);
    },

    /** Notifications held back for the next digest, oldest first. */
    async heldForDigest() {
      return db.rows(
        `select id, kind, title, url, created_at from notification
      where delivery = 'digest' and digest_id is null order by created_at`
      );
    },

    /** Cards the assistant (not you) closed after `since`, newest first, not undone. */
    async closedForYouSince(since: Date | string | number) {
      return db.rows(
        `select t.id, t.commitment_id, t.actor, t.reason, t.to_status, t.at, c.summary
       from ledger_transition t join commitment c on c.id = t.commitment_id
      where t.actor <> 'you' and t.undone_at is null and t.to_status in ('done','dropped') and t.at > $1
      order by t.at desc`,
        [since]
      );
    },

    /** Open asks owed to you that are overdue at `now` or older than `days` days. */
    async waitingOnOthers(now: Date | string | number, days: number) {
      return db.rows(
        `select c.id, c.summary, c.due_at, c.extracted_at, per.display_name as who
       from commitment c left join person per on per.id = c.counterparty_person_id
      where c.direction = 'owed_to_me' and c.status = 'open'
        and (c.due_at < $1 or c.extracted_at < $1::timestamptz - ($2 || ' days')::interval)
      order by coalesce(c.due_at, c.extracted_at)`,
        [now, String(days)]
      );
    },

    // --- for cli/index.js

    /** Marks every unread notification read (`pa inbox ack all`). */
    async markAllRead() {
      await db.query('update notification set read_at = now() where read_at is null');
    },
  };
}

module.exports = { create };
