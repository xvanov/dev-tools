'use strict';

// The daily model budget (src/budget.js) and the cost bookkeeping in
// src/llm.js: which purposes a cap may refuse, what a call is recorded as,
// and that recording can never fail the call it records. No database: the
// store is stubbed, so this never touches a live one.

const assert = require('assert');
const path = require('path');

// A fake store, installed before src/budget.js first asks for one.
const fake = { inserts: [], spent: 0, fail: false };
const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'db'));
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    async query(sql, params) {
      if (fake.fail) throw new Error('connect ECONNREFUSED 127.0.0.1:5433');
      fake.inserts.push({ sql, params });
      return { rowCount: 1 };
    },
    async one() {
      if (fake.fail) throw new Error('connect ECONNREFUSED 127.0.0.1:5433');
      return { usd: fake.spent };
    },
    async rows() {
      return [];
    },
  },
};

const budget = require('../src/budget');
const { cliUsage, apiUsage, priceOf } = require('../src/llm');

const ESSENTIAL = ['distill', 'reconcile', 'connector', 'reply-close'];
const DISCRETIONARY = ['eager', 'research', 'digest', 'planner'];
const d = (o) => budget.decide({ essential: ESSENTIAL, discretionary: DISCRETIONARY, ...o });

{
  // Under the cap everything runs.
  assert.strictEqual(d({ spent: 3, cap: 15, purpose: 'eager' }), true);
  assert.strictEqual(d({ spent: 3, cap: 15, purpose: 'distill' }), true);
  // At or over it, discretionary work stops…
  assert.strictEqual(d({ spent: 15, cap: 15, purpose: 'eager' }), false);
  assert.strictEqual(d({ spent: 40, cap: 15, purpose: 'research' }), false);
  assert.strictEqual(d({ spent: 40, cap: 15, purpose: 'eager-draft' }), false, 'a dash prefix is the same purpose');
  // …essential work never does, whatever the spend.
  for (const p of ESSENTIAL) assert.strictEqual(d({ spent: 1e6, cap: 15, purpose: p }), true, p);
  // Purposes in neither list predate the cap and are not gated by it.
  assert.strictEqual(d({ spent: 1e6, cap: 15, purpose: 'draft' }), true);
  assert.strictEqual(d({ spent: 1e6, cap: 15, purpose: 'memory-extract' }), true);
  // A prefix match is by whole dash-separated word, not by substring.
  assert.strictEqual(d({ spent: 1e6, cap: 15, purpose: 'eagerly' }), true);
}

{
  // The caller's estimate counts: a large job is refused before it overshoots.
  assert.strictEqual(d({ spent: 14, cap: 15, purpose: 'research', estimateUsd: 0.5 }), true);
  assert.strictEqual(d({ spent: 14, cap: 15, purpose: 'research', estimateUsd: 2 }), false);
  // A negative estimate cannot buy headroom.
  assert.strictEqual(d({ spent: 15, cap: 15, purpose: 'research', estimateUsd: -5 }), false);
  // `essential` may be given as a plain answer for this purpose.
  assert.strictEqual(budget.decide({ spent: 99, cap: 1, purpose: 'eager', essential: true, discretionary: DISCRETIONARY }), true);
  // A cap of zero stops all discretionary work; no cap stops none.
  assert.strictEqual(d({ spent: 0, cap: 0, purpose: 'planner' }), false);
  assert.strictEqual(d({ spent: 99, cap: null, purpose: 'planner' }), true);
  // Unknown spend (the store is down) is treated as over the cap.
  assert.strictEqual(d({ spent: Infinity, cap: 15, purpose: 'digest' }), false);
}

{
  // "Today" starts at local midnight.
  const s = budget.dayStart(new Date(2026, 9, 25, 1, 30));
  assert.strictEqual(s.getHours(), 0);
  assert.strictEqual(s.getDate(), 25);
}

