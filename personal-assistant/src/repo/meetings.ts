'use strict';

// Aggregate: meetings. Tables: meeting_series (a recurring meeting's kind and
// learned profile), meeting_brief (the pre-meeting note) and meeting_debrief
// (what a recorded meeting changed on your list).
// Callers: src/meetings (index.js, debrief.js).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

/**
 * @typedef {object} SeriesRow
 * @property {string} series_key
 * @property {string} label
 * @property {string|null} kind
 * @property {string|null} kind_source   manual | model | rule | default
 * @property {object} profile
 * @property {Date} updated_at
 */

/**
 * @typedef {object} BriefRow  meeting_brief.*: id, dedupe_key, event_external_id, source_item_id,
 *   starts_at, series_key, kind, title, headline, body, points, refs, join_url, error, attempts,
 *   notification_id, updated_at.
 */

/**
 * @typedef {object} DebriefRow  meeting_debrief.*: id, episode_id, event_external_id, source_item_id,
 *   title, started_at, ended_at, content_hash, transcript_chars, applied, dropped, error, attempts,
 *   notification_id, extracted_by, created_at, updated_at.
 */

/**
 * @typedef {object} BriefValues
 * @property {string} key  dedupe key
 * @property {string} eventId
 * @property {number|string|null} itemId
 * @property {string} startsAt
 * @property {string} seriesKey
 * @property {string} kind
 * @property {string} title
 */

