'use strict';

// What the audio spool on disk says, without opening any audio: which capture
// files are finished but not yet transcribed, how far transcription has got,
// and the roll file that asks capture to finish its current file early.
//
// Names are capture's (audio/naming.py): `YYYYMMDDTHHMM[SS][-n].wav`, local
// time, `.wav.done` when capture closed it (its content: the UTC close time),
// `.processed` when process.py is finished with it.

const fs = require('fs');
const path = require('path');

const STREAMS = ['mic', 'loopback'];
const STEM = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(?:-\d+)?$/;

/** Local start time a capture stem names, as a Date, or null. */
function stemStart(stem) {
  const m = STEM.exec(stem);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  return Number.isNaN(t.getTime()) ? null : t;
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readDone(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    // "recovered <time>" is when process.py found an orphan, not when its
    // audio ended; fall back to the slot length for those.
    if (!text || text.startsWith('recovered')) return null;
    const t = new Date(text).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Capture files per stream: [{stream, stem, start, done, doneAt, processed}].
 * @param {string} spool
 */
function files(spool) {
  const out = [];
  for (const stream of STREAMS) {
    const dir = path.join(spool, stream);
    const names = new Set(list(dir));
    const stems = new Set();
    for (const n of names) {
      if (n.endsWith('.speech.wav') || n.endsWith('.speech.json')) continue;
      const m = /^(.+?)\.(wav|wav\.done|processed)$/.exec(n);
      if (m) stems.add(m[1]);
    }
    for (const stem of stems) {
      const start = stemStart(stem);
      if (!start) continue;
      const done = names.has(`${stem}.wav.done`);
      out.push({
        stream,
        stem,
        start: start.getTime(),
        done,
        doneAt: done ? readDone(path.join(dir, `${stem}.wav.done`)) : null,
        processed: names.has(`${stem}.processed`),
        hasWav: names.has(`${stem}.wav`),
      });
    }
  }
  return out;
}

/** True when a finished capture file is waiting for process.py. */
function needsProcessing(spool) {
  return files(spool).some((f) => f.hasWav && f.done && !f.processed);
}

/**
 * The time up to which every active stream's audio has been transcribed, as
 * ms, or null when nothing recent has been. A stream with no file started in
 * the last `activeHours` is not recording and does not hold the others back.
 *
 * This is the honest answer to "has anyone spoken since the episode ended":
 * an episode that ended at 10:05 with coverage at 10:20 had fifteen quiet
 * minutes; with coverage at 10:06 nobody knows yet.
 */
function coverage(spool, { rollMinutes = 15, now = Date.now(), activeHours = 3 } = {}) {
  const all = files(spool);
  const ends = [];
  for (const stream of STREAMS) {
    const mine = all.filter((f) => f.stream === stream);
    if (!mine.some((f) => f.start > now - activeHours * 3600_000)) continue;
    const processed = mine.filter((f) => f.processed);
    if (!processed.length) return null;
    ends.push(Math.max(...processed.map((f) => f.doneAt ?? f.start + rollMinutes * 60_000)));
  }
  return ends.length ? Math.min(...ends) : null;
}

/** When capture was last asked to roll early (ms), or 0. */
function lastRoll(rollFile) {
  try {
    return fs.statSync(rollFile).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Asks both capture streams to finish their current file now. Capture compares
 * the file's mtime with when it opened its file, so touching it is the whole
 * request; nothing deletes it.
 */
function requestRoll(rollFile, reason = '') {
  fs.mkdirSync(path.dirname(rollFile), { recursive: true });
  fs.writeFileSync(rollFile, `${new Date().toISOString()} ${reason}\n`.trimStart());
}

module.exports = { stemStart, files, needsProcessing, coverage, lastRoll, requestRoll, STREAMS };
