'use strict';

// A run of statements on SQLite (src/db/sqlite.ts) lets the event loop in:
// better-sqlite3 is synchronous and each awaited query resumes as a microtask,
// so without a turn now and then a pass's loop of reads held off timers and
// requests (the deploy's health checks) until it finished. Skips without the
// optional driver.

const assert = require('assert');

const { available, createSqliteBackend } = require('../src/db/sqlite.ts');

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP sqliteYield: no SQLite driver');
  }
  const db = createSqliteBackend(':memory:');
  try {
    await db.exec('create table t (id integer primary key, v text)');
    await db.query(`insert into t (v) select 'x' from (with recursive n(i) as (select 1 union all select i + 1 from n where i < 20000) select i from n)`);
    const slow = 'select count(*) as n from t a join t b on b.id = a.id where a.v like $1';

    // Outside a transaction: a timer due now fires before the run is over.
    let fired = 0;
    setTimeout(() => (fired = performance.now()), 0);
    const start = performance.now();
    let last = start;
    while (last - start < 400) {
      await db.one(slow, ['%x%']);
      last = performance.now();
    }
    assert.ok(fired > 0 && fired < last, 'the timer ran between statements');
    assert.ok(fired - start < 250, `the timer waited ${Math.round(fired - start)} ms`);

    // Inside a transaction the statements run back to back (the write lock is held).
    let inTx = 0;
    await db.withTx(async (client) => {
      setTimeout(() => (inTx = performance.now()), 0);
      for (let i = 0; i < 5; i++) await client.query(slow, ['%x%']);
      assert.strictEqual(inTx, 0, 'no turn inside a transaction');
    });

    // Results are unchanged.
    assert.strictEqual((await db.one(slow, ['%x%'])).n, 20000);
    console.log('ok sqliteYield');
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
