'use strict';

// The Today board's columns (src/dashboard/board.js): one card per
// commitment, everything about it attached to that card, nothing twice.

const assert = require('assert');
const { build } = require('../src/dashboard/board');

const now = new Date(2026, 10, 5, 12).getTime();
const c = (id, o = {}) => ({ id: String(id), summary: `ask ${id}`, direction: 'owed_by_me', status: 'open', item_id: 1000 + id, occurred_at: '2026-11-04T10:00:00Z', ...o });

const state = {
  commitments: [
    c(1),
    c(2, { due_at: new Date(2026, 10, 5, 17).toISOString() }), // due today
    c(3), // has an offer to start
    c(4, { direction: 'owed_to_me' }), // a follow-up question on it
    c(5, { direction: 'owed_to_me' }), // looks done
    c(6), // looks done
    c(7, { summary: 'Send the report.', item_id: 77 }),
    c(8, { summary: 'send the report', item_id: 77 }), // same item, same words as 7
    c(9, { summary: 'send the slides', item_id: 77 }), // same item, other words: its own card
  ],
  selfNotes: [
    { key: 'pr', label: 'erp PR #1', items: [c(20, { source: 'claude_session' }), c(21, { source: 'claude_session' })] },
    { key: 's', label: 'session', items: [c(22, { source: 'claude_session' })] },
  ],
  needsYou: [
    { id: 50, kind: 'dispatch', commitment_id: '3', title: 'Start a coding session on: ask 3', created_at: '2026-11-05T09:00:00Z', payload: {} },
    { id: 51, kind: 'question', commitment_id: '4', title: 'When should I follow up?', created_at: '2026-11-05T09:00:00Z', payload: { on: 'cadence', task: 'chase' } },
    { id: 52, kind: 'land', commitment_id: null, run_id: 9, title: 'Land run #9?', created_at: '2026-11-05T09:00:00Z', payload: {} },
    { id: 53, kind: 'question', commitment_id: '99', commitment_summary: 'not on the board query', title: 'Which repo?', created_at: '2026-11-05T09:00:00Z', payload: { on: 'project' } },
    { id: 54, kind: 'question', commitment_id: '8', title: 'Which repo?', created_at: '2026-11-05T09:00:00Z', payload: { on: 'project' } },
    { id: 50, kind: 'dispatch', commitment_id: '3', title: 'the same row again', created_at: '2026-11-05T09:00:00Z', payload: {} },
  ],
  looksDone: [
    { id: 60, commitment_id: '5', summary: 'ask 5', direction: 'owed_to_me', confidence: 0.6, created_at: '2026-11-05T08:00:00Z' },
    { id: 61, commitment_id: '6', summary: 'ask 6', direction: 'owed_by_me', confidence: 0.7, created_at: '2026-11-05T08:00:00Z' },
    { id: 62, commitment_id: '21', summary: 'ask 21', direction: 'owed_by_me', confidence: 0.55, created_at: '2026-11-05T08:00:00Z' },
  ],
};

const b = build(state, { now });
const ids = (list) => list.map((x) => String(x.id));
const all = [...ids(b.onMe), ...ids(b.waiting), ...b.notes.flatMap((g) => ids(g.items))];

// Nothing twice, anywhere on the board.
assert.strictEqual(new Set(all).size, all.length, `duplicates: ${all}`);

// On me: to-dos first (the run to land, due today, then a ready offer, then the
// rest), and what looks done last, surest first.
assert.deepStrictEqual(ids(b.onMe), ['p52', '2', '3', '7', '99', '1', '9', '6', '5', '21']);
const card = (id) => [...b.onMe, ...b.waiting].find((x) => String(x.id) === id);
assert.strictEqual(card('3').asks.length, 1); // the repeated row is one ask
assert.strictEqual(card('5').group, 'settled'); // owed to me, but confirming it is mine
assert.strictEqual(card('5').settled.id, 60);
assert.strictEqual(card('99').synthesized, true);
assert.strictEqual(card('99').summary, 'not on the board query');
assert.ok(card('p52').standalone);

// 7 and 8 are one card, carrying 8's question.
assert.ok(!all.includes('8'));
assert.deepStrictEqual(card('7').also, ['8']);
assert.strictEqual(card('7').asks[0].id, 54);

// The follow-up question rides on its card, which stays under Waiting.
assert.deepStrictEqual(ids(b.waiting), ['4']);
assert.strictEqual(card('4').chase.id, 51);
assert.strictEqual(card('4').column, 'waiting');

// A note that needs you moves out of its folded group; the rest stay folded.
assert.deepStrictEqual(b.notes.map((g) => [g.label, ids(g.items)]), [['erp PR #1', ['20']], ['session', ['22']]]);
assert.deepStrictEqual(b.counts, { onMe: 10, todo: 7, settled: 3, waiting: 1, notes: 2 });

// Empty state.
assert.deepStrictEqual(build({}).counts, { onMe: 0, todo: 0, settled: 0, waiting: 0, notes: 0 });

console.log('board: ok');
