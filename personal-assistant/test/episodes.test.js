'use strict';

// Episode assembly. The property this is really protecting is speaker
// attribution: the mic is you and the loopback is everyone else, and no code
// path may quietly mix them into one anonymous transcript.

const assert = require('assert');
const { toEpisodes, classify, renderTranscript, isSubstantial } = require('../src/audio/episodes');

const at = (mins, secs = 0) =>
  new Date(Date.UTC(2026, 8, 1, 9, mins, secs)).toISOString();

{
  // Overlapping mic and loopback groups are one conversation, not two.
  const episodes = toEpisodes([
    { stream: 'mic', started_at: at(0), ended_at: at(4), speech_seconds: 90, transcript: 'I can take that on' },
    { stream: 'loopback', started_at: at(1), ended_at: at(5), speech_seconds: 120, transcript: 'can you fix the import' },
  ]);
  assert.strictEqual(episodes.length, 1);
  assert.deepStrictEqual(episodes[0].streams, ['loopback', 'mic']);
  assert.strictEqual(episodes[0].speech_seconds, 210);
  assert.strictEqual(episodes[0].ended_at, at(5));
}

{
  // A long silence splits episodes — the default gap is 90s.
  const episodes = toEpisodes(
    [
      { stream: 'mic', started_at: at(0), ended_at: at(1), speech_seconds: 30, transcript: 'a' },
      { stream: 'mic', started_at: at(30), ended_at: at(31), speech_seconds: 30, transcript: 'b' },
    ],
    { gapSeconds: 90 }
  );
  assert.strictEqual(episodes.length, 2);
}

{
  // Attribution: labels come from the stream, never from guessing.
  const episodes = toEpisodes([
    { stream: 'loopback', started_at: at(1), ended_at: at(2), speech_seconds: 20, transcript: 'can you fix the import' },
    { stream: 'mic', started_at: at(0), ended_at: at(3), speech_seconds: 20, transcript: 'yes, by Thursday' },
  ]);
  const text = renderTranscript(episodes[0]);
  assert.match(text, /^Me: yes, by Thursday/m);
  assert.match(text, /^Them: can you fix the import/m);
  // Ordering follows the clock, so a reply cannot appear before its question.
  assert.ok(text.indexOf('Me:') < text.indexOf('Them:'));
}

{
  const events = [
    {
      external_id: 'evt-1',
      subject: 'Estimating sync',
      occurred_at: at(0),
      raw: { end: { dateTime: '2026-09-01T09:30:00' }, attendees: ['sam@example.com'] },
    },
  ];

  const inMeeting = classify(
    { started_at: at(5), ended_at: at(20), streams: ['mic', 'loopback'] },
    events
  );
  assert.strictEqual(inMeeting.kind, 'meeting');
  assert.strictEqual(inMeeting.calendarEventId, 'evt-1');
  assert.strictEqual(inMeeting.title, 'Estimating sync');

  // Both streams, no calendar entry: a call.
  const call = classify({ started_at: at(120), ended_at: at(130), streams: ['loopback', 'mic'] }, events);
  assert.strictEqual(call.kind, 'call');

  // Mic only: you talking in a room. Real, and not a failure to classify.
  const ambient = classify({ started_at: at(120), ended_at: at(125), streams: ['mic'] }, events);
  assert.strictEqual(ambient.kind, 'ambient');

  // Loopback only is genuinely unknown — a video playing, most likely.
  const unknown = classify({ started_at: at(200), ended_at: at(205), streams: ['loopback'] }, events);
  assert.strictEqual(unknown.kind, 'unknown');
}

{
  // "yep, sounds good" is speech and not signal. Recording it is fine;
  // distilling it costs a model call and produces nothing.
  const trivial = { speech_seconds: 6, parts: [{ transcript: 'yep sounds good' }] };
  assert.strictEqual(isSubstantial(trivial), false);

  const real = {
    speech_seconds: 240,
    parts: [{ transcript: 'so the import drops rows with no cost code, can you take a look before Thursday' }],
  };
  assert.strictEqual(isSubstantial(real), true);

  // Long but empty (a VAD false positive on room tone) is not substantial.
  assert.strictEqual(isSubstantial({ speech_seconds: 600, parts: [{ transcript: '' }] }), false);
}

console.log('episodes.test.js ok');
