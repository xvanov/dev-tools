'use strict';

// Does what someone owes you block you? (src/commitments/blocks.js) — the pure parts.

const assert = require('assert');
const B = require('../src/commitments/blocks.ts');

// Only ids asked for; a task not offered becomes null; a bad verdict is skipped.
const v = B.parseVerdicts({ items: [
  { id: 'B#10', verdict: 'blocks', task: 'T#1', why: 'needs the field list to build the sync', who: null },
  { id: 'B11', verdict: 'blocks', task: 'T#99', why: 'x' },
  { id: 'B14', verdict: 'blocks', task: null, who: 'Torvan', why: 'y' },
  { id: '12', verdict: 'not_mine', task: 'T#1' },
  { id: 'B13', verdict: 'maybe' },
  { id: 'B77', verdict: 'blocks' },
  { id: 'B10', verdict: 'not_mine' },
] }, ['10', '11', '12', '13', '14'], ['1', '2']);
assert.deepStrictEqual(v.get('10'), { verdict: 'blocks', taskId: '1', why: 'needs the field list to build the sync', who: null });
assert.deepStrictEqual(v.get('11'), { verdict: 'blocks', taskId: null, why: 'x', who: null });
assert.deepStrictEqual(v.get('12'), { verdict: 'not_mine', taskId: null, why: null, who: null });
assert.ok(!v.has('13') && !v.has('77'));
assert.strictEqual(v.get('14').who, 'Torvan');
assert.strictEqual(B.parseVerdicts(null, ['1'], []).size, 0);

// What is due: never judged, its task closed, or a task added since it found none.
const t0 = '2026-11-05T10:00:00Z';
const later = new Date('2026-11-06T10:00:00Z').getTime();
const due = B.due([
  { id: 1, verdict: null },
  { id: 2, verdict: 'blocks', task_id: 5, judged_at: t0, task_gone: true },
  { id: 3, verdict: 'blocks', task_id: 5, judged_at: t0 },
  { id: 4, verdict: 'not_mine', judged_at: t0 },
  { id: 5, verdict: 'blocks', task_id: null, judged_at: t0 },
  { id: 6, verdict: null, manual: true },
  { id: 7, verdict: 'not_mine', judged_at: '2026-11-07T00:00:00Z' },
], later).map((b) => b.id);
assert.deepStrictEqual(due, [1, 2, 4, 5]);

// The prompt names tasks and blockers by T#/B# id.
const p = B.render([{ id: 1, summary: 'Set up the sync' }], [{ id: 10, who: 'Quorvin', summary: 'Send the field list' }]);
assert.ok(p.includes('T#1 Set up the sync') && p.includes('B#10 [Quorvin] Send the field list'));

console.log('blocks: ok');
