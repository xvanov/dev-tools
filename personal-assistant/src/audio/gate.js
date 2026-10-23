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
//   - another app is using the microphone — the unplanned call: a Teams ring,
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
const { execFile } = require('child_process');
const { promisify } = require('util');

const { config } = require('../config');
const { logger } = require('../log');
const { attendable, eventRange } = require('./episodes');

const exec = promisify(execFile);
const log = logger('meeting-gate');

const GATE_MARKER = 'meeting-gate';

// Windows records per-app microphone use here; LastUsedTimeStop is 0 while an
// app holds the device.
const MIC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

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

// Pure: the apps holding the microphone, from `reg query /s /v
// LastUsedTimeStop` output. Python is left out: that is our own recorder and
// voice-dictation, and counting them would keep the gate open forever.
function micHolders(regOutput) {
  const holders = [];
  let key = null;
  for (const line of String(regOutput).split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      key = line.trim();
      continue;
    }
    const m = /^\s+LastUsedTimeStop\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line);
    if (!m || !key || BigInt(m[1]) !== 0n) continue;
    const app = key.split('\\').pop().replace(/#/g, '\\');
    if (/\\pythonw?\.exe$/i.test(app)) continue;
    holders.push(app);
  }
  return holders;
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
function decide({ calendar, call, pause, wanted }) {
  const want = calendar || call;
  const reason = calendar ? 'calendar meeting' : call ? 'call in progress' : 'no meeting';
  if (pause === 'user') return { want, action: 'none', reason: 'paused by you' };
  if (want && pause === 'gate') return { want, action: 'resume', reason };
  if (!want && pause === 'on' && wanted !== false) return { want, action: 'pause', reason };
  return { want, action: 'none', reason };
}

async function currentMicHolders() {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await exec('reg.exe', ['query', MIC_KEY, '/s', '/v', 'LastUsedTimeStop'], {
      windowsHide: true,
      timeout: 10_000,
    });
    return micHolders(stdout);
  } catch (err) {
    // reg exits non-zero when some subkeys lack the value; the rest is still on stdout.
    return micHolders(err.stdout || '');
  }
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