function create(db: Db) {
  return {
    /**
     * @param {string} key  series key
     * @returns {Promise<SeriesRow|null>}
     */
    async seriesByKey(key: number | string) {
      return db.one('select * from meeting_series where series_key = $1', [key]);
    },

    /**
     * Creates or updates a series; null kind / kindSource / profile keep what is stored.
     * @param {{seriesKey: string, label: string, kind: string|null, kindSource: string|null, profile: object|null}} s
     * @returns {Promise<SeriesRow>}
     */
    async saveSeries({ seriesKey, label, kind, kindSource, profile }: { seriesKey?: unknown; label?: string | null; kind?: string | null; kindSource?: unknown; profile?: string | null }) {
      return db.one(
        `insert into meeting_series (series_key, label, kind, kind_source, profile)
     values ($1, $2, $3, $4, coalesce($5::jsonb, '{}'::jsonb))
     on conflict (series_key) do update set
       label = excluded.label,
       kind = coalesce($3, meeting_series.kind),
       kind_source = coalesce($4, meeting_series.kind_source),
       profile = coalesce($5::jsonb, meeting_series.profile),
       updated_at = now()
     returning *`,
        [seriesKey, label, kind ?? null, kindSource ?? null, profile ? JSON.stringify(profile) : null]
      );
    },

    /**
     * Sets a series' kind by hand; null when the series does not exist.
     * @returns {Promise<SeriesRow|null>}
     */
    async setSeriesKind(seriesKey: unknown, kind: string) {
      return db.one(
        `update meeting_series set kind = $2, kind_source = 'manual', updated_at = now() where series_key = $1 returning *`,
        [seriesKey, kind]
      );
    },

    /**
     * @param {string} key  dedupe key
     * @returns {Promise<BriefRow|null>}
     */
    async briefByKey(key: number | string) {
      return db.one('select * from meeting_brief where dedupe_key = $1', [key]);
    },

    /**
     * @param {number|string} id
     * @returns {Promise<BriefRow|null>}
     */
    async briefById(id: number | string) {
      return db.one('select * from meeting_brief where id = $1', [id]);
    },

    /**
     * Writes a brief (clearing any error, counting the attempt).
     * @param {BriefValues & {headline: string, body: string, points: object, refs: object, joinUrl: string|null}} v
     * @returns {Promise<BriefRow>}
     */
    async upsertBrief(v: Row) {
      return db.one(
        `insert into meeting_brief (dedupe_key, event_external_id, source_item_id, starts_at, series_key, kind, title,
                                    headline, body, points, refs, join_url, error, attempts)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null,1)
         on conflict (dedupe_key) do update set kind = excluded.kind, title = excluded.title,
           headline = excluded.headline, body = excluded.body, points = excluded.points, refs = excluded.refs,
           join_url = excluded.join_url, error = null, attempts = meeting_brief.attempts + 1, updated_at = now()
         returning *`,
        [v.key, v.eventId, v.itemId, v.startsAt, v.seriesKey, v.kind, v.title, v.headline, v.body,
          JSON.stringify(v.points), JSON.stringify(v.refs), v.joinUrl]
      );
    },

    /**
     * Records that writing a brief failed (a row with no body), counting the attempt.
     * @param {BriefValues & {error: string}} v
     */
    async recordBriefError(v: Row) {
      await db.query(
        `insert into meeting_brief (dedupe_key, event_external_id, source_item_id, starts_at, series_key, kind, title, error, attempts)
         values ($1,$2,$3,$4,$5,$6,$7,$8,1)
         on conflict (dedupe_key) do update set error = excluded.error, attempts = meeting_brief.attempts + 1, updated_at = now()`,
        [v.key, v.eventId, v.itemId, v.startsAt, v.seriesKey, v.kind, v.title, v.error]
      );
    },

    /**
     * @param {number|string} id  brief id
     * @param {number|string} notificationId
     * @returns {Promise<BriefRow|null>}
     */
    async markBriefNotified(id: number | string, notificationId: number | string) {
      return db.one('update meeting_brief set notification_id = $2 where id = $1 returning *', [id, notificationId]);
    },

    /**
     * @param {number|string} id
     * @returns {Promise<DebriefRow|null>}
     */
    async debriefById(id: number | string) {
      return db.one('select * from meeting_debrief where id = $1', [id]);
    },

    /**
     * The newest debrief of an episode that did not fail.
     * @returns {Promise<DebriefRow|null>}
     */
    async lastDebrief(episodeId: number | string) {
      return db.one(`select * from meeting_debrief where episode_id = $1 and error is null order by created_at desc limit 1`, [episodeId]);
    },

    /**
     * One debrief per episode (a good one before a failed one, then newest).
     * @param {Array<number|string>} episodeIds
     * @returns {Promise<DebriefRow[]>}
     */
    async bestForEpisodes(episodeIds: unknown[]) {
      return db.rows(
        `select distinct on (episode_id) *
           from meeting_debrief
          where episode_id = any($1::bigint[])
          order by episode_id, (error is null) desc, created_at desc`,
        [episodeIds]
      );
    },

    /**
     * Debriefs of the last `days` days that did not fail, newest first.
     * @returns {Promise<DebriefRow[]>}
     */
    async recentDebriefs(days: number, limit: number) {
      return db.rows(
        `select * from meeting_debrief where started_at > now() - ($1 || ' days')::interval and error is null
      order by started_at desc limit $2`,
        [String(days), limit]
      );
    },

    /**
     * Writes a debrief of (episode, transcript hash), clearing any error and
     * counting the attempt. Run it inside the transaction that applied the items.
     * @param {{episodeId: number|string, eventExternalId: string|null, sourceItemId: number|string, title: string,
     *   startedAt: string, endedAt: string, contentHash: string, transcriptChars: number, applied: object,
     *   dropped: number, extractedBy: string}} v
     * @returns {Promise<DebriefRow>}
     */
    async upsertDebrief(v: Row) {
      return db.one(
        `insert into meeting_debrief (episode_id, event_external_id, source_item_id, title, started_at, ended_at, content_hash,
                                    transcript_chars, applied, dropped, error, attempts, extracted_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,1,$11)
       on conflict (episode_id, content_hash) do update set title = excluded.title, applied = excluded.applied, dropped = excluded.dropped,
         error = null, attempts = meeting_debrief.attempts + 1, updated_at = now()
       returning *`,
        [v.episodeId, v.eventExternalId, v.sourceItemId, v.title, v.startedAt, v.endedAt, v.contentHash, v.transcriptChars,
          JSON.stringify(v.applied), v.dropped, v.extractedBy]
      );
    },

    /**
     * Records that debriefing failed (no applied items), counting the attempt.
     * @param {{episodeId: number|string, eventExternalId: string|null, sourceItemId: number|string, title: string,
     *   startedAt: string, endedAt: string, contentHash: string, transcriptChars: number, error: string,
     *   extractedBy: string}} v
     */
    async recordDebriefError(v: Row) {
      await db.query(
        `insert into meeting_debrief (episode_id, event_external_id, source_item_id, title, started_at, ended_at, content_hash,
                                  transcript_chars, error, attempts, extracted_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)
     on conflict (episode_id, content_hash) do update set error = excluded.error,
       attempts = meeting_debrief.attempts + 1, updated_at = now()`,
        [v.episodeId, v.eventExternalId, v.sourceItemId, v.title, v.startedAt, v.endedAt, v.contentHash, v.transcriptChars,
          v.error, v.extractedBy]
      );
    },

    /**
     * @param {number|string} id  debrief id
     * @param {number|string} notificationId
     * @returns {Promise<DebriefRow|null>}
     */
    async markDebriefNotified(id: number | string, notificationId: number | string) {
      return db.one('update meeting_debrief set notification_id = $2 where id = $1 returning *', [id, notificationId]);
    },

    /**
     * Marks one applied item of a debrief undone.
     * @param {number|string} id  debrief id
     * @param {number} index      position in applied.items
     * @param {string} result     what the undo did, kept as `undo`
     */
    async markItemUndone(id: number | string, index: unknown, result: string) {
      await db.query(
        `update meeting_debrief set applied = jsonb_set(applied, $2::text[], (applied #> $2::text[]) || jsonb_build_object('undone_at', now()::text, 'undo', $3::text)),
              updated_at = now() where id = $1`,
        [id, ['items', String(index)], result]
      );
    },

    // --- for cli/index.js

    /**
     * For `pa doctor`: briefs written and failed, the last delivered, and series learned from transcripts.
     * @returns {Promise<{ok: number, failed: number, last: Date|null, learned: number}>}
     */
    async briefStats() {
      return db.one(
        `select (select count(*) from meeting_brief where error is null)::int as ok,
                (select count(*) from meeting_brief where error is not null)::int as failed,
                (select max(created_at) from meeting_brief where notification_id is not null) as last,
                (select count(*) from meeting_series where profile ? 'learnedFrom')::int as learned`
      );
    },

    /**
     * For `pa doctor`: debriefs written, those that failed three times, and the last written.
     * @returns {Promise<{ok: number, failed: number, last: Date|null}>}
     */
    async debriefStats() {
      return db.one(
        `select (select count(*) from meeting_debrief where error is null)::int as ok,
                (select count(*) from meeting_debrief where error is not null and attempts >= 3)::int as failed,
                (select max(created_at) from meeting_debrief where error is null) as last`
      );
    },
  };
}

module.exports = { create };
