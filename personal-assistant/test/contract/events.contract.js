'use strict';

// Contract: src/repo/events.js (see test/repoContract.test.js). The outbox is
// written by the triggers (sql/034-036), so these cases make changes through
// another aggregate (notifications: topic board) and read what they left.

const note = (repos, title = 'evt') => repos.notifications.insert({ kind: 'info', title, body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });

module.exports = {
  'head: moves with every event; a written event is at or under it': async ({ repos, assert }) => {
    const before = BigInt(await repos.events.head());
    await note(repos);
    const after = BigInt(await repos.events.head());
    assert.ok(after > before, `${after} > ${before}`);
  },

  'after: what a change wrote, in order, with its payload, topic filter and limit': async ({ repos, assert }) => {
    const from = await repos.events.head();
    const a = await note(repos, 'one');
    const b = await note(repos, 'two');
    const { events, more } = await repos.events.after(from);
    assert.strictEqual(more, false);
    const mine = events.filter((e) => e.payload.table === 'notification' && [String(a.id), String(b.id)].includes(String(e.payload.id)));
    assert.strictEqual(mine.length, 2);
    assert.ok(BigInt(mine[0].seq) < BigInt(mine[1].seq), 'oldest first');
    assert.strictEqual(String(mine[0].payload.id), String(a.id));
    assert.deepStrictEqual([mine[0].topic, mine[0].payload.op, String(mine[0].payload.seq)], ['board', 'insert', mine[0].seq]);
    assert.ok(!('topic' in mine[0].payload), 'the topic is a column, not in the payload');
    assert.ok(mine[0].at instanceof Date);
    assert.deepStrictEqual((await repos.events.after(from, { topics: ['run'] })).events.filter((e) => e.payload.table === 'notification'), [], 'topic filter');
    const one = await repos.events.after(from, { limit: 1 });
    assert.deepStrictEqual([one.events.length, one.more], [1, true]);
    assert.deepStrictEqual(await repos.events.after(await repos.events.head()), { events: [], more: false });
  },

  'after: a rolled-back change leaves no event': async ({ repos, assert, uniq }) => {
    const from = await repos.events.head();
    const title = uniq('rolled');
    await assert.rejects(repos.withTx(async (r) => {
      await r.notifications.insert({ kind: 'info', title, body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
      throw new Error('boom');
    }), /boom/);
    const later = await note(repos, 'kept');
    const { events } = await repos.events.after(from);
    assert.deepStrictEqual(events.filter((e) => e.payload.table === 'notification').map((e) => String(e.payload.id)), [String(later.id)]);
  },

  'oldest: the lowest seq kept, at or under every event after it': async ({ repos, assert }) => {
    await note(repos);
    const oldest = await repos.events.oldest();
    assert.ok(oldest != null);
    const { events } = await repos.events.after(BigInt(oldest) - 1n);
    assert.strictEqual(events[0].seq, oldest);
  },

  'listen: the NOTIFY carries the same seq as the outbox row': async ({ db, repos, assert }) => {
    const { createRepos, clientBackend } = require('../../src/repo');
    const client = await db.pool.connect();
    try {
      const got = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no notification within 5 s')), 5000);
        client.on('notification', (n) => {
          const body = JSON.parse(n.payload);
          if (body.table === 'notification') {
            clearTimeout(t);
            resolve({ channel: n.channel, body });
          }
        });
      });
      await createRepos(clientBackend(client)).events.listen('pa_events');
      await assert.rejects(createRepos(clientBackend(client)).events.listen('pa_events; drop table x'), /bad channel/);
      const from = await repos.events.head();
      const n = await note(repos, 'listened');
      const { channel, body } = await got;
      assert.strictEqual(channel, 'pa_events');
      assert.strictEqual(String(body.id), String(n.id));
      const row = (await repos.events.after(from)).events.find((e) => String(e.payload.id) === String(n.id) && e.payload.table === 'notification');
      assert.strictEqual(String(body.seq), row.seq);
      assert.strictEqual(body.topic, row.topic);
    } finally {
      await client.query('unlisten *').catch(() => {});
      client.release();
    }
  },
};
