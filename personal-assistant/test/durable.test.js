'use strict';

// Durable tasks' pure parts (src/durable/tasks/chaseCore.js): when a chase
// looks again, and which commitments are worth chasing.

const assert = require('assert');
const C = require('../src/durable/tasks/chaseCore');

const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

{
  // Working mornings: evenings roll to the next day, weekends to Monday, at 09:00.
  assert.deepStrictEqual(C.workingMorning(local(2026, 10, 21, 18)), local(2026, 10, 22, 9)); // Wed evening → Thu
  assert.deepStrictEqual(C.workingMorning(local(2026, 10, 23, 18)), local(2026, 10, 26, 9)); // Fri evening → Mon
  assert.deepStrictEqual(C.workingMorning(local(2026, 10, 24, 11)), local(2026, 10, 26, 9)); // Sat → Mon
  assert.deepStrictEqual(C.workingMorning(local(2026, 10, 22, 7)), local(2026, 10, 22, 9)); // early → 09:00
  assert.deepStrictEqual(C.workingMorning(local(2026, 10, 22, 14, 30)), local(2026, 10, 22, 14, 30)); // working hours: as is
}

{
  const now = local(2026, 10, 20, 10);
  // Two days after the promise, on a working morning.
  assert.deepStrictEqual(C.firstChaseAt({ asked_at: local(2026, 10, 19, 10) }, now), local(2026, 10, 21, 10));
  // Due date set: a couple of hours after it.
  assert.deepStrictEqual(C.firstChaseAt({ asked_at: local(2026, 10, 19, 10), due_at: local(2026, 10, 20, 12) }, now), local(2026, 10, 20, 14));
  // Never in the past.
  assert.ok(C.firstChaseAt({ asked_at: local(2026, 10, 1, 10) }, now) >= now);
  assert.strictEqual(C.secondsUntil(local(2026, 10, 20, 9), now), 1);
}

{
  const now = local(2026, 10, 20, 10);
  const base = { status: 'open', direction: 'owed_to_me', counterparty_person_id: 7, source: 'graph_chat', asked_at: local(2026, 10, 18, 10) };
  assert.strictEqual(C.worthChasing(base, now), true);
  assert.strictEqual(C.worthChasing({ ...base, direction: 'owed_by_me' }, now), false);
  assert.strictEqual(C.worthChasing({ ...base, status: 'done' }, now), false);
  assert.strictEqual(C.worthChasing({ ...base, source: 'github_pr' }, now), false); // no thread to chase in
  assert.strictEqual(C.worthChasing({ ...base, counterparty_is_me: true }, now), false);
  assert.strictEqual(C.worthChasing({ ...base, asked_at: local(2026, 9, 1) }, now), false); // stale
}

{
  // The cadence I pick: counted from when I answer, kept inside working hours.
  const tue10 = local(2026, 10, 20, 10); // a Tuesday
  assert.strictEqual(+C.chaseAtFor('4h', tue10), +local(2026, 10, 20, 14));
  assert.strictEqual(+C.chaseAtFor('4h', local(2026, 10, 20, 15)), +local(2026, 10, 21, 9)); // 19:00 → next morning
  assert.strictEqual(+C.chaseAtFor('1d', tue10), +local(2026, 10, 21, 10));
  assert.strictEqual(+C.chaseAtFor('2d', local(2026, 10, 23, 10)), +local(2026, 10, 26, 9)); // Sunday → Monday
  assert.strictEqual(C.chaseAtFor('never', tue10), null);
  assert.strictEqual(C.chaseAtFor('fortnight', tue10), undefined);
  // The reminder after a nudge: half as long again, three days by default.
  assert.strictEqual(C.secondGapHours('4h'), 6);
  assert.strictEqual(C.secondGapHours('2d'), 72);
  assert.strictEqual(C.secondGapHours(null), 72);
  const opts = C.cadenceOptions('1d');
  assert.deepStrictEqual(opts.map((o) => o.value), ['4h', '1d', '2d', '1w', 'never']);
  assert.strictEqual(opts[1].label, 'Tomorrow (usual)');
  assert.ok(!C.cadenceOptions(null).some((o) => /usual/.test(o.label)));
}

{
  // Merging is mine alone outside the repos I listed (src/dispatch/merge.js).
  const M = require('../src/dispatch/merge');
  const list = ['innergy-dev/mv-assistant', 'xvanov/*'];
  assert.strictEqual(M.mayMerge('innergy-dev/mv-assistant', list), true);
  assert.strictEqual(M.mayMerge('INNERGY-dev/MV-Assistant', list), true);
  assert.strictEqual(M.mayMerge('xvanov/anything', list), true);
  assert.strictEqual(M.mayMerge('innergy-dev/erp', list), false);
  assert.strictEqual(M.mayMerge('innergy-dev/mv-assistant-fork', list), false);
  assert.strictEqual(M.mayMerge(null, list), false);
  assert.strictEqual(M.summarize([]), 'pass');
  assert.strictEqual(M.summarize([{ bucket: 'pass' }, { bucket: 'skipping' }]), 'pass');
  assert.strictEqual(M.summarize([{ bucket: 'pass' }, { bucket: 'pending' }]), 'pending');
  assert.strictEqual(M.summarize([{ bucket: 'pending' }, { bucket: 'fail' }]), 'fail');
  assert.strictEqual(M.summarize([{ bucket: 'cancel' }]), 'fail');
}

console.log('durable: ok');
