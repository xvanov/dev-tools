'use strict';

// The ledger's pure half (src/ledger/core.js): what a status change writes,
// what it must leave alone, and when an undo may put it back.

const assert = require('assert');
const L = require('../src/ledger/core');

const now = new Date('2026-10-25T10:00:00Z');
const open = { status: 'open', closed_at: null, closed_reason: null, touched_at: null };

{
  // The assistant closing: status, when and why — and `before` holds exactly what it overwrote.
  const p = L.plan(open, { to: 'done', actor: 'reconciler', reason: 'PR merged', now });
  assert.deepStrictEqual(p.set, { status: 'done', closed_at: now.toISOString(), closed_reason: 'PR merged' });
  assert.deepStrictEqual(p.before, { status: 'open', closed_at: null, closed_reason: null });
}

{
  // A person's change marks it touched; the assistant's does not.
  const p = L.plan(open, { to: 'done', actor: 'you', reason: 'you marked it done', now });
  assert.strictEqual(p.set.touched_at, now.toISOString());
  assert.ok('touched_at' in p.before);
  assert.ok(!('touched_at' in L.plan(open, { to: 'done', actor: 'github', reason: 'x', now }).set));
}

{
  // Reopening clears the close.
  const closed = { status: 'done', closed_at: '2026-10-24T09:00:00Z', closed_reason: 'PR merged', touched_at: null };
  const p = L.plan(closed, { to: 'open', actor: 'you', now });
  assert.strictEqual(p.set.closed_at, null);
  assert.strictEqual(p.set.closed_reason, null);
  assert.strictEqual(p.before.closed_reason, 'PR merged');
}

{
  // No-ops and guards.
  assert.ok(L.plan(null, { to: 'done', actor: 'you' }).skip);
  assert.ok(L.plan(open, { to: 'open', actor: 'you' }).skip);
  assert.ok(L.plan(open, { to: 'finished', actor: 'you' }).skip);
  const dispatched = { ...open, status: 'dispatched' };
  // `from` restricts which states a closer may act on: a run owns a dispatched commitment.
  assert.match(L.plan(dispatched, { to: 'done', actor: 'github', reason: 'x', from: ['open'] }).skip, /already dispatched/);
  // Closed twice for the same reason is nothing; for a new reason it is recorded.
  const done = { status: 'done', closed_at: now.toISOString(), closed_reason: 'PR merged' };
  assert.ok(L.plan(done, { to: 'done', actor: 'github', reason: 'PR merged' }).skip);
  assert.ok(L.plan(done, { to: 'done', actor: 'you', reason: 'you marked it done' }).set);
}

{
  // An undo may only put back what it finds untouched.
  const p = L.plan(open, { to: 'done', actor: 'reconciler', reason: 'answered', now });
  assert.strictEqual(L.changedSince({ ...p.set, closed_at: new Date(p.set.closed_at) }, p.set), false);
  assert.strictEqual(L.changedSince({ ...p.set, status: 'open' }, p.set), true);
  assert.strictEqual(L.changedSince({ ...p.set, closed_reason: 'you marked it done' }, p.set), true);
  assert.strictEqual(L.changedSince(null, p.set), true);
}

console.log('ledger: ok');
