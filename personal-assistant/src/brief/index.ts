'use strict';

// `pa brief` — the one command that has to be worth typing every morning.
//
// The ordering rule is the whole design: **overdue, then due, then asked but
// undated, then waiting on other people.** A brief sorted by arrival time is
// just your inbox again, and you already have one of those.
//
// Formatting is split from fetching so the layout can be tested without a
// database, and so the MCP server can return the same structure as text.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const repo = require('../repo');

const DAY = 86400_000;

// Pull requests, GitHub notifications, project items and Jira issues from the
// last three weeks: the brief's "open MRs" and the Repos view's "Review
// requests & board items" (dashboard/repos.js).
function recentReviews() {
  return repo.sources.recentReviews();
}

// `reviews: false` leaves the reviews out: the dashboard's /api/state does
// not draw them, and on SQLite they cost 120-160 ms of every board refresh.
async function gather({ horizonDays = 7, reviews: withReviews = true }: { horizonDays?: number; reviews?: boolean } = {}) {
  // What people ask of me, and notes from my own work, kept apart
  // (src/commitments/selfNotes.js): the second is grouped and expires.
  const { group } = require('../commitments/selfNotes.ts');
  const commitments = await repo.commitments.openForBrief(false, 60);
  const selfNotes = group(await repo.commitments.openForBrief(true, 200));

  // Through the end of tomorrow (local), so "what's on tomorrow?" in the
  // evening is answered from all of tomorrow, not the part before this hour.
  const endOfTomorrow = new Date();
  endOfTomorrow.setHours(48, 0, 0, 0);
  const meetings = await repo.sources.calendarToday(endOfTomorrow);

  const reviews = withReviews ? await recentReviews() : [];

  const runsActive = await repo.runs.activeForBrief();

  const runsReview = await repo.runs.reviewForBrief();

  return { commitments, selfNotes, meetings, reviews, runsActive, runsReview, horizonDays };
}

function bucket(commitment: any, now: any): 'overdue' | 'due' | 'undated' | 'waiting' {
  if (commitment.direction === 'owed_to_me') return 'waiting';
  if (!commitment.due_at) return 'undated';
  const due = new Date(commitment.due_at).getTime();
  if (due < now) return 'overdue';
  return 'due';
}

function relativeDue(due: any, now: any) {
  if (!due) return '';
  const diff = new Date(due).getTime() - now;
  const days = Math.round(diff / DAY);
  if (days < -1) return `${Math.abs(days)}d overdue`;
  if (days === -1 || (days === 0 && diff < 0)) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 7) return `in ${days}d`;
  return new Date(due).toISOString().slice(0, 10);
}

function timeOf(iso: any) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBrief(data: any, { now = Date.now() }: { now?: any } = {}) {
  const lines: any[] = [];
  const buckets = { overdue: [] as any[], due: [] as any[], undated: [] as any[], waiting: [] as any[] };
  for (const c of data.commitments) buckets[bucket(c, now)].push(c);

  const section = (title: any, items: any, render: (...a: any[]) => any) => {
    if (!items.length) return;
    lines.push('');
    lines.push(title);
    for (const item of items) lines.push(render(item));
  };

  lines.push(`Brief — ${new Date(now).toDateString()}`);

  section('OVERDUE', buckets.overdue, (c: any) =>
    `  ${String(c.id).padStart(4)}  ${c.summary}${c.who ? `  (${c.who})` : ''}  [${relativeDue(c.due_at, now)}]${flag(c)}`
  );
  section('DUE SOON', buckets.due.slice(0, 10), (c: any) =>
    `  ${String(c.id).padStart(4)}  ${c.summary}${c.who ? `  (${c.who})` : ''}  [${relativeDue(c.due_at, now)}]${flag(c)}`
  );
  section('ASKED OF YOU, NO DATE', buckets.undated.slice(0, 10), (c: any) =>
    `  ${String(c.id).padStart(4)}  ${c.summary}${c.who ? `  (${c.who})` : ''}${flag(c)}`
  );
  section('WAITING ON OTHERS', buckets.waiting.slice(0, 8), (c: any) =>
    `  ${String(c.id).padStart(4)}  ${c.summary}${c.who ? `  (${c.who})` : ''}`
  );

  // Notes from my own sessions and PRs: one line per PR or session, not per
  // note. They expire after a week untouched (src/commitments/selfNotes.js).
  const notes = data.selfNotes || [];
  if (notes.length) {
    const total = notes.reduce((n: any, g: any) => n + g.items.length, 0);
    section(`FROM YOUR OWN WORK (${total} notes, ${notes.length} groups)`, notes.slice(0, 6), (g: any) =>
      `  ${g.label}: ${g.items.length > 1 ? `${g.items.length} notes, latest ` : ''}#${g.items[0].id} ${g.items[0].summary}`
    );
  }

  // The calendar rows are a rolling window (now - 2 h .. now + 24 h): in the
  // afternoon most are tomorrow's, so each local day gets its own heading.
  const { dayOf } = require('../util/when.ts');
  const byDay = new Map<number, { title: string; items: any[] }>();
  for (const m of data.meetings || []) {
    const d = dayOf(m.occurred_at, now);
    const title = d.offset === 0 ? 'TODAY' : d.offset === 1 ? 'TOMORROW' : d.offset === -1 ? 'YESTERDAY' : d.date.toUpperCase();
    if (!byDay.has(d.offset)) byDay.set(d.offset, { title, items: [] });
    byDay.get(d.offset)!.items.push(m);
  }
  for (const [, g] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    section(g.title, g.items, (m: any) => {
      const attendees = (m.raw?.attendees || []).length;
      return `  ${timeOf(m.occurred_at)}  ${m.subject}${attendees ? `  (${attendees} people)` : ''}${m.raw?.isCancelled ? '  [cancelled]' : ''}`;
    });
  }

  const openMrs = data.reviews.filter((r: any) => r.raw?.state === 'opened' || r.raw?.action);
  section('CODE & BOARDS', openMrs.slice(0, 8), (r: any) =>
    `  ${r.subject}${r.raw?.pipeline ? `  [pipeline ${r.raw.pipeline}]` : ''}`
  );

  section('RUNS IN FLIGHT', data.runsActive, (r: any) =>
    `  #${r.id}  ${r.status.padEnd(8)} ${r.mode.padEnd(6)} ${r.task}`
  );
  section('WAITING FOR YOUR REVIEW', data.runsReview, (r: any) =>
    `  #${r.id}  ${r.task}${r.mr_url ? `  ${r.mr_url}` : ''}`
  );

  if (lines.length === 1) lines.push('', '  Nothing outstanding. Either you are on top of it or ingest has not run.');

  return lines.join('\n');
}

// A commitment the distiller was unsure about, or whose project it guessed,
// carries a marker. Confidence you cannot see is confidence you cannot correct.
function flag(c: any) {
  const marks: any[] = [];
  if (c.confidence !== null && c.confidence < 0.5) marks.push('?');
  if (c.project_confidence !== null && c.project_confidence < 0.6) marks.push('?repo');
  else if (c.project) marks.push(c.project);
  return marks.length ? `  {${marks.join(' ')}}` : '';
}

async function brief(options: any) {
  return formatBrief(await gather(options), options);
}

module.exports = { brief, gather, formatBrief, bucket, relativeDue, recentReviews };
