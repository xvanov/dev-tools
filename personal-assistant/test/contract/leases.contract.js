'use strict';

// Contract: src/repo/leases.js (see test/repoContract.test.js). Locks belong
// to a connection: two connections stand in for two worker generations.

async function two(db, fn) {
  const { createRepos, clientBackend } = require('../../src/repo');
  const a = await db.pool.connect();
  const b = await db.pool.connect();
  try {
    return await fn(createRepos(clientBackend(a)).leases, createRepos(clientBackend(b)).leases);
  } finally {
    a.release(true); // drop the connections: their locks go with them
    b.release(true);
  }
}

const KEY = 917300; // not the worker's 7300: a contract run beside a live worker must not take its lease

module.exports = {
  'tryLock: one holder at a time; the holder may take it again': ({ db, assert }) => two(db, async (a, b) => {
    assert.strictEqual(await a.tryLock(KEY), true);
    assert.strictEqual(await b.tryLock(KEY), false, 'held by the other generation');
    assert.strictEqual(await a.tryLock(KEY), true, 're-entrant for its holder');
    await a.unlock(KEY);
    await a.unlock(KEY);
  }),

  'unlock: hands the lock over': ({ db, assert }) => two(db, async (a, b) => {
    assert.strictEqual(await a.tryLock(KEY + 1), true);
    await a.unlock(KEY + 1);
    assert.strictEqual(await b.tryLock(KEY + 1), true);
    await b.unlock(KEY + 1);
  }),

  'tryPassLock: per pass name, apart from the one-key locks': ({ db, assert }) => two(db, async (a, b) => {
    assert.strictEqual(await a.tryPassLock(917301, 'factory'), true);
    assert.strictEqual(await b.tryPassLock(917301, 'factory'), false, 'that pass is running elsewhere');
    assert.strictEqual(await b.tryPassLock(917301, 'ingest'), true, 'another pass is free');
    assert.strictEqual(await b.tryLock(917301), true, 'the one-key space does not overlap');
    await b.unlock(917301);
    await b.passUnlock(917301, 'ingest');
    await a.passUnlock(917301, 'factory');
  }),

  'passUnlock: the pass can run elsewhere': ({ db, assert }) => two(db, async (a, b) => {
    assert.strictEqual(await a.tryPassLock(917301, 'memory'), true);
    await a.passUnlock(917301, 'memory');
    assert.strictEqual(await b.tryPassLock(917301, 'memory'), true);
    await b.passUnlock(917301, 'memory');
  }),

  'tryLock: a dead connection frees its locks': async ({ db, assert }) => {
    const { createRepos, clientBackend } = require('../../src/repo');
    const a = await db.pool.connect();
    assert.strictEqual(await createRepos(clientBackend(a)).leases.tryLock(KEY + 2), true);
    a.release(true);
    await two(db, async (b) => {
      let got = false;
      for (let i = 0; i < 50 && !got; i++) {
        got = await b.tryLock(KEY + 2);
        if (!got) await new Promise((r) => setTimeout(r, 20));
      }
      assert.strictEqual(got, true);
      await b.unlock(KEY + 2);
    });
  },
};
