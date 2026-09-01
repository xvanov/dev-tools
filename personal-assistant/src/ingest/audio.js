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
const { toEpisodes, classify, renderTranscript, isSubstantial } = require('../audio/episodes');
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

async function run() {
  const spool = config.audioDir;
  const files = sidecarFiles(spool);
  if (!files.length) return 0;

  const sidecars = files.map(readSidecar).filter(Boolean);
  if (!sidecars.length) return 0;

  const episodes = toEpisodes(sidecars, { gapSeconds: config.audio.episodeGapSeconds });
  const first = episodes[0].started_at;
  const last = episodes[episodes.length - 1].ended_at;
  const events = await calendarWindow(first, last);

  const items = [];
  const records = [];

  for (const episode of episodes) {
    const already = await one(
      'select id from audio_episode where stream = $1 and started_at = $2',
      [episode.streams.join('+'), episode.started_at]
    );
    if (already) continue;

    const meta = classify(episode, events);
    const transcript = renderTranscript(episode);

    // A thirty-second exchange of "yep, sounds good" is real speech and no
    // signal. Recording it is fine; distilling it costs a model call per
    // fragment and produces nothing.
    if (!isSubstantial(episode)) {
      records.push({ episode, meta, skipped: true });
      continue;
    }

    const subject =
      meta.title ||
      (meta.kind === 'call' ? 'Call' : meta.kind === 'ambient' ? 'Conversation' : 'Recording') +
        ` — ${new Date(episode.started_at).toLocaleString()}`;

    items.push({
      externalId: `${episode.started_at}/${episode.streams.join('+')}`,
      threadExternalId: meta.calendarEventId || null,
      occurredAt: episode.started_at,
      authorIdentity: 'me',
      subject,
      bodyText: transcript,
      raw: {
        kind: meta.kind,
        streams: episode.streams,
        speechSeconds: Math.round(episode.speech_seconds),
        attendees: meta.attendees,
        endedAt: episode.ended_at,
        audioPaths: episode.parts.map((p) => p.audio_path),
      },
    });
    records.push({ episode, meta, skipped: false });
  }

  const changed = items.length ? await saveItems('audio', items, null) : 0;

  for (const { episode, meta, skipped } of records) {
    const item = skipped
      ? null
      : await one('select id from source_item where source = $1 and external_id = $2', [
          'audio',
          `${episode.started_at}/${episode.streams.join('+')}`,
        ]);
    await query(
      `insert into audio_episode
         (started_at, ended_at, stream, speech_seconds, kind, calendar_event_id,
          audio_path, transcript_path, state, source_item_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (stream, started_at) do nothing`,
      [
        episode.started_at,
        episode.ended_at,
        episode.streams.join('+'),
        episode.speech_seconds,
        meta.kind,
        meta.calendarEventId,
        episode.parts[0]?.audio_path || null,
        episode.parts[0]?.__file || null,
        skipped ? 'transcribed' : 'distilled',
        item?.id || null,
      ]
    );
  }

  await saveItems('audio', [], {
    source: 'audio',
    deltaToken: null,
    state: { sidecars: sidecars.length, episodes: episodes.length },
  });

  log.info('episodes ingested', { episodes: episodes.length, stored: changed });
  return changed;
}

module.exports = { run, id: 'audio', sidecarFiles };
