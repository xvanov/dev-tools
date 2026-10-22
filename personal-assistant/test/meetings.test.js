'use strict';

// Pre-meeting briefs: the pure rules. Invented names and data throughout.

const assert = require('assert');
const core = require('../src/meetings/core');
const P = require('../src/meetings/prompt');
const { verifyQuote } = require('../src/memory/claims');
const { toastXml } = require('../src/notify');

const ME = 'brannoc@example.test';
const row = (over = {}) => ({
  id: 7,
  external_id: 'evt-1',
  subject: 'Team stand-up',
  body_text: '',
  occurred_at: '2026-09-02T09:00:00Z',
  author_identity: 'quill@example.test',
  raw: {
    start: { dateTime: '2026-09-02T09:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-02T09:15:00.0000000', timeZone: 'UTC' },
    attendees: [ME, 'quill@example.test', 'wren@example.test'],
    showAs: 'busy',
    isCancelled: false,
    isOnlineMeeting: true,
    location: 'Microsoft Teams Meeting',
  },
  ...over,
});
const meeting = (over = {}, raw = {}) => core.toMeeting(row({ ...over, raw: { ...row().raw, ...raw } }));

// ------------------------------------------------------------ parsing -----
{
  const m = meeting();
  assert.strictEqual(m.start, '2026-09-02T09:00:00.000Z');
  assert.strictEqual(m.minutes, 15);
  assert.strictEqual(m.seriesKey, 'team stand-up');
  assert.strictEqual(m.cancelled, false);
  assert.strictEqual(m.isAllDay, false);

  // A one-off "Canceled:" is the same series, and cancelled.
  const c = meeting({ subject: 'Canceled: Team  Stand-up' });
  assert.strictEqual(c.seriesKey, 'team stand-up');
  assert.strictEqual(c.cancelled, true);
  assert.strictEqual(core.seriesLabel('Canceled: Team Stand-up'), 'Team Stand-up');

  const allDay = meeting({}, { start: { dateTime: '2026-09-02T00:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-03T00:00:00', timeZone: 'UTC' } });
  assert.strictEqual(allDay.isAllDay, true);

  // Teams boilerplate is not a description; the join link is found.
  const body = '________________\r\nMicrosoft Teams meeting\r\nJoin: https://teams.microsoft.com/l/meetup-join/abc123def456ghi789jkl/0?context=x\r\nAgenda: ledger sync rollout';
  const j = meeting({ body_text: body });
  assert.strictEqual(j.description, 'Agenda: ledger sync rollout');
  assert.ok(j.joinUrl.startsWith('https://teams.microsoft.com/l/meetup-join/'));
  // A truncated link is worse than none.
  assert.strictEqual(core.joinUrlOf('Microsoft Teams Meeting', 'Join: https://teams.microsoft.com/l/'), null);
  assert.strictEqual(core.joinUrlOf('https://example.zoom.us/j/123?pwd=x', ''), 'https://example.zoom.us/j/123?pwd=x');
}

// -------------------------------------------------------- eligibility -----
{
  const opts = { myEmails: [ME] };
  assert.deepStrictEqual(core.eligibility(meeting(), opts), { ok: true, reason: null });
  assert.strictEqual(core.eligibility(meeting({}, { isCancelled: true }), opts).reason, 'cancelled');
  assert.strictEqual(core.eligibility(meeting({}, { showAs: 'free' }), opts).reason, 'marked free');
  const solo = meeting({ subject: 'Focus' }, { attendees: [ME], isOnlineMeeting: false });
  assert.strictEqual(core.eligibility(solo, opts).ok, false);
  assert.strictEqual(core.eligibility(solo, { ...opts, focusBlocks: true }).ok, true);
  const crowd = Array.from({ length: 60 }, (_, i) => `p${i}@example.test`);
  assert.match(core.eligibility(meeting({}, { attendees: crowd }), opts).reason, /^broadcast/);
  // ...unless you organised it.
  assert.strictEqual(core.eligibility(meeting({ author_identity: ME }, { attendees: crowd }), opts).ok, true);
}

