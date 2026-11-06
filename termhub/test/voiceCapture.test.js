'use strict';

// web/voiceCapture.js, the pure half: resampler, WAV encoder, VAD state
// machine, utterance recorder, whisper-noise filter.
// Plain node, no deps:  node test/voiceCapture.test.js

const assert = require('assert');
const VC = require('../web/voiceCapture');

function tone(n, rate, freq, amp) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

// ---- resampler ---------------------------------------------------------------
{
  // 48 kHz -> 16 kHz is exactly 3:1, chunked or not.
  const r = VC.createResampler(48000, 16000);
  let n = 0;
  for (let i = 0; i < 10; i++) n += r.push(new Float32Array(1024)).length;
  assert.ok(Math.abs(n - (10 * 1024) / 3) <= 1, `48k: got ${n}`);

  // 44.1 kHz: a ratio that is not a whole number must not drift across chunks.
  const r2 = VC.createResampler(44100, 16000);
  let m = 0;
  for (let i = 0; i < 431; i++) m += r2.push(new Float32Array(1024)).length;   // ~10 s
  const want = (431 * 1024 * 16000) / 44100;
  assert.ok(Math.abs(m - want) <= 1, `44.1k drift: got ${m}, want ~${want.toFixed(1)}`);

  // Values: a DC level survives the box filter; a chunk boundary leaves no seam.
  const r3 = VC.createResampler(48000, 16000);
  const a = r3.push(new Float32Array(1000).fill(0.5));
  const b = r3.push(new Float32Array(1000).fill(0.5));
  for (const x of [...a, ...b]) assert.ok(Math.abs(x - 0.5) < 1e-6);

  // Same rate is a copy.
  const same = VC.createResampler(16000, 16000).push(Float32Array.from([0.1, 0.2]));
  assert.deepStrictEqual(Array.from(same).map((x) => +x.toFixed(3)), [0.1, 0.2]);

  // The box filter nulls the band that would alias onto DC: 16 kHz at 48k->16k.
  const hi = VC.createResampler(48000, 16000).push(tone(4800, 48000, 16000, 0.5));
  assert.ok(VC.rms(hi) < 0.01, `16 kHz tone should vanish, rms ${VC.rms(hi)}`);
}

