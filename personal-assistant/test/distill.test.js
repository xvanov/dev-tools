'use strict';

// The distiller's response contract. These are the failure modes that would
// otherwise reach the commitments table and be believed.

const assert = require('assert');
const { parseResponse, extractJson, buildUserMessage } = require('../src/distill/prompt');

const REF = '2026-09-01T10:00:00.000Z';

{
  const out = parseResponse(
    JSON.stringify({
      commitments: [
        {
          direction: 'owed_by_me',
          summary: 'Fix the estimating import before Thursday',
          detail: 'The CSV import drops rows with empty cost codes.',
          counterparty: 'sam@example.com',
          due: '2026-09-04',
          project: 'estimating-api',
          project_reason: 'named in the thread',
          confidence: 0.8,
        },
      ],
      facts: [{ kind: 'blocker', summary: 'Waiting on a test tenant', detail: null }],
    }),
    { referenceIso: REF }
  );

  assert.strictEqual(out.commitments.length, 1);
  assert.strictEqual(out.commitments[0].direction, 'owed_by_me');
  assert.strictEqual(out.commitments[0].counterparty, 'sam@example.com');
  assert.ok(out.commitments[0].dueAt.startsWith('2026-09-04'));
  assert.strictEqual(out.facts.length, 1);
}

{
  // A due date before the item that created it is a hallucinated year or a
  // misread relative date. A commitment born overdue is worse than one with no
  // date at all, because it goes straight to the top of the brief.
  const out = parseResponse(
    JSON.stringify({
      commitments: [{ direction: 'owed_by_me', summary: 'x', due: '2025-01-01', confidence: 1 }],
      facts: [],
    }),
    { referenceIso: REF }
  );
  assert.strictEqual(out.commitments[0].dueAt, null);
}

{
  // "ASAP" is not a date.
  const out = parseResponse(
    JSON.stringify({ commitments: [{ summary: 'y', due: 'ASAP' }], facts: [] }),
    { referenceIso: REF }
  );
  assert.strictEqual(out.commitments[0].dueAt, null);
}

{
  // Fenced JSON with a preamble still parses — cheaper than a retry.
  const out = parseResponse(
    'Sure, here you go:\n```json\n{"commitments":[],"facts":[]}\n```',
    { referenceIso: REF }
  );
  assert.deepStrictEqual(out, { commitments: [], facts: [] });
}

{
  // Junk must throw, so the item is recorded as failed rather than silently
  // distilling to nothing and never being looked at again.
  assert.throws(() => parseResponse('I cannot help with that.'), /no JSON object/);
  assert.throws(() => extractJson(''), /empty response/);
}

{
  // Unknown fact kinds and empty summaries are dropped rather than stored.
  const out = parseResponse(
    JSON.stringify({
      commitments: [{ summary: '   ' }, { summary: 'real one' }],
      facts: [{ kind: 'vibes', summary: 'nope' }, { kind: 'decision', summary: 'yes' }],
    }),
    { referenceIso: REF }
  );
  assert.strictEqual(out.commitments.length, 1);
  assert.strictEqual(out.facts.length, 1);
  assert.strictEqual(out.facts[0].kind, 'decision');
}

{
  // Confidence outside the range is clamped, not trusted.
  const out = parseResponse(
    JSON.stringify({ commitments: [{ summary: 'a', confidence: 7 }, { summary: 'b', confidence: 'x' }], facts: [] }),
    { referenceIso: REF }
  );
  assert.strictEqual(out.commitments[0].confidence, 1);
  assert.strictEqual(out.commitments[1].confidence, 0.5);
}

{
  // The prompt must carry the candidate list and the ranked guess, or the model
  // has to invent project names — which the schema forbids it from doing.
  const msg = buildUserMessage(
    {
      source: 'graph_chat',
      occurred_at: REF,
      author_identity: 'aad:123',
      subject: 'quick ask',
      body_text: 'can you look at the import',
      raw: { members: 'Sam, Me' },
    },
    {
      meLabel: 'Me <me@example.com>',
      candidates: [{ name: 'estimating-api', aliases: [{ alias: 'the estimating rewrite' }] }],
      ranked: [{ name: 'estimating-api', score: 4.2, rationale: 'alias hit' }],
    }
  );
  assert.match(msg, /ME: Me <me@example.com>/);
  assert.match(msg, /estimating-api — the estimating rewrite/);
  assert.match(msg, /RANKED GUESS/);
  assert.match(msg, /can you look at the import/);
}

console.log('distill.test.js ok');
