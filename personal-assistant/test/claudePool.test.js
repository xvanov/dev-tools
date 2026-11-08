'use strict';

// The Claude credit pool (src/claudePool.js): the period arithmetic, the
// remaining-credit maths, and the API fallback decision (off by default, only for
// claude_session, only once the pool is spent, fail-open when the pool cannot be
// read). Also POST /api/telemetry's usage path, which is what feeds the pool.
// No database and no paid call: src/repo is stubbed.

const assert = require('assert');
const path = require('path');

const store = { rows: [], poolUsd: 0, poolCalls: 0, fail: false, asked: [] };
const repoPath = require.resolve(path.join(__dirname, '..', 'src', 'repo'));
require.cache[repoPath] = {
  id: repoPath,
  filename: repoPath,
  loaded: true,
  exports: {
    spend: {
      async record(row) {
        store.rows.push(row);
      },
      async claudePoolSince(start) {
        store.asked.push(start);
        if (store.fail) throw new Error('connect ECONNREFUSED');
        return { usd: store.poolUsd, calls: store.poolCalls };
      },
    },
    telemetry: { recordSpans: async (rows) => rows.length },
  },
};

const { config } = require('../src/config.ts');
const pool = require('../src/claudePool.ts');

let failed = 0;
async function t(name, fn) {
  try {
    store.rows = [];
    store.asked = [];
    store.fail = false;
    store.poolUsd = 0;
    store.poolCalls = 0;
    pool.invalidate();
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n${err.stack}`);
  }
}

const POOL = { monthlyUsd: 100, usedUsd: 40, since: new Date(2026, 10, 1), resetsAt: new Date(2026, 11, 1) };

(async () => {
  await t('periodStart: this month once the reset day has come, else last month', () => {
    assert.deepStrictEqual(pool.periodStart(new Date(2026, 10, 7, 9), 1), new Date(2026, 10, 1));
    assert.deepStrictEqual(pool.periodStart(new Date(2026, 10, 7, 9), 15), new Date(2026, 9, 15));
    assert.deepStrictEqual(pool.periodStart(new Date(2026, 10, 15, 0, 0), 15), new Date(2026, 10, 15));
    assert.deepStrictEqual(pool.periodStart(new Date(2026, 0, 3), 15), new Date(2025, 11, 15), 'across a year');
    assert.deepStrictEqual(pool.periodEnd(new Date(2026, 10, 7), 15), new Date(2026, 10, 15));
    assert.deepStrictEqual(pool.periodEnd(new Date(2026, 10, 20), 15), new Date(2026, 11, 15));
  });

  await t('compute: remaining is the pool less usage, never negative', () => {
    const c = pool.compute({ ...POOL });
    assert.deepStrictEqual([c.tracked, c.remainingUsd, c.exhausted], [true, 60, false]);
    const over = pool.compute({ ...POOL, usedUsd: 130 });
    assert.deepStrictEqual([over.remainingUsd, over.exhausted], [0, true]);
    assert.strictEqual(pool.compute({ ...POOL, usedUsd: 100 }).exhausted, true, 'spent at exactly the pool');
  });

  await t('compute: no pool size means not tracked, never exhausted', () => {
    const c = pool.compute({ ...POOL, monthlyUsd: null });
    assert.deepStrictEqual([c.tracked, c.monthlyUsd, c.remainingUsd, c.exhausted], [false, null, null, false]);
  });

  await t('decideRuntime: only a spent pool with the flag on moves claude_session to api', () => {
    const spent = pool.compute({ ...POOL, usedUsd: 100, fallbackApi: true });
    const out = pool.decideRuntime('claude_session', spent);
    assert.deepStrictEqual([out.runtime, out.fellBack], ['api', true]);
    assert.match(out.reason, /pool is spent/);
    assert.strictEqual(pool.decideRuntime('claude_session', { ...spent, fallbackApi: false }).runtime, 'claude_session', 'flag off');
    assert.strictEqual(pool.decideRuntime('claude_session', pool.compute({ ...POOL, fallbackApi: true })).runtime, 'claude_session', 'credit left');
    assert.strictEqual(pool.decideRuntime('api', spent).runtime, 'api');
    assert.strictEqual(pool.decideRuntime('claude_session', pool.compute({ ...POOL, monthlyUsd: null, fallbackApi: true })).fellBack, false, 'untracked');
  });

  await t('route: the default config never reroutes and never reads the store', async () => {
    assert.strictEqual(config.claudePool.fallbackApi, false, 'default off');
    const out = await pool.route('claude_session');
    assert.deepStrictEqual([out.runtime, out.fellBack], ['claude_session', false]);
    assert.strictEqual(store.asked.length, 0);
  });

  await t('route: flag on and pool spent -> api; credit left -> claude_session', async () => {
    Object.assign(config.claudePool, { monthlyUsd: 50, fallbackApi: true, resetDay: 1 });
    try {
      store.poolUsd = 20;
      assert.strictEqual((await pool.route('claude_session')).runtime, 'claude_session');
      pool.invalidate();
      store.poolUsd = 50.01;
      const out = await pool.route('claude_session');
      assert.deepStrictEqual([out.runtime, out.fellBack], ['api', true]);
      assert.strictEqual((await pool.route('api')).runtime, 'api');
    } finally {
      Object.assign(config.claudePool, { monthlyUsd: null, fallbackApi: false });
    }
  });

  await t('route: fails open when the store cannot say', async () => {
    Object.assign(config.claudePool, { monthlyUsd: 50, fallbackApi: true });
    try {
      store.fail = true;
      assert.strictEqual((await pool.route('claude_session')).runtime, 'claude_session');
    } finally {
      Object.assign(config.claudePool, { monthlyUsd: null, fallbackApi: false });
    }
  });

  await t('status: usage since the period start, cached until a usage row is recorded', async () => {
    Object.assign(config.claudePool, { monthlyUsd: 80, fallbackApi: false, resetDay: 1 });
    try {
      store.poolUsd = 30;
      store.poolCalls = 4;
      const a = await pool.status({ now: new Date(2026, 10, 7) });
      assert.deepStrictEqual([a.usedUsd, a.remainingUsd, a.calls], [30, 50, 4]);
      assert.deepStrictEqual(store.asked[0], new Date(2026, 10, 1));
      store.poolUsd = 35;
      assert.strictEqual((await pool.status({ now: new Date(2026, 10, 7) })).usedUsd, 30, 'cached');
      await require('../src/budget.ts').record({ purpose: 'x', backend: 'cli', costUsd: 5, ok: true });
      assert.strictEqual((await pool.status({ now: new Date(2026, 10, 7) })).usedUsd, 35, 'a cli row invalidates the cache');
    } finally {
      Object.assign(config.claudePool, { monthlyUsd: null });
    }
  });

  await t('POST /api/telemetry: a usage row is recorded as a claude_session spend row', async () => {
    const meter = require('../src/dashboard/meter.ts');
    const sent = [];
    const send = (res, status, body) => sent.push([status, body]);
    const req = (headers) => ({ method: 'POST', headers });
    const url = new URL('http://127.0.0.1/api/telemetry');
    const body = {
      usage: [{ purpose: 'factory-dev', model: 'claude-opus-5', costUsd: 1.5, inputTokens: 1000, outputTokens: 50, durationMs: 9000, ok: true }, { purpose: 'factory-review', costUsd: null }],
      spans: [{ hop: 'factory.dev', name: 'handle_dev', startedAt: new Date().toISOString(), durationMs: 1200, ok: true }, { hop: '', durationMs: 1 }, { nope: true }],
    };
    assert.strictEqual(await meter.route(req({}), {}, url, { send, readJson: async () => body }), true);
    assert.strictEqual(sent[0][0], 403, 'X-PA is required');
    assert.strictEqual(store.rows.length, 0);
    assert.strictEqual(await meter.route(req({ 'x-pa': '1' }), {}, url, { send, readJson: async () => body }), true);
    assert.deepStrictEqual(sent[1], [200, { ok: true, spans: 1, usage: 2 }]);
    assert.deepStrictEqual(store.rows.map((r) => [r.purpose, r.backend, r.costUsd, r.model]), [
      ['factory-dev', 'claude_session', 1.5, 'claude-opus-5'],
      ['factory-review', 'claude_session', null, null],
    ]);
  });

  process.exit(failed ? 1 : 0);
})();
