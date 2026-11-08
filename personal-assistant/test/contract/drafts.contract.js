'use strict';

// Contract: src/repo/drafts.js (see test/repoContract.test.js).

const target = (o = {}) => ({ channel: 'email', label: 'ada@example.test', subject: 'Re: deck', ...o });
const D = (o = {}) => ({ commitmentId: null, runId: null, sourceItemId: null, target: target(), subject: 'Re: deck', body: 'Here it is.', origin: 'manual', ...o });

async function ensureMe(db, seed, email) {
  const cur = await db.one('select id from person where is_me');
  const id = cur ? Number(cur.id) : await seed.personWith({ name: 'Me', email, isMe: true });
  await db.query('update person set primary_email = $2 where id = $1', [id, email]);
  return id;
}

module.exports = {
  'myEmail: my primary email, or null without a me': async ({ repos, seed, db, assert }) => {
    await ensureMe(db, seed, 'me@example.test');
    assert.strictEqual((await repos.drafts.myEmail()).primary_email, 'me@example.test');
  },

  'threadBefore: earlier messages in the thread and source, newest first, limited': async ({ repos, seed, assert, uniq }) => {
    const thr = uniq('thr');
    const t0 = Date.now() - 3600_000;
    const a = await seed.item({ source: 'graph_mail', thread: thr, occurredAt: new Date(t0), body: 'first', raw: { fromName: 'Ada' } });
    const b = await seed.item({ source: 'graph_mail', thread: thr, occurredAt: new Date(t0 + 60_000), body: 'second' });
    await seed.item({ source: 'graph_chat', thread: thr, occurredAt: new Date(t0 + 30_000), body: 'other source' });
    const askId = await seed.item({ source: 'graph_mail', thread: thr, occurredAt: new Date(t0 + 120_000), body: 'the ask' });
    await seed.item({ source: 'graph_mail', thread: thr, occurredAt: new Date(t0 + 180_000), body: 'later' });
    const ask = await repos.drafts.sourceItem(askId);
    const got = await repos.drafts.threadBefore(ask, 8);
    assert.deepStrictEqual(got.map((m) => m.body_text), ['second', 'first']);
    assert.strictEqual(got[1].from_name, 'Ada');
    assert.strictEqual((await repos.drafts.threadBefore(ask, 1)).length, 1);
    assert.ok(a && b);
  },

  'askWithCounterparty: the commitment with who and who_email': async ({ repos, seed, assert }) => {
    const p = await seed.personWith({ name: 'Bo', email: 'bo@example.test' });
    const c = await seed.commitment();
    await seed.updateCommitment(c, { counterparty_person_id: p });
    const row = await repos.drafts.askWithCounterparty(c);
    assert.deepStrictEqual([Number(row.id), row.who, row.who_email], [c, 'Bo', 'bo@example.test']);
    assert.strictEqual(await repos.drafts.askWithCounterparty(-1), null);
  },

  'sourceItem: the row, or null': async ({ repos, seed, assert }) => {
    const id = await seed.item({ source: 'graph_mail', subject: 'S' });
    assert.strictEqual((await repos.drafts.sourceItem(id)).subject, 'S');
    assert.strictEqual(await repos.drafts.sourceItem(-1), null);
  },

  'commitment: the row, or null': async ({ repos, seed, assert }) => {
    const c = await seed.commitment({ summary: 'cs' });
    assert.strictEqual((await repos.drafts.commitment(c)).summary, 'cs');
    assert.strictEqual(await repos.drafts.commitment(-1), null);
  },

  'person: the row, or null': async ({ repos, seed, assert }) => {
    const p = await seed.personWith({ name: 'Cy' });
    assert.strictEqual((await repos.drafts.person(p)).display_name, 'Cy');
    assert.strictEqual(await repos.drafts.person(-1), null);
  },

  'siblingAsks: other open asks on me from the same message': async ({ repos, seed, db, assert }) => {
    const item = await seed.sourceItem();
    const a = await seed.commitment({ sourceItemId: item, summary: 'a' });
    await seed.commitment({ sourceItemId: item, summary: 'b' });
    const c = await seed.commitment({ sourceItemId: item, summary: 'c', status: 'done' });
    await seed.commitment({ sourceItemId: item, summary: 'd', direction: 'owed_to_me' });
    const got = await repos.drafts.siblingAsks(item, a);
    assert.deepStrictEqual(got.map((s) => s.summary), ['b']);
    assert.ok(c);
    assert.ok(db);
  },

  'insert: a pending draft with its target': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const d = await repos.drafts.insert(D({ commitmentId: c }));
    assert.deepStrictEqual([d.status, d.channel, d.to_identity, d.subject, d.body, d.origin, Number(d.commitment_id)], ['pending', 'email', 'ada@example.test', 'Re: deck', 'Here it is.', 'manual', c]);
    assert.deepStrictEqual(d.target, target());
  },

  'byId: the row, or null': async ({ repos, assert }) => {
    const d = await repos.drafts.insert(D());
    assert.strictEqual(String((await repos.drafts.byId(d.id)).id), String(d.id));
    assert.strictEqual(await repos.drafts.byId(-1), null);
  },

  'forRun: a run\'s drafts, newest first': async ({ repos, seed, assert }) => {
    const run = await seed.run();
    const a = await repos.drafts.insert(D({ runId: run, origin: 'run' }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await repos.drafts.insert(D({ runId: run, origin: 'run' }));
    assert.deepStrictEqual((await repos.drafts.forRun(run)).map((d) => String(d.id)), [String(b.id), String(a.id)]);
  },

  'open: pending and edited, newest first, at most 30': async ({ repos, assert }) => {
    const a = await repos.drafts.insert(D());
    const b = await repos.drafts.insert(D());
    await repos.drafts.edit(b.id, 'changed');
    const c = await repos.drafts.insert(D());
    await repos.drafts.discard(c.id);
    const ids = (await repos.drafts.open()).map((d) => String(d.id));
    assert.ok(ids.includes(String(b.id)) && !ids.includes(String(c.id)));
    assert.ok(ids.length <= 30);
    assert.ok(a);
  },

  'edit: body and edited, only while open': async ({ repos, assert }) => {
    const d = await repos.drafts.insert(D());
    const e = await repos.drafts.edit(d.id, 'new body');
    assert.deepStrictEqual([e.body, e.status], ['new body', 'edited']);
    await repos.drafts.markSent(d.id);
    assert.strictEqual(await repos.drafts.edit(d.id, 'too late'), null);
  },

  'discard: only while open': async ({ repos, assert }) => {
    const d = await repos.drafts.insert(D());
    assert.deepStrictEqual(Object.keys(await repos.drafts.discard(d.id)), ['id']);
    assert.strictEqual(await repos.drafts.discard(d.id), null);
  },

  'markSent: sent with a time, only while open': async ({ repos, assert }) => {
    const d = await repos.drafts.insert(D());
    const s = await repos.drafts.markSent(d.id);
    assert.strictEqual(s.status, 'sent');
    assert.ok(s.sent_at instanceof Date);
    assert.strictEqual(await repos.drafts.markSent(d.id), null);
  },

  'answeredOpen: open non-nudge drafts whose thread has my later reply': async ({ repos, seed, assert, uniq }) => {
    const me = [uniq('me@example.test')];
    const thr = uniq('thr');
    const t0 = Date.now() - 3600_000;
    const askItem = await seed.item({ source: 'graph_mail', thread: thr, occurredAt: new Date(t0) });
    await seed.item({ source: 'graph_mail', thread: thr, occurredAt: new Date(t0 + 60_000), author: me[0] });
    const quiet = await seed.item({ source: 'graph_mail', thread: uniq('thr'), occurredAt: new Date(t0) });
    const answered = await repos.drafts.insert(D({ sourceItemId: askItem, origin: 'auto' }));
    const nudge = await repos.drafts.insert(D({ sourceItemId: askItem, origin: 'nudge' }));
    const open = await repos.drafts.insert(D({ sourceItemId: quiet, origin: 'auto' }));
    const got = await repos.drafts.answeredOpen(me);
    const ids = got.map((d) => String(d.id));
    assert.ok(ids.includes(String(answered.id)) && !ids.includes(String(nudge.id)) && !ids.includes(String(open.id)));
    assert.ok(got.find((d) => String(d.id) === String(answered.id)).answered_at instanceof Date);
  },

  'discardWithReason: closes an open draft and says why': async ({ repos, assert }) => {
    const d = await repos.drafts.insert(D());
    await repos.drafts.discardWithReason(d.id, 'you already replied');
    const row = await repos.drafts.byId(d.id);
    assert.deepStrictEqual([row.status, row.closed_reason], ['discarded', 'you already replied']);
    assert.ok(row.closed_at instanceof Date);
  },

  'discardOwnAsks: open auto drafts on my own message': async ({ repos, seed, assert, uniq }) => {
    const me = uniq('me@example.test');
    const mine = await seed.item({ source: 'graph_mail', author: me });
    const theirs = await seed.item({ source: 'graph_mail', author: 'ada@example.test' });
    const a = await repos.drafts.insert(D({ sourceItemId: mine, origin: 'auto' }));
    const b = await repos.drafts.insert(D({ sourceItemId: mine, origin: 'manual' }));
    const c = await repos.drafts.insert(D({ sourceItemId: theirs, origin: 'auto' }));
    assert.strictEqual(await repos.drafts.discardOwnAsks([me]), 1);
    assert.deepStrictEqual([(await repos.drafts.byId(a.id)).status, (await repos.drafts.byId(b.id)).status, (await repos.drafts.byId(c.id)).status], ['discarded', 'pending', 'pending']);
  },

  'discardSettledNudges: nudges about a commitment no longer open': async ({ repos, seed, assert }) => {
    const settled = await seed.commitment({ direction: 'owed_to_me', status: 'done' });
    const open = await seed.commitment({ direction: 'owed_to_me' });
    const a = await repos.drafts.insert(D({ commitmentId: settled, origin: 'nudge' }));
    const b = await repos.drafts.insert(D({ commitmentId: open, origin: 'nudge' }));
    assert.ok((await repos.drafts.discardSettledNudges()) >= 1);
    assert.deepStrictEqual([(await repos.drafts.byId(a.id)).status, (await repos.drafts.byId(b.id)).status], ['discarded', 'pending']);
  },

  'autoCandidates: fresh, confident asks on me from mail or chat, never drafted, not answered': async ({ repos, seed, db, assert, uniq }) => {
    const me = uniq('me@example.test');
    const mk = async (o = {}) => {
      const item = await seed.item({ source: o.source || 'graph_mail', occurredAt: o.at || new Date(Date.now() - 3600_000), author: o.author || 'ada@example.test', thread: o.thread || null });
      const c = await seed.commitment({ sourceItemId: item, direction: o.direction || 'owed_by_me' });
      if (o.confidence != null) await db.query('update commitment set confidence = $2 where id = $1', [c, o.confidence]);
      return { c, item };
    };
    const good = await mk();
    const old = await mk({ at: new Date(Date.now() - 3 * 86400_000) });
    const fromMe = await mk({ author: me });
    const unsure = await mk({ confidence: 0.1 });
    const meeting = await mk({ source: 'graph_event', at: new Date(Date.now() - 3 * 3600_000) }); // outside calendar windows other cases read
    const drafted = await mk();
    await repos.drafts.insert(D({ commitmentId: drafted.c }));
    const thr = uniq('thr');
    const answered = await mk({ thread: thr });
    await seed.item({ source: 'graph_mail', thread: thr, author: me, occurredAt: new Date() });
    const ids = (await repos.drafts.autoCandidates([me], 0.6, 500)).map((r) => Number(r.id));
    assert.ok(ids.includes(good.c));
    for (const x of [old, fromMe, unsure, meeting, drafted, answered]) assert.ok(!ids.includes(x.c));
    assert.strictEqual((await repos.drafts.autoCandidates([me], 0.6, 1)).length, 1);
  },
  // --- for dashboard (chunk G)

  'pendingForBoard: pending and edited drafts newest first, with the ask they answer': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment({ summary: 'the board ask' });
    const c2 = await seed.commitment({ summary: 'an older ask' });
    const mk = async (commitment, status, createdAt) => Number((await db.one(`insert into draft (commitment_id, channel, to_identity, body, status, created_at) values ($1, 'email', 'a@x.test', 'b', $2, coalesce($3, now())) returning id`, [commitment, status, createdAt])).id);
    const old = await mk(c2, 'pending', new Date(Date.now() - 3600_000));
    const edited = await mk(c, 'edited', null);
    await mk(await seed.commitment(), 'sent', null);
    const got = (await repos.drafts.pendingForBoard()).filter((r) => [old, edited].includes(Number(r.id)));
    assert.deepStrictEqual(got.map((r) => Number(r.id)), [edited, old]);
    assert.strictEqual(got[0].ask, 'the board ask');
    assert.ok(['run_id', 'task', 'ask_url', 'ask_link', 'ask_text', 'origin', 'to_identity'].every((k) => k in got[0]));
    assert.ok((await repos.drafts.pendingForBoard()).length <= 30);
  },
};
