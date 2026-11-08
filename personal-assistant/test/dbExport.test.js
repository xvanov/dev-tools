'use strict';

// `pa db export --to sqlite` (plan 3.3, src/db/export.js): a throwaway
// Postgres (as the repository contract makes one) with rows of every kind
// that needs converting is copied into a new SQLite file; counts match,
// vectors come back value for value, JSON, arrays, booleans and timestamps
// read back as they went in, the FTS index is filled, ids continue, the event
// counter continues, and the copy itself wrote no events. Skips without a
// reachable Postgres (CI's contract job has one) or the SQLite driver.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const { available } = require('../src/db/sqlite');
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP dbExport: no SQLite driver');
  }
  const b = await require('./contract/_backends').postgres();
  if (b.skip) return console.log(`SKIP dbExport: ${b.skip}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-export-'));
  try {
    const { db, seed } = b;
    const item = await seed.sourceItem({ subject: 'export me', body: 'the quarterly report is late' });
    const vec = Array.from({ length: 1536 }, (_, i) => Math.sin(i) / 3);
    const chunk = await seed.memChunk(item, { content: 'the quarterly report is late', embedding: `[${vec.join(',')}]` });
    const c = await seed.commitment({ sourceItemId: item, summary: 'send the report' });
    await db.query(`update commitment set plan = $2::jsonb where id = $1`, [c, JSON.stringify({ steps: ['a', 'b'], n: 2 })]);
    const n = await db.one(`insert into notification (kind, title, delivery, channel_sent, toasted_at) values ('info', 'hello', 'push', array['toast','chat'], '2026-11-01T10:00:00.123Z') returning id`);
    await db.query(`insert into llm_spend (purpose, backend, ok, cost_usd) values ('export-test', 'api', false, 0.125)`);
    const seqBefore = Number((await db.one('select last_value from pa_event_seq')).last_value);

    const { exportToSqlite } = require('../src/db/export');
    const file = path.join(dir, 'pa_test_export.sqlite');
    const url = db.pool.options.connectionString;
    const r = await exportToSqlite({ pgUrl: url, file, key: 'export-test-key' });
    assert.ok(r.ok, `export not ok: ${JSON.stringify({ bad: r.tables.filter((t) => !t.ok), vectors: r.vectors, missing: r.missing, fk: r.fk, fts: r.fts })}`);
    await assert.rejects(exportToSqlite({ pgUrl: url, file }), /exists/, 'never over an existing file');

    const { createSqliteBackend } = require('../src/db/sqlite');
    const lite = createSqliteBackend(file, { key: 'export-test-key' });
    try {
      const ch = await lite.one('select embedding from chunk where id = $1', [chunk]);
      assert.deepStrictEqual(Array.from(ch.embedding), Array.from(Float32Array.from(vec)), 'the vector, float32 for float32');
      assert.ok(await lite.one(`select rowid from chunk_fts where chunk_fts match 'quarterly' and rowid = $1`, [chunk]), 'FTS filled');
      assert.deepStrictEqual((await lite.one('select plan from commitment where id = $1', [c])).plan, { steps: ['a', 'b'], n: 2 });
      const nn = await lite.one('select channel_sent, toasted_at from notification where id = $1', [n.id]);
      assert.deepStrictEqual(nn.channel_sent, ['toast', 'chat']);
      assert.strictEqual(nn.toasted_at.toISOString(), '2026-11-01T10:00:00.123Z');
      const sp = await lite.one(`select ok, cost_usd from llm_spend where purpose = 'export-test'`);
      assert.deepStrictEqual([sp.ok, sp.cost_usd], [false, 0.125]);
      const next = await lite.one(`insert into notification (kind, title) values ('info', 'after') returning id`);
      assert.ok(Number(next.id) > Number(n.id), 'ids continue after the copied ones');
      const seq = Number((await lite.one('select last_value from pa_event_seq')).last_value);
      assert.ok(seq >= seqBefore + 1, 'the event counter continues past the copy (and past this insert)');
      assert.strictEqual(Number((await lite.one('select count(*) as n from event_outbox where seq > $1', [seqBefore])).n), Number((await db.one('select count(*) as n from event_outbox where seq > $1', [seqBefore])).n) + 1, 'the copy wrote no events of its own; the insert after it did');
    } finally {
      await lite.close();
    }
    console.log('dbExport: ok');
  } finally {
    await b.teardown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
