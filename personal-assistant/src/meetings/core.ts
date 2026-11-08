'use strict';

// The pure half of pre-meeting briefs: reading a calendar row, deciding
// whether it deserves a brief, what kind of meeting it is, and which window of
// work a stand-up should report on. No database, no model — every rule here
// is pinned by test/meetings.test.js.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const KINDS = ['standup', 'one_on_one', 'planning', 'review', 'retro', 'external', 'interview', 'other'];

const KIND_LABEL = {
  standup: 'stand-up',
  one_on_one: '1:1',
  planning: 'planning',
  review: 'review/demo',
  retro: 'retro',
  external: 'external',
  interview: 'interview',
  other: 'meeting',
};

// ------------------------------------------------------------- events -----

// {dateTime, timeZone} → ms. The connector reports UTC for this mailbox; a
// zone-less dateTime is read as UTC too, matching graphCalendar.isoOf.
function timeOf(t: any) {
  if (!t) return null;
  if (typeof t === 'string') return new Date(t).getTime();
  if (!t.dateTime) return null;
  const base = String(t.dateTime).replace(/(\.\d{3})\d*$/, '$1');
  const zoned = /Z$|[+-]\d\d:?\d\d$/.test(base) ? base : `${base}Z`;
  const ms = new Date(zoned).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const CANCEL_PREFIX = /^\s*(canceled|cancelled|anulowano|abgesagt|annul[ée]|cancelado|annullato)\s*:\s*/i;
const NOISE_PREFIX = /^\s*(updated|rescheduled|moved|fw|fwd|re|invitation|accepted|tentative)\s*:\s*/i;

// A recurring meeting's identity: its subject, without the "Canceled:" and
// "Updated:" a client prepends to one occurrence, case- and space-folded.
function seriesKey(subject: string) {
  let s = String(subject || '').trim();
  for (let i = 0; i < 3; i++) s = s.replace(CANCEL_PREFIX, '').replace(NOISE_PREFIX, '');
  return s.toLowerCase().replace(/\s+/g, ' ').trim() || '(untitled)';
}

// The subject as shown, without a one-off "Canceled:".
function seriesLabel(subject: string) {
  return String(subject || '').replace(CANCEL_PREFIX, '').trim() || '(untitled)';
}

// Teams/Zoom boilerplate is not a description.
function cleanDescription(body: any) {
  return String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[_\-=*]{6,}$/.test(l))
    .filter((l) => !/microsoft teams|join (the meeting|on your)|^join:|meeting id|passcode|need help\?|dial in|^caution:|for organizers|meeting options|https?:\/\//i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 600);
}

function joinUrlOf(location: any, body: any) {
  const loc = String(location || '');
  const fromLoc = loc.match(/https:\/\/[^\s<>"]*(teams\.microsoft\.com|zoom\.us|meet\.google\.com)[^\s<>"]*/i);
  if (fromLoc) return fromLoc[0];
  const fromBody = String(body || '').match(/https:\/\/teams\.microsoft\.com\/[^\s<>"]+/i);
  // The connector's body is a short summary; a URL cut off mid-way is worse than none.
  return fromBody && fromBody[0].length > 40 ? fromBody[0] : null;
}

/**
 * A graph_event source_item row → the shape every other function here takes.
 */
function toMeeting(row: any) {
  const raw = row.raw || {};
  const start = timeOf(raw.start) ?? new Date(row.occurred_at).getTime();
  const end = timeOf(raw.end) ?? start + 30 * 60_000;
  return {
    itemId: row.id ?? null,
    eventId: row.external_id,
    subject: row.subject || '(untitled meeting)',
    seriesKey: seriesKey(row.subject),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    minutes: Math.round((end - start) / 60_000),
    attendees: (raw.attendees || []).map((a: any) => String(a).toLowerCase()),
    organizer: row.author_identity ? String(row.author_identity).toLowerCase() : null,
    showAs: raw.showAs ? String(raw.showAs).toLowerCase() : null,
    cancelled: !!raw.isCancelled || CANCEL_PREFIX.test(row.subject || ''),
    isAllDay: raw.isAllDay === true || isAllDayRange(start, end),
    online: !!raw.isOnlineMeeting,
    description: cleanDescription(row.body_text),
    joinUrl: joinUrlOf(raw.location, row.body_text),
    webLink: raw.webLink || null,
  };
}

// Midnight to midnight, a whole number of days: what an all-day event is when
// the connector does not say so.
function isAllDayRange(start: any, end: any) {
  const s = new Date(start);
  const e = new Date(end);
  const midnight = (d: any) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  return end - start >= 86400_000 && (end - start) % 86400_000 === 0 && midnight(s) && midnight(e);
}

// -------------------------------------------------------- eligibility -----

/**
 * Should this meeting get a brief? Returns {ok, reason}.
 * @param {object} m          from toMeeting
 * @param {object} opts
 * @param {string[]} opts.myEmails
 * @param {number} [opts.maxAttendees=40] bigger than this is a broadcast you sit in, not a meeting you speak in
 * @param {boolean} [opts.focusBlocks=false] brief solo blocks too
 */
function eligibility(m: any, { myEmails = [], maxAttendees = 40, focusBlocks = false }: { myEmails?: any; maxAttendees?: number; focusBlocks?: boolean } = {}) {
  const mine = new Set(myEmails.map((e: any) => e.toLowerCase()));
  if (m.cancelled) return { ok: false, reason: 'cancelled' };
  if (m.isAllDay) return { ok: false, reason: 'all-day' };
  if (m.showAs === 'free') return { ok: false, reason: 'marked free' };
  if (m.showAs === 'oof' || m.showAs === 'workingelsewhere') return { ok: false, reason: `marked ${m.showAs}` };
  const others = m.attendees.filter((a: any) => !mine.has(a));
  const organised = m.organizer && mine.has(m.organizer);
  if (!others.length && !m.online) {
    return focusBlocks ? { ok: true, reason: 'focus block' } : { ok: false, reason: 'solo block' };
  }
  if (others.length + 1 > maxAttendees && !organised) return { ok: false, reason: `broadcast (${others.length + 1} invited)` };
  return { ok: true, reason: null };
}

// ----------------------------------------------------- classification -----

const KEYWORDS: [string, RegExp][] = [
  ['interview', /\b(interview|candidate|screening|tech(nical)? screen|hiring panel)\b/i],
  ['retro', /\b(retro|retrospective|post[\s-]?mortem|lessons learned)\b/i],
  ['standup', /\b(stand[\s-]?up|daily|scrum|sync[\s-]?up|huddle)\b/i],
  ['one_on_one', /(^|[^\d])1\s*(:|\/|x|-|on)\s*1([^\d]|$)|\bone[\s-]on[\s-]one\b/i],
  ['planning', /\b(planning|refinement|grooming|backlog|estimation|kick[\s-]?off|roadmap|pi plan)\b/i],
  ['review', /\b(demo|showcase|show[\s-]and[\s-]tell|show your work|sprint review|design review|review)\b/i],
  ['external', /\b(customer|client|vendor|prospect|onboarding call|partner call)\b/i],
];

function domainOf(email: string) {
  const at = String(email || '').lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : null;
}

/**
 * Deterministic classification: title keywords first, then the shape of the
 * series. Returns {kind, source} or null when only a model could tell.
 * @param {object} m           from toMeeting
 * @param {object} ctx
 * @param {string[]} ctx.myEmails
 * @param {string[]} [ctx.seriesStarts] ISO starts of every known occurrence of the series
 */
function classifyDeterministic(m: any, { myEmails = [], seriesStarts = [] }: { myEmails?: any; seriesStarts?: any } = {}) {
  const title = m.subject.replace(CANCEL_PREFIX, '');
  for (const [kind, re] of KEYWORDS) if (re.test(title)) return { kind, source: 'keyword' };

  const mine = new Set(myEmails.map((e: any) => e.toLowerCase()));
  const others = m.attendees.filter((a: any) => !mine.has(a));
  if (others.length === 1) return { kind: 'one_on_one', source: 'structure' };

  // Short, on most weekdays, with a team: a stand-up whatever it is called.
  const days = new Set(seriesStarts.map((s: any) => new Date(s).toISOString().slice(0, 10)));
  if (m.minutes > 0 && m.minutes <= 20 && days.size >= 3 && others.length >= 2) {
    return { kind: 'standup', source: 'structure' };
  }

  const myDomains = new Set(([...mine] as string[]).map((e: string) => domainOf(e)).filter(Boolean) as string[]);
  if (myDomains.size && others.length) {
    const external = others.filter((a: any) => !myDomains.has(domainOf(a) as string));
    if (external.length * 2 >= others.length) return { kind: 'external', source: 'structure' };
  }
  for (const [kind, re] of KEYWORDS) if (re.test(m.description)) return { kind, source: 'keyword' };
  return null;
}

function normaliseKind(k: number) {
  const s = String(k || '').toLowerCase().replace(/[^a-z_:1]/g, '');
  if (KINDS.includes(s)) return s;
  if (/^(1:1|1on1|oneonone)$/.test(s)) return 'one_on_one';
  if (/standup|daily/.test(s)) return 'standup';
  if (/demo/.test(s)) return 'review';
  return 'other';
}

// ------------------------------------------------------------ windows -----

/**
 * What a stand-up reports on: from the previous occurrence of the series to
 * now. Without one, the previous working day at the same time — a Monday
 * stand-up covers Friday, not Sunday. A previous occurrence more than a week
 * back (holiday, a skipped series) is not trusted either.
 *
 * Weekdays are local time: "yesterday" is the operator's yesterday.
 * @returns {{from: Date, to: Date, basis: 'previous'|'workday'}}
 */
function standupWindow(start: any, { now = new Date(), previousStart = null }: { now?: any; previousStart?: any } = {}) {
  const at = new Date(start);
  const to = new Date(now);
  if (previousStart) {
    const prev = new Date(previousStart);
    const age = (at as any) - (prev as any);
    if (age > 0 && age <= 7 * 86400_000) return { from: prev, to, basis: 'previous' };
  }
  const from = new Date(at.getTime() - 86400_000);
  while (from.getDay() === 0 || from.getDay() === 6) from.setTime(from.getTime() - 86400_000);
  return { from, to, basis: 'workday' };
}

function dedupeKey(m: any) {
  return `meeting_brief:${m.eventId}:${new Date(m.start).toISOString()}`;
}

/**
 * The upcoming occurrence that is due a brief now: starts after `now` and
 * within `leadMinutes`.
 */
function dueForBrief(m: any, { now = new Date(), leadMinutes = 60 }: { now?: any; leadMinutes?: number } = {}) {
  const start = new Date(m.start).getTime();
  const t = new Date(now).getTime();
  return start > t && start - t <= leadMinutes * 60_000;
}

module.exports = {
  KINDS,
  KIND_LABEL,
  timeOf,
  seriesKey,
  seriesLabel,
  cleanDescription,
  joinUrlOf,
  toMeeting,
  isAllDayRange,
  eligibility,
  classifyDeterministic,
  normaliseKind,
  standupWindow,
  dedupeKey,
  dueForBrief,
  domainOf,
};
