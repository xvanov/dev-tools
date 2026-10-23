'use strict';

// The meeting gate: which calendar events open it, which apps on the mic
// count as a call, and when it pauses or resumes capture — never over a pause
// you made, and pausing only on the way out of a meeting.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, readPause, micHolders, calendarActive, meetingEvent, GATE_MARKER } = require('../src/audio/gate');

// --- decide -----------------------------------------------------------------

const d = (s) => decide({ calendar: false, call: false, pause: 'on', wanted: null, ...s });

// A meeting starts while the gate holds the pause: resume.
assert.strictEqual(d({ calendar: true, pause: 'gate' }).action, 'resume');
assert.strictEqual(d({ call: true, pause: 'gate' }).action, 'resume');
// Your pause wins over any meeting.
assert.strictEqual(d({ calendar: true, pause: 'user' }).action, 'none');
assert.strictEqual(d({ pause: 'user', wanted: true }).action, 'none');
// A meeting ends: pause. At first tick with nothing on: pause too.
assert.strictEqual(d({ wanted: true }).action, 'pause');
assert.strictEqual(d({ wanted: null }).action, 'pause');
// `pa mic on` between meetings: left recording until the next meeting ends.
assert.strictEqual(d({ wanted: false }).action, 'none');
// Already in the right state.
assert.strictEqual(d({ calendar: true, pause: 'on' }).action, 'none');
assert.strictEqual(d({ pause: 'gate', wanted: false }).action, 'none');
assert.strictEqual(d({ calendar: true }).reason, 'calendar meeting');
assert.strictEqual(d({ call: true }).reason, 'call in progress');

// --- calendar ---------------------------------------------------------------

const ev = (start, end, raw = {}) => ({
  subject: 'Planning',
  occurred_at: start,
  raw: { start: { dateTime: start }, end: { dateTime: end }, showAs: 'busy', attendees: [{}, {}], ...raw },
});
const at = (iso) => new Date(`${iso}Z`).getTime();
const opts = { leadMs: 2 * 60_000, graceMs: 5 * 60_000 };
const standup = ev('2026-10-23T09:00:00.0000000', '2026-10-23T09:15:00.0000000');

assert.strictEqual(calendarActive([standup], at('2026-10-23T08:57:00'), opts), false);
assert.strictEqual(calendarActive([standup], at('2026-10-23T08:58:30'), opts), true); // lead
assert.strictEqual(calendarActive([standup], at('2026-10-23T09:10:00'), opts), true);
assert.strictEqual(calendarActive([standup], at('2026-10-23T09:19:00'), opts), true); // grace
assert.strictEqual(calendarActive([standup], at('2026-10-23T09:21:00'), opts), false);

// Not a conversation: cancelled, free, all-day, or a solo focus block.
assert.strictEqual(meetingEvent(ev('2026-10-23T09:00:00', '2026-10-23T09:30:00', { isCancelled: true })), false);
assert.strictEqual(meetingEvent(ev('2026-10-23T09:00:00', '2026-10-23T09:30:00', { showAs: 'free' })), false);
assert.strictEqual(meetingEvent(ev('2026-10-23T00:00:00', '2026-10-24T00:00:00', { isAllDay: true })), false);
assert.strictEqual(meetingEvent(ev('2026-10-23T09:00:00', '2026-10-23T11:00:00', { attendees: [] })), false);
// A Teams link with nobody invited yet still counts.
assert.strictEqual(meetingEvent(ev('2026-10-23T09:00:00', '2026-10-23T09:30:00', { attendees: [], isOnlineMeeting: true })), true);

// --- mic holders ------------------------------------------------------------

const KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
const reg = [
  `${KEY}\\MSTeams_8wekyb3d8bbwe`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${KEY}\\Mozilla.Firefox_n80bbvh6b1yt2`,
  '    LastUsedTimeStop    REG_QWORD    0x1dced37bd86ddd2',
  '',
  `${KEY}\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  `${KEY}\\NonPackaged\\C:#Users#someone#AppData#Local#Programs#Python#Python312#python.exe`,
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  'End of search: 4 match(es) found.',
].join('\r\n');
assert.deepStrictEqual(micHolders(reg), ['MSTeams_8wekyb3d8bbwe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']);
assert.deepStrictEqual(micHolders(''), []);

// --- pause file -------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-gate-'));
const file = path.join(dir, 'audio.paused');
assert.strictEqual(readPause(file).state, 'on');
fs.writeFileSync(file, GATE_MARKER);
assert.strictEqual(readPause(file).state, 'gate');
fs.writeFileSync(file, '');
assert.strictEqual(readPause(file).state, 'user');
fs.writeFileSync(file, new Date(Date.now() + 60_000).toISOString());
assert.strictEqual(readPause(file).state, 'user');
fs.writeFileSync(file, new Date(Date.now() - 60_000).toISOString());
assert.strictEqual(readPause(file).state, 'on');
// Unreadable is honoured as a pause, as capture.py does.
fs.writeFileSync(file, 'quiet please');
assert.strictEqual(readPause(file).state, 'user');
fs.rmSync(dir, { recursive: true, force: true });

console.log('meetingGate.test.js ok');
