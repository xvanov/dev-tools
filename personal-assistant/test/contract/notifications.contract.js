'use strict';

// Contract: src/repo/notifications.js (see test/repoContract.test.js).

module.exports = {
  'insert: returns the row; a taken dedupe key is a no-op (null)': async ({ repos, assert, uniq }) => {
    const key = uniq('dedupe');
    const row = await repos.notifications.insert({ kind: 'info', title: 'T', body: 'B', url: null, dedupeKey: key, priority: 'normal', delivery: 'feed' });
    assert.ok(row && row.id, 'inserted');
    assert.deepStrictEqual([row.kind, row.title, row.body, row.dedupe_key, row.priority, row.delivery, row.read_at], ['info', 'T', 'B', key, 'normal', 'feed', null]);
    assert.strictEqual(await repos.notifications.insert({ kind: 'info', title: 'again', body: '', url: null, dedupeKey: key, priority: 'normal', delivery: 'feed' }), null);
    const free = await repos.notifications.insert({ kind: 'info', title: 'no key', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    const free2 = await repos.notifications.insert({ kind: 'info', title: 'no key', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    assert.ok(free && free2 && free.id !== free2.id, 'no key never dedupes');
  },

  'exists: by dedupe key': async ({ repos, assert, uniq }) => {
    const key = uniq('exists');
    assert.strictEqual(await repos.notifications.exists(key), false);
    await repos.notifications.insert({ kind: 'info', title: 'T', body: '', url: null, dedupeKey: key, priority: 'normal', delivery: 'feed' });
    assert.strictEqual(await repos.notifications.exists(key), true);
  },

  'markSent: channels, and toasted_at only when toasted': async ({ repos, assert }) => {
    const a = await repos.notifications.insert({ kind: 'info', title: 'A', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'push' });
    await repos.notifications.markSent(a.id, ['toast', 'chat'], true);
    const b = await repos.notifications.insert({ kind: 'info', title: 'B', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'push' });
    await repos.notifications.markSent(b.id, ['chat'], false);
    const feed = await repos.notifications.feed({ limit: 50 });
    const ra = feed.find((r) => String(r.id) === String(a.id));
    const rb = feed.find((r) => String(r.id) === String(b.id));
    assert.deepStrictEqual(ra.channel_sent, ['toast', 'chat']);
    assert.ok(ra.toasted_at instanceof Date);
    assert.deepStrictEqual(rb.channel_sent, ['chat']);
    assert.strictEqual(rb.toasted_at, null);
  },

  'pushedSince: pushes after a time, the digest itself not counted': async ({ repos, assert }) => {
    const start = new Date(Date.now() + 60_000); // nothing yet
    assert.strictEqual(await repos.notifications.pushedSince(start), 0);
    const before = await repos.notifications.pushedSince(new Date(0));
    await repos.notifications.insert({ kind: 'info', title: 'p', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'push' });
    await repos.notifications.insert({ kind: 'digest', title: 'd', body: '', url: null, dedupeKey: null, priority: 'digest', delivery: 'push' });
    await repos.notifications.insert({ kind: 'info', title: 'f', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    assert.strictEqual(await repos.notifications.pushedSince(new Date(0)), before + 1);
  },

  'feed: newest first, limit, unread only': async ({ repos, assert }) => {
    const x = await repos.notifications.insert({ kind: 'info', title: 'older', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    await new Promise((r) => setTimeout(r, 5));
    const y = await repos.notifications.insert({ kind: 'info', title: 'newer', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    const top = await repos.notifications.feed({ limit: 2 });
    assert.strictEqual(top.length, 2);
    assert.strictEqual(String(top[0].id), String(y.id));
    await repos.notifications.markRead(y.id);
    const unread = await repos.notifications.feed({ limit: 500, unreadOnly: true });
    assert.ok(!unread.some((r) => String(r.id) === String(y.id)) && unread.some((r) => String(r.id) === String(x.id)));
  },

  'markRead: stamps read_at once, keeps the first time': async ({ repos, assert }) => {
    const n = await repos.notifications.insert({ kind: 'info', title: 'r', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    await repos.notifications.markRead(n.id);
    const first = (await repos.notifications.feed({ limit: 500 })).find((r) => String(r.id) === String(n.id)).read_at;
    await new Promise((r) => setTimeout(r, 5));
    await repos.notifications.markRead(n.id);
    const second = (await repos.notifications.feed({ limit: 500 })).find((r) => String(r.id) === String(n.id)).read_at;
    assert.ok(first instanceof Date);
    assert.strictEqual(second.getTime(), first.getTime());
  },

  'lockById: the row inside a transaction, null when missing': async ({ repos, assert }) => {
    const n = await repos.notifications.insert({ kind: 'info', title: 'l', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    const got = await repos.withTx((r) => r.notifications.lockById(n.id));
    assert.strictEqual(got.title, 'l');
    assert.strictEqual(await repos.withTx((r) => r.notifications.lockById(-1)), null);
  },

  'setFeedback: up, down, cleared': async ({ repos, assert }) => {
    const n = await repos.notifications.insert({ kind: 'info', title: 'f', body: '', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    const read = async () => (await repos.notifications.feed({ limit: 500 })).find((r) => String(r.id) === String(n.id));
    await repos.notifications.setFeedback(n.id, 'up');
    let r = await read();
    assert.strictEqual(r.feedback, 'up');
    assert.ok(r.feedback_at instanceof Date);
    await repos.notifications.setFeedback(n.id, null);
    r = await read();
    assert.strictEqual(r.feedback, null);
  },

  'weight: null for a kind with none': async ({ repos, assert, uniq }) => {
    assert.strictEqual(await repos.notifications.weight(uniq('kind')), null);
  },

  'setWeight: inserts then updates; weight and lockWeight read it': async ({ repos, assert, uniq }) => {
    const k = uniq('kind');
    await repos.notifications.setWeight(k, 0.5);
    assert.strictEqual(await repos.notifications.weight(k), 0.5);
    await repos.notifications.setWeight(k, 1.25);
    assert.strictEqual(await repos.notifications.weight(k), 1.25);
    assert.strictEqual(await repos.withTx((r) => r.notifications.lockWeight(k)), 1.25);
  },

  'lockWeight: null for a kind with none': async ({ repos, assert, uniq }) => {
    assert.strictEqual(await repos.withTx((r) => r.notifications.lockWeight(uniq('kind'))), null);
  },

  'weights: every kind, lowest weight first': async ({ repos, assert, uniq }) => {
    const lo = uniq('lo');
    const hi = uniq('hi');
    await repos.notifications.setWeight(hi, 9);
    await repos.notifications.setWeight(lo, 0.01);
    const all = await repos.notifications.weights();
    const i = all.findIndex((w) => w.kind === lo);
    const j = all.findIndex((w) => w.kind === hi);
    assert.ok(i >= 0 && j > i, 'ordered by weight');
    assert.ok(all[i].updated_at instanceof Date);
  },

  'withTx: a throw rolls every write back': async ({ repos, assert, uniq }) => {
    const k = uniq('tx');
    await assert.rejects(repos.withTx(async (r) => {
      await r.notifications.setWeight(k, 3);
      throw new Error('boom');
    }), /boom/);
    assert.strictEqual(await repos.notifications.weight(k), null);
  },
};
