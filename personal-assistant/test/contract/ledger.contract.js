'use strict';

// Contract: src/repo/ledger.js (see test/repoContract.test.js).

const T = (o) => ({ from: 'open', to: 'done', actor: 'reconcile', reason: 'merged', evidenceId: null, before: { status: 'open', closed_at: null, closed_reason: null }, at: new Date().toISOString(), ...o });

module.exports = {
  'lockCommitment: its status columns inside a transaction; null when missing': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const row = await repos.withTx((r) => r.ledger.lockCommitment(c));
    assert.deepStrictEqual([Number(row.id), row.status, row.closed_at, row.closed_reason], [c, 'open', null, null]);
    assert.ok('touched_at' in row);
    assert.strictEqual(await repos.withTx((r) => r.ledger.lockCommitment(-1)), null);
  },

  'setCommitment: writes the status columns, refuses any other': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const at = new Date('2026-11-01T10:00:00Z');
    await repos.ledger.setCommitment(c, { status: 'done', closed_at: at, closed_reason: 'shipped', touched_at: at });
    const row = await repos.withTx((r) => r.ledger.lockCommitment(c));
    assert.deepStrictEqual([row.status, row.closed_at.toISOString(), row.closed_reason], ['done', at.toISOString(), 'shipped']);
    await assert.rejects(repos.ledger.setCommitment(c, { summary: 'x' }), /does not write commitment.summary/);
  },

  'insertTransition: returns the id; before kept as json': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const id = await repos.ledger.insertTransition(T({ commitmentId: c }));
    assert.ok(Number.isInteger(id) && id > 0);
    const row = await repos.withTx((r) => r.ledger.lockTransition(id));
    assert.deepStrictEqual([Number(row.commitment_id), row.from_status, row.to_status, row.actor, row.reason, row.undone_at], [c, 'open', 'done', 'reconcile', 'merged', null]);
    assert.deepStrictEqual(row.before, { status: 'open', closed_at: null, closed_reason: null });
  },

  'lockTransition: null when missing': async ({ repos, assert }) => {
    assert.strictEqual(await repos.withTx((r) => r.ledger.lockTransition(-1)), null);
  },

  'markUndone: stamps undone_at and the result': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const id = await repos.ledger.insertTransition(T({ commitmentId: c }));
    await repos.ledger.markUndone(id, 'changed since; left as it is');
    const row = await repos.withTx((r) => r.ledger.lockTransition(id));
    assert.ok(row.undone_at instanceof Date);
    assert.strictEqual(row.undo, 'changed since; left as it is');
  },

  'latest: the newest change not undone; null when none': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    assert.strictEqual(await repos.ledger.latest(c), null);
    const a = await repos.ledger.insertTransition(T({ commitmentId: c, at: '2026-11-01T10:00:00Z' }));
    const b = await repos.ledger.insertTransition(T({ commitmentId: c, from: 'done', to: 'open', at: '2026-11-02T10:00:00Z' }));
    assert.strictEqual(Number((await repos.ledger.latest(c)).id), b);
    await repos.ledger.markUndone(b, 'undone');
    assert.strictEqual(Number((await repos.ledger.latest(c)).id), a);
  },

  'history: every change newest first, with its evidence': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const item = await seed.sourceItem();
    const ev = await seed.evidence(c, { sourceItemId: item, quote: 'done, merged', confidence: 0.9 });
    const a = await repos.ledger.insertTransition(T({ commitmentId: c, at: '2026-11-01T10:00:00Z', evidenceId: ev }));
    const b = await repos.ledger.insertTransition(T({ commitmentId: c, from: 'done', to: 'open', actor: 'you', at: '2026-11-02T10:00:00Z' }));
    const h = await repos.ledger.history(c);
    assert.deepStrictEqual(h.map((t) => Number(t.id)), [b, a]);
    assert.deepStrictEqual([h[1].quote, Number(h[1].source_item_id), Number(h[1].confidence)], ['done, merged', item, 0.9]);
    assert.strictEqual(h[0].quote, null);
  },
};
