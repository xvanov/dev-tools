'use strict';

// Aggregate: audio. Tables: audio_episode (one stretch of recorded speech, its
// kind, and the source_item its transcript became).
// Callers: src/ingest/audio.js, src/meetings (debrief.js, index.js).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

/**
 * @typedef {object} EpisodeRow  audio_episode.*, plus (for the debrief reads) the
 *   transcript item and the calendar event it matched: body_text, item_subject,
 *   content_hash, event_subject, event_raw, event_item_id, event_occurred_at,
 *   event_external_id, event_organizer, event_body.
 */

// A meeting or call with enough speech to debrief.
const MIN_CHARS = 400;

const EPISODE_SQL = `
  select e.*, si.body_text, si.subject as item_subject, si.content_hash,
         ev.subject as event_subject, ev.raw as event_raw, ev.id as event_item_id, ev.occurred_at as event_occurred_at,
         ev.external_id as event_external_id, ev.author_identity as event_organizer, ev.body_text as event_body
    from audio_episode e
    join source_item si on si.id = e.source_item_id
    left join source_item ev on ev.source = 'graph_event' and ev.external_id = e.calendar_event_id`;

// A meeting or call with enough speech: dual-stream when loopback is present,
// or mic-only when speakerphone picked up both sides of the call.
const OWNED = `e.kind in ('meeting','call') and e.state <> 'superseded'
   and e.stream like '%mic%' and length(si.body_text) >= ${MIN_CHARS}`;

