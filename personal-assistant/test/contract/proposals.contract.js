'use strict';

// Contract: src/repo/proposals.js (see test/repoContract.test.js).

const P = (o = {}) => ({ kind: 'question', commitmentId: null, runId: null, title: 'When?', body: 'b', options: null, payload: {}, dedupeKey: null, expiresAt: null, ...o });

module.exports = {
  'insert: the row; a taken dedupe key is a no-op; options as JSON': async ({ repos, assert, uniq }) => {
    const key = uniq('prop');
    const row = await repos.proposals.insert(P({ dedupeKey: key, options: ['yes', 'no'], payload: { on: 'cadence' } }));
    assert.deepStrictEqual([row.kind, row.status, row.title, row.dedupe_key, row.payload], ['question', 'pending', 'When?', key, { on: 'cadence' }]);
    assert.deepStrictEqual(typeof row.options === 'string' ? JSON.parse(row.options) : row.options, ['yes', 'no']);
    assert.strictEqual(await repos.proposals.insert(P({ dedupeKey: key })), null);
  },

  'pending: unexpired pending ones, newest first, with the commitment summary': async ({ repos, seed, assert }) => {
    const c = await seed.commitment({ summary: 'the ask' });
    const a = await repos.proposals.insert(P({ commitmentId: c, title: 'older' }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await repos.proposals.insert(P({ title: 'newer' }));
    const gone = await repos.proposals.insert(P({ title: 'expired', expiresAt: new Date(Date.now() - 1000) }));
    const done = await repos.proposals.insert(P({ title: 'decided' }));
    await repos.proposals.decide(done.id, 'accepted', null);
    const list = await repos.proposals.pending({ limit: 1000 });
    const ids = list.map((p) => String(p.id));
    assert.ok(ids.indexOf(String(b.id)) >= 0 && ids.indexOf(String(b.id)) < ids.indexOf(String(a.id)));
    assert.ok(!ids.includes(String(gone.id)) && !ids.includes(String(done.id)));
    assert.strictEqual(list.find((p) => String(p.id) === String(a.id)).commitment_summary, 'the ask');
    assert.strictEqual((await repos.proposals.pending({ limit: 1 })).length, 1);
  },

  'payloadOf: the payload, or null': async ({ repos, assert }) => {
    const p = await repos.proposals.insert(P({ payload: { on: 'project', x: 1 } }));
    assert.deepStrictEqual((await repos.proposals.payloadOf(p.id)).payload, { on: 'project', x: 1 });
    assert.strictEqual(await repos.proposals.payloadOf(-1), null);
  },

  'statusOf: the status, or null': async ({ repos, assert }) => {
    const p = await repos.proposals.insert(P());
    assert.strictEqual((await repos.proposals.statusOf(p.id)).status, 'pending');
    assert.strictEqual(await repos.proposals.statusOf(-1), null);
  },

  'decide: only a pending one, once': async ({ repos, assert }) => {
    const p = await repos.proposals.insert(P());
    const d = await repos.proposals.decide(p.id, 'accepted', 'delivery=pr');
    assert.deepStrictEqual([d.status, d.answer], ['accepted', 'delivery=pr']);
    assert.ok(d.decided_at instanceof Date);
    assert.strictEqual(await repos.proposals.decide(p.id, 'rejected', null), null, 'already decided');
    assert.strictEqual(await repos.proposals.decide(-1, 'accepted', null), null);
  },

  'reopen: back to pending, undecided': async ({ repos, assert }) => {
    const p = await repos.proposals.insert(P());
    await repos.proposals.decide(p.id, 'accepted', null);
    await repos.proposals.reopen(p.id);
    assert.strictEqual((await repos.proposals.statusOf(p.id)).status, 'pending');
    assert.ok(await repos.proposals.decide(p.id, 'rejected', null), 'decidable again');
  },

  'expireDue: past expiry, and questions or offers about a closed ask': async ({ repos, seed, assert }) => {
    const open = await seed.commitment();
    const closed = await seed.commitment({ status: 'done' });
    const late = await repos.proposals.insert(P({ expiresAt: new Date(Date.now() - 1000), payload: { task: 'chase' } }));
    const onClosed = await repos.proposals.insert(P({ kind: 'dispatch', commitmentId: closed }));
    const landOnClosed = await repos.proposals.insert(P({ kind: 'land', commitmentId: closed }));
    const live = await repos.proposals.insert(P({ commitmentId: open }));
    const out = await repos.proposals.expireDue();
    const ids = out.map((p) => String(p.id));
    assert.ok(ids.includes(String(late.id)) && ids.includes(String(onClosed.id)));
    assert.ok(!ids.includes(String(landOnClosed.id)) && !ids.includes(String(live.id)));
    assert.deepStrictEqual(out.find((p) => String(p.id) === String(late.id)).payload, { task: 'chase' });
    assert.strictEqual((await repos.proposals.statusOf(late.id)).status, 'expired');
    assert.ok(!(await repos.proposals.expireDue()).some((p) => String(p.id) === String(late.id)), 'once');
  },
};
