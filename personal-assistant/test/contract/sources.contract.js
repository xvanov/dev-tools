'use strict';

// Contract: src/repo/sources.js (see test/repoContract.test.js).

module.exports = {
  'deleteOldMessages: mail and chat older than the window; nothing else': async ({ repos, seed, db, assert }) => {
    const old = new Date(Date.now() - 40 * 86400_000);
    const mail = await seed.sourceItem({ source: 'graph_mail', occurredAt: old });
    const chat = await seed.sourceItem({ source: 'graph_chat', occurredAt: old });
    const meeting = await seed.sourceItem({ source: 'graph_event', occurredAt: old });
    const fresh = await seed.sourceItem({ source: 'graph_mail' });
    const n = await repos.sources.deleteOldMessages(30);
    assert.ok(n >= 2);
    const left = (await db.rows('select id from source_item where id = any($1::bigint[])', [[mail, chat, meeting, fresh]])).map((r) => Number(r.id)).sort();
    assert.deepStrictEqual(left, [meeting, fresh].sort());
    assert.strictEqual(await repos.sources.deleteOldMessages(30), 0, 'nothing left to delete');
  },
};
