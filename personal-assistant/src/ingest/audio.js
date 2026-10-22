'use strict';

// Audio ingest: sidecars on disk become episodes in the store.
//
// The split with the Python side is on purpose — audio-shaped work (devices,
// VAD, whisper) lives in `audio/*.py`, storage-shaped work lives here. The
// interface between them is a JSON file, which means either half can be
// rewritten, run by hand, or debugged with `cat`.
//
// A recorded conversation becomes a normal `source_item`, so distillation sees
// it exactly as it sees an email. That is the point of having one commitments
// table: a promise made out loud and a promise made in writing are the same
// kind of thing to everyone downstream.

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { rows, query, one } = require('../db');
const { saveItems } = require('./store');
const { toEpisodes, splitAtEvents, classify, episodeChanged, renderTranscript, isSubstantial } = require('../audio/episodes');
const { logger } = require('../log');

const log = logger('audio');

function sidecarFiles(spool) {
  const found = [];
  for (const stream of ['mic', 'loopback']) {
    const dir = path.join(spool, stream);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.speech.json')) found.push(path.join(dir, name));
    }
  }
  return found;
}

function readSidecar(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...parsed, __file: file };
  } catch (err) {
    log.warn('unreadable sidecar', { file: path.basename(file), message: err.message });
    return null;
  }
}

async function calendarWindow(fromIso, toIso) {
  return rows(
    `select external_id, subject, occurred_at, raw from source_item
      where source = 'graph_event'
        and occurred_at between $1::timestamptz - interval '2 hours' and $2::timestamptz + interval '2 hours'
      order by occurred_at`,
    [fromIso, toIso]
  );
}

// The stored episode a freshly computed one continues: the same start and
// streams, else the same start, else one that started inside it (its earliest
// speech group arrived late, after a failed transcription was retried, or a
// meeting boundary now cuts it). Rows already matched in this pass are not
// matched twice.
async function existingFor(episode, claimed) {
  return one(
    `select e.*, si.external_id as item_external_id from audio_episode e
       left join source_item si on si.id = e.source_item_id
      where (e.started_at = $1 or (e.started_at > $1 and e.started_at <= $2))
        and e.state <> 'superseded'
        and not (e.id = any($3::bigint[]))
      order by (e.started_at = $1 and e.stream = $4) desc, (e.started_at = $1) desc, e.speech_seconds desc
      limit 1`,
    [episode.started_at, episode.ended_at, [...claimed], episode.streams.join('+')]
  );
}

// Rows that no computed episode continues but that start inside one: the
// mic-only fragment stored before the loopback half arrived, or the whole of
// two meetings stored as one before they were cut apart. Their speech now
// lives in another row; marking them keeps them (capture is append-only) and
// keeps the debrief from reading the same conversation twice.
async function supersedeLeftovers(episodes, claimed) {
  let n = 0;
  for (const e of episodes) {
    const r = await query(
      `update audio_episode set state = 'superseded'
        where started_at >= $1 and started_at <= $2 and state <> 'superseded'
          and not (id = any($3::bigint[]))`,
      [e.started_at, e.ended_at, [...claimed]]
    );
    n += r.rowCount;
  }
  if (n) log.info('episodes superseded', { count: n });
  return n;
}

async function run() {
  const spool = config.audioDir;
  const files = sidecarFiles(spool);
  if (!files.length) return 0;

  const sidecars = files.map(readSidecar).filter(Boolean);
  if (!sidecars.length) return 0;

  const joined = toEpisodes(sidecars, { gapSeconds: config.audio.episodeGapSeconds });
  const first = joined[0].started_at;
  const last = joined[joined.length - 1].ended_at;
  const events = await calendarWindow(first, last);
  const episodes = splitAtEvents(joined, events);

  const claimed = new Set();
  let changed = 0;

  for (const episode of episodes) {
    const stream = episode.streams.join('+');
    const meta = classify(episode, events);
    // An episode grows while its meeting goes on: each finished capture file
    // adds speech groups to it. It is updated in place — once frozen at its
    // first fifteen minutes, a meeting's debrief would read a fraction of it.
    const existing = await existingFor(episode, claimed);
    if (existing) claimed.add(existing.id);
    if (existing && !episodeChanged(existing, episode, meta)) continue;

    // A thirty-second exchange of "yep, sounds good" is real speech and no
    // signal. Recording it is fine; distilling it costs a model call per
    // fragment and produces nothing.
    const substantial = isSubstantial(episode);
    let itemId = existing?.source_item_id || null;
    if (substantial) {
      const subject =
        meta.title ||
        (meta.kind === 'call' ? 'Call' : meta.kind === 'ambient' ? 'Conversation' : 'Recording') +
          ` — ${new Date(episode.started_at).toLocaleString()}`;
      const externalId = existing?.item_external_id || `${episode.started_at}/${stream}`;
      changed += await saveItems(
        'audio',
        [
          {
            externalId,
            threadExternalId: meta.calendarEventId || null,
            occurredAt: episode.started_at,
            authorIdentity: 'me',
            subject,
            bodyText: renderTranscript(episode),
            raw: {
              kind: meta.kind,
              streams: episode.streams,
              speechSeconds: Math.round(episode.speech_seconds),
              attendees: meta.attendees,
              endedAt: episode.ended_at,
              audioPaths: episode.parts.map((p) => p.audio_path),
            },
          },
        ],
        null
      );
      itemId = (await one('select id from source_item where source = $1 and external_id = $2', ['audio', externalId]))?.id ?? itemId;
      if (itemId && (meta.kind === 'meeting' || meta.kind === 'call')) {
        await require('../distill').markOwnedByDebrief(itemId);
      }
    }

    const values = [
      episode.started_at,
      episode.ended_at,
      stream,
      episode.speech_seconds,
      meta.kind,
      meta.calendarEventId,
      episode.parts[0]?.audio_path || null,
      episode.parts[0]?.__file || null,
      substantial ? 'distilled' : 'transcribed',
      itemId,
    ];
    if (!existing) {
      // A conflict here is a row this pass marked superseded earlier, or
      // one a previous pass did: the conversation is back, so is the row.
      const row = await one(
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
      claimed.add(row.id);
      continue;
    }
    try {
      await query(
        `update audio_episode set started_at = $1, ended_at = $2, stream = $3, speech_seconds = $4, kind = $5,
                calendar_event_id = $6, audio_path = $7, transcript_path = $8, state = $9, source_item_id = $10
          where id = $11`,
        [...values, existing.id]
      );
    } catch (err) {
      // Another row already holds this (stream, start) — a fragment stored
      // before the rest of its conversation arrived. Keep this row's key.
      if (err.code !== '23505') throw err;
      await query(
        `update audio_episode set ended_at = $1, speech_seconds = $2, kind = $3, calendar_event_id = $4,
                state = $5, source_item_id = $6 where id = $7`,
        [episode.ended_at, episode.speech_seconds, meta.kind, meta.calendarEventId, values[8], itemId, existing.id]
      );
    }
    log.info('episode updated', { episode: existing.id, kind: meta.kind, speechSeconds: Math.round(episode.speech_seconds) });
  }

  await supersedeLeftovers(episodes, claimed);

  await saveItems('audio', [], {
    source: 'audio',
    deltaToken: null,
    state: { sidecars: sidecars.length, episodes: episodes.length },
  });

  log.info('episodes ingested', { episodes: episodes.length, stored: changed });
  return changed;
}

module.exports = { run, id: 'audio', sidecarFiles };
