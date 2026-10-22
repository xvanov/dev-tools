'use strict';

// The memory layer's pure logic: evidence checks, the model-answer contracts,
// bitemporal belief, and page hashing. The names here are invented.

const assert = require('assert');
const m = require('../src/memory/claims');

// ------------------------------------------------------------ evidence -----

{
  const body = `Hi team,\r\n\r\n> Brannoc owns the  ledger-sync service now and\nreviews every change to it.\n\nThanks, Quill`;
  // Whitespace, line breaks and markdown quote marks do not make a quote fake.
  assert.strictEqual(m.verifyQuote('Brannoc owns the ledger-sync service now and reviews every change to it', body), 'exact');
  // Curly quotes and case are folded.
  assert.strictEqual(m.verifyQuote('“brannoc OWNS the ledger-sync service”', body), 'exact');
  assert.strictEqual(m.verifyQuote('Brannoc owns the ledger-sync service', 'brannoc owns the ledger‑sync service'), 'exact');
  // Elision with "..." is fine when each piece is real and in order.
  assert.strictEqual(m.verifyQuote('Brannoc owns the ledger-sync service ... reviews every change to it', body), 'fragments');
  assert.strictEqual(m.verifyQuote('reviews every change to it ... Brannoc owns the ledger-sync service', body), 'fuzzy');
  // A paraphrase with most words present is kept for review, not believed.
  assert.strictEqual(m.verifyQuote('Brannoc owns ledger-sync service now and reviews every single change to it', body), 'fuzzy');
  // An invented quote is rejected.
  assert.strictEqual(m.verifyQuote('Quill is the tech lead for payments', body), null);
  assert.strictEqual(m.verifyQuote('', body), null);
  assert.strictEqual(m.verifyQuote('short', body), null);
}

// ---------------------------------------------------- claims response -----

{
  const text = 'Here you go:\n```json\n' + JSON.stringify({
    claims: [
      { item: 11, subject: { kind: 'person', ref: 'brannoc@example.test', name: 'Brannoc Vale' }, kind: 'ownership', text: 'Brannoc owns ledger-sync.', quote: 'Brannoc owns the ledger-sync service', confidence: 0.9 },
      { item: 99, subject: { kind: 'person', ref: 'x' }, kind: 'role', text: 'Not from this batch.', quote: 'q' },
      { item: 11, subject: { kind: 'me' }, kind: 'workflow', text: 'Me reviews on Fridays.', quote: 'every Friday', confidence: 7, valid_until: '2026-12-01' },
      { item: 11, subject: { kind: 'person', ref: 'y' }, kind: 'gossip', text: 'Unknown kind.', quote: 'q' },
      { item: 11, subject: { kind: 'project' }, kind: 'status', text: 'No ref.', quote: 'q' },
    ],
  }) + '\n```';
  const out = m.parseClaimsResponse(text, [11, 12]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].subjectRef, 'brannoc@example.test');
  assert.strictEqual(out[0].subjectName, 'Brannoc Vale');
  assert.strictEqual(out[1].subjectKind, 'me');
  assert.strictEqual(out[1].confidence, 1);
  assert.ok(out[1].validUntil.startsWith('2026-12-01'));
  assert.throws(() => m.parseClaimsResponse('no json here', [1]), /no JSON/);
  // Two objects in one reply, with a brace inside a string and prose after.
  const two = m.parseClaimsResponse(
    '{"claims":[{"item":1,"subject":{"kind":"me"},"kind":"workflow","text":"Uses {braces}.","quote":"q"}]}\n' +
      '{"claims":[{"item":1,"subject":{"kind":"topic","ref":"ledger"},"kind":"status","text":"Frozen.","quote":"q"}]}\nDone {ok}.',
    [1]
  );
  assert.strictEqual(two.length, 2);
}

// ---------------------------------------------------------- decisions -----

{
  const cands = new Map([
    ['5', ['1', '2']],
    ['6', ['3']],
    ['7', ['4']],
    ['8', ['9']],
  ]);
  const text = JSON.stringify({
    decisions: [
      { claim: 5, action: 'supersede', target: 2, reason: 'role changed' },
      { claim: 6, action: 'DUPLICATE', target: 42 }, // not a candidate: hallucinated
      { claim: 7, action: 'NOOP', target: 4 },
      { claim: 5, action: 'ADD' }, // a second answer for the same claim is ignored
      { claim: 77, action: 'ADD' }, // not in the batch
    ],
  });
  const d = m.parseDecisions(text, cands);
  assert.deepStrictEqual(d.get('5'), { action: 'SUPERSEDE', target: '2', reason: 'role changed' });
  assert.strictEqual(d.get('6').action, 'ADD');
  assert.strictEqual(d.get('6').target, null);
  assert.deepStrictEqual([d.get('7').action, d.get('7').target], ['NOOP', null]);
  // Silence keeps the claim.
  assert.strictEqual(d.get('8').action, 'ADD');
  assert.ok(!d.has('77'));
}

