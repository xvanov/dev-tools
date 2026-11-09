'use strict';

// Only meetings with other people are recorded. Your own dictation, the voice
// page and its spoken replies are you alone: their speech groups are dropped
// before episodes are made, and a mic-only episode is a call only when a call
// app held the mic. (The bug: push-to-talk dictation while coding was filed
// as "Solo dictation … · ad-hoc call · debrief #63".)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/audio/selfSpeech.ts');
const { toEpisodes, classify } = require('../src/audio/episodes.ts');
const { settled } = require('../src/ingest/audio.ts');

const at = (mins, secs = 0) => new Date(Date.UTC(2026, 10, 9, 21, mins, secs)).toISOString();
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// --- dictation windows (voice-dictation's speech-activity log) ---------------

{
  const w = S.dictationWindows(
    jsonl([
      { at: at(5, 3), end: at(5, 0), seconds: 40, file: 'vd-final.wav' },
      // The PA's own capture going through the same transcriber is not dictation.
      { at: at(6), end: at(6), seconds: 300, file: '20261109T2144-mic.speech.wav' },
      // No length known: half a minute before it ended.
      { at: at(8), file: 'talk-123.wav' },
    ]) + '{torn'
  );
  assert.strictEqual(w.length, 2);
  // Ends when the audio ended (its mtime), not when the request was served.
  assert.ok(w[0].end > Date.parse(at(5, 0)) && w[0].end < Date.parse(at(5, 3)));
  assert.ok(w[0].start <= Date.parse(at(4, 20)));
  assert.ok(w[1].start <= Date.parse(at(7, 30)));
}

// --- voice page windows: you asking, Jarvis answering ------------------------

{
  const w = S.talkWindows(jsonl([{ at: at(10), what: 'turn' }, { at: at(12), what: 'tts' }]));
  assert.strictEqual(w.length, 2);
  // The reply is spoken after the request: Jarvis on the speakers ("Them:") is covered.
  assert.ok(w[0].end >= Date.parse(at(11)));
  assert.ok(w[1].end >= Date.parse(at(12, 25)));
}

// --- selfShare / splitSelfSpeech --------------------------------------------

{
  const windows = S.dictationWindows(jsonl([{ end: at(1), seconds: 50, file: 'vd-final.wav' }, { end: at(3), seconds: 50, file: 'vd-final.wav' }]));
  // A speech group whose segments are both dictations is yours.
  const dictated = {
    stream: 'mic',
    started_at: at(0, 15),
    ended_at: at(3),
    segments: [
      { start: at(0, 15), end: at(1) },
      { start: at(2, 15), end: at(3) },
    ],
  };
  assert.ok(S.selfShare(dictated, windows) > 0.95);
  // Talking across the room between dictations is not.
  const talk = { stream: 'mic', started_at: at(4), ended_at: at(9), segments: [{ start: at(4), end: at(9) }] };
  assert.strictEqual(S.selfShare(talk, windows), 0);
  // Without segments, the group's span is used.
  assert.ok(S.selfShare({ started_at: at(0, 15), ended_at: at(1) }, windows) > 0.95);

  const { kept, self } = S.splitSelfSpeech([dictated, talk], windows);
  assert.deepStrictEqual(kept, [talk]);
  assert.deepStrictEqual(self, [dictated]);
  // No evidence at all: nothing is dropped.
  assert.strictEqual(S.splitSelfSpeech([dictated], []).kept.length, 1);
}

// --- the live case: dictation while coding, gate open, no call app -----------

