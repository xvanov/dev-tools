'use strict';

// The reconciler's pure half (src/ledger/reconcileCore.js): identities,
// what a judge reads of a long item, batching, what a verdict may mean, and
// what is applied on its own. Names are invented.

const assert = require('assert');
const R = require('../src/ledger/reconcileCore');

{
  // A person's identities in the forms source items carry.
  const forms = R.authorForms([
    { kind: 'smtp', value: 'Brannoc.Vale@example.com' },
    { kind: 'aad_oid', value: 'ABC-1' },
    { kind: 'github_username', value: 'bvale' },
    { kind: 'phone', value: '123' },
  ]);
  assert.deepStrictEqual(forms.sort(), ['aad:abc-1', 'brannoc.vale@example.com', 'github:bvale']);
}

{
  // Short bodies are shown whole; long ones keep start, end and the commitment's words.
  assert.strictEqual(R.snippet('short text', ['x']), 'short text');
  const long = `${'start '.repeat(100)}${'filler '.repeat(2000)}the ledgerportal sandbox is now granted ${'filler '.repeat(2000)}the end`;
  const s = R.snippet(long, R.terms([{ summary: 'Grant ledgerportal sandbox access' }]), 1200);
  assert.ok(s.length <= 1200, `snippet too long: ${s.length}`);
  assert.ok(s.startsWith('start'));
  assert.ok(s.includes('ledgerportal sandbox is now granted'));
  assert.ok(s.endsWith('the end'));
}

{
  // Commitments sharing an item are judged together; unrelated ones are not.
  const b = R.batches([
    { id: 1, items: [{ id: 10 }, { id: 11 }] },
    { id: 2, items: [{ id: 99 }] },
    { id: 3, items: [{ id: 11 }, { id: 12 }] },
  ]);
  assert.deepStrictEqual(b.map((x) => x.commitments.map((c) => c.id)), [[1, 3], [2]]);
  assert.deepStrictEqual(b[0].items.map((i) => i.id), [10, 11, 12]);
  // Caps hold.
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i, items: [{ id: 1 }] }));
  assert.ok(R.batches(many).every((x) => x.commitments.length <= 8));
}

const commitments = [
  { id: 101, direction: 'owed_to_me', summary: 'Get back to me about the ledger-portal role', counterparty: 'Brannoc Vale', asked_at: '2026-09-02T14:00:00Z', source: 'graph_chat' },
  { id: 102, direction: 'owed_by_me', summary: 'Open a fix PR for the export timeout', counterparty: 'Ysolde Marr', asked_at: '2026-09-02T14:00:00Z', source: 'graph_chat' },
  { id: 103, direction: 'owed_by_me', summary: 'Send the rollout notes', asked_at: '2026-09-02T14:00:00Z', source: 'graph_mail' },
];
const items = [
  { id: 500, source: 'graph_chat', author: 'brannoc.vale@example.com', mine: false, occurred_at: '2026-09-02T14:04:00Z', body_text: 'Just added your role. Shout if activation fails.' },
  { id: 501, source: 'github_pr', author: 'github:me', mine: true, occurred_at: '2026-09-02T15:00:00Z', subject: 'PR acme/export#12: raise the export timeout', body_text: 'Raises the timeout to 60s.', raw: { state: 'opened' } },
  { id: 502, source: 'graph_mail', author: 'me', mine: true, occurred_at: '2026-09-02T16:00:00Z', body_text: "I'll send the rollout notes tomorrow." },
];
const { prompt, cRefs, eRefs } = R.buildPrompt(commitments, items);

{
  assert.ok(prompt.includes('C1 (owed to me by Brannoc Vale'));
  assert.ok(prompt.includes('pull request opened by the engineer (open)'));
  assert.ok(prompt.includes('E1 (Teams message, from brannoc.vale@example.com'));
}

{
  const v = R.parseVerdicts(
    {
      verdicts: [
        { commitment: 'C1', effect: 'closes', evidence: 'E1', quote: 'Just added your role.', confidence: 0.9 },
        { commitment: 'C2', effect: 'closes', evidence: 'E2', quote: 'raise the export timeout', confidence: 0.85 },
        // A promise is never a delivery, whatever the model says.
        { commitment: 'C3', effect: 'closes', evidence: 'E3', quote: "I'll send the rollout notes tomorrow.", confidence: 0.9 },
        { commitment: 'C1', effect: 'none' }, // a second verdict for one commitment is ignored
        { commitment: 'C9', effect: 'closes', evidence: 'E1', quote: 'Just added', confidence: 1 },
      ],
    },
    cRefs,
    eRefs
  );
  assert.strictEqual(v.length, 3);
  assert.strictEqual(v[0].effect, 'closes');
  assert.strictEqual(v[0].item.id, 500);
  assert.strictEqual(v[1].effect, 'closes');
  assert.strictEqual(v[2].effect, 'progresses');
  assert.strictEqual(v[2].reason, 'quote reads as a promise');
  assert.strictEqual(R.decide(v[0]), 'apply');
  assert.strictEqual(R.decide(v[2]), 'record');
  assert.match(R.reasonFor(v[0]), /^done — brannoc\.vale@example\.com in a Teams message: "Just added your role\."$/);
}

{
  // A quote that is not in the item, an unknown item, or no quote: nothing.
  const v = R.parseVerdicts(
    {
      verdicts: [
        { commitment: 'C1', effect: 'closes', evidence: 'E1', quote: 'Your role is granted.', confidence: 0.95 },
        { commitment: 'C2', effect: 'closes', evidence: 'E7', quote: 'raise the export timeout', confidence: 0.95 },
        { commitment: 'C3', effect: 'moot', evidence: 'E3', quote: '', confidence: 0.95 },
      ],
    },
    cRefs,
    eRefs
  );
  assert.deepStrictEqual(v.map((x) => [x.effect, x.reason]), [
    ['none', 'quote not in item'],
    ['none', 'unknown item'],
    ['none', 'no quote'],
  ]);
  assert.ok(v.every((x) => R.decide(x) === 'skip'));
}

{
  // Confidence bands, and a close you took back before is only ever proposed.
  const base = { effect: 'closes', item: { id: 1 }, quote: 'done' };
  assert.strictEqual(R.decide({ ...base, confidence: 0.8 }), 'apply');
  assert.strictEqual(R.decide({ ...base, confidence: 0.79 }), 'propose');
  assert.strictEqual(R.decide({ ...base, confidence: 0.5 }), 'propose');
  assert.strictEqual(R.decide({ ...base, confidence: 0.49 }), 'record');
  assert.strictEqual(R.decide({ ...base, confidence: 0.99 }, { reopenedByYou: true }), 'propose');
  assert.strictEqual(R.decide({ ...base, effect: 'moot', confidence: 0.9 }), 'apply');
}

console.log('reconcile: ok');
