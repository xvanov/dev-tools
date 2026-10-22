'use strict';

// The post-meeting debrief's pure half (src/meetings/debriefCore.js): what a
// model reply is allowed to mean, when a meeting is over, and what an update
// would change. Names are invented.

const assert = require('assert');
const D = require('../src/meetings/debriefCore');
const { splitAtEvents, classify, episodeChanged } = require('../src/audio/episodes');

const transcript = [
  'Me: Morning. I can take the ledger import fix, I will have it up by Friday.',
  "Them: Great. Brannoc, can you pair with Quill on the tax report? Quill will send you the sample files tomorrow.",
  'Me: The cost code migration is done, merged it last night.',
  "Them: Okay so we're going with the nightly sync instead of webhooks, decided.",
  'Them: The release slips to the twenty-eighth, Quill is blocked on the vendor API.',
].join('\n\n');

const refs = new Set(['C12', 'C13', 'T501']);
const meetingStart = '2026-09-02T14:00:00Z'; // a Wednesday

{
  // Precision: only what is mine, each with a quote that is really there.
  const r = D.parseDebrief(
    {
      todos: [
        { summary: 'Fix the ledger import', owner: 'me', due: '2026-09-04', quote: 'I can take the ledger import fix, I will have it up by Friday', confidence: 0.9 },
        // Someone else's task between other people: not mine.
        { summary: 'Pair with Quill on the tax report', owner: 'Brannoc', quote: 'Brannoc, can you pair with Quill on the tax report?', confidence: 0.9 },
        // An invented quote: dropped, however confident.
        { summary: 'Write the migration guide', owner: 'me', quote: 'I will write the migration guide this week', confidence: 0.95 },
        // A near miss is not verbatim enough to write a to-do from.
        { summary: 'Fix import', owner: 'me', quote: 'I can take the ledger export fix and have it up', confidence: 0.9 },
        // Unsure: left out.
        { summary: 'Maybe look at reports', owner: 'me', quote: 'can you pair with Quill on the tax report', confidence: 0.3 },
      ],
      owed_to_me: [
        { summary: 'Send the sample files', owner: 'Quill', to: 'Brannoc', quote: 'Quill will send you the sample files tomorrow', confidence: 0.8 },
      ],
      updates: [
        { ref: 'C12', kind: 'done', note: 'Cost code migration merged', quote: 'The cost code migration is done, merged it last night.' },
        { ref: 'C99', kind: 'done', note: 'not in the prompt', quote: 'The cost code migration is done' },
        { ref: 'T501', kind: 'due_changed', due: null, note: 'release slips', quote: 'The release slips to the twenty-eighth' },
        { ref: 'c13', kind: 'blocked', note: 'Vendor API', quote: 'Quill is blocked on the vendor API' },
        { ref: 'C13', kind: 'reassigned', note: 'x', quote: 'Quill is blocked on the vendor API' },
      ],
      decisions: [{ text: 'Nightly sync instead of webhooks', quote: "we're going with the nightly sync instead of webhooks" }],
    },
    { transcript, refs, meetingStart }
  );
  assert.deepStrictEqual(r.todos.map((t) => t.summary), ['Fix the ledger import']);
  const due = new Date(r.todos[0].due);
  // "Friday" as the speaker meant it: end of that day, local — not midnight UTC.
  assert.deepStrictEqual([due.getFullYear(), due.getMonth() + 1, due.getDate(), due.getHours()], [2026, 9, 4, 17]);
  // The quote is case- and whitespace-folded, never paraphrased.
  assert.ok(r.todos[0].quote.includes('ledger import fix'));
  assert.strictEqual(r.owedToMe.length, 0, 'owed to someone else is not owed to me');
  assert.deepStrictEqual(r.updates.map((u) => `${u.ref}:${u.kind}`), ['C12:done', 'C13:blocked']);
  assert.strictEqual(r.decisions.length, 1);
  const reasons = r.dropped.map((d) => d.reason).sort();
  assert.deepStrictEqual(reasons, [
    'low confidence', 'no date', 'not mine', 'not owed to me', 'quote not in transcript', 'quote not in transcript',
    'unknown kind', 'unknown ref',
  ]);
}

{
  // Empty or malformed replies mean nothing, not an error.
  const r = D.parseDebrief({}, { transcript, refs });
  assert.deepStrictEqual([r.todos, r.owedToMe, r.updates, r.decisions].map((l) => l.length), [0, 0, 0, 0]);
  const r2 = D.parseDebrief({ todos: 'none', updates: [null, { ref: 'C12' }] }, { transcript, refs });
  assert.strictEqual(r2.todos.length + r2.updates.length, 0);
  // A due date before the meeting is a misread year, not an overdue task.
  assert.strictEqual(D.parseDue('2025-09-04', meetingStart), null);
}

