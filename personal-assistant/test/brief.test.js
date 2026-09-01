'use strict';

// The brief's ordering rules, which are the reason the command exists: a brief
// sorted by arrival time is just the inbox again.

const assert = require('assert');
const { formatBrief, bucket, relativeDue } = require('../src/brief');

const NOW = new Date('2026-09-01T09:00:00Z').getTime();
const iso = (offsetDays) => new Date(NOW + offsetDays * 86400_000).toISOString();

{
  assert.strictEqual(bucket({ direction: 'owed_by_me', due_at: iso(-2) }, NOW), 'overdue');
  assert.strictEqual(bucket({ direction: 'owed_by_me', due_at: iso(3) }, NOW), 'due');
  assert.strictEqual(bucket({ direction: 'owed_by_me', due_at: null }, NOW), 'undated');
  // Something someone owes *you* is never overdue on your list, however late it
  // is — it belongs under "waiting on others", not at the top of your work.
  assert.strictEqual(bucket({ direction: 'owed_to_me', due_at: iso(-9) }, NOW), 'waiting');
}

{
  assert.strictEqual(relativeDue(iso(0), NOW), 'today');
  assert.strictEqual(relativeDue(iso(1), NOW), 'tomorrow');
  assert.strictEqual(relativeDue(iso(3), NOW), 'in 3d');
  assert.strictEqual(relativeDue(iso(-4), NOW), '4d overdue');
  assert.strictEqual(relativeDue(null, NOW), '');
}

{
  const text = formatBrief(
    {
      commitments: [
        { id: 1, summary: 'Ship the import fix', direction: 'owed_by_me', due_at: iso(-1), who: 'Sam', confidence: 0.9, project_confidence: 0.9, project: 'estimating-api' },
        { id: 2, summary: 'Review the grid MR', direction: 'owed_by_me', due_at: iso(2), who: 'Alex', confidence: 0.8, project_confidence: 0.3, project: 'shopfloor-ui' },
        { id: 3, summary: 'Send the estimate', direction: 'owed_by_me', due_at: null, who: null, confidence: 0.4, project_confidence: null, project: null },
        { id: 4, summary: 'Test tenant from IT', direction: 'owed_to_me', due_at: iso(-6), who: 'IT', confidence: 0.9, project_confidence: null, project: null },
      ],
      meetings: [{ subject: 'Stand-up', occurred_at: iso(0), raw: { attendees: ['a', 'b'] } }],
      reviews: [],
      runsActive: [{ id: 7, task: 'fix import', mode: 'mr', status: 'running' }],
      runsReview: [{ id: 6, task: 'grid tweak', mr_url: 'https://gitlab/x/-/merge_requests/9' }],
    },
    { now: NOW }
  );

  const overdueAt = text.indexOf('OVERDUE');
  const dueAt = text.indexOf('DUE SOON');
  const undatedAt = text.indexOf('ASKED OF YOU');
  const waitingAt = text.indexOf('WAITING ON OTHERS');

  assert.ok(overdueAt > 0 && overdueAt < dueAt, 'overdue comes first');
  assert.ok(dueAt < undatedAt, 'dated work outranks undated');
  assert.ok(undatedAt < waitingAt, 'your work outranks other people\'s');

  // A guessed repo and a shaky ask must be visibly marked — confidence you
  // cannot see is confidence you cannot correct.
  assert.match(text, /Review the grid MR.*\{\?repo\}/);
  assert.match(text, /Send the estimate.*\{\?\}/);
  assert.match(text, /Ship the import fix.*\{estimating-api\}/);

  assert.match(text, /RUNS IN FLIGHT/);
  assert.match(text, /WAITING FOR YOUR REVIEW/);
  assert.match(text, /merge_requests\/9/);
}

{
  const empty = formatBrief(
    { commitments: [], meetings: [], reviews: [], runsActive: [], runsReview: [] },
    { now: NOW }
  );
  // An empty brief must not look like a clean bill of health when the real
  // cause is that ingest has not run.
  assert.match(empty, /ingest has not run/);
}

console.log('brief.test.js ok');
