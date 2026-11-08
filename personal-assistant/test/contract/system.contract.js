'use strict';

// Contract: src/repo/system.js (see test/repoContract.test.js).

module.exports = {
  'installedExtensions: the ones present, of those asked': async ({ repos, assert }) => {
    const got = await repos.system.installedExtensions(['vector', 'pg_trgm', 'no_such_extension']);
    assert.deepStrictEqual(got.sort(), ['pg_trgm', 'vector']);
  },

  'serverMajor: a whole major version': async ({ repos, assert }) => {
    const v = await repos.system.serverMajor();
    assert.ok(Number.isInteger(v) && v >= 13, String(v));
  },

  // --- for src/cli, src/chat/fastLane.js, src/dashboard (chunk G)

  'ping: the store answers': async ({ repos, assert }) => {
    assert.strictEqual(Number((await repos.system.ping()).ok), 1);
  },

  'appliedMigrations: versions, oldest first': async ({ repos, assert }) => {
    const got = await repos.system.appliedMigrations();
    assert.ok(got.length > 5);
    const v = got.map((r) => r.version);
    assert.deepStrictEqual(v, [...v].sort());
  },

  'replaceInstallId: leaves exactly one install id': async ({ repos, db, assert, uniq }) => {
    const id = '00000000-0000-4000-8000-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
    await repos.system.replaceInstallId(id);
    assert.deepStrictEqual((await db.rows('select id::text as id from pa_install')).map((r) => r.id), [id]);
    const again = '00000000-0000-4000-8000-' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
    await repos.system.replaceInstallId(again);
    assert.deepStrictEqual((await db.rows('select id::text as id from pa_install')).map((r) => r.id), [again]);
    assert.ok(uniq);
  },

  'pendingCounts: reply drafts waiting and memory items to review': async ({ repos, seed, db, assert }) => {
    const before = await repos.system.pendingCounts();
    await db.query(`insert into draft (channel, to_identity, body, status) values ('email', 'a@x.test', 'b', 'pending')`);
    await seed.claim({ status: 'pending_review' });
    const after = await repos.system.pendingCounts();
    assert.deepStrictEqual([after.drafts, after.review], [before.drafts + 1, before.review + 1]);
  },

  'waitingCounts: drafts, memory items to review and live runs': async ({ repos, seed, assert }) => {
    const before = await repos.system.waitingCounts();
    await seed.run({ status: 'running' });
    await seed.run({ status: 'done' });
    const after = await repos.system.waitingCounts();
    assert.deepStrictEqual([after.runs, after.drafts, after.review], [before.runs + 1, before.drafts, before.review]);
  },

  'counts: items, open commitments, live runs, pending drafts, failed distillations': async ({ repos, seed, assert }) => {
    const before = await repos.system.counts();
    await seed.commitment();
    await seed.run({ status: 'waiting' });
    const after = await repos.system.counts();
    assert.strictEqual(Number(after.items), Number(before.items) + 1);
    assert.strictEqual(Number(after.open_commitments), Number(before.open_commitments) + 1);
    assert.strictEqual(Number(after.live_runs), Number(before.live_runs) + 1);
    for (const k of ['pending_drafts', 'failed_items']) assert.ok(Number(after[k]) >= 0);
  },

  'attention: pushes since a time, notifications held for the digest, the last digest': async ({ repos, assert }) => {
    const start = new Date(Date.now() - 60_000);
    const before = await repos.system.attention(start);
    await repos.notifications.insert({ kind: 'info', title: 'p', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'push' });
    await repos.notifications.insert({ kind: 'digest', title: 'd', body: '', url: null, dedupeKey: null, priority: 'digest', delivery: 'push' });
    await repos.notifications.insert({ kind: 'info', title: 'h', body: '', url: null, dedupeKey: null, priority: 'digest', delivery: 'digest' });
    const after = await repos.system.attention(start);
    assert.deepStrictEqual([after.pushed, after.held], [before.pushed + 1, before.held + 1]);
    assert.ok(after.last_digest === null || after.last_digest instanceof Date);
  },
};