{
  // Ten minutes of push-to-talk dictation, recorded because a browser held
  // the mic. voice-dictation logged every request.
  const dictations = [];
  const sidecars = [];
  for (let i = 0; i < 6; i++) {
    const s = at(44 + i, 10);
    const e = at(44 + i, 50);
    dictations.push({ at: e, end: e, seconds: 40, file: 'vd-final.wav' });
    sidecars.push({ stream: 'mic', started_at: s, ended_at: e, speech_seconds: 35, transcript: 'so the personal assistant has a bug where', segments: [{ start: s, end: e }] });
  }
  const self = S.dictationWindows(jsonl(dictations));
  const { kept } = S.splitSelfSpeech(sidecars, self);
  assert.strictEqual(kept.length, 0, 'every dictation is yours: nothing to make an episode from');

  // Even without the dictation log (voice-dictation not updated yet), a
  // mic-only episode with no call app on the mic is you alone, not a call.
  const [episode] = toEpisodes(sidecars);
  assert.strictEqual(classify(episode, [], { calls: [] }).kind, 'solo');

  // The same mic-only speech while Teams held the mic is a call heard
  // through the speakers.
  const calls = S.callWindows(jsonl([at(44), at(45), at(46), at(47), at(48), at(49), at(50)].map((t) => ({ at: t, apps: ['ms-teams.exe'] }))));
  assert.strictEqual(classify(episode, [], { calls }).kind, 'call');
  // A brush with a call app (a ring you declined) is not enough.
  const ring = S.callWindows(jsonl([{ at: at(44), apps: ['ms-teams.exe'] }]));
  assert.strictEqual(S.heldByCall(episode, ring), false);
}

// --- Jarvis's reply on the speakers is not another person --------------------

{
  const talk = S.talkWindows(jsonl([{ at: at(20), what: 'turn' }, { at: at(20, 20), what: 'tts' }]));
  const mic = { stream: 'mic', started_at: at(19, 40), ended_at: at(19, 58), speech_seconds: 12, transcript: 'hey Jarvis what is on my calendar', segments: [{ start: at(19, 40), end: at(19, 58) }] };
  const loop = { stream: 'loopback', started_at: at(20, 5), ended_at: at(20, 40), speech_seconds: 25, transcript: 'You have two meetings left today', segments: [{ start: at(20, 5), end: at(20, 40) }] };
  const { kept, self } = S.splitSelfSpeech([mic, loop], talk);
  assert.strictEqual(kept.length, 0, 'a voice-page exchange never becomes a "call"');
  assert.strictEqual(self.length, 2);
}

// --- talk mic heartbeat ------------------------------------------------------

{
  assert.strictEqual(S.browserOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'msedge');
  assert.strictEqual(S.browserOf('Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0 Safari/537.36'), 'chrome');
  assert.strictEqual(S.browserOf('Mozilla/5.0 Gecko/20100101 Firefox/131.0'), 'firefox');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-talkmic-'));
  const file = path.join(dir, 'talk-mic.json');
  assert.strictEqual(S.readTalkMic(file), null);
  const now = Date.parse(at(30));
  fs.writeFileSync(file, JSON.stringify({ at: at(30), browser: 'msedge' }));
  assert.deepStrictEqual(S.readTalkMic(file, now + 20_000), { browser: 'msedge' });
  assert.strictEqual(S.readTalkMic(file, now + 5 * 60_000), null, 'a closed tab stops counting');
}

// --- append: best effort, bounded --------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-selfspeech-'));
  const file = path.join(dir, 'a', 'calls.jsonl');
  S.append(file, { at: at(1), apps: ['x.exe'] });
  S.append(file, { at: at(2), apps: ['y.exe'] });
  assert.strictEqual(S.callWindows(fs.readFileSync(file, 'utf8')).length, 2);
  const loaded = S.load({ dictationLog: path.join(dir, 'missing.jsonl'), talkLog: path.join(dir, 'missing2.jsonl'), callLog: file });
  assert.strictEqual(loaded.self.length, 0);
  assert.strictEqual(loaded.calls.length, 2);
  // Never throws, even where it cannot write.
  S.append(path.join(file, 'not-a-dir', 'x.jsonl'), { at: at(3) });
}

// --- settled: when a recording of you alone may be deleted ------------------

{
  const end = Date.parse(at(0));
  const o = { now: end + 40 * 60_000, coverage: end + 10 * 60_000, pending: true, settleMs: 30 * 60_000, gapMs: 90_000 };
  assert.strictEqual(settled(at(0), o), true);
  assert.strictEqual(settled(at(0), { ...o, now: end + 10 * 60_000 }), false, 'too fresh');
  // Transcription has not moved past it: the loopback half may still come.
  assert.strictEqual(settled(at(0), { ...o, coverage: end + 30_000 }), false);
  assert.strictEqual(settled(at(0), { ...o, coverage: null }), false);
  // Nothing left to transcribe at all.
  assert.strictEqual(settled(at(0), { ...o, coverage: null, pending: false }), true);
}

console.log('selfSpeech.test.js ok');