{
  const g = m.parseMerges(
    JSON.stringify({ duplicates: [{ keep: 1, drop: [2, 3, 99] }, { keep: 2, drop: [4] }, { keep: 5, drop: [3, 6] }, { keep: 7, drop: [] }] }),
    [1, 2, 3, 4, 5, 6, 7]
  );
  // 99 is foreign; 2 was dropped so cannot keep; 3 cannot be dropped twice.
  assert.deepStrictEqual(g, [{ keep: '1', drop: ['2', '3'] }, { keep: '5', drop: ['6'] }]);
}

// --------------------------------------------------------- bitemporal -----

{
  const c = {
    status: 'superseded',
    valid_at: '2026-03-01T00:00:00Z',
    invalid_at: '2026-06-01T00:00:00Z',
    recorded_at: '2026-03-02T00:00:00Z',
    expired_at: '2026-06-03T00:00:00Z',
  };
  // Before the store knew it.
  assert.strictEqual(m.believedAsOf(c, '2026-03-01T12:00:00Z'), false);
  // Known, and true in the world.
  assert.strictEqual(m.currentAsOf(c, '2026-04-01T00:00:00Z'), true);
  // True in the world until June 1, but believed until June 3: between the
  // two it is believed and no longer valid.
  assert.strictEqual(m.believedAsOf(c, '2026-06-02T00:00:00Z'), true);
  assert.strictEqual(m.validAsOf(c, '2026-06-02T00:00:00Z'), false);
  assert.strictEqual(m.currentAsOf(c, '2026-07-01T00:00:00Z'), false);

  const now = { status: 'active', valid_at: '2026-03-01T00:00:00Z', recorded_at: '2026-03-01T00:00:00Z' };
  assert.strictEqual(m.currentAsOf(now, '2026-10-01T00:00:00Z'), true);
  assert.strictEqual(m.believedAsOf({ ...now, status: 'retracted' }, '2026-10-01T00:00:00Z'), false);
  assert.strictEqual(m.believedAsOf({ ...now, status: 'pending_review' }, '2026-10-01T00:00:00Z'), false);
}

{
  const NOW = new Date('2026-10-22T00:00:00Z');
  const base = { status: 'active', recorded_at: '2026-10-01T00:00:00Z' };
  assert.strictEqual(m.isStale({ ...base, kind: 'status', valid_at: '2026-10-15T00:00:00Z' }, NOW), false);
  assert.strictEqual(m.isStale({ ...base, kind: 'status', valid_at: '2026-09-01T00:00:00Z' }, NOW), true);
  assert.strictEqual(m.isStale({ ...base, kind: 'role', valid_at: '2025-01-01T00:00:00Z' }, NOW), false);
  assert.strictEqual(m.isStale({ ...base, kind: 'role', valid_at: '2026-01-01T00:00:00Z', invalid_at: '2026-10-20T00:00:00Z' }, NOW), true);
  assert.strictEqual(m.isStale({ ...base, kind: 'blocker', valid_at: '2026-09-20T00:00:00Z' }, NOW), false);
  assert.strictEqual(m.isStale({ ...base, status: 'superseded', kind: 'status', valid_at: '2025-01-01T00:00:00Z' }, NOW), false);
}

{
  const at = (h) => new Date(2026, 9, 22, h, 0, 0);
  assert.strictEqual(m.dreamDue(at(3), null, 2), true);
  assert.strictEqual(m.dreamDue(at(3), new Date(at(3).getTime() - 10 * 3600_000), 2), false);
  assert.strictEqual(m.dreamDue(at(3), new Date(at(3).getTime() - 22 * 3600_000), 2), true);
  assert.strictEqual(m.dreamDue(at(1), new Date(at(1).getTime() - 22 * 3600_000), 2), false);
  assert.strictEqual(m.dreamDue(at(1), new Date(at(1).getTime() - 40 * 3600_000), 2), true);
}

// --------------------------------------------------------------- pages ----

