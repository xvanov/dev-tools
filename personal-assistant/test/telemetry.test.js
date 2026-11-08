'use strict';

// OpenTelemetry into Meter (plan 7.5): the instrument (src/telemetry), the local
// exporter that turns finished spans into trace_span rows, and the maths behind
// the Meter page (p50/p95 per hop, spend per day/model/purpose). The provider is
// installed with an in-memory recorder: no database, no collector.

const assert = require('assert');
const path = require('path');

const recorded = { spans: [] };
const repoPath = require.resolve(path.join(__dirname, '..', 'src', 'repo'));
require.cache[repoPath] = {
  id: repoPath,
  filename: repoPath,
  loaded: true,
  exports: { telemetry: { recordSpans: async (rows) => (recorded.spans.push(...rows), rows.length) } },
};

const telemetry = require('../src/telemetry');
const { LocalSpanExporter, toRow } = require('../src/telemetry/exporter.ts');
const meter = require('../src/telemetry/meter.ts');

let failed = 0;
async function t(name, fn) {
  try {
    recorded.spans = [];
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n${err.stack}`);
  }
}

(async () => {
  await t('percentile: nearest rank; null when empty', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.deepStrictEqual([meter.percentile(v, 50), meter.percentile(v, 95), meter.percentile(v, 100)], [50, 95, 100]);
    assert.strictEqual(meter.percentile([7], 95), 7);
    assert.strictEqual(meter.percentile([], 50), null);
  });

  await t('summariseHops: p50/p95/failed per hop, slowest p95 first', () => {
    const rows = [];
    for (let i = 1; i <= 20; i++) rows.push({ hop: 'voice.turn', durationMs: i * 100, ok: i !== 3 });
    rows.push({ hop: 'tool.call', durationMs: 40, ok: true }, { hop: 'tool.call', durationMs: 60, ok: true });
    const out = meter.summariseHops(rows);
    assert.deepStrictEqual(out.map((h) => h.hop), ['voice.turn', 'tool.call']);
    assert.deepStrictEqual(out[0], { hop: 'voice.turn', calls: 20, failed: 1, p50: 1000, p95: 1900, max: 2000 });
    assert.deepStrictEqual([out[1].p50, out[1].p95, out[1].calls], [40, 60, 2]);
    assert.deepStrictEqual(meter.summariseHops([]), []);
  });

  await t('summariseSpend: per day, model and purpose; null model is unknown; priciest first', () => {
    const s = meter.summariseSpend([
      { day: '2026-11-06', model: 'a', purpose: 'distill', usd: 1, calls: 2 },
      { day: '2026-11-07', model: 'a', purpose: 'draft', usd: 0.5, calls: 1 },
      { day: '2026-11-07', model: null, purpose: 'distill', usd: 0, calls: 3 },
      { day: '2026-11-07', model: 'b', purpose: 'distill', usd: 4, calls: 1 },
    ]);
    assert.deepStrictEqual(s.days.map((d) => [d.day, d.usd, d.calls]), [['2026-11-07', 4.5, 5], ['2026-11-06', 1, 2]]);
    assert.deepStrictEqual(s.models.map((m) => [m.model, m.usd]), [['b', 4], ['a', 1.5], ['unknown', 0]]);
    assert.deepStrictEqual(s.purposes.map((p) => [p.purpose, p.usd, p.calls]), [['distill', 5, 6], ['draft', 0.5, 1]]);
    assert.strictEqual(s.totalUsd, 5.5);
  });

  await t('off in a test process: span just runs the function with no span', async () => {
    assert.strictEqual(telemetry.installed(), null);
    assert.strictEqual(await telemetry.span('tool.call', 'x', {}, async (s) => (assert.strictEqual(s, null), 42)), 42);
    assert.strictEqual(telemetry.span('x', 'y', () => 7), 7, 'attrs may be left out; sync works');
    assert.strictEqual(telemetry.installed(), null, 'never installed by itself here');
  });

  await t('span: a finished hop becomes a trace_span row with hop, name, duration and scalar attrs', async () => {
    telemetry.install({ exporter: new LocalSpanExporter(), simple: true });
    try {
      const out = await telemetry.span('tool.call', 'board', { tool: 'board', n: 3, skip: { nested: true } }, async (s) => {
        s.setAttribute('extra', 'yes');
        await new Promise((r) => setTimeout(r, 15));
        return 'done';
      });
      assert.strictEqual(out, 'done');
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(recorded.spans.length, 1);
      const [row] = recorded.spans;
      assert.deepStrictEqual([row.hop, row.name, row.ok, row.source], ['tool.call', 'board', true, 'pa']);
      assert.ok(row.durationMs >= 10 && row.durationMs < 1000, `${row.durationMs}`);
      assert.deepStrictEqual(row.attrs, { tool: 'board', n: 3, extra: 'yes' });
      assert.ok(row.startedAt instanceof Date);
      assert.match(row.traceId, /^[0-9a-f]{32}$/);
      assert.strictEqual(row.parentSpanId, null);
    } finally {
      await telemetry.reset();
    }
  });

  await t('span: a nested span is a child in the same trace; an error is ok:false and rethrown', async () => {
    telemetry.install({ exporter: new LocalSpanExporter(), simple: true });
    try {
      await assert.rejects(
        telemetry.span('voice.turn', 'outer', {}, () => telemetry.span('tool.call', 'inner', {}, async () => { throw new Error('boom'); })),
        /boom/
      );
      await new Promise((r) => setImmediate(r));
      const by = Object.fromEntries(recorded.spans.map((s) => [s.name, s]));
      assert.strictEqual(by.inner.parentSpanId, by.outer.spanId);
      assert.strictEqual(by.inner.traceId, by.outer.traceId);
      assert.deepStrictEqual([by.inner.ok, by.outer.ok], [false, false]);
      telemetry.span('x', 'sync-throw', {}, () => {});
      assert.throws(() => telemetry.span('x', 'sync-throw2', {}, () => { throw new Error('sync'); }), /sync/);
    } finally {
      await telemetry.reset();
    }
  });

  await t('exporter: a store that fails is reported to onError and never thrown into the caller', async () => {
    const errors = [];
    const exp = new LocalSpanExporter({ record: async () => { throw new Error('relation "trace_span" does not exist'); }, onError: (e) => errors.push(e.message) });
    telemetry.install({ exporter: exp, simple: true });
    try {
      assert.strictEqual(await telemetry.span('deploy', 'deploy', {}, async () => 'ok'), 'ok');
      await new Promise((r) => setTimeout(r, 10));
      assert.deepStrictEqual(errors, ['relation "trace_span" does not exist']);
    } finally {
      await telemetry.reset();
    }
  });

  await t('toRow: long strings are cut, non-scalars dropped, the hop attribute becomes hop', () => {
    const row = toRow({
      name: 'n',
      attributes: { 'pa.hop': 'factory.dev', 'pa.source': 'factory', long: 'x'.repeat(500), obj: { a: 1 }, flag: true },
      spanContext: () => ({ traceId: 't'.repeat(32), spanId: 's'.repeat(16) }),
      startTime: [1000, 500_000_000],
      duration: [2, 250_000_000],
      status: { code: 2 },
    });
    assert.deepStrictEqual([row.hop, row.source, row.ok, row.durationMs], ['factory.dev', 'factory', false, 2250]);
    assert.strictEqual(row.attrs.long.length, 200);
    assert.deepStrictEqual(Object.keys(row.attrs).sort(), ['flag', 'long']);
    assert.strictEqual(row.startedAt.getTime(), 1_000_500);
  });

  await t('ingest: keeps well-formed factory spans, drops malformed ones, bounds attributes', async () => {
    const n = await telemetry.ingest([
      { hop: 'factory.dev', name: 'handle_dev', startedAt: '2026-11-07T10:00:00Z', durationMs: 5000, ok: false, attrs: { story: 12, big: 'y'.repeat(300), obj: {} } },
      { hop: 'deploy', startedAt: 'not a date', durationMs: 1 },
      { hop: 'deploy', startedAt: '2026-11-07T10:00:00Z', durationMs: 'slow' },
      null,
    ]);
    assert.strictEqual(n, 1);
    const [row] = recorded.spans;
    assert.deepStrictEqual([row.hop, row.source, row.ok, row.durationMs, row.traceId.length], ['factory.dev', 'factory', false, 5000, 32]);
    assert.strictEqual(row.attrs.big.length, 200);
    assert.strictEqual(row.attrs.story, 12);
    assert.ok(!('obj' in row.attrs));
    assert.strictEqual(await telemetry.ingest('nope'), 0);
  });

  process.exit(failed ? 1 : 0);
})();
