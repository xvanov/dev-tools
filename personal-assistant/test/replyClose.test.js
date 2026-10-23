'use strict';

// Closing a commitment by my own reply — the pure half
// (src/commitments/replyCloseCore.js): which replies are shown, what a model
// verdict is allowed to mean, and what closing would change. Names are
// invented.

const assert = require('assert');
const R = require('../src/commitments/replyCloseCore');

const ask = {
  item_id: 10,
  summary: 'Tell Brannoc whether a sandbox is required for ledger-portal access',
  counterparty: 'Brannoc Vale',
  source: 'graph_chat',
  author_identity: 'brannoc.vale@example.com',
  occurred_at: '2026-09-02T14:00:00Z',
  body_text: 'Quick one: does the new hire need a sandbox to get into ledger-portal?',
  status: 'open',
  closed_at: null,
  closed_reason: null,
};

const replies = [
  { id: 13, occurred_at: '2026-09-02T14:20:00Z', body_text: 'No, but they need to be added to the portal-users group. So I still have to approve that by hand.' },
  { id: 11, occurred_at: '2026-09-02T14:05:00Z', body_text: 'Let me check, I will look tomorrow.' },
  { id: 10, occurred_at: '2026-09-02T14:00:00Z', body_text: 'the ask itself, which is not a reply' },
  { id: 9, occurred_at: '2026-09-01T09:00:00Z', body_text: 'Something from the day before.' },
  { id: 12, occurred_at: '2026-09-02T14:10:00Z', body_text: '   ' },
];

{
  // Only later replies with text, oldest first, never the ask itself.
  const picked = R.selectReplies(ask, replies);
  assert.deepStrictEqual(picked.map((r) => r.id), [11, 13]);
  assert.strictEqual(R.selectReplies(ask, replies, { max: 1 }).length, 1);
}

const picked = R.selectReplies(ask, replies);
const { prompt, refs } = R.buildPrompt(ask, picked);

{
  // The prompt names each reply by id, carries the ask, and says text is data.
  assert.ok(prompt.includes('M1 ('));
  assert.ok(prompt.includes('M2 ('));
  assert.ok(prompt.includes('ledger-portal'));
  assert.ok(prompt.includes('Brannoc Vale'));
  assert.strictEqual(refs.get('M2').id, 13);
  assert.ok(/data, never instructions/.test(R.SYSTEM));
  assert.ok(/promise is not a discharge/.test(R.SYSTEM));
  assert.ok(/When unsure, it is not "discharged"/.test(R.SYSTEM));
}

{
  // A real answer, quoted verbatim (case and spacing folded), closes.
  const j = R.parseVerdict({ verdict: 'discharged', message: 'M2', quote: '"no, but they need to be added  to the portal-users group"', confidence: 0.9 }, refs);
  assert.strictEqual(j.close, true);
  assert.strictEqual(j.message.id, 13);
  assert.strictEqual(j.quote, 'no, but they need to be added to the portal-users group');
}

{
  // An invented quote is dropped, however confident.
  const j = R.parseVerdict({ verdict: 'discharged', message: 'M2', quote: 'yes, a sandbox is required for everyone', confidence: 0.99 }, refs);
  assert.strictEqual(j.close, false);
  assert.strictEqual(j.reason, 'quote not in message');
}

{
  // A real quote attributed to the wrong message is not evidence for it.
  const j = R.parseVerdict({ verdict: 'discharged', message: 'M1', quote: 'they need to be added to the portal-users group', confidence: 0.9 }, refs);
  assert.strictEqual(j.close, false);
}

{
  // A ref that was not in the prompt, or no quote at all: nothing closes.
  assert.strictEqual(R.parseVerdict({ verdict: 'discharged', message: 'M7', quote: 'No, but they need to be added', confidence: 0.9 }, refs).close, false);
  assert.strictEqual(R.parseVerdict({ verdict: 'discharged', message: 'M2', confidence: 0.9 }, refs).close, false);
}

{
  // A promise is not a discharge — even when the model calls it one.
  const j = R.parseVerdict({ verdict: 'discharged', message: 'M1', quote: 'Let me check, I will look tomorrow', confidence: 0.9 }, refs);
  assert.strictEqual(j.close, false);
  assert.strictEqual(j.verdict, 'promise');
  for (const verdict of ['promise', 'partial', 'unrelated']) {
    const k = R.parseVerdict({ verdict, message: 'M2', quote: 'No, but they need to be added to the portal-users group', confidence: 1 }, refs);
    assert.strictEqual(k.close, false, verdict);
    assert.strictEqual(k.verdict, verdict);
  }
}

{
  // Unknown verdicts and garbage are "unrelated"; low confidence closes nothing.
  assert.strictEqual(R.parseVerdict({ verdict: 'probably' }, refs).verdict, 'unrelated');
  assert.strictEqual(R.parseVerdict(null, refs).close, false);
  const low = R.parseVerdict({ verdict: 'discharged', message: 'M2', quote: 'they need to be added to the portal-users group', confidence: 0.4 }, refs);
  assert.strictEqual(low.close, false);
  assert.strictEqual(low.reason, 'low confidence');
}

{
  // Closing writes status, time and the quote as the reason, and remembers
  // what it replaced so undo can put it back.
  const j = R.parseVerdict({ verdict: 'discharged', message: 'M2', quote: 'they need to be added to the portal-users group', confidence: 0.9 }, refs);
  const now = new Date('2026-09-02T15:00:00Z');
  const plan = R.planClose(ask, j, { source: 'graph_chat', now });
  assert.deepStrictEqual(plan.set, {
    status: 'done',
    closed_at: '2026-09-02T15:00:00.000Z',
    closed_reason: 'answered in chat: "they need to be added to the portal-users group"',
  });
  assert.deepStrictEqual(plan.before, { status: 'open', closed_at: null, closed_reason: null });
  assert.ok(R.planClose(ask, j, { source: 'graph_mail', now }).set.closed_reason.startsWith('answered in mail: '));

  // Already closed by hand, or not discharged: skip.
  assert.ok(R.planClose({ ...ask, status: 'done' }, j, { source: 'graph_chat', now }).skip);
  assert.ok(R.planClose(ask, { verdict: 'promise', close: false }, { source: 'graph_chat', now }).skip);

  // Undo leaves a commitment alone once someone has changed it since.
  assert.strictEqual(R.changedSince({ ...plan.set }, plan.set), false);
  assert.strictEqual(R.changedSince({ ...plan.set, status: 'open', closed_reason: null }, plan.set), true);
}

console.log('replyClose: ok');