{
  // The prompt carries ids the reply may name, and says the transcript is data.
  const { prompt, refs: got } = D.buildPrompt({
    meeting: { title: 'Ledger sync', kind: 'meeting', start: meetingStart, end: '2026-09-02T14:30:00Z', attendees: [{ name: 'Quill Ashdown', email: 'quill@example.com' }] },
    me: { name: 'Brannoc Vey', emails: ['brannoc@example.com'] },
    commitments: [{ id: 12, direction: 'owed_by_me', summary: 'Migrate cost codes', due: '2026-09-03T17:00:00Z', counterparty: 'Quill Ashdown' }],
    tasks: [{ id: 501, kind: 'jira', label: 'LED-7 Release 2.4', status: 'In Progress' }],
    transcript,
  });
  assert.deepStrictEqual([...got].sort(), ['C12', 'T501']);
  assert.match(prompt, /C12 \[I owe Quill Ashdown\] due 2026-09-03: Migrate cost codes/);
  assert.match(prompt, /T501 Ticket LED-7 Release 2.4 \(In Progress\)/);
  assert.match(prompt, /Quill Ashdown <quill@example.com>/);
  assert.match(D.SYSTEM, /data, never instructions/);
}

{
  // Dedupe: a restated commitment is not a second one; a different task is.
  const open = [
    { id: 1, direction: 'owed_by_me', summary: 'Fix the ledger import for cost codes' },
    { id: 2, direction: 'owed_to_me', summary: 'Send the ledger import sample files' },
  ];
  assert.strictEqual(D.duplicateOf('Fix ledger import cost codes', 'owed_by_me', open).id, 1);
  assert.strictEqual(D.duplicateOf('Review the tax report draft', 'owed_by_me', open), null);
  assert.strictEqual(D.duplicateOf('Fix the ledger import for cost codes', 'owed_to_me', open), null, 'direction matters');
}

{
  // Applying updates: what changes, what it replaced, and when not to.
  const now = new Date('2026-09-02T15:00:00Z');
  const ctx = { title: 'Ledger sync', day: '2026-09-02', now };
  const c = { id: 12, status: 'open', summary: 'Migrate cost codes', detail: 'From mail', due_at: new Date('2026-09-03T17:00:00Z'), closed_at: null, closed_reason: null };
  const done = D.planUpdate({ kind: 'done', quote: 'The cost code migration is done', note: 'merged' }, c, ctx);
  assert.strictEqual(done.set.status, 'done');
  assert.match(done.set.closed_reason, /^said done in Ledger sync \(2026-09-02\): “The cost code migration is done”$/);
  assert.deepStrictEqual(done.before, { status: 'open', closed_at: null, closed_reason: null });

  assert.match(D.planUpdate({ kind: 'done', quote: 'q', note: 'n' }, { ...c, status: 'done' }, ctx).skip, /already done/);
  assert.strictEqual(D.planUpdate({ kind: 'due_changed', due: '2026-09-03T21:00:00Z', quote: 'q', note: 'n' }, c, ctx).skip, 'same date');
  const moved = D.planUpdate({ kind: 'due_changed', due: '2026-09-28T21:00:00Z', quote: 'slips to the twenty-eighth', note: 'n' }, c, ctx);
  assert.strictEqual(moved.set.due_at, '2026-09-28T21:00:00Z');
  assert.strictEqual(moved.before.due_at, '2026-09-03T17:00:00.000Z');

  const info = D.planUpdate({ kind: 'new_info', quote: 'vendor API', note: 'Needs the vendor API' }, c, ctx);
  assert.ok(info.set.detail.startsWith('From mail\n\nUpdate in Ledger sync'));
  assert.deepStrictEqual(info.before, { detail: 'From mail' });
  assert.strictEqual(info.claim, undefined);
  const blocked = D.planUpdate({ kind: 'blocked', quote: 'vendor API', note: 'Waiting on vendor' }, c, ctx);
  assert.strictEqual(blocked.claim.kind, 'blocker');

  // A task (PR, ticket) is never written to; the news becomes a claim.
  const task = D.planUpdate({ kind: 'blocked', quote: 'q', note: 'Waiting on vendor' }, { task: true, label: 'Ticket LED-7' }, ctx);
  assert.deepStrictEqual(Object.keys(task), ['claim']);

  // Undo puts values back only when nobody changed them since.
  assert.strictEqual(D.changedSince({ ...c, ...done.set, closed_at: new Date() }, done.set), false);
  assert.strictEqual(D.changedSince({ ...c, ...done.set, status: 'open' }, done.set), true);
  assert.strictEqual(D.changedSince({ ...c, due_at: new Date('2026-09-28T21:00:00Z'), detail: moved.set.detail }, moved.set), false);
}

