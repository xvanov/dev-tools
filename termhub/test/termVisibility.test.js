'use strict';

// Client-side pure pieces for the "hidden terminals stop streaming" work:
// the detach timing rule (web/termVisibility.js) and the perf overlay's numbers
// (web/termPerf.js). No browser: timers and clocks are injected.

const assert = require('assert');
const V = require('../web/termVisibility.js');
const P = require('../web/termPerf.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };

function fakeTimers() {
  let t = 0; let id = 0; const q = new Map();
  return {
    setTimer: (fn, ms) => { q.set(++id, { fn, at: t + ms }); return id; },
    clearTimer: (i) => q.delete(i),
    advance(ms) {
      t += ms;
      for (const [i, v] of [...q]) if (v.at <= t) { q.delete(i); v.fn(); }
    },
  };
}

ok('delay is in the 10-20 s window', () => {
  assert.ok(V.HIDDEN_DETACH_MS >= 10000 && V.HIDDEN_DETACH_MS <= 20000);
});

ok('only the active terminal of a visible page is visible', () => {
  assert.strictEqual(V.isVisible('a', 'a', true), true);
  assert.strictEqual(V.isVisible('b', 'a', true), false);
  assert.strictEqual(V.isVisible('a', 'a', false), false, 'a hidden page shows nothing');
});

ok('a hidden terminal detaches after the delay, once', () => {
  const f = fakeTimers(); const detached = [];
  const s = V.createScheduler({ ...f, delayMs: 15000, onDetach: (id) => detached.push(id) });
  s.update('a', false);
  f.advance(14999); assert.deepStrictEqual(detached, []);
  f.advance(1); assert.deepStrictEqual(detached, ['a']);
  f.advance(60000); assert.deepStrictEqual(detached, ['a']);
});

ok('a quick flip away and back never detaches', () => {
  const f = fakeTimers(); const detached = [];
  const s = V.createScheduler({ ...f, delayMs: 15000, onDetach: (id) => detached.push(id) });
  s.update('a', false); f.advance(5000);
  s.update('a', true); assert.strictEqual(s.pending('a'), false);
  f.advance(60000); assert.deepStrictEqual(detached, []);
});

ok('repeated hidden updates do not postpone the detach', () => {
  const f = fakeTimers(); const detached = [];
  const s = V.createScheduler({ ...f, delayMs: 15000, onDetach: (id) => detached.push(id) });
  for (let i = 0; i < 10; i++) { s.update('a', false); f.advance(1400); }
  f.advance(1000);
  assert.deepStrictEqual(detached, ['a']);
});

ok('perf: rates, avg and max write time, and long tasks per window', () => {
  let t = 0;
  const entries = [];
  let cb = null;
  class FakePO { constructor(fn) { cb = fn; } observe() {} disconnect() {} }
  const perf = P.create({
    now: () => t, doc: null, PerformanceObserver: FakePO, setInterval: null, clearInterval: null,
  });
  perf.enable({ terminals: () => [{ id: 'a', title: 'one', state: 'live' }, { id: 'b', title: 'two', state: 'detached' }] });
  assert.strictEqual(perf.on, true);
  for (let i = 0; i < 50; i++) perf.recv('a', 100);
  perf.wrote('a', 2); perf.wrote('a', 6);
  cb({ getEntries: () => [{ duration: 80 }, { duration: 120 }] });
  t = 2000;
  const rows = perf.tick();
  const a = rows.find((r) => r.id === 'a'); const b = rows.find((r) => r.id === 'b');
  assert.strictEqual(a.bytesPerSec, 2500); assert.strictEqual(a.msgsPerSec, 25);
  assert.strictEqual(a.avgMs, 4); assert.strictEqual(a.maxMs, 6);
  assert.strictEqual(b.state, 'detached'); assert.strictEqual(b.bytesPerSec, 0);
  assert.deepStrictEqual([perf.longTasks.count, perf.longTasks.ms], [2, 200]);
  t = 3000;
  perf.tick();
  assert.strictEqual(perf.longTasks.count, 0, 'the window resets');
  assert.strictEqual(perf.longTasks.totalCount, 2, 'the running total does not');
  perf.disable();
  assert.strictEqual(perf.on, false);
  void entries;
});

ok('perf: shortcut is Ctrl+Alt+Shift+P only', () => {
  const perf = P.create({ doc: null, PerformanceObserver: null });
  assert.ok(perf.isShortcut({ ctrlKey: true, altKey: true, shiftKey: true, key: 'P' }));
  assert.ok(!perf.isShortcut({ ctrlKey: true, altKey: false, shiftKey: true, key: 'P' }));
  assert.ok(!perf.isShortcut({ ctrlKey: false, altKey: true, shiftKey: true, key: 'P' }));
});

console.log(`termVisibility.test.js: ok (${n} cases)`);