{
  // Per-day rows fold into days, newest first, purposes by cost.
  const days = budget.summarise([
    { day: '2026-10-24', purpose: 'distill', usd: '1.50', calls: 10, failed: 1, unknown: 0 },
    { day: '2026-10-25', purpose: 'reconcile', usd: 0.4, calls: 4, failed: 0, unknown: 0 },
    { day: '2026-10-25', purpose: 'distill', usd: 2, calls: 20, failed: 0, unknown: 2 },
  ]);
  assert.deepStrictEqual(days.map((x) => x.day), ['2026-10-25', '2026-10-24']);
  assert.strictEqual(days[0].usd, 2.4);
  assert.strictEqual(days[0].calls, 24);
  assert.strictEqual(days[0].unknown, 2);
  assert.deepStrictEqual(days[0].purposes.map((p) => p.purpose), ['distill', 'reconcile']);
  assert.strictEqual(days[1].failed, 1);
  assert.strictEqual(budget.usd(2.4), '$2.40');
  assert.strictEqual(budget.usd(15), '$15');
}

{
  // `claude -p --output-format json`: one object with cost and usage.
  const json = JSON.stringify({
    subtype: 'success',
    result: 'secret body text',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 },
  });
  assert.deepStrictEqual(cliUsage(json), { costUsd: 0.0123, inputTokens: 1110, outputTokens: 50 });
  // stream-json: the final `result` event carries it.
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the "result" is coming' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.5, usage: { input_tokens: 7, output_tokens: 3 } }),
    '',
  ].join('\n');
  assert.deepStrictEqual(cliUsage(stream), { costUsd: 0.5, inputTokens: 7, outputTokens: 3 });
  // Unparseable output is nulls, not a throw.
  assert.deepStrictEqual(cliUsage('boom'), { costUsd: null, inputTokens: null, outputTokens: null });
  assert.deepStrictEqual(cliUsage(JSON.stringify({ subtype: 'success' })), { costUsd: null, inputTokens: null, outputTokens: null });
}

{
  // The API backend reports tokens, not cost: estimate it from list prices.
  assert.deepStrictEqual(priceOf('claude-sonnet-5-5'), [2, 10]);
  assert.deepStrictEqual(priceOf('claude-sonnet-9-9'), [2, 10], 'an unknown sonnet is priced as its family');
  assert.strictEqual(priceOf('some-other-model'), null);
  const u = apiUsage('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 });
  assert.strictEqual(u.costUsd, 3);
  assert.strictEqual(u.inputTokens, 1_000_000);
  const cached = apiUsage('claude-opus-5-5', { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 });
  assert.ok(Math.abs(cached.costUsd - 0.4) < 1e-9, `cache reads at a tenth of input: ${cached.costUsd}`);
  // An unknown model is recorded with a null cost, never a guess.
  assert.strictEqual(apiUsage('some-other-model', { input_tokens: 5, output_tokens: 5 }).costUsd, null);
  assert.strictEqual(apiUsage('claude-sonnet-5-5', null).costUsd, null);
}

(async () => {
  // A recorded row holds the purpose and numbers, nothing else.
  await budget.record({ purpose: 'distill', model: 'claude-sonnet-5-5', backend: 'cli', costUsd: 0.01, inputTokens: 10, outputTokens: 5, durationMs: 1234.4, ok: true });
  const row = fake.inserts.pop();
  assert.match(row.sql, /insert into llm_spend/);
  assert.deepStrictEqual(row.params, ['distill', 'claude-sonnet-5-5', 'cli', 0.01, 10, 5, 1234, true]);
  // Missing numbers are nulls; a missing purpose is 'unknown'.
  await budget.record({ backend: 'api', ok: false });
  assert.deepStrictEqual(fake.inserts.pop().params, ['unknown', null, 'api', null, null, null, null, false]);

  // A store that is down costs the row, never the caller.
  fake.fail = true;
  await budget.record({ purpose: 'distill', backend: 'cli', ok: true });

  // allow(): essential and ungated purposes never ask the store…
  assert.strictEqual(await budget.allow('reconcile'), true);
  assert.strictEqual(await budget.allow('draft'), true);
  // …and discretionary work is refused when spend cannot be known.
  assert.strictEqual(await budget.allow('eager'), false);
  fake.fail = false;

  // With the store up, the cap decides (default cap: PA_DAILY_BUDGET_USD).
  const { config } = require('../src/config');
  fake.spent = config.budget.dailyUsd + 1;
  assert.strictEqual(await budget.allow('research'), false);
  assert.strictEqual(await budget.allow('distill'), true);

  console.log('budget ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
