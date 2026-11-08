'use strict';

// `pa e2e` screenshots (src/e2e/screens.ts, 8.4.11): which signal each view
// waits for, and the DevTools wait itself against a fake client and clock.
// No browser.

const assert = require('assert');
const S = require('../src/e2e/screens.ts');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('each view waits for its own loaded signal; run-<session> is a run view; others only for the network', () => {
  assert.strictEqual(S.kindOf('run-smw8915da2'), 'run');
  assert.strictEqual(S.kindOf('plan'), 'plan');
  assert.strictEqual(S.kindOf('github-pr'), null);
  assert.ok(/getElementById\('updated'\)/.test(S.readyFor('plan')));
  assert.ok(/chat-log/.test(S.readyFor('ask')));
  assert.ok(/empty-state/.test(S.readyFor('run-abc')));
  assert.strictEqual(S.readyFor('github-pr'), null);
  const withText = S.readyFor('plan', '#6773');
  assert.ok(withText.includes('innerText.includes("#6773")') && withText.includes('updated'));
  assert.deepStrictEqual(S.activePort('51234\n/devtools/browser/abc\n'), { port: 51234, path: '/devtools/browser/abc' });
  assert.strictEqual(S.activePort(''), null);
});

function fakeCdp({ readyAfterMs, requests = [] }) {
  let now = 0;
  const clock = { now: () => now, sleep: async (ms) => { now += ms; } };
  const calls = [];
  let listener = null;
  const cdp = {
    on(fn) { listener = fn; },
    close() {},
    async send(method, params = {}) {
      calls.push(method);
      if (method === 'Page.navigate') for (const r of requests) listener(r.method, r.params);
      if (method === 'Runtime.evaluate') {
        if (/innerText : ''/.test(params.expression)) return { result: { value: `board at ${now}` } };
        return { result: { value: now >= readyAfterMs } };
      }
      if (method === 'Page.captureScreenshot') return { data: Buffer.from(`png at ${now}`).toString('base64') };
      return {};
    },
  };
  return { cdp, clock, calls, at: () => now };
}

test('drive: shoots after the page says its data is in, not at load', async () => {
  const f = fakeCdp({ readyAfterMs: 3000 });
  const r = await S.drive(f.cdp, 'http://pa/', { ready: 'x', settleMs: 500, quietMs: 500 }, f.clock);
  assert.strictEqual(r.ready, true);
  assert.ok(r.waitedMs >= 3000 && r.waitedMs < 3500, String(r.waitedMs));
  assert.strictEqual(r.png.toString(), `png at ${r.waitedMs + 500}`, 'shot after the settle');
  assert.ok(/^board at/.test(r.text));
  assert.deepStrictEqual(f.calls.slice(0, 4), ['Page.enable', 'Network.enable', 'Emulation.setDeviceMetricsOverride', 'Page.navigate']);
});

test('drive: a page that never gets ready is shot at the budget and says so; a live feed does not hold it', async () => {
  const f = fakeCdp({ readyAfterMs: Infinity });
  const r = await S.drive(f.cdp, 'http://pa/', { ready: 'x', budgetMs: 4000, settleMs: 0 }, f.clock);
  assert.strictEqual(r.ready, false);
  assert.ok(r.waitedMs >= 4000);
  // An EventSource that never finishes is not traffic to wait for.
  const live = fakeCdp({ readyAfterMs: 0, requests: [{ method: 'Network.requestWillBeSent', params: { requestId: 'es', type: 'EventSource' } }] });
  const r2 = await S.drive(live.cdp, 'http://pa/', { ready: null, settleMs: 0, quietMs: 500 }, live.clock);
  assert.strictEqual(r2.ready, true);
  assert.ok(r2.waitedMs < 1000, String(r2.waitedMs));
  // A fetch still in flight holds the shot until half the budget.
  const busy = fakeCdp({ readyAfterMs: 0, requests: [{ method: 'Network.requestWillBeSent', params: { requestId: 'f1', type: 'Fetch' } }] });
  const r3 = await S.drive(busy.cdp, 'http://pa/', { ready: null, budgetMs: 4000, settleMs: 0, quietMs: 500 }, busy.clock);
  assert.ok(r3.ready && r3.waitedMs > 2000, String(r3.waitedMs));
});

// 8.4.40: a page whose renderer never yields left `capture` pending forever,
// and Node exited 0 under it: the kill timer closed the DevTools socket, and
// the next call went out on it unanswered.
test('connect: a call that gets no answer, or goes out on a closed socket, rejects', async () => {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const conns = [];
  wss.on('connection', (c) => conns.push(c));
  try {
    const cdp = await S.connect(`ws://127.0.0.1:${wss.address().port}/`, 2000, { callMs: 200 });
    await assert.rejects(cdp.send('Runtime.evaluate'), /no answer in 200 ms/);
    const held = cdp.send('Page.captureScreenshot', {}, 5000);
    for (const c of conns) c.terminate();
    await assert.rejects(held, /closed/);
    await assert.rejects(cdp.send('Page.captureScreenshot'), /closed before Page.captureScreenshot/);
  } finally {
    await new Promise((r) => wss.close(r));
  }
});

test('within: a shot that never settles is cut at its deadline, and one whose browser exits ends then', async () => {
  const never = new Promise(() => {});
  const t0 = Date.now();
  const cut = await S.within(never, 100, never);
  assert.strictEqual(cut.ok, false);
  assert.strictEqual(cut.timedOut, true);
  assert.ok(Date.now() - t0 < 2000);
  const died = await S.within(never, 60_000, Promise.resolve('code 9'));
  assert.deepStrictEqual(died, { ok: false, error: 'the browser exited mid-shot (code 9)' });
  const done = await S.within(Promise.resolve({ ok: true, file: 'x' }), 60_000, never);
  assert.strictEqual(done.ok, true);
});

test('shootCdp: a "browser" that exits at once settles the shot at its exit, not the deadline', async () => {
  const file = require('path').join(require('os').tmpdir(), `pa-e2e-shot-test-${process.pid}.png`);
  const t0 = Date.now();
  // node refuses chrome's flags and exits: no DevTools port ever appears.
  const r = await S.shootCdp(process.execPath, 'http://127.0.0.1:9/', file, { timeoutMs: 30_000 });
  assert.strictEqual(r.ok, false);
  assert.ok(/exited|no DevTools port/.test(r.error), r.error);
  assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok - ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`not ok - ${t.name}\n  ${err.stack}`);
    }
  }
  if (failed) {
    console.log(`${failed} of ${tests.length} failed`);
    process.exit(1);
  }
  console.log(`${tests.length} passed`);
})();
