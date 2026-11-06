'use strict';

// The voice page (/talk): what is read aloud, how answers become sentences,
// the VAD, the WAV, and the transcribe proxy against a fake whisper server.

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

// ---- the transcribe proxy, against a fake faster-whisper server --------------------
(async () => {
  const { config } = require('../src/config');
  const talk = require('../src/dashboard/talk');
  const { handle } = require('../src/dashboard/server');

  let seenPath = null;
  let seenBytes = 0;
  const whisper = net.createServer((sock) => {
    let data = '';
    sock.on('data', (d) => (data += d));
    sock.on('end', () => {
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
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(seenPath), 'the temp file is removed');

  // Guarded like every POST.
  res = await fetch(`${base}/api/talk/transcribe`, { method: 'POST', body: wav });
  assert.strictEqual(res.status, 403);

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

  server.close();
  console.log('talk ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
