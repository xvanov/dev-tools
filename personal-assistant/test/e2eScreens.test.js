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
