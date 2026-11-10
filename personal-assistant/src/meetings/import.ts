'use strict';

// Import a meeting you did not record live: a webinar you watched later, a call
// someone sent you, a Teams or Zoom transcript.
//
//   importMeeting(opts)     one import, start to debrief (`pa meeting import`)
//   start(opts)             the same in the background, for the dashboard's upload
//   jobs()                  the dashboard's imports, newest first
//   parseTranscript(text)   a .vtt / .srt / .txt transcript as "Name: line" paragraphs
//   matchEvent(...)         the calendar event a recording overlaps (pure)
//
// Audio or video is decoded and cut into chunks by ffmpeg (PA_FFMPEG), and each
// chunk is sent to the same faster-whisper server the live audio pass and the
// voice page use (voice-dictation/transcribe_server.py, askWhisper). The text
// is stored as a transcript of 'loopback' speech: everyone in it is someone
// else, so it reads as "Them:" like the far end of a call. A transcript file
// skips transcription.
//
// The episode is stored with state 'imported', which keeps it out of the live
// capture's reach: audio ingest does not continue it, merge it into the episode
// beside it or supersede it as a leftover (repo.audio continuing /
// supersedeWithin), and the audio pass does not debrief it by itself (it has no
// mic stream). The debrief reads it as a meeting the engineer was not in, and
// never discards it as "you alone". No audio is kept: the chunks go when the
// transcript is made.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { config } = require('../config.ts');
const repo = require('../repo');
const { logger } = require('../log.ts');
const { saveItems } = require('../ingest/store.ts');
const { attendable, eventRange } = require('../audio/episodes.ts');

const log = logger('import');

const AUDIO_EXT = /\.(wav|mp3|m4a|mp4|m4v|mov|mkv|webm|ogg|oga|opus|flac|aac|wma|wmv|avi|3gp)$/i;
const TEXT_EXT = /\.(txt|vtt|srt)$/i;
const MIN_CHARS = 200;
const WHISPER_TIMEOUT_MS = 20 * 60_000;
// A chunk whose loudest sample is under this (of 32768) is silence: whisper
// invents text for silence, so it is not sent.
const SILENT_PEAK = 120;