{
  const claims = [{ id: 2, text: 'b' }, { id: 1, text: 'a' }];
  const commitments = [{ id: 9, status: 'open', due_at: '2026-11-01T00:00:00Z' }];
  const h1 = m.factsHash({ claims, commitments, version: 'p1' });
  // Order does not matter; content and status do.
  assert.strictEqual(h1, m.factsHash({ claims: [...claims].reverse(), commitments, version: 'p1' }));
  assert.notStrictEqual(h1, m.factsHash({ claims: [{ id: 1, text: 'a' }], commitments, version: 'p1' }));
  assert.notStrictEqual(h1, m.factsHash({ claims, commitments: [{ ...commitments[0], status: 'done' }], version: 'p1' }));
  assert.notStrictEqual(h1, m.factsHash({ claims, commitments: [{ ...commitments[0], due_at: '2026-11-08T00:00:00Z' }], version: 'p1' }));
  assert.notStrictEqual(h1, m.factsHash({ claims, commitments, version: 'p2' }));
}

{
  const long = 'line of text\n'.repeat(2000);
  const cut = m.truncateToTokens(long, 1500);
  assert.ok(m.approxTokens(cut) <= 1510);
  assert.ok(cut.endsWith('_(truncated)_'));
  assert.strictEqual(m.truncateToTokens('short', 10), 'short');
  const ht = m.headTail('a'.repeat(100) + 'b'.repeat(100), 50);
  assert.ok(ht.startsWith('a') && ht.endsWith('b') && ht.includes('omitted'));
}

// ---------------------------------------------------------- the passes ----

{
  const extract = require('../src/memory/extract');
  const item = {
    id: 7,
    source: 'graph_chat',
    author_identity: 'brannoc@example.test',
    subject: 'ledger',
    body_text: 'I own the ledger-sync service and I review every change to it.',
    occurred_at: '2026-10-01T00:00:00Z',
    raw: { fromName: 'Brannoc Vale', members: 'Brannoc Vale, Quill Ashby', memberEmails: ['brannoc@example.test', 'quill@example.test'] },
  };
  const people = extract.peopleOf(item);
  assert.deepStrictEqual(people.map((p) => p.handle), ['brannoc@example.test', 'quill@example.test']);
  assert.strictEqual(people[1].name, 'Quill Ashby');
  assert.ok(extract.renderItem(item).includes('=== END ITEM 7'));

  const claim = (quote) => ({ quote, confidence: 0.8, kind: 'ownership', text: 't' });
  const v = extract.vet([claim('I own the ledger-sync service'), claim('I run payroll'), claim('own ledger-sync service and I review every single change')], item);
  assert.strictEqual(v.keep.length, 2);
  assert.strictEqual(v.dropped, 1);
  assert.strictEqual(v.keep[0].status, 'active');
  assert.strictEqual(v.keep[1].status, 'pending_review');
  assert.ok(v.keep[1].confidence <= 0.4);

  // Transcripts: capped at three, and only when a speaker is attributable.
  const audio = { ...item, source: 'audio', raw: {}, body_text: 'Me: I always ship the release notes on Monday mornings and I own the ledger-sync service now.' };
  const many = Array.from({ length: 5 }, () => claim('I own the ledger-sync service'));
  assert.strictEqual(extract.vet(many, audio).keep.length, 3);
  assert.strictEqual(extract.vet(many, { ...audio, body_text: 'Them: I own the ledger-sync service now.' }).keep.length, 0);

  const big = { source: 'claude_session', body_text: 'x'.repeat(50_000) };
  const small = { source: 'graph_chat', body_text: 'y'.repeat(300) };
  const b = extract.batches([big, big, big, small, small, small]);
  assert.strictEqual(b.length, 2);
  assert.deepStrictEqual(b.map((x) => x.length), [2, 4]);
}

{
  const { renderIndex } = require('../src/memory/pages');
  const idx = renderIndex({
    people: [{ name: 'Brannoc Vale', claims: [{ kind: 'expertise', text: 'Knows the ledger.' }, { kind: 'role', text: 'Leads payments.' }] }],
    projects: [{ name: 'quill-api', claims: [{ kind: 'status', text: 'In beta.' }] }],
    topics: [{ label: 'billing migration' }],
  });
  assert.ok(idx.includes('**Brannoc Vale** — Leads payments. Knows the ledger.'));
  assert.ok(idx.includes('**quill-api** — In beta.'));
  assert.ok(idx.includes('billing migration'));
}

{
  const { rrf } = require('../src/memory');
  const fused = rrf([[{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }]], [1, 1]);
  assert.strictEqual(String(fused[0].row.id), '2');
  assert.strictEqual(fused.length, 3);
}

console.log('memory ok');
