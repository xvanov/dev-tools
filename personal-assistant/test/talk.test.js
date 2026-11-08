'use strict';

// The voice page (/talk): what is read aloud, how answers become sentences,
// the VAD, the WAV, and the transcribe proxy against a fake whisper server.

// These reach src/db only incidentally (board refresh, brief gather): never the real one.
require('./_fakeDb').install();
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const http = require('http');
const C = require('../src/dashboard/talk.core');

// ---- speakable -------------------------------------------------------------
{
  const r = C.speakable('Done. Here is the fix:\n\n```js\nconst x = 1;\n```\n\nIt passes now.');
  assert.ok(!r.text.includes('const'), r.text);
  assert.ok(r.text.includes('It passes now.'));
  assert.strictEqual(r.omitted, true);

  const t = C.speakable('Three items:\n\n| id | what |\n|---|---|\n| 1 | a |\n\nThat is all.');
  assert.ok(!t.text.includes('|'));
  assert.strictEqual(t.omitted, true);

  const u = C.speakable('The PR is at https://github.com/x/y/pull/3 and [the ticket](https://jira/ABC-1) is closed.');
  assert.ok(!/https?:/.test(u.text), u.text);
  assert.ok(u.text.includes('the ticket is closed'), u.text);
  assert.ok(u.text.startsWith('The PR is at the link and'), u.text);
  assert.strictEqual(C.speakable('See https://x.io/a.').text, 'See the link.');
  assert.strictEqual(u.omitted, true);

  const md = C.speakable('## Summary\n- **Two** things are _late_.\n- Run `pa brief` today.');
  assert.strictEqual(md.omitted, false);
  assert.ok(!/[#*_`]/.test(md.text), md.text);
  assert.ok(md.text.includes('Two things are late.'));
  assert.ok(md.text.includes('Run pa brief today.'));

  // An unclosed fence (still streaming) hides everything after it.
  const open = C.speakable('Look:\n```\nrm -rf');
  assert.strictEqual(open.text, 'Look:');
  assert.strictEqual(open.omitted, true);

  // Long inline code is code, not words.
  assert.strictEqual(C.speakable('Run `node bin/pa.js do 42 --mode autonomous --machine build-box` now.').omitted, true);
}

// ---- sentences -------------------------------------------------------------
{
  const { sentences, rest } = C.splitSentences('It is 3.5 GB, e.g. too big. Shall I trim it? Yes! And then');
  assert.deepStrictEqual(sentences, ['It is 3.5 GB, e.g. too big.', 'Shall I trim it?', 'Yes!']);
  assert.strictEqual(rest, 'And then');
  // Line breaks end a spoken unit (lists).
  assert.deepStrictEqual(C.splitSentences('one\ntwo\n').sentences, ['one', 'two']);
}

// ---- utterance stream: cumulative partials, then final -----------------------
{
  const s = C.createUtteranceStream();
  assert.deepStrictEqual(s.push('Hello the'), []);
  assert.deepStrictEqual(s.push('Hello there. I chec'), ['Hello there.']);
  assert.deepStrictEqual(s.push('Hello there. I checked. '), ['I checked.']);
  assert.deepStrictEqual(s.finish('Hello there. I checked. Two are open:\n```\nx\n```'), ['Two are open:', C.DETAILS]);
  assert.deepStrictEqual(s.finish('more'), [], 'finish is once');
}
{
  // Deltas work too.
  const s = C.createUtteranceStream();
  assert.deepStrictEqual(s.push('One. '), ['One.']);
  assert.deepStrictEqual(s.push('Two. Thr'), ['Two.']);
  assert.deepStrictEqual(s.finish(), ['Thr']);
}
{
  // A complete block in one event (the chat's v1): everything at once.
  const s = C.createUtteranceStream();
  assert.deepStrictEqual(s.finish('All clear. Nothing waits on you.'), ['All clear.', 'Nothing waits on you.']);
}

// ---- VAD -------------------------------------------------------------------
{
  const F = 20;
  const run = (vad, levels, t0 = 0, ctx) => {
    const evs = [];
    levels.forEach((lv, i) => {
      const e = vad.step(lv, t0 + i * F, F, ctx);
      if (e) evs.push([e, i]);
    });
    return evs;
  };
  const quiet = (n) => Array(n).fill(0.002);
  const loud = (n, v = 0.08) => Array(n).fill(v);

  // Speech then silence: one start, one end.
  let v = C.createVad();
  let evs = run(v, [...quiet(20), ...loud(30), ...quiet(60)]);
  assert.deepStrictEqual(evs.map((e) => e[0]), ['start', 'end']);
  assert.ok(evs[0][1] >= 20 + 150 / F - 1 && evs[0][1] <= 20 + 150 / F + 1);

  // A click is not speech.
  v = C.createVad();
  assert.deepStrictEqual(run(v, [...quiet(20), ...loud(2), ...quiet(40)]), []);

  // Just over the start bar but too short overall: cancelled, not sent.
  v = C.createVad({ minUtteranceMs: 400 });
  evs = run(v, [...quiet(10), ...loud(9), ...quiet(60)]);
  assert.deepStrictEqual(evs.map((e) => e[0]), ['start', 'cancel']);

  // While the assistant talks, its echo (moderate level) does not count...
  v = C.createVad();
  assert.deepStrictEqual(run(v, [...quiet(20), ...loud(40, 0.025), ...quiet(10)], 0, { echo: true }), []);
  // ...but the user talking over it (loud, sustained) does — after bargeInMs.
  v = C.createVad();
  evs = run(v, [...quiet(20), ...loud(40, 0.2)], 0, { echo: true });
  assert.deepStrictEqual(evs.map((e) => e[0]), ['start']);
  assert.ok(evs[0][1] >= 20 + 350 / F - 1);

  // A short pause mid-sentence does not end it.
  v = C.createVad();
  evs = run(v, [...quiet(10), ...loud(20), ...quiet(20), ...loud(20), ...quiet(60)]);
  assert.deepStrictEqual(evs.map((e) => e[0]), ['start', 'end']);

  // The floor adapts to a noisy room so constant hum is not speech.
  v = C.createVad();
  run(v, Array(200).fill(0.01));
  assert.ok(v.floor > 0.005, `floor ${v.floor}`);
  assert.strictEqual(v.state, 'silence');

  // Never longer than maxUtteranceMs.
  v = C.createVad({ maxUtteranceMs: 1000 });
  evs = run(v, loud(200));
  assert.deepStrictEqual(evs.map((e) => e[0]), ['start', 'end']);
}

// ---- audio -------------------------------------------------------------------
{
  assert.ok(Math.abs(C.rms(new Float32Array([0.5, -0.5, 0.5, -0.5])) - 0.5) < 1e-9);
  const down = C.downsample(new Float32Array(48000).fill(0.25), 48000, 16000);
  assert.strictEqual(down.length, 16000);
  assert.ok(Math.abs(down[100] - 0.25) < 1e-6);
  const wav = Buffer.from(C.encodeWav(new Float32Array([0, 1, -1]), 16000));
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.readUInt32LE(24), 16000);
  assert.strictEqual(wav.readUInt16LE(34), 16);
  assert.strictEqual(wav.length, 44 + 6);
  assert.strictEqual(wav.readInt16LE(46), 32767);
  assert.strictEqual(wav.readInt16LE(48), -32768);
}

// ---- whisper hallucinations, face priority ------------------------------------
{
  assert.ok(C.isNoise('Thank you.'));
  assert.ok(C.isNoise(' you '));
  assert.ok(C.isNoise('...'));
  assert.ok(!C.isNoise('Thank you, close it.'));
  assert.ok(!C.isNoise("What's on me today?"));
  assert.strictEqual(C.expression({ talking: true, listening: true }), 'listening');
  assert.strictEqual(C.expression({ thinking: true, happy: true }), 'thinking');
  assert.strictEqual(C.expression({}), 'idle');
}

// ---- VAD end wait: tunable, clamped, and the last voiced frame is known -----------
{
  assert.strictEqual(C.VAD_DEFAULTS.endMs, 650);
  assert.strictEqual(C.createVad({ endMs: 50 }).endMs, C.END_MS_MIN);
  assert.strictEqual(C.createVad({ endMs: 99999 }).endMs, C.END_MS_MAX);
  const v = C.createVad({ endMs: 600 });
  let end = null;
  for (let i = 0; i < 120; i++) {
    const t = i * 20;
    const e = v.step(i >= 10 && i < 50 ? 0.08 : 0.002, t, 20);
    if (e === 'end') end = t;
  }
  assert.strictEqual(v.lastVoice, 49 * 20);
  assert.ok(end - v.lastVoice >= 600 && end - v.lastVoice < 640, `ended ${end - v.lastVoice} ms after the voice`);
}

// ---- face follows the audio, not the queue -------------------------------------------
{
  const y = C.createSpeechSync();
  assert.deepStrictEqual(y.frame(0), { face: null, mouth: 0 });
  // Queued, nothing audible yet: "about to speak", mouth shut.
  y.queued(0);
  assert.deepStrictEqual(y.frame(300), { face: 'about', mouth: 0 });
  // Audio starts; a voice never seen sending boundaries loops.
  y.start(500, 'ava');
  const loop = new Set();
  for (let t = 500; t < 1600; t += 60) loop.add(y.frame(t).mouth);
  assert.ok(loop.size >= 3 && loop.has(0), 'a gentle open/close loop');
  // A word boundary opens the mouth for about that word, then it closes.
  y.boundary(1600, 8);
  assert.strictEqual(y.frame(1610).mouth, 3);
  assert.ok(y.frame(1610 + 300).mouth >= 1);
  assert.strictEqual(y.frame(1600 + 600).mouth, 0, 'closed between words');
  // Sentence ends: between sentences the mouth is closed, still the talking face.
  y.end(2500);
  y.queued(2500);
  assert.deepStrictEqual(y.frame(2600), { face: 'talking', mouth: 0 });
  // The same voice again: known to send boundaries, so the mouth waits for
  // the first word instead of moving at onstart (natural voices start
  // early)...
  y.start(3000, 'ava');
  for (let t = 3000; t < 3700; t += 60) assert.strictEqual(y.frame(t).mouth, 0, `shut before the first word (${t})`);
  // ...but not forever: no word within boundaryWaitMs, it loops.
  const late = new Set();
  for (let t = 3900; t < 4900; t += 60) late.add(y.frame(t).mouth);
  assert.ok(late.size >= 3);
  y.end(5000);
  y.done(5000);
  assert.strictEqual(y.frame(5100).face, null);
  // A fresh run starts from "about" again; barge-in clears everything.
  y.queued(6000);
  assert.strictEqual(y.frame(6000).face, 'about');
  y.cancel();
  assert.strictEqual(y.frame(6100).face, null);
  // An engine that plays audio itself drives the mouth by loudness.
  y.queued(7000);
  y.start(7100, 'local-tts');
  y.level(7200, 0.3);
  assert.strictEqual(y.frame(7210).mouth, 3);
  y.level(7300, 0.001);
  assert.strictEqual(y.frame(7310).mouth, 0);
  // A boundary after the run was cancelled does nothing.
  y.cancel();
  y.boundary(7400, 5);
  assert.strictEqual(y.frame(7410).face, null);
  // Face priority: the user talking wins; "about" sits under talking.
  assert.strictEqual(C.expression({ about: true, thinking: true }), 'about');
  assert.strictEqual(C.expression({ about: true, talking: true }), 'talking');
}

// ---- which blocks of a turn are spoken ---------------------------------------------
{
  // auto: a quick turn's step is held, then dropped when the answer comes.
  const v = C.createTurnVoice();
  v.userTurn(0);
  assert.strictEqual(v.assistant('a', false, 1500), 'hold');
  assert.strictEqual(v.due(3000), null);
  assert.strictEqual(v.assistant('b', true, 3200), 'speak');
  assert.strictEqual(v.due(9000), null, 'the held step is dropped');
  // A slow turn: the held step is spoken once the turn passes 4 s...
  v.userTurn(10000);
  assert.strictEqual(v.assistant('c', false, 11000), 'hold');
  assert.strictEqual(v.due(13999), null);
  assert.strictEqual(v.due(14000), 'c');
  assert.strictEqual(v.due(14500), null, 'once');
  // ...and later steps are spoken at once.
  assert.strictEqual(v.assistant('d', false, 16000), 'speak');
  // A turn that ends without an answer block speaks its step.
  v.userTurn(20000);
  v.assistant('e', false, 20500);
  assert.strictEqual(v.end(), 'e');
  // Unknown finality is the answer; no user turn seen (the inbox doorbell): speak.
  const w = C.createTurnVoice();
  assert.strictEqual(w.assistant('f', undefined, 0), 'speak');
  assert.strictEqual(w.assistant('g', false, 0), 'speak');
  // all / final.
  const all = C.createTurnVoice({ mode: 'all' });
  all.userTurn(0);
  assert.strictEqual(all.assistant('h', false, 10), 'speak');
  all.mode = 'final';
  assert.strictEqual(all.assistant('i', false, 9000), 'drop');
  all.mode = 'nonsense';
  assert.strictEqual(all.mode, 'auto');
}

// ---- latency readout ---------------------------------------------------------------
{
  const m = { speechEnd: 1000, vadEnd: 1650, transcribed: 2050, posted: 2900, firstReply: 6900, audioStart: 7400 };
  assert.deepStrictEqual(C.latencySlices(m), { silence: 650, transcribe: 400, send: 850, reply: 4000, voice: 500, total: 6400 });
  assert.strictEqual(C.formatLatency(m), 'silence 650ms · stt 400ms · send 850ms · reply 4.0s · voice 500ms = 6.4s');
  // A typed turn has no mic slices.
  const typed = C.latencySlices({ posted: 0, firstReply: 3000, audioStart: 3400 });
  assert.strictEqual(typed.silence, null);
  assert.strictEqual(typed.reply, 3000);
  assert.strictEqual(typed.total, null);
}

// ---- the fast lane's NDJSON, and its latency row ------------------------------------
{
  const r = C.createLineReader();
  assert.deepStrictEqual(r.push('{"type":"decision","route":"answer"}\n{"type":"del'), [{ type: 'decision', route: 'answer' }]);
  assert.deepStrictEqual(r.push('ta","text":"Hi"}\n\nnot json\n'), [{ type: 'delta', text: 'Hi' }]);
  assert.deepStrictEqual(r.push(''), []);
  const m = { speechEnd: 0, vadEnd: 650, transcribed: 1050, posted: 1100, decision: 1800, firstToken: 1850, firstReply: 1900, audioStart: 2400, route: 'handoff' };
  assert.strictEqual(C.formatLatency(m), 'handoff: decide 750ms · 1st token 800ms | silence 650ms · stt 400ms · send 50ms · reply 800ms · voice 500ms = 2.4s');
}

// ---- the page sends voice turns to the fast lane, and barge-in cancels it --------
{
  const page = fs.readFileSync(require('path').join(__dirname, '../src/dashboard/talk.page.js'), 'utf8');
  assert.match(page, /fetch\('api\/talk\/turn'/);
  assert.match(page, /if \(await fastTurn\(text\)\) return;\s*await post\('api\/chat'/, 'falls back to api/chat');
  assert.match(page, /function beginUtterance\(\) \{\s*cancelFastTurn\(\);/);
  // The transcription starts with the smart-turn check and is kept only for that check's "done".
  assert.match(page, /early\.text = post\('api\/talk\/transcribe'[\s\S]{0,200}fetch\('api\/talk\/endpoint'/);
  assert.match(page, /finishTurn\(det, Date\.now\(\), 'smart-turn', r\.probability, token\)/);
  assert.match(page, /endUtterance\(true, token && early\.token === token \? early\.text : null\)/);
  assert.match(page, /if \(text == null\) \(\{ text \} = await post\('api\/talk\/transcribe'/, 'a failed early transcription is asked again');
}

// ---- the page wires the face to audio events, and the settings exist ---------------
{
  const page = fs.readFileSync(require('path').join(__dirname, '../src/dashboard/talk.page.js'), 'utf8');
  const html = fs.readFileSync(require('path').join(__dirname, '../src/dashboard/talk.html'), 'utf8');
  assert.match(page, /u\.onboundary = /);
  assert.match(page, /sync\.start\(/);
  assert.ok(!/Math\.random\(\) \* MOUTHS/.test(page), 'the mouth no longer moves at random');
  for (const id of ['endMs', 'voiceMode', 'debug']) assert.match(html, new RegExp(`id="${id}"`));
}

// ---- the first clause, early ------------------------------------------------------
{
  const s = C.createUtteranceStream({ firstClause: true });
  assert.deepStrictEqual(s.push('There is one overdue'), []);
  assert.deepStrictEqual(s.push('There is one overdue item on your list, due'), ['There is one overdue item on your list,'], 'a clause after four words goes early');
  assert.deepStrictEqual(s.push('There is one overdue item on your list, due on the 29th, asked by Jon. Also'), ['due on the 29th, asked by Jon.'], 'then the rest of that sentence, once');
  assert.deepStrictEqual(s.finish('There is one overdue item on your list, due on the 29th, asked by Jon. Also two meetings.'), ['Also two meetings.']);

  const short = C.createUtteranceStream({ firstClause: true });
  assert.deepStrictEqual(short.push('Yes, it is'), [], 'not after a single word');
  assert.deepStrictEqual(short.push('Yes, it is done. '), ['Yes, it is done.']);
  const num = C.createUtteranceStream({ firstClause: true });
  assert.deepStrictEqual(num.push('You have spent about 1,200 dollars'), [], 'a thousands separator is not a clause');
  const unfinished = C.createUtteranceStream({ firstClause: true });
  unfinished.push('Your next meeting is the sync, at half');
  assert.deepStrictEqual(unfinished.finish(), ['at half'], 'no full stop: the rest still comes');
  const plain = C.createUtteranceStream();
  assert.deepStrictEqual(plain.push('There is one overdue item on your list, due'), [], 'off by default (the chat stream)');
}

// ---- clause boundaries: , ; : and dashes, with a minimum length ------------------------
{
  const f = C.firstClauseOf;
  assert.strictEqual(f('Your next meeting is the sync, at half past two'), 'Your next meeting is the sync,');
  assert.strictEqual(f('You have two overdue items; the first is due today'), 'You have two overdue items;');
  assert.strictEqual(f('Here is what I found: three unread emails'), 'Here is what I found:');
  assert.strictEqual(f('The nightly build finished — and everything passed'), 'The nightly build finished', 'an em dash ends a clause and is not spoken');
  assert.strictEqual(f('The nightly build finished – and everything passed'), 'The nightly build finished', 'en dash');
  assert.strictEqual(f('The nightly build finished -- and everything passed'), 'The nightly build finished', 'double hyphen');
  assert.strictEqual(f('Yes, that is right and good'), null, 'one word is too short');
  assert.strictEqual(f('OK so, I am on it, checking now'), 'OK so, I am on it,', 'the first boundary that is long enough');
  assert.strictEqual(f('I am on it, and checking now now now'), null, 'under four words: skipped, no later boundary');
  assert.strictEqual(f('a b c d,  and more'), null, 'under the minimum length');
  assert.strictEqual(f('You spent about 1,200 dollars on this today'), null, 'no whitespace after a thousands comma');
  assert.strictEqual(f('Your meeting is at 10, then lunch with Jon'), null, 'a number before the comma is not a clause');
  assert.strictEqual(f('Your next meeting is the sync,'), null, 'nothing after the boundary yet');
  assert.strictEqual(f('well-known well-meant well-kept well-run'), null, 'a hyphen is not a dash');
  assert.strictEqual(f('Tunable', { minWords: 1, minChars: 1 }), null);
  assert.strictEqual(f('A, b', { minWords: 1, minChars: 1 }), 'A,');

  // The stream: the dash is not repeated in the rest.
  const s = C.createUtteranceStream({ firstClause: true });
  assert.deepStrictEqual(s.push('The nightly build finished —'), []);
  assert.deepStrictEqual(s.push('The nightly build finished — and everything'), ['The nightly build finished']);
  assert.deepStrictEqual(s.finish('The nightly build finished — and everything passed, nice. Done.'), ['and everything passed, nice.', 'Done.']);
}

// ---- the per-turn latency report ----------------------------------------------------------
{
  const { sanitizeLatency } = require('../src/dashboard/talk.ts');
  assert.deepStrictEqual(sanitizeLatency({ total: 812.4, silence: 150, transcribe: 200, route: 'answer', turnBy: 'smart-turn', tts: 'kokoro', text: 'secret words' }), { speechToAudioMs: 812, silenceMs: 150, sttMs: 200, route: 'answer', endBy: 'smart-turn', tts: 'kokoro' });
  assert.strictEqual(sanitizeLatency({ silence: 5 }), null, 'no total: nothing to log');
  assert.strictEqual(sanitizeLatency({ total: -1 }), null);
  assert.strictEqual(sanitizeLatency({ total: 5, route: 'x'.repeat(100) }).route, undefined, 'free text is not logged');
  assert.strictEqual(sanitizeLatency(null), null);
}

// ---- which voice speaks --------------------------------------------------------
{
  const both = { kokoro: true, browser: true };
  assert.strictEqual(C.chooseTts('auto', both), 'kokoro', 'auto: the local voice when it is up');
  assert.strictEqual(C.chooseTts('auto', { kokoro: false, browser: true }), 'browser', 'auto: the browser when it is down');
  assert.strictEqual(C.chooseTts('browser', both), 'browser', 'a named engine wins');
  assert.strictEqual(C.chooseTts('kokoro', { kokoro: false, browser: true }), 'browser', 'a named engine that is down falls back');
  assert.strictEqual(C.chooseTts('nonsense', both), 'kokoro', 'an unknown setting is auto');
  assert.strictEqual(C.chooseTts('browser', { kokoro: true, browser: false }), 'kokoro');
  assert.strictEqual(C.chooseTts('auto', {}), null);
}

// ---- the sentence pipeline: fetch the next sentence while this one plays --------
{
  const started = [];
  const aborted = [];
  const pf = C.createPrefetcher({ depth: 2, start: (t) => (started.push(t), { t }), abort: (j) => aborted.push(j.t) });
  pf.prefetch('Two.');
  pf.prefetch('Two.'); // once per text
  pf.prefetch('Three.');
  pf.prefetch('Four.'); // over the depth: not started
  assert.deepStrictEqual(started, ['Two.', 'Three.']);
  assert.strictEqual(pf.get('Two.').t, 'Two.', 'a prefetched job is handed over');
  assert.deepStrictEqual(started, ['Two.', 'Three.'], 'and not fetched again');
  assert.strictEqual(pf.get('Five.').t, 'Five.', 'an unknown text starts now');
  assert.deepStrictEqual(started, ['Two.', 'Three.', 'Five.']);
  pf.clear();
  assert.deepStrictEqual(aborted, ['Three.'], 'barge-in aborts what was waiting');
  assert.strictEqual(pf.size, 0);
}

// ---- PCM in and out ------------------------------------------------------------------
{
  const dec = C.createPcmDecoder();
  // 0x4000 = 0.5, 0xC000 = -0.5, split mid-sample across chunks.
  const a = dec.push(new Uint8Array([0x00, 0x40, 0x00]));
  const b = dec.push(new Uint8Array([0xc0]));
  assert.deepStrictEqual(Array.from(a), [0.5]);
  assert.deepStrictEqual(Array.from(b), [-0.5], 'an odd byte waits for its other half');
  const pcm = C.floatToPcm16(Float32Array.from([0, 1, -1, 2]));
  assert.deepStrictEqual(Array.from(pcm), [0, 0, 0xff, 0x7f, 0x00, 0x80, 0xff, 0x7f]);
  assert.deepStrictEqual(Array.from(C.createPcmDecoder().push(C.floatToPcm16(Float32Array.from([0.25])))), [0.25]);
}

// ---- end of turn: Silero + smart-turn ---------------------------------------------------
{
  // Feed 32 ms frames: speech for `ms`, then silence; returns the events with times.
  // The clock carries across calls for the same detector.
  const clocks = new WeakMap();
  function run(det, plan) {
    const out = [];
    let t = clocks.get(det) || 0;
    for (const [prob, ms] of plan) {
      for (let k = 0; k < ms; k += 32) {
        t += 32;
        clocks.set(det, t);
        const ev = det.step(prob, t, 32);
        if (ev) out.push([ev, t, det.pending]);
      }
    }
    return out;
  }
  // Silence only: nothing.
  assert.deepStrictEqual(run(C.createTurnDetector(), [[0.01, 2000]]), []);

  // Smart-turn says done at the first pause: the turn ends then, not 650 ms later.
  let det = C.createTurnDetector({ endMs: 650 });
  let evs = run(det, [[0.9, 1000], [0.02, 224]]);
  assert.deepStrictEqual(evs.map((e) => e[0]), ['start', 'check']);
  const checkAt = evs[1][1];
  const quiet = checkAt - det.lastVoice;
  assert.ok(quiet >= 96 && quiet < 140, `VAD shortcut: a sure-silent pause is asked about after ~96 ms, got ${quiet}`);

  assert.strictEqual(det.verdict(evs[1][2], true), 'end');
  assert.strictEqual(det.state, 'silence');

  // Hesitant frames (0.2: a breath, a fading syllable) keep the full 200 ms wait.
  let slow = C.createTurnDetector();
  evs = run(slow, [[0.9, 1000], [0.2, 224]]);
  assert.deepStrictEqual(evs.map((e) => e[0]), ['start', 'check']);
  assert.ok(evs[1][1] - slow.lastVoice >= 200, 'not sure it stopped: wait the full checkMs');
  // One unsure frame inside the pause is enough to lose the shortcut.
  slow = C.createTurnDetector();
  evs = run(slow, [[0.9, 1000], [0.02, 64], [0.2, 32], [0.02, 160]]);
  assert.ok(evs[1][1] - slow.lastVoice >= 200, 'a 0.2 frame in the pause cancels the shortcut');
  // And the shortcut never fires on a cough-length utterance, nor sooner than sureCheckMs.
  slow = C.createTurnDetector({ sureCheckMs: 300 });
  evs = run(slow, [[0.9, 1000], [0.02, 224]]);
  assert.ok(evs[1][1] - slow.lastVoice >= 200 && evs[1][1] - slow.lastVoice < 240, 'sureCheckMs above checkMs changes nothing');

  // Not done: the silence timer still ends it, at endMs.
  det = C.createTurnDetector({ endMs: 650 });
  evs = run(det, [[0.9, 1000], [0.02, 224]]);
  assert.strictEqual(det.verdict(evs[1][2], false), null);
  evs = run(det, [[0.02, 700]]);
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0][0], 'end');

  // Talking again during the check: its answer is stale, and the next pause asks again.
  det = C.createTurnDetector({ endMs: 650 });
  evs = run(det, [[0.9, 1000], [0.02, 224]]);
  const stale = evs[1][2];
  run(det, [[0.9, 300]]);
  assert.strictEqual(det.verdict(stale, true), null, 'a verdict about an old pause is ignored');
  evs = run(det, [[0.02, 224]]);
  assert.deepStrictEqual(evs.map((e) => e[0]), ['check'], 'the new pause is asked about');

  // A cough: too short to ask about, cancelled at the timer.
  det = C.createTurnDetector({ endMs: 650 });
  evs = run(det, [[0.9, 192], [0.02, 800]]);
  assert.deepStrictEqual(evs.map((e) => e[0]), ['start', 'cancel']);

  // Hysteresis: once talking, a 0.4 frame is still voice.
  det = C.createTurnDetector({ endMs: 650 });
  evs = run(det, [[0.9, 600], [0.4, 900], [0.02, 224]]);
  assert.deepStrictEqual(evs.map((e) => e[0]), ['start', 'check']);

  // While the assistant speaks, a start needs a near-certain frame for bargeInMs.
  det = C.createTurnDetector();
  let t = 0;
  let got = null;
  for (let k = 0; k < 20; k++) got = det.step(0.7, (t += 32), 32, { echo: true }) || got;
  assert.strictEqual(got, null, 'its own voice at 0.7 is not a barge-in');
  for (let k = 0; k < 14 && !got; k++) got = det.step(0.95, (t += 32), 32, { echo: true });
  assert.strictEqual(got, 'start');
  assert.ok(t - 640 >= 350, 'after bargeInMs');

  // endMs is clamped like the energy VAD's.
  assert.strictEqual(C.createTurnDetector({ endMs: 50 }).endMs, C.END_MS_MIN);
}

// ---- wake word and conversation ---------------------------------------------------------
{
  const c = C.createConversation({ wake: true });
  assert.strictEqual(c.state, 'asleep');
  assert.ok(c.listensForWake() && !c.accepts(), 'asleep: only the wake word');
  c.on('speech', 0);
  assert.strictEqual(c.state, 'asleep', 'speech does not wake it');
  c.on('wake', 1000);
  assert.ok(c.accepts() && !c.listensForWake());
  assert.strictEqual(c.tick(1000 + C.WAKE_DEFAULTS.awakeMs - 1), null);
  assert.strictEqual(c.tick(1000 + C.WAKE_DEFAULTS.awakeMs), 'sleep', 'woken and nothing said: back to sleep');

  c.on('wake', 10000);
  c.on('speech', 10500);
  c.on('sent', 11500);
  assert.strictEqual(c.state, 'busy');
  assert.strictEqual(c.tick(60000), null, 'a hand-off can take a while');
  c.on('idle', 61000);
  assert.strictEqual(c.state, 'follow');
  assert.ok(c.accepts(), 'a follow-up needs no wake word');
  c.on('speech', 61000 + C.WAKE_DEFAULTS.followMs - 100);
  assert.strictEqual(c.state, 'busy');
  c.on('idle', 80000);
  assert.strictEqual(c.tick(80000 + C.WAKE_DEFAULTS.followMs), 'sleep', 'quiet after the answer: asleep');
  c.on('wake', 90000);
  c.on('stop', 91000);
  assert.strictEqual(c.state, 'asleep', '"thanks Jarvis" ends it');
  c.on('wake', 92000);
  c.on('speech', 92100);
  c.on('nothing', 93000);
  assert.strictEqual(c.state, 'follow', 'noise is not an answer to wait for');
  assert.strictEqual(c.tick(92000 + C.WAKE_DEFAULTS.busyMaxMs * 2), 'sleep');

  const open = C.createConversation({ wake: false });
  assert.strictEqual(open.state, 'open');
  assert.ok(open.accepts() && !open.listensForWake(), 'wake word off: every utterance is a request');
  open.on('idle', 0);
  assert.strictEqual(open.tick(1e9), null, 'and it never sleeps');
  open.wake = true;
  assert.strictEqual(open.state, 'asleep');

  for (const s of ['Stop.', 'stop', 'Thanks, Jarvis.', 'thank you jarvis', "That's all.", 'okay, stop talking', 'Never mind.', 'Goodbye Jarvis!']) assert.ok(C.isStopPhrase(s), s);
  for (const s of ['Stop the build on main.', 'Thanks for the summary, what else is due?', 'Tell Jarvis to stop', 'what is on today']) assert.ok(!C.isStopPhrase(s), s);

  assert.strictEqual(C.stripWakeWord("Jarvis, what's on today?"), "what's on today?");
  assert.strictEqual(C.stripWakeWord('Hey Jarvis. Check my mail.'), 'Check my mail.');
  assert.strictEqual(C.stripWakeWord('Ask Jarvis later'), 'Ask Jarvis later', 'only a leading wake word');

  const w = C.createWakeTrigger({ threshold: 0.5, refractoryMs: 1500, warmupFrames: 3 });
  assert.strictEqual(w.step(0.99, 0), false, 'the feature window is still filling');
  w.step(0, 80);
  w.step(0, 160);
  assert.strictEqual(w.step(0.4, 240), false);
  assert.strictEqual(w.step(0.8, 320), true, 'over the bar: woken');
  assert.strictEqual(w.step(0.9, 400), false, 'the same "hey Jarvis" is not a second wake');
  assert.strictEqual(w.step(0.9, 320 + 1500), true);

  assert.strictEqual(C.wakeDefault({ coarsePointer: false }), true, 'on at a desk');
  assert.strictEqual(C.wakeDefault({ coarsePointer: true }), false, 'off on a phone');
  assert.strictEqual(C.expression({ asleep: true }), 'asleep');
  assert.strictEqual(C.expression({ asleep: true, talking: true }), 'talking');
  assert.strictEqual(C.expression({ awake: true, happy: true }), 'awake');

  const line = C.formatLatency({ speechEnd: 0, vadEnd: 250, transcribed: 600, posted: 610, firstReply: 1000, audioStart: 1250, turnBy: 'smart-turn', turnP: 0.91, tts: 'kokoro', ttsFirstMs: 240 });
  assert.match(line, /end by smart-turn \(p 0\.91\)/);
  assert.match(line, /kokoro 240ms to audio/);
}

// ---- the page wires the local voice ----------------------------------------------------
{
  const html = fs.readFileSync(require.resolve('../src/dashboard/talk.html'), 'utf8');
  const page = fs.readFileSync(require.resolve('../src/dashboard/talk.page.js'), 'utf8');
  for (const id of ['wake', 'smartTurn', 'tapPrompt', 'ttsBackend', 'voice']) assert.match(html, new RegExp(`id="${id}"`), id);
  const order = ['talk.core.js', 'talk.capture.js', 'talk.voice.js', 'talk.page.js'].map((f) => html.indexOf(`src="${f}"`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'scripts load in dependency order');
  // iOS: the audio is unlocked inside the tap, before any await.
  assert.match(page, /function tapped\(\) \{\s*unlockAudio\(\);/);
  assert.match(page, /createMicOwner\(\{\s*app: 'pa-talk'/, 'the page joins the one-mic channel');
  assert.match(page, /workletUrl: 'talk\.worklet\.js'/, 'a relative worklet URL works under /pa/');
}

// ---- the transcribe proxy, against a fake faster-whisper server --------------------
(async () => {
  const { config } = require('../src/config.ts');
  const talk = require('../src/dashboard/talk.ts');
  const { handle } = require('../src/dashboard/server.ts');

  let seenPath = null;
  let seenBytes = 0;
  const whisper = net.createServer({ allowHalfOpen: true }, (sock) => {
    // Like the real server: one read (the path), no wait for EOF.
    sock.once('data', (d) => {
      const data = String(d).trim();
      seenPath = data;
      seenBytes = fs.existsSync(data) ? fs.statSync(data).size : -1;
      sock.end(seenBytes > 44 ? 'what is on me today' : 'ERROR: empty file');
    });
  });
  await new Promise((r) => whisper.listen(0, '127.0.0.1', r));
  config.audio.transcribeHost = '127.0.0.1';
  config.audio.transcribePort = whisper.address().port;

  const server = http.createServer((req, res) => handle(req, res).catch((e) => res.writeHead(e.status || 500).end(e.message)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const wav = Buffer.from(C.encodeWav(new Float32Array(1600), 16000));
  let res = await fetch(`${base}/api/talk/transcribe`, { method: 'POST', headers: { 'X-PA': '1', 'Content-Type': 'audio/wav' }, body: wav });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).text, 'what is on me today');
  assert.strictEqual(seenBytes, wav.length, 'whisper got a path to the uploaded WAV');
  for (let i = 0; i < 100 && fs.existsSync(seenPath); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!fs.existsSync(seenPath), 'the temp file is removed');

  // Guarded like every POST.
  res = await fetch(`${base}/api/talk/transcribe`, { method: 'POST', body: wav });
  assert.strictEqual(res.status, 403);

  // While the user talks the transcriber is handed silence, until the transcription comes.
  let pings = 0;
  const onPing = () => pings++;
  whisper.on('connection', onPing);
  talk.keepWhisperWarm(Date.now(), { gapMs: 10, maxMs: 5000 });
  for (let i = 0; i < 200 && pings < 3; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(pings >= 3, `pinged while the user talks (${pings})`);
  res = await fetch(`${base}/api/talk/transcribe`, { method: 'POST', headers: { 'X-PA': '1', 'Content-Type': 'audio/wav' }, body: wav });
  assert.strictEqual((await res.json()).text, 'what is on me today');
  await new Promise((r) => setTimeout(r, 30));
  const after = pings;
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(pings, after, 'no pings after the transcription');

  // An utterance's start (POST /api/talk/warm) refreshes a snapshot that would go stale before its turn.
  {
    const FL = require('../src/chat/fastLane.ts');
    const saved = { cache: FL.snapshotCache, enabled: config.fastLane.enabled, voice: config.voice.url };
    const warmed = [];
    FL.snapshotCache = () => ({ warm: (o) => warmed.push(o) });
    config.fastLane.enabled = true;
    config.voice.url = '';
    res = await fetch(`${base}/api/talk/warm`, { method: 'POST', headers: { 'X-PA': '1' } });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(warmed.length, 1);
    assert.ok(warmed[0].marginMs >= 10_000, `with a margin for the utterance and its turn (${warmed[0].marginMs})`);
    talk.stopWhisperWarm();
    Object.assign(config.fastLane, { enabled: saved.enabled });
    config.voice.url = saved.voice;
    FL.snapshotCache = saved.cache;
  }
  whisper.off('connection', onPing);

  // The page and its scripts are served, the page with the termhub URL.
  res = await fetch(`${base}/talk`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('name="pa-termhub"'));
  assert.ok(html.includes('talk.page.js'));
  for (const f of ['talk.core.js', 'talk.page.js']) {
    res = await fetch(`${base}/${f}`);
    assert.strictEqual(res.status, 200, f);
    assert.ok(res.headers.get('content-type').startsWith('text/javascript'));
  }
  res = await fetch(`${base}/talk.js`);
  assert.strictEqual(res.status, 404, 'the server module is not served');

  // Transcriber down: a clear 503, not a hang.
  whisper.close();
  await assert.rejects(talk.transcribe(wav), (e) => e.status === 503 && /not reachable/.test(e.message));

  // ---- the local voice service, through the PA ----------------------------------
  for (const f of ['talk.voice.js', 'talk.capture.js', 'talk.worklet.js']) {
    res = await fetch(`${base}/${f}`);
    assert.strictEqual(res.status, 200, f);
  }
  const seen = [];
  const voice = http.createServer((req, r) => {
    let body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', () => {
      body = Buffer.concat(body);
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], bytes: body.length, origin: req.headers.origin });
      if (req.url === '/health') return r.end(JSON.stringify({ ok: true, ready: true, device: 'cuda', turn: true }));
      if (req.url === '/voices') return r.end(JSON.stringify({ voices: [{ id: 'bf_isabella', label: 'Isabella (British)' }] }));
      if (req.url === '/tts') {
        r.writeHead(200, { 'Content-Type': 'audio/L16; rate=24000; channels=1', 'X-First-Ms': '190', 'Set-Cookie': 'no=1' });
        r.write(Buffer.alloc(480));
        setTimeout(() => r.end(Buffer.alloc(480)), 20);
        return;
      }
      if (req.url === '/endpoint') return r.end(JSON.stringify({ complete: true, probability: 0.93, ms: 60 }));
      r.writeHead(404).end('{}');
    });
  });
  await new Promise((r) => voice.listen(0, '127.0.0.1', r));
  const modelsDir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'pa-voice-models-'));
  fs.writeFileSync(require('path').join(modelsDir, 'silero_vad.onnx'), 'onnx');
  fs.writeFileSync(require('path').join(modelsDir, 'secret.txt'), 'nope');
  config.voice.url = `http://127.0.0.1:${voice.address().port}`;
  config.voice.models = modelsDir;

  res = await fetch(`${base}/api/talk/voice`);
  let info = await res.json();
  assert.strictEqual(info.tts.ok, true);
  assert.strictEqual(info.turn, true);
  assert.strictEqual(info.voices[0].id, 'bf_isabella');
  assert.deepStrictEqual(info.models, { vad: true, wake: false, ort: false });

  res = await fetch(`${base}/api/talk/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"Hi."}' });
  assert.strictEqual(res.status, 403, 'X-PA guarded');
  res = await fetch(`${base}/api/talk/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PA': '1' }, body: '{"text":"Hi."}' });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^audio\/L16/);
  assert.strictEqual(res.headers.get('x-first-ms'), '190');
  assert.strictEqual(res.headers.get('set-cookie'), null, 'only the audio headers pass');
  assert.strictEqual((await res.arrayBuffer()).byteLength, 960, 'streamed through whole');
  const ttsSeen = seen.find((s) => s.url === '/tts');
  assert.strictEqual(ttsSeen.origin, undefined, 'the service sees no browser Origin');

  const pcm = Buffer.from(C.floatToPcm16(new Float32Array(16000)));
  res = await fetch(`${base}/api/talk/endpoint`, { method: 'POST', headers: { 'Content-Type': 'audio/L16; rate=16000', 'X-PA': '1' }, body: pcm });
  assert.deepStrictEqual(await res.json(), { complete: true, probability: 0.93, ms: 60 });
  assert.strictEqual(seen.find((s) => s.url === '/endpoint').bytes, 32000);

  // The page's models: by name only.
  res = await fetch(`${base}/talk/models/silero_vad.onnx`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), 'onnx');
  res = await fetch(`${base}/talk/models/secret.txt`);
  assert.strictEqual(res.status, 404, 'nothing else in the folder is served');
  res = await fetch(`${base}/talk/models/..%2F..%2Fpackage.json`);
  assert.strictEqual(res.status, 404);
  res = await fetch(`${base}/talk/models/hey_jarvis_v0.1.onnx`);
  assert.strictEqual(res.status, 404, 'a known model that is not installed');

  // The service down: a clear 503 for the page to fall back on.
  voice.close();
  config.voice.url = 'http://127.0.0.1:9';
  // past the health cache: move the clock instead of sleeping through it
  const realNow = Date.now;
  Date.now = () => realNow() + 3100;
  res = await fetch(`${base}/api/talk/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PA': '1' }, body: '{"text":"Hi."}' });
  assert.strictEqual(res.status, 503);
  info = await (await fetch(`${base}/api/talk/voice`)).json();
  assert.strictEqual(info.tts.ok, false);
  Date.now = realNow;
  fs.rmSync(modelsDir, { recursive: true, force: true });

  server.close();
  whisper.close();
  voice.close();
  // The dashboard handler lazily opens the pg pool; its 30 s idle timers would hold the process open.
  await require('../src/db').close();
  console.log('talk ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
