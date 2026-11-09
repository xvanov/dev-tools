'use strict';

// SQLite twin of src/repo/meetings.js (meeting_series, meeting_brief,
// meeting_debrief).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const { NOW, DAY, sinceMs } = require('./_sql.ts');

function create(db: Db) {
  return {
    /** A series by key, or null. */
    async seriesByKey(key: number | string) {
      return db.one('select * from meeting_series where series_key = $1', [key]);
    },

    /** Creates or updates a series; null kind / kindSource / profile keep what is stored. */
    async saveSeries({ seriesKey, label, kind, kindSource, profile }: { seriesKey?: unknown; label?: string | null; kind?: string | null; kindSource?: unknown; profile?: string | null }) {
      return db.one(
        `insert into meeting_series (series_key, label, kind, kind_source, profile)
     values ($1, $2, $3, $4, coalesce($5, '{}'))
     on conflict (series_key) do update set
       label = excluded.label,
       kind = coalesce($3, meeting_series.kind),
       kind_source = coalesce($4, meeting_series.kind_source),
       profile = coalesce($5, meeting_series.profile),
       updated_at = ${NOW}
     returning *`,
        [seriesKey, label, kind ?? null, kindSource ?? null, profile ? JSON.stringify(profile) : null]
      );
    },

    /** Sets a series' kind by hand; null when the series does not exist. */
    async setSeriesKind(seriesKey: unknown, kind: string) {
      return db.one(`update meeting_series set kind = $2, kind_source = 'manual', updated_at = ${NOW} where series_key = $1 returning *`, [
        seriesKey,
        kind,
      ]);
    },

    /** A brief by dedupe key, or null. */
    async briefByKey(key: number | string) {
      return db.one('select * from meeting_brief where dedupe_key = $1', [key]);
    },

    /** A brief by id, or null. */
    async briefById(id: number | string) {
      return db.one('select * from meeting_brief where id = $1', [id]);
    },

    /** Writes a brief (clearing any error, counting the attempt). */
    async upsertBrief(v: Row) {
      return db.one(
        `insert into meeting_brief (dedupe_key, event_external_id, source_item_id, starts_at, series_key, kind, title,
                                    headline, body, points, refs, join_url, error, attempts)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null,1)
         on conflict (dedupe_key) do update set kind = excluded.kind, title = excluded.title,
           headline = excluded.headline, body = excluded.body, points = excluded.points, refs = excluded.refs,
           join_url = excluded.join_url, error = null, attempts = meeting_brief.attempts + 1, updated_at = ${NOW}
         returning *`,
        [v.key, v.eventId, v.itemId, v.startsAt, v.seriesKey, v.kind, v.title, v.headline, v.body,
          JSON.stringify(v.points), JSON.stringify(v.refs), v.joinUrl]
      );
    },

    /** Records that writing a brief failed (a row with no body), counting the attempt. */
    async recordBriefError(v: Row) {
      await db.query(
        `insert into meeting_brief (dedupe_key, event_external_id, source_item_id, starts_at, series_key, kind, title, error, attempts)
         values ($1,$2,$3,$4,$5,$6,$7,$8,1)
         on conflict (dedupe_key) do update set error = excluded.error, attempts = meeting_brief.attempts + 1, updated_at = ${NOW}`,
        [v.key, v.eventId, v.itemId, v.startsAt, v.seriesKey, v.kind, v.title, v.error]
      );
    },

    /** Links a brief to its notification. */
    async markBriefNotified(id: number | string, notificationId: number | string) {
      return db.one('update meeting_brief set notification_id = $2 where id = $1 returning *', [id, notificationId]);
    },

    /** A debrief by id, or null. */
    async debriefById(id: number | string) {
      return db.one('select * from meeting_debrief where id = $1', [id]);
    },

    /** The newest debrief of an episode that did not fail. */
    async debriefsForEpisode(episodeId: number | string) {
      return db.rows('select * from meeting_debrief where episode_id = $1 order by created_at, id', [episodeId]);
    },

    async lastDebrief(episodeId: number | string) {
      return db.one('select * from meeting_debrief where episode_id = $1 and error is null order by created_at desc, id desc limit 1', [episodeId]);
    },

    /** One debrief per episode (a good one before a failed one, then newest): pg's distinct on. */
    async bestForEpisodes(episodeIds: unknown[]) {
      return db.rows(
        `select d.* from meeting_debrief d
          where d.episode_id in (select value from json_each($1))
            and d.id = (select x.id from meeting_debrief x where x.episode_id = d.episode_id
                         order by (x.error is null) desc, x.created_at desc, x.id desc limit 1)
          order by d.episode_id`,
        [(episodeIds || []).map(Number)]
      );
    },

    /** Debriefs of the last `days` days that did not fail, newest first. */
    async recentDebriefs(days: number, limit: number) {
      return db.rows('select * from meeting_debrief where started_at > $1 and error is null order by started_at desc limit $2', [
        sinceMs(Number(days) * DAY),
        limit,
      ]);
    },

    /** Writes a debrief of (episode, transcript hash), clearing any error and counting the attempt. */
    async upsertDebrief(v: Row) {
      return db.one(
        `insert into meeting_debrief (episode_id, event_external_id, source_item_id, title, started_at, ended_at, content_hash,
                                    transcript_chars, applied, dropped, error, attempts, extracted_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,1,$11)
       on conflict (episode_id, content_hash) do update set title = excluded.title, applied = excluded.applied, dropped = excluded.dropped,
         error = null, attempts = meeting_debrief.attempts + 1, updated_at = ${NOW}
       returning *`,
        [v.episodeId, v.eventExternalId, v.sourceItemId, v.title, v.startedAt, v.endedAt, v.contentHash, v.transcriptChars,
          JSON.stringify(v.applied), v.dropped, v.extractedBy]
      );
    },

    /** Records that debriefing failed (no applied items), counting the attempt. */
    async recordDebriefError(v: Row) {
      await db.query(
        `insert into meeting_debrief (episode_id, event_external_id, source_item_id, title, started_at, ended_at, content_hash,
                                  transcript_chars, error, attempts, extracted_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10)
     on conflict (episode_id, content_hash) do update set error = excluded.error,
       attempts = meeting_debrief.attempts + 1, updated_at = ${NOW}`,
        [v.episodeId, v.eventExternalId, v.sourceItemId, v.title, v.startedAt, v.endedAt, v.contentHash, v.transcriptChars,
          v.error, v.extractedBy]
      );
    },

    /** Links a debrief to its notification. */
    async markDebriefNotified(id: number | string, notificationId: number | string) {
      return db.one('update meeting_debrief set notification_id = $2 where id = $1 returning *', [id, notificationId]);
    },

    /** Marks one applied item of a debrief undone (undone_at, and `undo` = what the undo did). */
    async markItemUndone(id: number | string, index: unknown, result: string) {
      const at = `$.items[${Number(index) | 0}]`;
      await db.query(
        `update meeting_debrief set applied = json_set(applied, $2,
                  json_patch(coalesce(json_extract(applied, $2), '{}'), json_object('undone_at', ${NOW}, 'undo', $3))),
              updated_at = ${NOW} where id = $1`,
        [id, at, result]
      );
    },

    /** For `pa doctor`: briefs written and failed, the last delivered, and series learned from transcripts. */
    async briefStats() {
      const r = await db.one(
        `select (select count(*) from meeting_brief where error is null) as ok,
                (select count(*) from meeting_brief where error is not null) as failed,
                (select max(created_at) from meeting_brief where notification_id is not null) as last,
                (select count(*) from meeting_series where json_type(profile, '$.learnedFrom') is not null) as learned`
      );
      if (r && typeof r.last === 'string') r.last = new Date(r.last as string);
      return r;
    },

    /** For `pa doctor`: debriefs written, those that failed three times, and the last written. */
    async debriefStats() {
      const r = await db.one(
        `select (select count(*) from meeting_debrief where error is null) as ok,
                (select count(*) from meeting_debrief where error is not null and attempts >= 3) as failed,
                (select max(created_at) from meeting_debrief where error is null) as last`
      );
      if (r && typeof r.last === 'string') r.last = new Date(r.last as string);
      return r;
    },
  };
}

module.exports = { create };
