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

// The calendar window runs 24 h ahead: on a Sunday afternoon Monday's meetings
// are listed under TOMORROW, never under TODAY (docs/native/acceptance/whats-on.md).
{
  const sun = new Date(2026, 10, 8, 14, 53).getTime(); // local time
  const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).toISOString();
  const text = formatBrief(
    {
      commitments: [],
      meetings: [
        { subject: 'Wrap-up', occurred_at: at(8, 16) },
        { subject: 'Early sync', occurred_at: at(9, 4), raw: { isCancelled: true } },
        { subject: 'Team standup', occurred_at: at(9, 11) },
      ],
      reviews: [],
      runsActive: [],
      runsReview: [],
    },
    { now: sun }
  );
  const today = text.indexOf('TODAY');
  const tomorrow = text.indexOf('TOMORROW');
  assert.ok(today > 0 && tomorrow > today, text);
  assert.ok(text.indexOf('Wrap-up') < tomorrow && text.indexOf('Team standup') > tomorrow, text);
  assert.match(text, /Early sync.*\[cancelled\]/);
  const none = formatBrief({ commitments: [], meetings: [{ subject: 'Team standup', occurred_at: at(9, 11) }], reviews: [], runsActive: [], runsReview: [] }, { now: sun });
  assert.ok(!/TODAY/.test(none) && /TOMORROW/.test(none), none);
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
