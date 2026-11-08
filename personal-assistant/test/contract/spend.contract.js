'use strict';

// Contract: src/repo/spend.js (see test/repoContract.test.js). Each case
// uses its own purpose names, so the shared database does not matter.

const call = (purpose, o = {}) => ({ purpose, model: 'm', backend: 'api', costUsd: 0.5, inputTokens: 10, outputTokens: 5, durationMs: 100, ok: true, ...o });

module.exports = {
  'record: one row per call; nulls where unknown': async ({ repos, assert, uniq }) => {
    const p = uniq('rec');
    await repos.spend.record(call(p));
    await repos.spend.record(call(p, { model: null, costUsd: null, inputTokens: null, outputTokens: null, durationMs: null, ok: false }));
    const [row] = (await repos.spend.byPurposeSince(new Date(Date.now() - 60_000))).filter((r) => r.purpose === p);
    assert.deepStrictEqual([row.usd, row.calls], [0.5, 2]);
  },

  'totalSince: dollars at or after a time; 0 when none': async ({ repos, assert }) => {
    const future = new Date(Date.now() + 3600_000);
    assert.strictEqual(await repos.spend.totalSince(future), 0);
    const start = new Date(Date.now() - 1000);
    const before = await repos.spend.totalSince(start);
    await repos.spend.record(call('total-a', { costUsd: 1.25 }));
    await repos.spend.record(call('total-b', { costUsd: null }));
    const after = await repos.spend.totalSince(start);
    assert.ok(Math.abs(after - before - 1.25) < 1e-9, `${after} - ${before}`);
    assert.strictEqual(typeof after, 'number');
  },

  'byPurposeSince: most expensive first, then most calls': async ({ repos, assert, uniq }) => {
    const [a, b, c] = [uniq('a'), uniq('b'), uniq('c')];
    const start = new Date(Date.now() - 1000);
    await repos.spend.record(call(a, { costUsd: 0.1 }));
    await repos.spend.record(call(b, { costUsd: 2 }));
    await repos.spend.record(call(c, { costUsd: 0.1 }));
    await repos.spend.record(call(c, { costUsd: 0 }));
    const list = (await repos.spend.byPurposeSince(start)).filter((r) => [a, b, c].includes(r.purpose));
    assert.deepStrictEqual(list.map((r) => r.purpose), [b, c, a]);
    assert.deepStrictEqual(list.map((r) => r.calls), [1, 2, 1]);
  },

  'dailyByPurpose: per local day and purpose, with failed and unknown counts': async ({ repos, seed, db, assert, uniq }) => {
    const p = uniq('day');
    await repos.spend.record(call(p, { costUsd: 1 }));
    await repos.spend.record(call(p, { costUsd: null, ok: false }));
    // One the day before, at noon UTC (the same calendar day in UTC whatever the offset below).
    await repos.spend.record(call(p, { costUsd: 3 }));
    const last = await db.one('select max(id) as id from llm_spend where purpose = $1', [p]);
    const yesterday = new Date(Date.now() - 86400_000);
    yesterday.setUTCHours(12, 0, 0, 0);
    await seed.backdate('llm_spend', 'at', last.id, yesterday);
    const rows = (await repos.spend.dailyByPurpose(new Date(Date.now() - 3 * 86400_000), 'UTC')).filter((r) => r.purpose === p);
    const day = (d) => d.toISOString().slice(0, 10);
    const today = rows.find((r) => r.day === day(new Date()));
    const before = rows.find((r) => r.day === day(yesterday));
    assert.deepStrictEqual([today.usd, today.calls, today.failed, today.unknown], [1, 2, 1, 1]);
    assert.deepStrictEqual([before.usd, before.calls, before.failed, before.unknown], [3, 1, 0, 0]);
  },
};
