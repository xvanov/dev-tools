'use strict';

// Contract: src/repo/telemetry.js (see test/repoContract.test.js). Each case
// uses its own hop names, so the shared database does not matter.

let n = 0;
const span = (hop, o = {}) => ({
  traceId: 'a'.repeat(32),
  spanId: (++n).toString(16).padStart(16, '0'),
  parentSpanId: null,
  hop,
  name: `${hop}.x`,
  source: 'pa',
  startedAt: new Date(),
  durationMs: 100,
  ok: true,
  attrs: { tool: 'board' },
  ...o,
});

module.exports = {
  'recordSpans: writes every span in one call; nothing to write is 0': async ({ repos, assert, uniq }) => {
    const hop = uniq('rec');
    assert.strictEqual(await repos.telemetry.recordSpans([]), 0);
    assert.strictEqual(await repos.telemetry.recordSpans([span(hop), span(hop, { ok: false, attrs: null, parentSpanId: 'b'.repeat(16), source: 'factory' })]), 2);
    const rows = (await repos.telemetry.hopDurations(new Date(Date.now() - 60_000))).filter((r) => r.hop === hop);
    assert.deepStrictEqual(rows.map((r) => r.ok).sort(), [false, true]);
  },

  'hopDurations: spans at or after a time, as numbers; the limit caps the window': async ({ repos, assert, uniq }) => {
    const hop = uniq('dur');
    const old = new Date(Date.now() - 3 * 86400_000);
    await repos.telemetry.recordSpans([span(hop, { durationMs: 10 }), span(hop, { durationMs: 30 }), span(hop, { durationMs: 999, startedAt: old })]);
    const recent = (await repos.telemetry.hopDurations(new Date(Date.now() - 86400_000))).filter((r) => r.hop === hop);
    assert.deepStrictEqual(recent.map((r) => r.durationMs).sort((a, b) => a - b), [10, 30]);
    assert.strictEqual(typeof recent[0].durationMs, 'number');
    const all = (await repos.telemetry.hopDurations(new Date(Date.now() - 7 * 86400_000))).filter((r) => r.hop === hop);
    assert.strictEqual(all.length, 3);
    assert.strictEqual((await repos.telemetry.hopDurations(new Date(Date.now() - 7 * 86400_000), 1)).length, 1);
  },

  'pruneSpans: deletes spans that started before the cutoff and says how many': async ({ repos, assert, uniq }) => {
    const hop = uniq('prune');
    const old = new Date(Date.now() - 40 * 86400_000);
    await repos.telemetry.recordSpans([span(hop, { startedAt: old }), span(hop, { startedAt: old }), span(hop)]);
    const deleted = await repos.telemetry.pruneSpans(new Date(Date.now() - 30 * 86400_000));
    assert.ok(deleted >= 2, `deleted ${deleted}`);
    const left = (await repos.telemetry.hopDurations(new Date(Date.now() - 60 * 86400_000))).filter((r) => r.hop === hop);
    assert.strictEqual(left.length, 1);
  },
};