function bad(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** 'audio', 'text', or null for a name this cannot import. */
function kindOf(name: string) {
  if (TEXT_EXT.test(name)) return 'text';
  if (AUDIO_EXT.test(name)) return 'audio';
  return null;
}

// ------------------------------------------------------ text transcripts ----

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Is a speaker label you? A full-name match, or the name inside the label.
function isMe(speaker: string, me: string | null) {
  const a = norm(speaker);
  const b = norm(me || '');
  return !!a && !!b && (a === b || (b.includes(' ') && (a.includes(b) || b.includes(a))));
}

function secondsOf(stamp: string) {
  const m = /(?:(\d+):)?(\d+):(\d+)(?:[.,](\d+))?/.exec(stamp);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4] || 0}`) : null;
}

/**
 * A transcript file as paragraphs of "Name: what they said", and how long it
 * runs when its timings say. Teams and Zoom .vtt (`<v Name>` tags or
 * "Name: text" lines), .srt, and plain text — one paragraph per line when most
 * lines start with a name, else per blank-line paragraph, read as other people.
 * The speaker that is you (`me`) is labelled "Me".
 * @param {string} raw
 * @param {string|null} [me] your display name
 * @returns {{text: string, seconds: number|null}}
 */
function parseTranscript(raw: string, me: string | null = null) {
  const lines = String(raw || '').replace(/^﻿/, '').split(/\r?\n/);
  const label = (speaker: string | null) => (speaker ? (isMe(speaker, me) ? 'Me' : speaker.trim()) : 'Them');
  const out: Array<{ speaker: string | null; text: string }> = [];
  const add = (speaker: string | null, text: string, merge = true) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const last = out[out.length - 1];
    if (merge && last && last.speaker === speaker) last.text += ` ${t}`;
    else out.push({ speaker, text: t });
  };
  const named = (s: string) => /^([^:<>\n]{2,40}):\s+(\S.*)$/.exec(s);

  if (lines.some((l) => l.includes('-->'))) {
    let seconds: number | null = null;
    let inCue = false;
    let cue: string[] = [];
    const flush = () => {
      if (cue.length) {
        const joined = cue.join(' ');
        const v = /^<v(?:\.[^\s>]+)?\s+([^>]+)>/.exec(joined);
        const n = v ? null : named(joined);
        if (v) add((v[1] as string).trim(), joined.replace(/<[^>]*>/g, ''));
        else if (n) add(n[1] as string, n[2] as string);
        else add(null, joined.replace(/<[^>]*>/g, ''));
      }
      cue = [];
    };
    for (const line of lines) {
      const t = line.trim();
      if (t.includes('-->')) {
        flush();
        inCue = true;
        const end = secondsOf(t.split('-->')[1] as string);
        if (end != null && (seconds == null || end > seconds)) seconds = end;
      } else if (!t) {
        flush();
        inCue = false;
      } else if (inCue) cue.push(t);
    }
    flush();
    return { text: out.map((c) => `${label(c.speaker)}: ${c.text}`).join('\n\n'), seconds };
  }

  const rows = lines.map((l) => l.trim()).filter(Boolean);
  const labelled = rows.filter((l) => named(l)).length;
  if (rows.length && labelled >= rows.length / 2) {
    for (const l of rows) {
      const n = named(l);
      if (n) add(n[1] as string, n[2] as string);
      else add(out[out.length - 1]?.speaker ?? null, l);
    }
  } else {
    for (const para of String(raw || '').split(/\r?\n\s*\r?\n/)) add(null, para, false);
  }
  return { text: out.map((c) => `${label(c.speaker)}: ${c.text}`).join('\n\n'), seconds: null };
}

// ------------------------------------------------------------ calendar ----

/**
 * The calendar event a recording of [startMs, endMs] belongs to: the one it
 * overlaps most, at least half of the shorter of the two (as the live capture's
 * classify does). Two overlapping equally (within a minute) are ambiguous: the
 * caller has to say which.
 * @returns {{event: object|null, ambiguous: object[]}}
 */
function matchEvent(events: Row[], startMs: number, endMs: number) {
  const scored: Array<{ event: Row; overlap: number }> = [];
  for (const event of events) {
    if (!attendable(event)) continue;
    const r = eventRange(event);
    const overlap = Math.min(endMs, r.end) - Math.max(startMs, r.start);
    if (overlap < 0 || overlap < 0.5 * Math.min(endMs - startMs, r.end - r.start)) continue;
    scored.push({ event, overlap });
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  const best = scored[0];
  if (!best) return { event: null, ambiguous: [] };
  const tied = scored.filter((s) => best.overlap - s.overlap <= 60_000);
  return tied.length > 1 ? { event: null, ambiguous: tied.map((s) => s.event) } : { event: best.event, ambiguous: [] };
}

async function findEvent(ref: string) {
  const r = String(ref).trim();
  const byExternal = await repo.sources.eventByExternalId(r);
  if (byExternal) return byExternal;
  if (/^\d+$/.test(r)) return repo.sources.eventById(Number(r));
  return null;
}

// ---------------------------------------------------------------- audio ----

function run(cmd: string, args: string[]) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    let stderr = '';
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    p.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    p.on('error', (err: Error & { code?: string }) =>
      reject(err.code === 'ENOENT' ? bad(`ffmpeg not found (${cmd}): install it or set PA_FFMPEG to its path`, 500) : err)
    );
    p.on('close', (code: number | null) => resolve({ code, stderr }));
  });
}

// A 16-bit mono WAV's seconds, and whether it is only silence.
function wavInfo(file: string) {
  const buf = fs.readFileSync(file);
  // ffmpeg's header is longer than 44 bytes (a LIST chunk): the samples start after "data" + its size.
  const at = buf.indexOf('data', 12, 'latin1');
  const pcm = buf.subarray(at < 0 ? 44 : at + 8);
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return { seconds: pcm.length / 2 / config.audio.sampleRate, silent: peak < SILENT_PEAK };
}

/**
 * Transcribes an audio or video file: ffmpeg cuts it into 16 kHz mono chunks,
 * the transcriber reads each, and what it hears is "Them:" paragraphs.
 * @returns {Promise<{text: string, seconds: number, speechSeconds: number}>}
 */
async function transcribeAudio(file: string, onProgress: (p: Row) => void) {
  const { askWhisper } = require('../dashboard/talk.ts');
  fs.mkdirSync(config.audioDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(config.audioDir, 'import-'));
  try {
    onProgress({ state: 'decoding' });
    const seg = Math.max(30, config.audio.import.chunkSeconds);
    const cut = await run(config.audio.import.ffmpeg, [
      '-nostdin', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(config.audio.sampleRate),
      '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', String(seg), '-reset_timestamps', '1', path.join(dir, '%05d.wav'),
    ]);
    const chunks = fs.readdirSync(dir).filter((n: string) => n.endsWith('.wav')).sort();
    if (cut.code !== 0 || !chunks.length) throw bad(`ffmpeg could not read this file as audio: ${cut.stderr.trim().split('\n').pop() || `exit ${cut.code}`}`);
    const paragraphs: string[] = [];
    let seconds = 0;
    let speech = 0;
    for (let i = 0; i < chunks.length; i++) {
      onProgress({ state: 'transcribing', done: i, total: chunks.length });
      const f = path.join(dir, chunks[i] as string);
      const info = wavInfo(f);
      seconds += info.seconds;
      if (info.silent) continue;
      speech += info.seconds;
      const text = await askWhisper(f, { timeoutMs: WHISPER_TIMEOUT_MS });
      if (text) paragraphs.push(`Them: ${text}`);
      fs.unlinkSync(f);
    }
    return { text: paragraphs.join('\n\n'), seconds, speechSeconds: speech };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------- import ----

const cleanName = (name: string) => path.basename(name).replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Imports one recording or transcript, stores it as an episode, and debriefs it.
 * Importing the same transcript again updates its episode (new title, time or
 * event) and debriefs it again, replacing the earlier debrief.
 *
 * @param {object} o
 * @param {string} o.file         path of an audio/video file or a .txt/.vtt/.srt transcript
 * @param {string} [o.name]       its original name (decides the type; default: the path's)
 * @param {string} [o.eventId]    a calendar event: external id, or item id
 * @param {string} [o.title]      a title, when no event is named (no event is matched then)
 * @param {string} [o.at]         when it started (ISO); default: the event's start, else its file time
 * @param {boolean} [o.debrief]   debrief it (default true)
 * @param {function} [o.onProgress]
 */
async function importMeeting(o: { file: string; name?: string; eventId?: string | null; title?: string | null; at?: string | null; debrief?: boolean; onProgress?: (p: Row) => void }) {
  const progress = o.onProgress || (() => {});
  const name = o.name || path.basename(o.file);
  const type = kindOf(name);
  if (!type) throw bad(`cannot import "${name}": expected audio or video (${AUDIO_EXT.source.slice(3, -3).replace(/\|/g, ' ')}) or a .txt, .vtt or .srt transcript`);
  let atMs: number | null = null;
  if (o.at) {
    atMs = new Date(o.at).getTime();
    if (!Number.isFinite(atMs)) throw bad(`--at "${o.at}" is not a date; use an ISO time like 2026-11-10T13:15:00-05:00`);
  }
  const event = o.eventId ? await findEvent(o.eventId) : null;
  if (o.eventId && !event) throw bad(`no calendar event "${o.eventId}" (an external id from \`pa meeting list\`, or an item id)`);

  const me = (await require('./index').context().catch(() => ({ name: null }))).name as string | null;
  let text: string;
  let seconds: number | null;
  let speech: number | null;
  if (type === 'text') {
    progress({ state: 'reading' });
    const t = parseTranscript(fs.readFileSync(o.file, 'utf8'), me);
    text = t.text;
    seconds = t.seconds;
    speech = null;
  } else {
    const t = await transcribeAudio(o.file, progress);
    text = t.text;
    seconds = t.seconds;
    speech = t.speechSeconds;
  }
  if (text.length < MIN_CHARS) throw bad(`only ${text.length} characters of transcript came out of "${name}": nothing to debrief`);

  // When it ran. An explicit time first, then its event's slot, then when the file was saved.
  const range = event ? eventRange(event) : null;
  const length = (seconds ?? (range ? (range.end - range.start) / 1000 : Math.max(300, text.split(/\s+/).length / 2.5))) * 1000;
  const startMs = atMs ?? range?.start ?? Math.floor(fs.statSync(o.file).mtimeMs - length);
  const endMs = startMs + length;

  // No event named: the one it overlaps, unless a title says what it is.
  let matched = event;
  if (!matched && !o.title) {
    const found = matchEvent(await repo.sources.calendarWindow(new Date(startMs).toISOString(), new Date(endMs).toISOString()), startMs, endMs);
    if (found.ambiguous.length) {
      const list = found.ambiguous.map((e: Row) => `  ${e.external_id}  ${e.subject}`).join('\n');
      throw bad(`${found.ambiguous.length} calendar events overlap it equally; say which with --event <id> (or give it a --title):\n${list}`);
    }
    matched = found.event;
  }
  const title = matched?.subject || o.title || cleanName(name) || 'Imported recording';
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  progress({ state: 'storing' });
  const externalId = `import/${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
  const known = await repo.sources.idByExternal('audio', externalId);
  const existing = known ? await repo.audio.forItem(known.id) : null;
  await saveItems(
    'audio',
    [
      {
        externalId,
        threadExternalId: matched?.external_id || null,
        occurredAt: startIso,
        authorIdentity: 'me',
        subject: title,
        bodyText: text,
        raw: {
          kind: 'meeting',
          streams: ['loopback'],
          speechSeconds: Math.round(speech ?? seconds ?? 0),
          attendees: matched?.raw?.attendees || [],
          endedAt: endIso,
          audioPaths: [],
          imported: true,
          importedFrom: name,
        },
      },
    ],
    null
  );
  const itemId = (await repo.sources.idByExternal('audio', externalId)).id;
  await require('../distill').markOwnedByDebrief(itemId);
  const values = [startIso, endIso, 'loopback', speech ?? seconds ?? 0, 'meeting', matched?.external_id || null, null, null, 'imported', itemId];
  let episodeId: number;
  if (existing) {
    await repo.audio.update([...values, existing.id]);
    episodeId = Number(existing.id);
  } else {
    episodeId = Number((await repo.audio.upsert(values)).id);
  }
  log.info('meeting imported', { episode: episodeId, name, chars: text.length, event: matched?.external_id || null, reimport: !!existing });

  let debrief: Row | null = null;
  if (o.debrief !== false) {
    progress({ state: 'debriefing' });
    debrief = await require('./debrief.ts').debrief(episodeId, { deliver: false });
  }
  return { episodeId, title, startedAt: startIso, endedAt: endIso, eventId: matched?.external_id || null, chars: text.length, reimport: !!existing, debrief };
}

// -------------------------------------------------- dashboard imports ----

const JOBS: Row[] = [];
let queue: Promise<unknown> = Promise.resolve();

/** The dashboard's imports: queued, running and finished, newest first (the last 20). */
function jobs() {
  return JOBS.map((j) => ({ ...j })).reverse();
}

/**
 * Starts an import in the background (one at a time: the transcriber takes one
 * request at a time) and returns its job at once. The file is deleted when it
 * is done, whatever happened.
 */
function start(o: { file: string; name: string; eventId?: string | null; title?: string | null; at?: string | null; debrief?: boolean }) {
  const job: Row = { id: crypto.randomBytes(6).toString('hex'), name: o.name, state: 'queued', queuedAt: new Date().toISOString() };
  JOBS.push(job);
  while (JOBS.length > 20) JOBS.shift();
  queue = queue.then(async () => {
    try {
      const r = await importMeeting({ ...o, onProgress: (p) => Object.assign(job, p) });
      Object.assign(job, { state: 'done', done: undefined, total: undefined, episodeId: r.episodeId, title: r.title, debriefId: r.debrief?.debrief?.id ?? null, finishedAt: new Date().toISOString() });
    } catch (err: any) {
      log.warn('import failed', { name: o.name, message: err.message });
      Object.assign(job, { state: 'error', error: err.message, finishedAt: new Date().toISOString() });
    } finally {
      fs.rm(o.file, { force: true }, () => {});
    }
  });
  return { ...job };
}

/** A fresh path for an upload to be written to: not in the capture spool, so live ingest never sees it. */
function uploadPath(name: string) {
  const dir = path.join(config.audioDir, 'import-uploads');
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(name).replace(/[^\w.\- ]+/g, '_').slice(-80) || 'upload';
  return path.join(dir, `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${safe}`);
}

module.exports = { importMeeting, start, jobs, uploadPath, parseTranscript, matchEvent, kindOf, isMe, MIN_CHARS };
