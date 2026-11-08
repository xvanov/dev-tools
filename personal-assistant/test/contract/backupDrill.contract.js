'use strict';

// Contract: src/repo/backupDrill.js (see test/repoContract.test.js). Creating a
// database needs CREATEDB, which the contract backend's role has (it makes its
// own pa_test_* database); the names here stay inside pa_test_*.

const crypto = require('crypto');

const isSqlite = (repos) => repos.backend.dialect === 'sqlite';
const name = () => `pa_test_drill_${crypto.randomBytes(4).toString('hex')}`;

module.exports = {
  'tableCounts: exact counts for every public table': async ({ repos, db, assert }) => {
    await db.query('create table drill_counts_probe (n int)');
    try {
      let c = await repos.backupDrill.tableCounts();
      assert.strictEqual(c.drill_counts_probe, 0);
      await db.query('insert into drill_counts_probe values (1), (2), (3)');
      c = await repos.backupDrill.tableCounts();
      assert.strictEqual(c.drill_counts_probe, 3);
      assert.ok(Object.values(c).every((n) => Number.isInteger(n) && n >= 0));
    } finally {
      await db.query('drop table drill_counts_probe');
    }
  },

  'createDatabase: creates it once; refuses a bad name': async ({ repos, assert }) => {
    if (isSqlite(repos)) return assert.rejects(() => repos.backupDrill.createDatabase('x'), /not applicable/);
    const n = name();
    await assert.rejects(() => repos.backupDrill.createDatabase('Bad-Name; drop'), /not a safe database name/);
    await repos.backupDrill.createDatabase(n);
    const m = name();
    await repos.backupDrill.createDatabase(m, { template: 'template1' });
    await repos.backupDrill.dropDatabase(m);
    try {
      assert.strictEqual(await repos.backupDrill.databaseExists(n), true);
      await assert.rejects(() => repos.backupDrill.createDatabase(n));
    } finally {
      await repos.backupDrill.dropDatabase(n);
    }
  },

  'dropDatabase: removes it; absent is not an error': async ({ repos, assert }) => {
    const n = name();
    if (isSqlite(repos)) return repos.backupDrill.dropDatabase(n);
    await repos.backupDrill.createDatabase(n);
    await repos.backupDrill.dropDatabase(n);
    assert.strictEqual(await repos.backupDrill.databaseExists(n), false);
    await repos.backupDrill.dropDatabase(n);
  },

  'databaseExists: true for the connected database, false for a random name': async ({ repos, assert }) => {
    assert.strictEqual(await repos.backupDrill.databaseExists(name()), false);
    if (isSqlite(repos)) return;
    const r = await repos.backupDrill.databaseExists('postgres');
    assert.strictEqual(typeof r, 'boolean');
  },

  'ensureExtensions: idempotent': async ({ repos }) => {
    await repos.backupDrill.ensureExtensions();
    await repos.backupDrill.ensureExtensions();
  },
};
