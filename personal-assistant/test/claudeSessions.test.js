'use strict';

// The local Claude sessions pass (src/ingest/claudeSessions.ts) reads only
// what a transcript gained since the last pass, and parses without holding the
// event loop. What has to hold: the item read in steps is the one a whole read
// gives; a half-written last line is picked up once it is finished; a file
// that shrank or was rewritten is read again from the start; and a big parse
// lets timers run. Files live in a temp dir; prompts are invented.

const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cs = require('../src/ingest/claudeSessions.ts');

const line = (o) => JSON.stringify(o) + '\n';
const prompt = (i) => line({ type: 'user', sessionId: 'sess-1', cwd: 'C:\\src\\orchard', timestamp: `2026-10-20T09:${String(i).padStart(2, '0')}:00Z`, message: { content: `prompt ${i}` } });
const reply = (i) => line({ type: 'assistant', sessionId: 'sess-1', timestamp: `2026-10-20T09:${String(i).padStart(2, '0')}:30Z`, message: { content: [{ type: 'text', text: `reply ${i}` }] } });

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-cs-'));
  return path.join(dir, 'sess-1.jsonl');
}
const stat = (p) => {
  const st = fs.statSync(p);
  return { path: p, mtime: st.mtimeMs, size: st.size };
};
const whole = (p) => cs.toItem(cs.parseTranscript(fs.readFileSync(p, 'utf8')), p);
// mtime has a coarse grain on some filesystems; a step must look changed.
const bump = (p, n) => fs.utimesSync(p, new Date(), new Date(Date.now() + n * 1000));

test('an appended transcript reads to the same item as a whole read', async () => {
  const p = tmpFile();
  const cache = new Map();
  fs.writeFileSync(p, prompt(1) + reply(1));
  assert.deepStrictEqual(await cs.readTranscript(stat(p), cache), whole(p));

  fs.appendFileSync(p, prompt(2) + reply(2) + line({ type: 'ai-title', aiTitle: 'Orchard upload' }));
  bump(p, 1);
  const stepped = await cs.readTranscript(stat(p), cache);
  assert.deepStrictEqual(stepped, whole(p));
  assert.strictEqual(stepped.subject, 'Orchard upload');
  assert.strictEqual(stepped.raw.turns, 4);
});

test('an unchanged transcript is not read again', async () => {
  const p = tmpFile();
  const cache = new Map();
  fs.writeFileSync(p, prompt(1) + reply(1));
  const first = await cs.readTranscript(stat(p), cache);
  const open = fs.promises.open;
  let opened = 0;
  fs.promises.open = (...a) => (opened++, open(...a));
  try {
    assert.strictEqual(await cs.readTranscript(stat(p), cache), first);
  } finally {
    fs.promises.open = open;
  }
  assert.strictEqual(opened, 0);
});

test('a half-written last line counts once it is finished', async () => {
  const p = tmpFile();
  const cache = new Map();
  const next = reply(1);
  fs.writeFileSync(p, prompt(1) + next.slice(0, 20));
  assert.strictEqual((await cs.readTranscript(stat(p), cache)).raw.turns, 1);

  fs.appendFileSync(p, next.slice(20));
  bump(p, 1);
  const done = await cs.readTranscript(stat(p), cache);
  assert.strictEqual(done.raw.turns, 2);
  assert.deepStrictEqual(done, whole(p));
});

test('a last line with no line end is kept when it is whole JSON, and the next append still reads right', async () => {
  const p = tmpFile();
  const cache = new Map();
  fs.writeFileSync(p, prompt(1) + reply(1).trimEnd());
  assert.strictEqual((await cs.readTranscript(stat(p), cache)).raw.turns, 2);

  fs.appendFileSync(p, '\n' + prompt(2));
  bump(p, 1);
  const after = await cs.readTranscript(stat(p), cache);
  assert.deepStrictEqual(after, whole(p));
  assert.strictEqual(after.raw.turns, 3);
});

test('a transcript that shrank or was rewritten is read from the start', async () => {
  const p = tmpFile();
  const cache = new Map();
  fs.writeFileSync(p, prompt(1) + reply(1) + prompt(2));
  await cs.readTranscript(stat(p), cache);

  fs.writeFileSync(p, prompt(5));
  bump(p, 1);
  assert.deepStrictEqual(await cs.readTranscript(stat(p), cache), whole(p));

  // Longer, but not an append: the byte before the old offset moved.
  fs.writeFileSync(p, '  ' + prompt(6) + reply(6) + prompt(7));
  bump(p, 2);
  const re = await cs.readTranscript(stat(p), cache);
  assert.deepStrictEqual(re, whole(p));
  assert.deepStrictEqual(re.bodyText.match(/prompt \d/g), ['prompt 6', 'prompt 7']);
});

test('parsing a big transcript lets timers run', async () => {
  let text = '';
  for (let i = 0; i < 4000; i++) text += prompt(i % 60) + line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(2000) }] } });
  let ticks = 0;
  const iv = setInterval(() => ticks++, 1);
  const t0 = Date.now();
  const parsed = await cs.parseTranscriptAsync(text);
  const ms = Date.now() - t0;
  clearInterval(iv);
  assert.deepStrictEqual(parsed, cs.parseTranscript(text));
  if (ms >= 40) assert.ok(ticks > 0, `no timer ran during a ${ms} ms parse`);
});