function create(db: Db) {
  return {
    /**
     * The newest episode a debrief owns (see OWNED), with its transcript item
     * and calendar event.
     * @returns {Promise<EpisodeRow|null>}
     */
    async lastOwned() {
      return db.one(`${EPISODE_SQL} where ${OWNED} order by e.ended_at desc limit 1`);
    },

    /**
     * One episode by id (owned or not), with its transcript item and event.
     * @param {number} id
     * @returns {Promise<EpisodeRow|null>}
     */
    async withEventById(id: number | string) {
      return db.one(`${EPISODE_SQL} where e.id = $1`, [id]);
    },

    /**
     * Owned episodes that ended in the last 48 hours of `now` and have no
     * debrief of their current transcript (or one that failed three times).
     * @param {Date} now
     * @returns {Promise<EpisodeRow[]>}
     */
    async awaitingDebrief(now: Date | string | number) {
      return db.rows(
        `${EPISODE_SQL}
      where ${OWNED} and e.ended_at > $1::timestamptz - interval '48 hours'
        and not exists (select 1 from meeting_debrief d where d.episode_id = e.id and d.content_hash = si.content_hash
                          and (d.error is null or d.attempts >= 3))
      order by e.ended_at`,
        [now]
      );
    },

    /**
     * Owned episodes of the last 45 minutes with no debrief row at all.
     * @param {Date} now
     * @returns {Promise<EpisodeRow[]>}
     */
    async waitingForQuiet(now: Date | string | number) {
      return db.rows(
        `${EPISODE_SQL}
        where ${OWNED} and e.ended_at > $1::timestamptz - interval '45 minutes'
          and not exists (select 1 from meeting_debrief d where d.episode_id = e.id)`,
        [now]
      );
    },

    /**
     * The Meetings tab's recorded meetings and calls since `since`, newest
     * first (at most 60), with a transcript (24000 chars) and the matched event.
     * @param {Date} since
     * @returns {Promise<object[]>}
     */
    async overviewSince(since: Date | string | number) {
      return db.rows(
        `select e.id, e.started_at, e.ended_at, e.stream, e.speech_seconds, e.kind, e.calendar_event_id,
            e.source_item_id, si.subject as item_subject, left(si.body_text, 24000) as transcript,
            ev.id as event_item_id, ev.external_id as event_external_id, ev.subject as event_subject,
            ev.occurred_at as event_occurred_at, ev.author_identity as event_organizer,
            ev.body_text as event_body, ev.raw as event_raw
       from audio_episode e
       join source_item si on si.id = e.source_item_id
       left join source_item ev on ev.source = 'graph_event' and ev.external_id = e.calendar_event_id
      where e.kind in ('meeting','call') and e.state <> 'superseded'
        and e.started_at >= $1
      order by e.started_at desc
      limit 60`,
        [since]
      );
    },

    /**
     * Transcripts (audio source items) that belong to a meeting: linked to its
     * event, or overlapping its slot. A superseded episode's item is skipped.
     * @param {string} eventId
     * @param {string} start  ISO
     * @param {string} end    ISO
     * @returns {Promise<{id: number|string, body_text: string, occurred_at: Date}[]>}
     */
    async transcriptsFor(eventId: number | string, start: Date | string | number, end: unknown) {
      return db.rows(
        `select si.id, si.body_text, si.occurred_at from source_item si
      where si.source = 'audio' and length(si.body_text) > 40
        -- A superseded episode's speech lives in another row (ingest/audio.js).
        and not exists (select 1 from audio_episode x where x.source_item_id = si.id and x.state = 'superseded')
        and (
            si.thread_external_id = $1
         or si.id in (select source_item_id from audio_episode where calendar_event_id = $1 and source_item_id is not null)
         or si.occurred_at between $2::timestamptz - interval '10 minutes' and $3::timestamptz)
      order by si.occurred_at`,
        [eventId, start, end]
      );
    },

    /**
     * The stored episode a freshly computed one continues: the same start and
     * streams, else the same start, else one that started inside it. Rows in
     * `claimed` (ids matched earlier in the pass) are not matched twice.
     * @param {{startedAt: string, endedAt: string, claimed: Iterable<number|string>, stream: string}} q
     * @returns {Promise<(EpisodeRow & {item_external_id: string|null})|null>}
     */
    async continuing({ startedAt, endedAt, claimed, stream }: { startedAt?: unknown; endedAt?: unknown; claimed?: Iterable<unknown>; stream?: unknown }) {
      return db.one(
        `select e.*, si.external_id as item_external_id from audio_episode e
       left join source_item si on si.id = e.source_item_id
      where (e.started_at = $1 or (e.started_at > $1 and e.started_at <= $2))
        and e.state <> 'superseded'
        and not (e.id = any($3::bigint[]))
      order by (e.started_at = $1 and e.stream = $4) desc, (e.started_at = $1) desc, e.speech_seconds desc
      limit 1`,
        [startedAt, endedAt, [...(claimed ?? [])], stream]
      );
    },

    /**
     * Marks rows that start inside [startedAt, endedAt] and are not `claimed`
     * superseded (kept: capture is append-only).
     * @returns {Promise<number>} rows marked
     */
    async supersedeWithin(startedAt: unknown, endedAt: unknown, claimed: Iterable<unknown>) {
      const r = await db.query(
        `update audio_episode set state = 'superseded'
        where started_at >= $1 and started_at <= $2 and state <> 'superseded'
          and not (id = any($3::bigint[]))`,
        [startedAt, endedAt, [...(claimed ?? [])]]
      );
      return r.rowCount;
    },

    /**
     * Inserts an episode; a conflict on (stream, started_at) revives that row.
     * @param {Array} values  [started_at, ended_at, stream, speech_seconds, kind, calendar_event_id,
     *   audio_path, transcript_path, state, source_item_id]
     * @returns {Promise<{id: number|string}>}
     */
    async upsert(values: unknown[]) {
      return db.one(
        `insert into audio_episode
           (started_at, ended_at, stream, speech_seconds, kind, calendar_event_id,
            audio_path, transcript_path, state, source_item_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (stream, started_at) do update set
           ended_at = excluded.ended_at, speech_seconds = excluded.speech_seconds, kind = excluded.kind,
           calendar_event_id = excluded.calendar_event_id, state = excluded.state,
           source_item_id = coalesce(excluded.source_item_id, audio_episode.source_item_id)
         returning id`,
        values
      );
    },

    /**
     * Rewrites an episode in place. Throws pg's 23505 when another row holds
     * the new (stream, started_at).
     * @param {Array} values  upsert's ten values, then the episode id
     */
    async update(values: unknown[]) {
      await db.query(
        `update audio_episode set started_at = $1, ended_at = $2, stream = $3, speech_seconds = $4, kind = $5,
                calendar_event_id = $6, audio_path = $7, transcript_path = $8, state = $9, source_item_id = $10
          where id = $11`,
        values
      );
    },

    /** update()'s fallback on a key conflict: everything but the key and paths. */
    async updateKeepingKey({ endedAt, speechSeconds, kind, calendarEventId, state, sourceItemId, id }: { endedAt?: unknown; speechSeconds?: unknown; kind?: string | null; calendarEventId?: number | string | null; state?: string | null; sourceItemId?: number | string | null; id?: number | string | null }) {
      await db.query(
        `update audio_episode set ended_at = $1, speech_seconds = $2, kind = $3, calendar_event_id = $4,
                state = $5, source_item_id = $6 where id = $7`,
        [endedAt, speechSeconds, kind, calendarEventId, state, sourceItemId, id]
      );
    },

    /**
     * Removes a recording of you alone that was stored as a meeting or call:
     * its debriefs and its transcript item go, and the row stays as a
     * kind 'solo', state 'discarded' marker without links, so the audio pass
     * never stores it again. Run it inside a transaction, after undoing what
     * its debriefs applied. Null when there is no such episode.
     * @param {number|string} id
     * @returns {Promise<{files: string[]}|null>} the audio files it pointed at, for the caller to delete
     */
    async discardSolo(id: number | string) {
      const row = await db.one(
        `select e.audio_path, e.transcript_path, e.source_item_id, si.raw as item_raw
           from audio_episode e left join source_item si on si.id = e.source_item_id where e.id = $1`,
        [id]
      );
      if (!row) return null;
      await db.query('delete from meeting_debrief where episode_id = $1', [id]);
      if (row.source_item_id != null) await db.query('delete from source_item where id = $1', [row.source_item_id]);
      await db.query(
        `update audio_episode set kind = 'solo', state = 'discarded', source_item_id = null,
                audio_path = null, transcript_path = null where id = $1`,
        [id]
      );
      return { files: audioFiles(row) };
    },
  };
}

// The files a stored episode points at: its first speech group and sidecar,
// and every speech group its transcript item lists.
function audioFiles(row: Row) {
  const raw = (typeof row.item_raw === 'string' ? JSON.parse(row.item_raw) : row.item_raw) || {};
  const files = [row.audio_path, row.transcript_path, ...(Array.isArray(raw.audioPaths) ? raw.audioPaths : [])];
  return [...new Set(files.filter((f): f is string => typeof f === 'string' && f !== ''))];
}

module.exports = { create };