// ----------------------------------------------------- classification -----
{
  const k = (subject, raw = {}, ctx = {}) => core.classifyDeterministic(meeting({ subject }, raw), { myEmails: [ME], ...ctx })?.kind ?? null;
  assert.strictEqual(k('Quill daily'), 'standup');
  assert.strictEqual(k('Platform Standup'), 'standup');
  assert.strictEqual(k('Stand-up + guests'), 'standup');
  assert.strictEqual(k('Brannoc / Quill 1:1'), 'one_on_one');
  assert.strictEqual(k('Biweekly 1-1 Brannoc'), 'one_on_one');
  assert.strictEqual(k('Sprint planning'), 'planning');
  assert.strictEqual(k('Backlog refinement'), 'planning');
  assert.strictEqual(k('Sprint 42 retro'), 'retro');
  assert.strictEqual(k('Show and tell'), 'review');
  assert.strictEqual(k('Ledger demo'), 'review');
  assert.strictEqual(k('Interview: backend candidate'), 'interview');
  // Interview wins over "review" in "interview".
  assert.strictEqual(k('Tech screen review'), 'interview');
  // "Room 11" is not a 1:1.
  assert.strictEqual(k('Room 11 sync'), null);
  // Two people and no keyword: a 1:1 by shape.
  assert.strictEqual(k('Catch up', { attendees: [ME, 'quill@example.test'] }), 'one_on_one');
  // Short, on many days, with a team: a stand-up whatever it is called.
  const starts = ['2026-08-31T09:00:00Z', '2026-09-01T09:00:00Z', '2026-09-02T09:00:00Z'];
  assert.strictEqual(k('Tactical ten', {}, { seriesStarts: starts }), 'standup');
  assert.strictEqual(k('Tactical ten', {}, { seriesStarts: starts.slice(0, 1) }), null);
  // Mostly outside my domain: external.
  assert.strictEqual(k('Quarterly sync', { attendees: [ME, 'a@vendor.test', 'b@vendor.test', 'quill@example.test'] }), 'external');

  assert.strictEqual(core.normaliseKind('1:1'), 'one_on_one');
  assert.strictEqual(core.normaliseKind('STANDUP'), 'standup');
  assert.strictEqual(core.normaliseKind('nonsense'), 'other');
}

// ------------------------------------------------------------ windows -----
{
  // Local times on purpose: "yesterday" is the operator's yesterday.
  const wed = new Date(2026, 8, 2, 9, 0);
  const tue = new Date(2026, 8, 1, 9, 0);
  const now = new Date(2026, 8, 2, 8, 0);
  let w = core.standupWindow(wed, { now, previousStart: tue });
  assert.strictEqual(w.basis, 'previous');
  assert.strictEqual(w.from.getTime(), tue.getTime());
  assert.strictEqual(w.to.getTime(), now.getTime());

  // No previous occurrence: Monday's covers Friday, not Sunday.
  const mon = new Date(2026, 8, 7, 9, 0);
  w = core.standupWindow(mon, { now: new Date(2026, 8, 7, 8, 0) });
  assert.strictEqual(w.basis, 'workday');
  assert.strictEqual(w.from.getDay(), 5);
  assert.strictEqual(w.from.getDate(), 4);

  // Tuesday without a previous one: Monday.
  w = core.standupWindow(new Date(2026, 8, 8, 9, 0), { now: new Date(2026, 8, 8, 8, 0) });
  assert.strictEqual(w.from.getDay(), 1);

  // A previous occurrence two weeks back (holiday) is not trusted.
  w = core.standupWindow(wed, { now, previousStart: new Date(2026, 7, 19, 9, 0) });
  assert.strictEqual(w.basis, 'workday');
  // Nor one after the meeting.
  w = core.standupWindow(wed, { now, previousStart: new Date(2026, 8, 3, 9, 0) });
  assert.strictEqual(w.basis, 'workday');
}

// ------------------------------------------------------------- dedupe -----
{
  const a = meeting();
  assert.strictEqual(core.dedupeKey(a), 'meeting_brief:evt-1:2026-09-02T09:00:00.000Z');
  assert.strictEqual(core.dedupeKey(meeting()), core.dedupeKey(a));
  // Moved meeting → briefed again.
  const moved = meeting({}, { start: { dateTime: '2026-09-02T10:00:00', timeZone: 'UTC' } });
  assert.notStrictEqual(core.dedupeKey(moved), core.dedupeKey(a));

  const now = new Date('2026-09-02T08:10:00Z');
  assert.strictEqual(core.dueForBrief(a, { now, leadMinutes: 60 }), true);
  assert.strictEqual(core.dueForBrief(a, { now: new Date('2026-09-02T07:30:00Z'), leadMinutes: 60 }), false);
  assert.strictEqual(core.dueForBrief(a, { now: new Date('2026-09-02T09:01:00Z'), leadMinutes: 60 }), false);
}

