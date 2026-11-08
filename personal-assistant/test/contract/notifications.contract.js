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

  'unreadPushes: unread pushes in the window, newest first, at most limit': async ({ repos, seed, assert }) => {
    const ins = (title, delivery = 'push') => repos.notifications.insert({ kind: 'info', title, body: 'b', url: null, dedupeKey: null, priority: 'normal', delivery });
    const old = await ins('old push');
    await seed.backdate('notification', 'created_at', old.id, new Date(Date.now() - 49 * 3600_000));
    const read = await ins('read push');
    await repos.notifications.markRead(read.id);
    const feedOnly = await ins('feed only', 'feed');
    const a = await ins('push a');
    await new Promise((r) => setTimeout(r, 5));
    const b = await ins('push b');
    const ids = (await repos.notifications.unreadPushes(48, 500)).map((n) => String(n.id));
    assert.ok(ids.indexOf(String(b.id)) >= 0 && ids.indexOf(String(b.id)) < ids.indexOf(String(a.id)), 'newest first');
    for (const x of [old, read, feedOnly]) assert.ok(!ids.includes(String(x.id)), x.title);
    assert.strictEqual((await repos.notifications.unreadPushes(48, 1)).length, 1);
  },

  'lastDigest: the newest slot': async ({ repos, assert }) => {
    await repos.notifications.insertDigest('2099-01-01 08:00', 'early', { closed: [], proposals: [], waiting: [], held: [] });
    await repos.notifications.insertDigest('2099-01-01 17:00', 'late', { closed: [], proposals: [], waiting: [], held: [] });
    const last = await repos.notifications.lastDigest();
    assert.strictEqual(last.slot, '2099-01-01 17:00');
    assert.ok(last.created_at instanceof Date);
  },

  'insertDigest: once per slot; items kept': async ({ repos, assert, uniq }) => {
    const slot = uniq('slot');
    const row = await repos.notifications.insertDigest(slot, 'body', { closed: [1], proposals: [], waiting: [2], held: [] });
    assert.deepStrictEqual([row.slot, row.body, row.items], [slot, 'body', { closed: [1], proposals: [], waiting: [2], held: [] }]);
    assert.strictEqual(await repos.notifications.insertDigest(slot, 'again', {}), null, 'another process wrote this slot');
  },

  'heldForDigest: digest-delivery rows not yet in a digest, oldest first': async ({ repos, assert }) => {
    const ins = (title) => repos.notifications.insert({ kind: 'info', title, body: '', url: null, dedupeKey: null, priority: 'digest', delivery: 'digest' });
    const a = await ins('held a');
    await new Promise((r) => setTimeout(r, 5));
    const b = await ins('held b');
    const ids = (await repos.notifications.heldForDigest()).map((n) => String(n.id));
    assert.ok(ids.indexOf(String(a.id)) >= 0 && ids.indexOf(String(a.id)) < ids.indexOf(String(b.id)));
  },

  'attachToDigest: held rows leave the queue, once': async ({ repos, assert, uniq }) => {
    const n = await repos.notifications.insert({ kind: 'info', title: 'h', body: '', url: null, dedupeKey: null, priority: 'digest', delivery: 'digest' });
    const d1 = await repos.notifications.insertDigest(uniq('s'), '', {});
    const d2 = await repos.notifications.insertDigest(uniq('s'), '', {});
    await repos.notifications.attachToDigest(d1.id, [n.id]);
    await repos.notifications.attachToDigest(d2.id, [n.id]);
    assert.ok(!(await repos.notifications.heldForDigest()).some((x) => String(x.id) === String(n.id)));
    const row = (await repos.notifications.feed({ limit: 1000 })).find((x) => String(x.id) === String(n.id));
    assert.strictEqual(String(row.digest_id), String(d1.id), 'the first digest keeps it');
  },

  'closedForYouSince: closed by the assistant, not by you, not undone, newest first': async ({ repos, seed, assert }) => {
    const since = new Date(Date.now() - 1000);
    const c = await seed.commitment({ summary: 'closed for you' });
    const mine = await seed.transition(c, { actor: 'you' });
    const undone = await seed.transition(c, { actor: 'reconcile', undoneAt: new Date() });
    const reopened = await seed.transition(c, { actor: 'reconcile', to: 'open' });
    const a = await seed.transition(c, { actor: 'reconcile', reason: 'merged', to: 'done' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await seed.transition(c, { actor: 'policy', to: 'dropped' });
    const list = (await repos.notifications.closedForYouSince(since)).filter((t) => Number(t.commitment_id) === c);
    assert.deepStrictEqual(list.map((t) => Number(t.id)), [b, a]);
    assert.deepStrictEqual([list[1].summary, list[1].actor, list[1].reason, list[1].to_status], ['closed for you', 'reconcile', 'merged', 'done']);
    for (const x of [mine, undone, reopened]) assert.ok(!list.some((t) => Number(t.id) === x));
  },

  'waitingOnOthers: open asks owed to you, overdue or older than the window': async ({ repos, seed, assert }) => {
    const now = new Date();
    const who = await seed.person('Bo Example');
    const overdue = await seed.commitment({ direction: 'owed_to_me', summary: 'overdue' });
    await seed.updateCommitment(overdue, { due_at: new Date(now - 86400_000), counterparty_person_id: who });
    const stale = await seed.commitment({ direction: 'owed_to_me', summary: 'stale' });
    await seed.updateCommitment(stale, { extracted_at: new Date(now - 10 * 86400_000) });
    const fresh = await seed.commitment({ direction: 'owed_to_me', summary: 'fresh' });
    const mine = await seed.commitment({ direction: 'owed_by_me', summary: 'mine' });
    await seed.updateCommitment(mine, { due_at: new Date(now - 86400_000) });
    const closed = await seed.commitment({ direction: 'owed_to_me', summary: 'closed', status: 'done' });
    await seed.updateCommitment(closed, { due_at: new Date(now - 86400_000) });
    const list = await repos.notifications.waitingOnOthers(now, 7);
    const ids = list.map((w) => Number(w.id));
    assert.ok(ids.includes(overdue) && ids.includes(stale));
    for (const x of [fresh, mine, closed]) assert.ok(!ids.includes(x));
    assert.strictEqual(list.find((w) => Number(w.id) === overdue).who, 'Bo Example');
    assert.ok(ids.indexOf(stale) < ids.indexOf(overdue), 'by due date, else age: the stale one is older');
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
