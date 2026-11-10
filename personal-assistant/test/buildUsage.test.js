'use strict';

// src/build/usage.ts: the usage payload parsed (full, partial, junk), the
// fallbacks to five_hour/seven_day, a minute's cache that survives failure, a 429 backoff, no token
// in the answer, and Fable among the Build model choices everywhere one is made.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const U = require('../src/build/usage.ts');

const full = {
  limits: [
    { kind: 'weekly_scoped', percent: 41.5, resets_at: '2026-11-14T09:00:00Z', severity: 'normal', scope: { model: { display_name: 'Fable' } } },
    { kind: 'session', percent: 78, resets_at: '2026-11-10T14:10:00Z', severity: 'warning' },
    { kind: 'weekly_all', percent: 12, resets_at: '2026-11-14T09:00:00Z', severity: 'normal' },
    { kind: 'something_new', percent: 5 },
    null,
  ],
  five_hour: { utilization: 99 },
  extra_usage: { used_credits: 1250, monthly_limit: 5000, utilization: 25 },
};
{
  const r = U.parseUsage(full);
  assert.deepStrictEqual(r.meters.map((m) => m.kind), ['session', 'weekly_all', 'weekly_scoped']);
  assert.strictEqual(r.meters[0].percent, 78);
  assert.strictEqual(r.meters[0].severity, 'warning');
  assert.strictEqual(r.meters[2].label, 'Weekly Fable');
  assert.strictEqual(r.meters[2].model, 'Fable');
  assert.strictEqual(r.meters[1].resets_at, '2026-11-14T09:00:00.000Z');
  assert.deepStrictEqual(r.extra, { used_usd: 12.5, limit_usd: 50, percent: 25 });
}
{ // missing fields: fall back to five_hour / seven_day, derive severity, no extra
  const r = U.parseUsage({ five_hour: { utilization: 92, resets_at: 'nonsense' }, seven_day: { utilization: 10 } });
  assert.deepStrictEqual(r.meters.map((m) => [m.kind, m.percent, m.severity, m.resets_at]), [['session', 92, 'critical', null], ['weekly_all', 10, 'normal', null]]);
  assert.strictEqual(r.extra, null);
}
for (const junk of [null, undefined, 7, 'x', [], {}, { limits: 'no', extra_usage: 3 }, { limits: [{ kind: 'session' }] }]) {
  assert.deepStrictEqual(U.parseUsage(junk), { meters: [], extra: null });
}
assert.deepStrictEqual(U.parseUsage({ extra_usage: { used_credits: 100, monthly_limit: 400 } }).extra, { used_usd: 1, limit_usd: 4, percent: 25 });

// Fable is a Build model everywhere one is chosen.
const B = require('../src/build/index.ts');
assert.ok(B.MODELS.includes('fable'));
assert.strictEqual(B.checkModel('Fable'), 'fable');
assert.strictEqual(B.checkModel('claude-fable-5-1'), 'fable');
assert.strictEqual(B.MODEL_IDS.fable, 'claude-fable-5-1');
const tools = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'chatTools.ts'), 'utf8');
assert.match(tools, /enum: \['haiku', 'sonnet', 'opus', 'fable'\]/);
assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'factory.html'), 'utf8'), /<option value="fable">/);
assert.ok(require('../src/dashboard/dispatchMenu.client.js').rows({ settings: { model: 'fable' }, options: { models: B.MODELS } }));
assert.strictEqual(require('../src/build/track.ts').priceOf('claude-fable-5-1').in, 10);

// Fetch: token re-read from the file each time, cached a minute, a 429 backs off serving the last good numbers stale, failures are {ok:false}, token never returned.
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-usage-'));
  const cred = path.join(dir, 'c.json');
  process.env.PA_CLAUDE_CREDENTIALS = cred;
  process.env.PA_USAGE_CACHE = path.join(dir, 'last.json');
  const realFetch = global.fetch;
  let calls = 0;
  let seen = null;
  let answer = () => ({ ok: true, status: 200, json: async () => full });
  global.fetch = async (url, init) => { calls++; seen = { url, init }; return answer(); };
  try {
    U.resetCache();
    const none = await U.usage(); // no credentials file
    assert.strictEqual(none.ok, false);
    assert.strictEqual(calls, 0);

    fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET-TOKEN' } }));
    U.resetCache();
    const [a, b] = await Promise.all([U.usage(), U.usage()]);
    assert.strictEqual(calls, 1, 'a burst shares one call');
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.meters.length, 3);
    assert.strictEqual(seen.url, U.URL_USAGE);
    assert.strictEqual(seen.init.headers.Authorization, 'Bearer SECRET-TOKEN');
    assert.strictEqual(seen.init.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.ok(!JSON.stringify(a).includes('SECRET-TOKEN') && b === a);
    await U.usage();
    assert.strictEqual(calls, 1, 'cached');

    // Rate-limited (seen live, 2026-11-10): the last good numbers, marked stale, and no retry inside the backoff.
    U.expireCache();
    answer = () => ({ ok: false, status: 429, headers: { get: () => '300' }, json: async () => ({}) });
    const before = calls;
    const stale = await U.usage();
    assert.strictEqual(stale.ok, true);
    assert.strictEqual(stale.stale, true);
    assert.strictEqual(stale.meters.length, 3);
    assert.match(stale.reason, /rate-limited/);
    await U.usage();
    assert.strictEqual(calls, before + 1, 'no retry inside the backoff');
    // A restart (cache and memory gone) still has the last good numbers from disk.
    U.resetCache();
    const cold = await U.usage();
    assert.strictEqual(cold.stale, true);
    assert.strictEqual(cold.meters.length, 3);
    assert.ok(!fs.readFileSync(process.env.PA_USAGE_CACHE, 'utf8').includes('SECRET-TOKEN'));
    fs.rmSync(process.env.PA_USAGE_CACHE); // the failures below start with nothing to fall back on

    U.resetCache();
    answer = () => ({ ok: false, status: 500, json: async () => ({}) });
    const bad = await U.usage();
    assert.strictEqual(bad.ok, false);
    assert.ok(!JSON.stringify(bad).includes('SECRET-TOKEN'));
    U.resetCache();
    answer = () => { throw new Error('offline'); };
    assert.strictEqual((await U.usage()).ok, false);
    U.resetCache();
    answer = () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) });
    assert.strictEqual((await U.usage()).ok, false);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('buildUsage ok');
}
main().catch((e) => { console.error(e); process.exit(1); });
