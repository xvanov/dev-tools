'use strict';

// Per-client output coalescing (lib/outputCoalescer.ts), on a fake clock so the
// timing rules are pinned without sleeping.
//
// The cases that earned their place:
//  - a burst of ~100-byte chunks becomes a handful of messages, not one each;
//  - a lone keystroke echo is not delayed (leading edge goes out at once);
//  - a size/exit message flushes pending output first, so it never overtakes
//    bytes sent before it;
//  - a big burst flushes at the byte cap instead of waiting for the timer;
//  - dispose drops what is pending and cancels the timer.

const assert = require('assert');
const { OutputCoalescer } = require('../lib/outputCoalescer.ts');

function rig(opts = {}) {
  const sent = [];
  let t = 1000;
  const timers = new Map();
  let nextId = 1;
  const c = new OutputCoalescer((m) => sent.push(m), {
    intervalMs: 12, maxBytes: 64 * 1024,
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    ...opts,
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); t = due[1].at; due[1].fn();
    }
    t = end;
  };
  return { c, sent, advance, timers, now: () => t };
}

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ok ${name}`); };

ok('a lone chunk is sent immediately', () => {
  const { c, sent } = rig();
  c.push('a');
  assert.deepStrictEqual(sent, [{ type: 'output', data: 'a' }]);
});

ok('a burst after the leading edge is joined and sent at the end of the window', () => {
  const { c, sent, advance } = rig();
  c.push('a');                       // leading edge
  advance(1); c.push('b');
  advance(1); c.push('c');
  advance(1); c.push('d');
  assert.strictEqual(sent.length, 1, 'held until the window ends');
  advance(20);
  assert.deepStrictEqual(sent.map((m) => m.data), ['a', 'bcd']);
});

ok('1000 chunks over one second become ~80 messages, in order, nothing lost', () => {
  const { c, sent, advance } = rig();
  let expect = '';
  for (let i = 0; i < 1000; i++) { const d = String(i % 10); expect += d; c.push(d); advance(1); }
  advance(50);
  assert.ok(sent.length < 100, `got ${sent.length} messages`);
  assert.strictEqual(sent.map((m) => m.data).join(''), expect);
});

ok('a keystroke echo after a quiet spell is not delayed', () => {
  const { c, sent, advance } = rig();
  c.push('x'); advance(500);
  c.push('y');
  assert.deepStrictEqual(sent.map((m) => m.data), ['x', 'y']);
});

ok('sendOther flushes pending output first, then the message', () => {
  const { c, sent, advance } = rig();
  c.push('a'); advance(1); c.push('b'); c.push('c');
  c.sendOther({ type: 'size', cols: 50, rows: 20, owner: 'c1' });
  assert.deepStrictEqual(sent, [
    { type: 'output', data: 'a' },
    { type: 'output', data: 'bc' },
    { type: 'size', cols: 50, rows: 20, owner: 'c1' },
  ]);
  advance(50);
  assert.strictEqual(sent.length, 3, 'the cancelled timer sends nothing more');
});

ok('exit with nothing pending is just the exit', () => {
  const { c, sent } = rig();
  c.sendOther({ type: 'exit', code: 0 });
  assert.deepStrictEqual(sent, [{ type: 'exit', code: 0 }]);
});

ok('the byte cap flushes without waiting for the timer', () => {
  const { c, sent, advance } = rig({ maxBytes: 100 });
  c.push('a'); advance(1);
  c.push('b'.repeat(60));
  assert.strictEqual(sent.length, 1);
  c.push('c'.repeat(60));
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].data.length, 120);
});

ok('dispose drops pending output and cancels the timer', () => {
  const { c, sent, advance, timers } = rig();
  c.push('a'); advance(1); c.push('b');
  assert.strictEqual(timers.size, 1);
  c.dispose();
  assert.strictEqual(timers.size, 0);
  advance(50); c.push('z'); c.sendOther({ type: 'exit' });
  assert.deepStrictEqual(sent.map((m) => m.data), ['a']);
});

// Real timers, once, so the fake clock isn't the only thing vouching for it.
(async () => {
  const sent = [];
  const c = new OutputCoalescer((m) => sent.push(m));
  c.push('1'); c.push('2'); c.push('3');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepStrictEqual(sent.map((m) => m.data), ['1', '23']);
  console.log(`outputCoalescer.test.js: ok (${passed + 1} cases)`);
})().catch((e) => { console.error(e); process.exit(1); });
