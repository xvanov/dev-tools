'use strict';

// The meeting gate: capture records during meetings and holds no device the
// rest of the day.
//
// Always-on capture fed the transcriber every second of the day — music,
// videos, an empty room — and that was a CPU core and a slice of the GPU from
// login to shutdown for audio no debrief would ever read. The gate keeps the
// recorders paused except while
//
//   - a calendar meeting is on (from PA_AUDIO_GATE_LEAD_MINUTES before its
//     start to PA_AUDIO_GATE_GRACE_MINUTES after its end), or
//   - another app is using the microphone (src/platform says which, per OS) —
//     the unplanned call: a Teams ring,
//     a Zoom link in chat, a Meet tab — plus PA_AUDIO_GATE_CALL_GRACE_SECONDS
//     after it lets go, so a dropped call that rejoins stays one recording.
//
// Its lever is the pause file capture already honours, written with the
// marker GATE_MARKER so a pause the gate made is told apart from one you made.
// The gate never removes your pause (`pa mic pause`): silence you asked for
// wins over any meeting. And it only pauses on the way *out* of a meeting, so
// `pa mic on` between meetings records until the next meeting ends.

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { logger } = require('../log');
const { attendable, eventRange } = require('./episodes');
const platform = require('../platform');

const log = logger('meeting-gate');

const GATE_MARKER = 'meeting-gate';

// Who holds the pause file: 'on' (nobody), 'user' (`pa mic pause`, or a file
// we cannot read — honoured the way capture.py honours it), or 'gate'.
function readPause(file = config.audio.pauseFile) {
  let until;
  try {
    until = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return { state: 'on' };
  }
  if (until === GATE_MARKER) return { state: 'gate' };
  if (!until) return { state: 'user', until: null };
  const at = new Date(until).getTime();
  if (Number.isFinite(at) && at <= Date.now()) return { state: 'on', expired: until };
  return { state: 'user', until };
}

// An event worth recording: attendable, and with someone else in it — a solo
// focus block is not a conversation.
function meetingEvent(event) {
  if (!attendable(event)) return false;
  const raw = event.raw || {};
  const attendees = Array.isArray(raw.attendees) ? raw.attendees.length : Number(raw.attendees) || 0;
  return attendees > 0 || raw.isOnlineMeeting === true;
}

// Pure: is a calendar meeting on at `now`?
function calendarActive(events, now, { leadMs, graceMs }) {
  return events
    .filter(meetingEvent)
    .map(eventRange)
    .some((e) => e.start - leadMs <= now && now < e.end + graceMs);
}

// Who holds the microphone is the platform's to answer (src/platform): the
// Windows registry's per-app consent store, or PipeWire/PulseAudio's
// recording streams on Linux. Python — our own recorder and voice-dictation —
// never counts, or the gate would hold itself open forever.
// Pure, kept here for its tests: the Windows registry parser.
const micHolders = platform.select('win32').parseMicHolders;

/**
 * Pure: what the gate should do now.
 *
 * @param {object} s
 * @param {boolean} s.calendar  a calendar meeting is on
 * @param {boolean} s.call      another app holds the mic, or did within the call grace
 * @param {string}  s.pause     readPause().state
 * @param {?boolean} s.wanted   what the last tick wanted (null on the first tick)
 * @returns {{want: boolean, action: 'resume'|'pause'|'none', reason: string}}
 */
function decide({ calendar, call, pause, wanted }) {
  const want = calendar || call;
  const reason = calendar ? 'calendar meeting' : call ? 'call in progress' : 'no meeting';
  if (pause === 'user') return { want, action: 'none', reason: 'paused by you' };
  if (want && pause === 'gate') return { want, action: 'resume', reason };
  if (!want && pause === 'on' && wanted !== false) return { want, action: 'pause', reason };
  return { want, action: 'none', reason };
}

async function currentMicHolders() {
  return platform.capture.micHolders().catch(() => []);
}

async function upcomingEvents(now) {
  const { rows } = require('../db');
  return rows(
    `select subject, occurred_at, raw from source_item
      where source = 'graph_event'
        and occurred_at between $1::timestamptz - interval '12 hours' and $1::timestamptz + interval '1 hour'`,
    [new Date(now)]
  );
}

let wanted = null;
let lastCallAt = 0;

async function tick({ now = Date.now() } = {}) {
  const g = config.audio.gate;
  const holders = await currentMicHolders();
  if (holders.length) lastCallAt = now;
  const calendar = calendarActive(await upcomingEvents(now), now, {
    leadMs: g.leadMinutes * 60_000,
    graceMs: g.graceMinutes * 60_000,
  });
  const call = now - lastCallAt < g.callGraceSeconds * 1000;
  const pause = readPause();
  const d = decide({ calendar, call, pause: pause.state, wanted });

  if (d.action === 'resume') {
    try {
      fs.unlinkSync(config.audio.pauseFile);
    } catch {
      /* already gone */
    }
  } else if (d.action === 'pause') {
    fs.mkdirSync(path.dirname(config.audio.pauseFile), { recursive: true });
    fs.writeFileSync(config.audio.pauseFile, GATE_MARKER);
  }
  if (d.action !== 'none' || d.want !== wanted) {
    log.info(d.want ? 'recording' : 'idle', { action: d.action, reason: d.reason, micApps: holders.length });
  }
  wanted = d.want;
  return d;
}

module.exports = { tick, decide, readPause, micHolders, calendarActive, meetingEvent, GATE_MARKER };
