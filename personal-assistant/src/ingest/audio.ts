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
//
// Only conversations with someone else in them are stored. Speech groups that
// are your own dictation or the voice page (src/audio/selfSpeech.ts) are left
// out before episodes are made, and an episode that is you alone (`solo`) is
// not stored at all; once transcription has moved past them, their sidecars
// and speech audio are deleted. A row stored before this rule is left for
// `pa meeting solo` to list and remove.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const fs = require('fs');
const path = require('path');
const { config } = require('../config.ts');
const repo = require('../repo');
const { saveItems } = require('./store.ts');
const { toEpisodes, splitAtEvents, classify, episodeChanged, renderTranscript, isSubstantial } = require('../audio/episodes.ts');
const { logger } = require('../log.ts');
const selfSpeech = require('../audio/selfSpeech.ts');
const spool = require('../audio/spool.ts');

const log = logger('audio');

/**
 * Pure: may a recording that ended at `endedAt` be deleted? Old enough, and
 * transcription has moved past it (or has nothing left to do), so no speech of
 * another stream can still join it.
 */
function settled(endedAt: any, { now, coverage, pending, settleMs, gapMs }: { now: number; coverage: number | null; pending: boolean; settleMs: number; gapMs: number }) {
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(end) || now - end < settleMs) return false;
  return !pending || (coverage != null && coverage >= end + gapMs);
}

// Deletes the sidecars and trimmed speech audio of a recording of you alone.
function forget(parts: any[]) {
  let n = 0;
  for (const p of parts) {
    for (const f of [p.__file, p.audio_path]) {
      if (!f) continue;
      try {
        fs.unlinkSync(f);
        n++;
      } catch {
        /* already gone */
      }
    }
  }
  return n;
}

function sidecarFiles(spool: any) {
  const found: any[] = [];
  for (const stream of ['mic', 'loopback']) {
    const dir = path.join(spool, stream);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.speech.json')) found.push(path.join(dir, name));
    }
  }
  return found;
}

function readSidecar(file: any) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...parsed, __file: file };
  } catch (err: any) {
    log.warn('unreadable sidecar', { file: path.basename(file), message: err.message });
    return null;
  }
}

async function calendarWindow(fromIso: any, toIso: any) {
  return repo.sources.calendarWindow(fromIso, toIso);
}

// The stored episode a freshly computed one continues: the same start and
// streams, else the same start, else one that started inside it (its earliest
// speech group arrived late, after a failed transcription was retried, or a
// meeting boundary now cuts it). Rows already matched in this pass are not
// matched twice.
async function existingFor(episode: any, claimed: any) {
  return repo.audio.continuing({ startedAt: episode.started_at, endedAt: episode.ended_at, claimed, stream: episode.streams.join('+') });
}

// Rows that no computed episode continues but that start inside one: the
// mic-only fragment stored before the loopback half arrived, or the whole of
// two meetings stored as one before they were cut apart. Their speech now
// lives in another row; marking them keeps them (capture is append-only) and
// keeps the debrief from reading the same conversation twice.
async function supersedeLeftovers(episodes: any, claimed: any) {
  let n = 0;
  for (const e of episodes) {
    n += await repo.audio.supersedeWithin(e.started_at, e.ended_at, claimed);
  }
  if (n) log.info('episodes superseded', { count: n });
  return n;
}

async function run() {
  const spool = config.audioDir;
  const files = sidecarFiles(spool);
  if (!files.length) return 0;

  const all = files.map(readSidecar).filter(Boolean);
  if (!all.length) return 0;

  const evidence = selfSpeech.load(config.audio.selfSpeech);
  const { kept: sidecars, self } = selfSpeech.splitSelfSpeech(all, evidence.self);
  const now = Date.now();
  const settle = {
    now,
    coverage: spool.coverage(config.audioDir, { rollMinutes: config.audio.rollMinutes, now }),
    pending: spool.needsProcessing(config.audioDir),
    settleMs: config.audio.selfSpeech.settleMinutes * 60_000,
    gapMs: config.audio.episodeGapSeconds * 1000,
  };
  let forgotten = forget(self.filter((p: any) => settled(p.ended_at, settle)));
  if (!sidecars.length) {
    if (forgotten) log.info('dictation and voice-page audio deleted', { files: forgotten });
    return 0;
  }

  const joined = toEpisodes(sidecars, { gapSeconds: config.audio.episodeGapSeconds });
  const first = joined[0].started_at;
  const last = joined[joined.length - 1].ended_at;
  const events = await calendarWindow(first, last);
  const episodes = splitAtEvents(joined, events);

  const claimed = new Set<any>();
  const stored: any[] = [];
  let changed = 0;
  let solo = 0;

  for (const episode of episodes) {
    const stream = episode.streams.join('+');
    const meta = classify(episode, events, { calls: evidence.calls });
    // An episode grows while its meeting goes on: each finished capture file
    // adds speech groups to it. It is updated in place — once frozen at its
    // first fifteen minutes, a meeting's debrief would read a fraction of it.
    const existing = await existingFor(episode, claimed);
    if (existing) claimed.add(existing.id);
    // You alone: not a meeting, and not stored. A row stored before is left
    // as it is (`pa meeting solo` lists it); one a debrief discarded as solo
    // stays discarded.
    if (meta.kind === 'solo' || existing?.kind === 'solo') {
      if (!existing && settled(episode.ended_at, settle)) forgotten += forget(episode.parts);
      solo++;
      continue;
    }
    stored.push(episode);
    if (existing && !episodeChanged(existing, episode, meta)) continue;

    // A thirty-second exchange of "yep, sounds good" is real speech and no
    // signal. Recording it is fine; distilling it costs a model call per
    // fragment and produces nothing.
    const substantial = isSubstantial(episode);
    let itemId = existing?.source_item_id || null;
    if (substantial) {
      const subject =
        meta.title ||
        (meta.kind === 'call' ? 'Call' : 'Recording') +
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
              audioPaths: episode.parts.map((p: any) => p.audio_path),
            },
          },
        ],
        null
      );
      itemId = (await repo.sources.idByExternal('audio', externalId))?.id ?? itemId;
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
      const row = await repo.audio.upsert(values);
      claimed.add(row.id);
      continue;
    }
    try {
      await repo.audio.update([...values, existing.id]);
    } catch (err: any) {
      // Another row already holds this (stream, start) — a fragment stored
      // before the rest of its conversation arrived. Keep this row's key.
      if (err.code !== '23505') throw err;
      await repo.audio.updateKeepingKey({
        endedAt: episode.ended_at,
        speechSeconds: episode.speech_seconds,
        kind: meta.kind,
        calendarEventId: meta.calendarEventId,
        state: values[8],
        sourceItemId: itemId,
        id: existing.id,
      });
    }
    log.info('episode updated', { episode: existing.id, kind: meta.kind, speechSeconds: Math.round(episode.speech_seconds) });
  }

  await supersedeLeftovers(stored, claimed);
  if (forgotten) log.info('recordings of you alone deleted', { episodes: solo, selfSpeechGroups: self.length, filesDeleted: forgotten });

  await saveItems('audio', [], {
    source: 'audio',
    deltaToken: null as any,
    state: { sidecars: sidecars.length, episodes: episodes.length },
  });

  log.info('episodes ingested', { episodes: episodes.length, stored: changed });
  return changed;
}

module.exports = { run, id: 'audio', sidecarFiles, settled };