// ---- WAV -----------------------------------------------------------------------
{
  const buf = Buffer.from(VC.encodeWav(Float32Array.from([0, 1, -1, 0.5, 2]), 16000));
  assert.strictEqual(buf.length, 44 + 5 * 2);
  assert.strictEqual(buf.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(buf.readUInt32LE(4), 36 + 10);
  assert.strictEqual(buf.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.strictEqual(buf.readUInt16LE(20), 1, 'PCM');
  assert.strictEqual(buf.readUInt16LE(22), 1, 'mono');
  assert.strictEqual(buf.readUInt32LE(24), 16000);
  assert.strictEqual(buf.readUInt32LE(28), 32000, 'byte rate');
  assert.strictEqual(buf.readUInt16LE(34), 16, 'bits');
  assert.strictEqual(buf.toString('ascii', 36, 40), 'data');
  assert.strictEqual(buf.readUInt32LE(40), 10);
  assert.deepStrictEqual([0, 1, 2, 3, 4].map((i) => buf.readInt16LE(44 + i * 2)), [0, 32767, -32768, 16383, 32767],
    'samples are clipped to [-1, 1]');
}

// ---- VAD state machine ----------------------------------------------------------
{
  const FRAME = 20;
  const run = (vad, levels, t0 = 0) => {
    const events = [];
    levels.forEach((lv, i) => {
      const ev = vad.step(lv, t0 + i * FRAME, FRAME);
      if (ev) events.push([ev, t0 + i * FRAME]);
    });
    return events;
  };
  const quiet = (ms) => Array(ms / FRAME).fill(0.001);
  const loud = (ms) => Array(ms / FRAME).fill(0.2);

  // Speech for a second, then quiet: start after startMs, end ~endMs after the last voice.
  let v = VC.createVad();
  assert.strictEqual(v.endMs, 700, 'default end-of-utterance silence is 700 ms');
  let ev = run(v, [...quiet(400), ...loud(1000), ...quiet(1200)]);
  assert.deepStrictEqual(ev.map((e) => e[0]), ['start', 'end']);
  const lastVoice = 400 + 1000 - FRAME;
  assert.ok(ev[1][1] - lastVoice >= 700 && ev[1][1] - lastVoice < 700 + 2 * FRAME, `end at ${ev[1][1]}`);
  assert.strictEqual(v.state, 'silence');

  // A click (one loud frame) never starts anything.
  v = VC.createVad();
  assert.deepStrictEqual(run(v, [...quiet(200), 0.3, ...quiet(600)]), []);

  // Speech too short to be words: 'cancel', not 'end'.
  v = VC.createVad();
  ev = run(v, [...quiet(200), ...loud(200), ...quiet(1000)]);
  assert.deepStrictEqual(ev.map((e) => e[0]), ['start', 'cancel']);

  // A pause shorter than endMs keeps the utterance going.
  v = VC.createVad();
  ev = run(v, [...loud(600), ...quiet(400), ...loud(600), ...quiet(1000)]);
  assert.deepStrictEqual(ev.map((e) => e[0]), ['start', 'end']);

  // endMs is tunable and clamped.
  assert.strictEqual(VC.createVad({ endMs: 1000 }).endMs, 1000);
  assert.strictEqual(VC.createVad({ endMs: 50 }).endMs, VC.END_MS_MIN);
  assert.strictEqual(VC.createVad({ endMs: 9000 }).endMs, VC.END_MS_MAX);

  // A steady noise for longer than maxUtteranceMs ends, and raises the floor so
  // the same noise doesn't start a new utterance straight away.
  v = VC.createVad({ maxUtteranceMs: 2000 });
  ev = run(v, loud(3000));
  assert.strictEqual(ev[1][0], 'end');
  assert.ok(v.threshold(false) > 0.2, 'the fan is now the room');

  // Echo (our own audio playing) raises the bar.
  v = VC.createVad();
  assert.strictEqual(v.threshold(true), v.threshold(false) * VC.VAD_DEFAULTS.echoFactor);
}

// ---- utterance recorder ---------------------------------------------------------
{
  const RATE = 16000;
  const CH = 320; // 20 ms
  const silent = () => new Float32Array(CH).fill(0.0005);
  const speech = (i) => tone(CH, RATE, 220 + i, 0.3);

  // Hands-free: one utterance, with pre-roll, handed back on 'end'.
  let r = VC.createUtteranceRecorder({ mode: 'vad' });
  const events = [];
  let t = 0;
  const feed = (chunk) => { const e = r.push(chunk, t); t += 20; if (e) events.push(e); };
  for (let i = 0; i < 20; i++) feed(silent());
  for (let i = 0; i < 50; i++) feed(speech(i));      // 1 s of "speech"
  for (let i = 0; i < 60; i++) feed(silent());
  assert.deepStrictEqual(events.map((e) => e.type), ['start', 'end']);
  const got = events[1].samples.length / RATE;
  assert.ok(got >= 1.0 + 0.7 && got <= 1.0 + 0.7 + 0.35, `utterance ${got}s: speech + pre-roll + endMs tail`);
  assert.strictEqual(r.recording, false);

  // Hands-free flush mid-utterance returns what was heard; idle flush returns null.
  r = VC.createUtteranceRecorder({ mode: 'vad' });
  t = 0;
  for (let i = 0; i < 20; i++) r.push(speech(i), (t += 20));
  assert.ok(r.recording);
  assert.ok(r.flush().samples.length > 0);
  assert.strictEqual(r.flush(), null);

  // Push-to-talk: everything until flush(); silence alone is not an utterance.
  r = VC.createUtteranceRecorder({ mode: 'manual' });
  for (let i = 0; i < 50; i++) assert.strictEqual(r.push(silent(), i * 20), null);
  assert.strictEqual(r.flush(), null, 'a release after silence sends nothing');
  for (let i = 0; i < 10; i++) r.push(silent(), i * 20);
  for (let i = 0; i < 25; i++) r.push(speech(i), 200 + i * 20);
  const out = r.flush();
  assert.strictEqual(out.samples.length, 35 * CH, 'manual keeps the whole press');

  // Push-to-talk has a ceiling.
  r = VC.createUtteranceRecorder({ mode: 'manual', maxManualMs: 1000 });
  let last = null;
  for (let i = 0; i < 60 && !last; i++) last = r.push(speech(i), i * 20);
  assert.strictEqual(last && last.type, 'end');
}

// ---- whisper noise --------------------------------------------------------------
{
  for (const s of ['', ' ', 'Thank you.', 'you', 'Thanks for watching!', '...', '♪♪']) assert.ok(VC.isNoise(s), s);
  for (const s of ['okay', 'yes', 'run the tests', 'Sputnik send it']) assert.ok(!VC.isNoise(s), s);
}

console.log('voiceCapture: ok');
