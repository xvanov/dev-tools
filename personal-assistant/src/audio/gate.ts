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
// Not every app on the mic is a call: dictation apps (PA_AUDIO_GATE_IGNORE_APPS)
// never are, and neither is the browser the voice page (/talk) is listening
// in while it says so (src/audio/selfSpeech.ts readTalkMic). The apps that do
// count are logged while they hold the mic, so the audio pass can tell a call
// heard only through the mic from you dictating alone.
//
// Its lever is the pause file capture already honours, written with the
// marker GATE_MARKER so a pause the gate made is told apart from one you made.
// The gate never removes your pause (`pa mic pause`): silence you asked for
// wins over any meeting. And it only pauses on the way *out* of a meeting, so
// `pa mic on` between meetings records until the next meeting ends.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../types.ts').Json;

const fs = require('fs');
const path = require('path');
const { config } = require('../config.ts');
const { logger } = require('../log.ts');
const { eventRange, meetingEvent } = require('./episodes.ts');
const selfSpeech = require('./selfSpeech.ts');
const platform = require('../platform');

const log = logger('meeting-gate');

const GATE_MARKER = 'meeting-gate';

// Who holds the pause file: 'on' (nobody), 'user' (`pa mic pause`, or a file
// we cannot read — honoured the way capture.py honours it), or 'gate'.
function readPause(file: any = config.audio.pauseFile) {
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

// Pure: is a calendar meeting on at `now`?
function calendarActive(events: any, now: any, { leadMs, graceMs }: { leadMs?: any; graceMs?: any }) {
  return events
    .filter(meetingEvent)
    .map(eventRange)
    .some((e: any) => e.start - leadMs <= now && now < e.end + graceMs);
}

// Who holds the microphone is the platform's to answer (src/platform): the
// Windows registry's per-app consent store, or PipeWire/PulseAudio's
// recording streams on Linux. Python — our own recorder and voice-dictation —
// never counts, or the gate would hold itself open forever.
// Pure, kept here for its tests: the Windows registry parser.
const micHolders = platform.select('win32').parseMicHolders;

const BROWSERS: Record<string, RegExp> = {
  msedge: /msedge/i,
  chrome: /chrome/i,
  firefox: /firefox/i,
  opera: /opera/i,
  browser: /msedge|chrome|chromium|firefox|opera|brave|vivaldi|arc\.exe/i,
};

/**
 * Pure: the mic holders that are a call. Dictation apps are not; nor is the
 * browser the voice page holds the mic in (`talkMic`, while it says so).
 *
 * @param {string[]} holders  app paths or names (platform micHolders)
 * @param {{ignore?: string, talkMic?: {browser: string}|null}} opts
 */
function callHolders(holders: string[], { ignore = '', talkMic = null }: { ignore?: string; talkMic?: { browser: string } | null } = {}) {
  let skip: RegExp | null = null;
  try {
    skip = ignore ? new RegExp(ignore, 'i') : null;
  } catch {
    skip = null;
  }
  const browser = talkMic ? BROWSERS[talkMic.browser] || BROWSERS.browser : null;
  return holders.filter((app) => !(skip && skip.test(app)) && !(browser && browser.test(app)));
}

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
function decide({ calendar, call, pause, wanted }: { calendar?: any; call?: any; pause?: any; wanted?: any }) {
  const want = calendar || call;
  const reason = calendar ? 'calendar meeting' : call ? 'call in progress' : 'no meeting';
  if (pause === 'user') return { want, action: 'none', reason: 'paused by you' };
  if (want && pause === 'gate') return { want, action: 'resume', reason };
  if (!want && pause === 'on' && wanted !== false) return { want, action: 'pause', reason };
  return { want, action: 'none', reason };
}

async function currentMicHolders() {
  const all = await platform.capture.micHolders().catch(() => []);
  return callHolders(all, { ignore: config.audio.gate.ignoreApps, talkMic: selfSpeech.readTalkMic(config.audio.selfSpeech.talkMicFile) });
}

// The call evidence the audio pass reads: a line when the apps change, and
// every 30 s while they hold the mic.
let lastLogged = { at: 0, apps: '' };
function logCall(holders: string[], now: number) {
  const apps = holders.map((a) => String(a).split(/[\\/]/).pop()).sort();
  const key = apps.join('|');
  if (key === lastLogged.apps && now - lastLogged.at < 30_000) return;
  lastLogged = { at: now, apps: key };
  selfSpeech.append(config.audio.selfSpeech.callLog, { at: new Date(now).toISOString(), apps }, now);
}

async function upcomingEvents(now: any) {
  return require('../repo').sources.calendarAroundNow(now);
}

let wanted: any = null;
let lastCallAt = 0;

async function tick({ now = Date.now() }: { now?: number } = {}) {
  const g = config.audio.gate;
  const holders = await currentMicHolders();
  if (holders.length) {
    lastCallAt = now;
    logCall(holders, now);
  }
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

module.exports = { tick, decide, readPause, micHolders, callHolders, calendarActive, meetingEvent, GATE_MARKER };