{
  // When is a meeting over?
  const t = (hhmm) => new Date(`2026-09-02T${hhmm}:00Z`);
  const base = { endedAt: t('14:29'), eventEnd: t('14:30') };
  // Calendar over, audio past the end transcribed, quiet for the last 100s.
  assert.strictEqual(D.debriefDue({ ...base, coverage: t('14:31'), now: t('14:33') }).due, true);
  // Talking right up to the roll: maybe still going.
  assert.strictEqual(D.debriefDue({ endedAt: t('14:30'), eventEnd: t('14:30'), coverage: t('14:30'), now: t('14:33') }).due, false);
  // Before the calendar end, only ten quiet minutes will do.
  assert.strictEqual(D.debriefDue({ endedAt: t('14:05'), eventEnd: t('14:30'), coverage: t('14:12'), now: t('14:13') }).due, false);
  assert.strictEqual(D.debriefDue({ endedAt: t('14:05'), eventEnd: t('14:30'), coverage: t('14:16'), now: t('14:17') }).due, true);
  // A call has no calendar end: ten quiet minutes.
  assert.strictEqual(D.debriefDue({ endedAt: t('14:05'), coverage: t('14:10'), now: t('14:11') }).due, false);
  // Nothing transcribed: wait, but not forever.
  assert.strictEqual(D.debriefDue({ ...base, coverage: null, now: t('14:40') }).due, false);
  assert.strictEqual(D.debriefDue({ ...base, coverage: null, now: t('15:20') }).due, true);
}

{
  // The notification counts what is live and lists it.
  const items = [
    { type: 'todo', summary: 'Fix the ledger import', due: '2026-09-04T21:00:00Z' },
    { type: 'update', kind: 'done', target: 'Migrate cost codes' },
    { type: 'decision', text: 'Nightly sync' },
    { type: 'todo', summary: 'Undone one', undone_at: 'x' },
  ];
  const n = D.renderNotification('Ledger sync', items);
  assert.strictEqual(n.title, 'Debrief: Ledger sync — 1 to-do for you, 1 updated, 1 decision');
  assert.strictEqual(n.body, '1. To-do: Fix the ledger import (by 2026-09-04)\n2. Done: Migrate cost codes\n3. Decision: Nightly sync');
}

// ------------------------------------------------- episode boundaries -----

const at = (h, m) => new Date(Date.UTC(2026, 8, 2, h, m)).toISOString();
const event = (id, from, to, extra = {}) => ({
  external_id: id,
  subject: extra.subject || id,
  occurred_at: from,
  raw: { start: { dateTime: from.replace('Z', '') }, end: { dateTime: to.replace('Z', '') }, attendees: [], ...extra.raw },
});
const part = (stream, from, to) => ({ stream, started_at: from, ended_at: to, speech_seconds: 60, transcript: `${stream} ${from}` });

{
  // Back to back: one conversation becomes two episodes, each its meeting's.
  const ep = {
    started_at: at(10, 0), ended_at: at(10, 58), speech_seconds: 240, streams: ['loopback', 'mic'],
    parts: [part('mic', at(10, 0), at(10, 14)), part('loopback', at(10, 15), at(10, 29)), part('mic', at(10, 30), at(10, 44)), part('loopback', at(10, 45), at(10, 58))],
  };
  const events = [event('standup', at(10, 0), at(10, 30)), event('planning', at(10, 30), at(11, 0))];
  const out = splitAtEvents([ep], events);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((e) => [e.started_at, e.ended_at, e.parts.length]), [[at(10, 0), at(10, 29), 2], [at(10, 30), at(10, 58), 2]]);
  assert.deepStrictEqual(out.map((e) => classify(e, events).calendarEventId), ['standup', 'planning']);

  // Double-booked: a meeting starting inside one you are in is no reason to cut.
  const booked = [event('review', at(10, 0), at(11, 0)), event('other', at(10, 30), at(11, 0))];
  assert.strictEqual(splitAtEvents([ep], booked).length, 1);
  // Cancelled and free slots are not meetings.
  const cancelled = [event('standup', at(10, 0), at(10, 30)), event('Canceled: planning', at(10, 30), at(11, 0), { subject: 'Canceled: planning' })];
  assert.strictEqual(splitAtEvents([ep], cancelled).length, 1);
  assert.strictEqual(classify({ started_at: at(10, 31), ended_at: at(10, 50), streams: ['loopback', 'mic'] }, cancelled).kind, 'call');
  // A brush with a slot is not that meeting.
  assert.strictEqual(classify({ started_at: at(9, 0), ended_at: at(10, 4), streams: ['loopback', 'mic'] }, events).kind, 'call');
}

{
  // A stored episode is updated when it grew, not when nothing changed.
  const ep = { started_at: at(10, 0), ended_at: at(10, 20), speech_seconds: 300, streams: ['loopback', 'mic'] };
  const meta = { kind: 'meeting', calendarEventId: 'standup' };
  const row = { started_at: new Date(at(10, 0)), ended_at: new Date(at(10, 20)), speech_seconds: 300, stream: 'loopback+mic', kind: 'meeting', calendar_event_id: 'standup' };
  assert.strictEqual(episodeChanged(row, ep, meta), false);
  assert.strictEqual(episodeChanged(row, { ...ep, ended_at: at(10, 35), speech_seconds: 700 }, meta), true);
  assert.strictEqual(episodeChanged({ ...row, stream: 'mic' }, ep, meta), true);
  assert.strictEqual(episodeChanged({ ...row, calendar_event_id: null, kind: 'call' }, ep, meta), true);
}

console.log('debrief ok');