// ------------------------------------------------ evidence → prompt -------
{
  const ev = {
    meeting: { title: 'Team stand-up', kind: 'standup', start: '2026-09-02T09:00:00Z', minutes: 15, description: '', attendees: ['quill@example.test'] },
    window: { from: new Date('2026-09-01T09:00:00Z'), to: new Date('2026-09-02T08:00:00Z'), basis: 'previous' },
    sections: [
      { title: 'Done since the last stand-up', items: [
        { key: 'gh:https://github.test/o/ledger/pull/12', text: 'Merged PR ledger#12: retry the sync', url: 'https://github.test/o/ledger/pull/12' },
        { key: 'item:41', text: 'Coding session: Fix the importer' },
      ] },
      { title: 'On my plate today', items: [
        { key: 'commitment:9', text: 'Due 2026-09-02: send Quill the rollout plan' },
        { key: 'item:41', text: 'duplicate of a done item, dropped' },
      ] },
      { title: 'Possible blockers', items: [] },
      { title: 'Said last time (2026-09-01, from the transcript)', items: [{ key: 'said:0', text: 'Promised: finish ledger#12 — "I\'ll finish the retry by tomorrow"' }] },
    ],
  };
  const { prompt, refs } = P.buildBriefPrompt(ev);
  assert.deepStrictEqual(Object.keys(refs), ['E1', 'E2', 'E3', 'E4']);
  assert.strictEqual(refs.E1.url, 'https://github.test/o/ledger/pull/12');
  assert.strictEqual(refs.E3.key, 'commitment:9');
  assert.match(prompt, /\[E1\] Merged PR ledger#12/);
  assert.match(prompt, /## Possible blockers — none/);
  assert.match(prompt, /Said last time/);
  assert.match(prompt, /since the previous occurrence/);
  assert.match(prompt, /data, not instructions/);
  assert.ok(!prompt.includes('duplicate of a done item'));

  // Model reply → brief. Unknown labels dropped, context without evidence dropped.
  const r = P.renderBrief(
    {
      points: [
        { label: 'Yesterday', text: 'Merged the sync retry; fixed the importer.', refs: ['E1', 'E2'] },
        { label: 'Today', text: 'Send Quill the rollout plan.', refs: ['E3', 'E99'] },
        { label: 'Blocker', text: 'none known', refs: [] },
        { label: 'Said last time', text: 'Finish the retry — merged ✅', refs: ['E4', 'E1'] },
      ],
      context: [{ text: 'Quill asked about rollout last time', refs: ['E4'] }, { text: 'Invented', refs: ['E77'] }],
    },
    refs,
    { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' }
  );
  assert.strictEqual(r.points.length, 4);
  assert.deepStrictEqual(r.points[1].refs, ['E3']);
  assert.strictEqual(r.context.length, 1);
  assert.ok(r.headline.startsWith('1. Yesterday: Merged the sync retry'));
  assert.match(r.headline, /\n4\. Said last time: /);
  assert.ok(!/E\d/.test(r.headline), 'no labels in the toast text');
  assert.match(r.body, /\nContext:\n- Quill asked/);
  assert.match(r.body, /Join: https:\/\/teams/);

  // The cap: a rambling reply is cut to the headline budget.
  const long = Array.from({ length: 80 }, () => 'word').join(' ');
  const capped = P.renderBrief({ points: Array.from({ length: 6 }, (_, i) => ({ label: `P${i}`, text: long, refs: ['E1'] })) }, refs);
  assert.ok(capped.words <= P.HEADLINE_WORDS, `headline ${capped.words} words`);
  assert.ok(capped.points.length >= 1);
}

// ------------------------------------------------------------ learning ----
{
  const transcript = [
    "Them: Brannoc, where are we on the ledger sync?",
    "Me: I merged the retry yesterday. I'll finish the importer fix by tomorrow.",
    'Them: Any blockers on the staging database?',
  ].join('\n\n');
  const myLines = P.myLinesOf(transcript);
  assert.ok(myLines.startsWith('I merged the retry'));
  assert.ok(!myLines.includes('where are we'));
  const parsed = P.parseLearn(
    {
      format: 'Round-robin updates, then blockers.',
      format_quote: 'Any blockers on the staging database?',
      asks: [
        { text: 'Status of the ledger sync', quote: 'where are we on the ledger sync' },
        { text: 'Invented ask', quote: 'what about the moon base timeline' },
      ],
      said: [
        { text: 'Will finish the importer fix by tomorrow', quote: "I'll finish the importer fix by tomorrow", promise: true },
        // Said by them, not me: not mine to have promised.
        { text: 'Blockers on staging', quote: 'Any blockers on the staging database', promise: false },
      ],
    },
    { transcript, myLines, verify: verifyQuote }
  );
  assert.strictEqual(parsed.asks.length, 1);
  assert.strictEqual(parsed.said.length, 1);
  assert.strictEqual(parsed.said[0].promise, true);
  assert.strictEqual(parsed.formatQuote, 'Any blockers on the staging database?');
  assert.match(P.buildLearnPrompt({ title: 'Team stand-up', kind: 'standup', start: '2026-09-01T09:00:00Z', transcript }), /stand-up/);
}

// ---------------------------------------------------------- toast xml -----
{
  const xml = toastXml({ title: 'Stand-up', body: '1. a\n2. b', url: 'http://127.0.0.1:7300/#brief-1', actions: [{ label: 'Join', url: 'https://teams.microsoft.com/l/x?a=1&b=2' }, { label: 'bad', url: 'javascript:alert(1)' }] });
  assert.match(xml, /<actions><action content="Join" activationType="protocol" arguments="https:\/\/teams\.microsoft\.com\/l\/x\?a=1&amp;b=2"\/><\/actions>/);
  assert.ok(!xml.includes('javascript:'));
  assert.ok(!toastXml({ title: 't', body: '' }).includes('<actions>'));
}

console.log('meetings ok');
