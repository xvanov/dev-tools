'use strict';

// Contract: src/repo/cardPlans.ts (see test/repoContract.test.js).

const plan = (title) => ({ title, rationale: 'because', sources: JSON.stringify(['https://example.test/a']), via: 'chat' });

module.exports = {
  'insertPlan: a pending plan': async ({ repos, assert }) => {
    const p = await repos.cardPlans.insertPlan(plan('first'));
    assert.deepStrictEqual([p.title, p.status, p.rationale, p.via], ['first', 'pending', 'because', 'chat']);
    assert.strictEqual(typeof p.created_at, 'string');
    assert.strictEqual(p.applied_at, null);
  },

  'planById: the row, or null': async ({ repos, assert }) => {
    const p = await repos.cardPlans.insertPlan(plan('by id'));
    assert.strictEqual((await repos.cardPlans.planById(p.id)).title, 'by id');
    assert.strictEqual(await repos.cardPlans.planById(999999), null);
  },

  'insertItem: an item in a plan, enabled and pending': async ({ repos, assert }) => {
    const p = await repos.cardPlans.insertPlan(plan('items'));
    const i = await repos.cardPlans.insertItem({ planId: p.id, idx: 0, op: 'edit', commitmentId: 5, fields: JSON.stringify({ title: 't' }), reason: 'why' });
    assert.deepStrictEqual([i.op, Number(i.commitment_id), i.status, Number(i.enabled), i.reason], ['edit', 5, 'pending', 1, 'why']);
    const off = await repos.cardPlans.insertItem({ planId: p.id, idx: 1, op: 'create', fields: '{}', enabled: false });
    assert.strictEqual(Number(off.enabled), 0);
  },

  'items: one plan, in order': async ({ repos, assert }) => {
    const p = await repos.cardPlans.insertPlan(plan('order'));
    await repos.cardPlans.insertItem({ planId: p.id, idx: 1, op: 'close', commitmentId: 2 });
    await repos.cardPlans.insertItem({ planId: p.id, idx: 0, op: 'create', fields: '{}' });
    assert.deepStrictEqual((await repos.cardPlans.items(p.id)).map((x) => x.op), ['create', 'close']);
  },

  'listPlans: newest first, status filter': async ({ repos, assert }) => {
    const a = await repos.cardPlans.insertPlan(plan('la'));
    const b = await repos.cardPlans.insertPlan(plan('lb'));
    await repos.cardPlans.setPlanStatus(a.id, 'applied');
    const all = await repos.cardPlans.listPlans({ limit: 10 });
    assert.deepStrictEqual(all.slice(0, 2).map((x) => x.id), [b.id, a.id]);
    assert.ok((await repos.cardPlans.listPlans({ status: 'applied' })).every((x) => x.status === 'applied'));
    assert.ok((await repos.cardPlans.listPlans({ status: 'pending' })).some((x) => x.id === b.id));
  },

  'countPlans: how many in a status': async ({ repos, assert }) => {
    const p = await repos.cardPlans.insertPlan(plan('count'));
    const n = await repos.cardPlans.countPlans('pending');
    assert.ok(n >= 1);
    await repos.cardPlans.setPlanStatus(p.id, 'discarded');
    assert.strictEqual(await repos.cardPlans.countPlans('pending'), n - 1);
  },

  'setPlanStatus: sets it, stamps an apply, refuses an unknown status': async ({ repos, assert }) => {
    const p = await repos.cardPlans.insertPlan(plan('status'));
    assert.strictEqual(await repos.cardPlans.setPlanStatus(p.id, 'applied', '2026-11-10T12:00:00.000Z'), 1);
    const u = await repos.cardPlans.planById(p.id);
    assert.deepStrictEqual([u.status, u.applied_at], ['applied', '2026-11-10T12:00:00.000Z']);
    await repos.cardPlans.setPlanStatus(p.id, 'partly');
    assert.strictEqual((await repos.cardPlans.planById(p.id)).applied_at, '2026-11-10T12:00:00.000Z', 'a later status keeps the stamp');
    assert.strictEqual(await repos.cardPlans.setPlanStatus(999999, 'applied'), 0);
    await assert.rejects(() => repos.cardPlans.setPlanStatus(p.id, 'bogus'), /plan status must be/);
  },

  'updateItem: sets named columns, refuses an unknown one': async ({ repos, assert }) => {
    const p = await repos.cardPlans.insertPlan(plan('upd'));
    const i = await repos.cardPlans.insertItem({ planId: p.id, idx: 0, op: 'close', commitmentId: 3 });
    await repos.cardPlans.updateItem(i.id, { status: 'failed', error: 'boom', enabled: 0 });
    const [u] = await repos.cardPlans.items(p.id);
    assert.deepStrictEqual([u.status, u.error, Number(u.enabled)], ['failed', 'boom', 0]);
    await assert.rejects(() => repos.cardPlans.updateItem(i.id, { op: 'edit' }), /no settable column/);
    await assert.rejects(() => repos.cardPlans.updateItem(i.id, {}), /no settable column/);
  },

  'claimItem: only a pending item, once': async ({ repos, assert }) => {
    const p = await repos.cardPlans.insertPlan(plan('claim'));
    const i = await repos.cardPlans.insertItem({ planId: p.id, idx: 0, op: 'close', commitmentId: 3 });
    assert.strictEqual(await repos.cardPlans.claimItem(i.id), 1);
    assert.strictEqual(await repos.cardPlans.claimItem(i.id), 0);
    assert.strictEqual((await repos.cardPlans.items(p.id))[0].status, 'running');
  },
};
