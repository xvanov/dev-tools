'use strict';

// The pure half of chasing (chase.ts): when to look again, and whether a
// commitment is one worth chasing at all. No database, no clock of its own.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../../repo/types.ts').Row;
/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../../types.ts').Json;

const FIRST_WAIT_HOURS = 48;
const SECOND_WAIT_HOURS = 72;
const MAX_NUDGES_PER_DAY = 3;
// Older than this when the chase would start: it is no longer a live ask, and
// a surprise nudge about it would read as noise.
const MAX_AGE_DAYS = 10;
const MORNING_HOUR = 9;

const CHANNELS = new Set(['graph_chat', 'graph_mail']);

// How long to wait before following up: I am asked once per ask (chase.ts),
// and the answer I last gave for the same person is the one marked usual.
const CADENCES = [
  { value: '4h', label: 'In 4 hours', hours: 4 },
  { value: '1d', label: 'Tomorrow', hours: 24 },
  { value: '2d', label: 'In 2 days', hours: 48 },
  { value: '1w', label: 'In a week', hours: 168 },
  { value: 'never', label: "Don't chase", hours: null },
];

const cadence = (value: any) => CADENCES.find((c) => c.value === value) || null;
const { parseWhen } = require('../../util/when.ts');

/** The buttons for the question, the usual answer marked. */
function cadenceOptions(usual: any) {
  return CADENCES.map((c) => ({ value: c.value, label: c.value === usual ? `${c.label} (usual)` : c.label }));
}

/**
 * When to chase for a cadence answer, counted from `from`. The fixed answers
 * (4h, 1d, 2d, 1w) stay inside working hours, so "in 4 hours" at 16:00 means
 * the next morning. Anything else typed or picked on the dashboard ("5m",
 * "tomorrow 3pm", "at:<ISO>", src/util/when.ts) is taken literally. Null:
 * don't chase. Undefined: not an answer I understand.
 */
function chaseAtFor(value: any, from: any) {
  const c = cadence(value);
  if (c) {
    if (c.hours == null) return null;
    return workingMorning(new Date(new Date(from).getTime() + c.hours * 3600_000));
  }
  const w = parseWhen(value, from);
  return w ? w.at : undefined;
}

/** The gap before the one reminder after a nudge: half as long again. */
function secondGapHours(value: any) {
  const c = cadence(value);
  if (c) return c.hours ? Math.max(4, c.hours * 1.5) : SECOND_WAIT_HOURS;
  const w = value ? parseWhen(value, new Date()) : null;
  return w && w.kind === 'duration' ? Math.max(4, (w.ms / 3600_000) * 1.5) : SECOND_WAIT_HOURS;
}

/**
 * An answer to "when should I follow up?" as it is stored: a fixed value as
 * is, anything else in its canonical form ("5m", "at:<ISO>"), so the chase
 * computes exactly what the page previewed. Null: not an answer I understand
 * (or a time already past).
 */
function cadenceAnswer(text: any, now: any = new Date()) {
  const t = String(text || '').trim();
  if (cadence(t)) return t;
  const w = parseWhen(t, now);
  return w ? w.canonical : null;
}

/**
 * Whether an answer can be someone's *usual*: a span of at least an hour.
 * "Don't chase this one", "in 5 minutes" or "Friday 3pm" was about that ask,
 * not about how long that person usually takes.
 */
function usualWorthy(value: any) {
  const c = cadence(value);
  if (c) return c.hours != null;
  const w = /^(\d+)([mhdw])$/.exec(String(value || ''));
  if (!w) return false;
  const hours = Number(w[1]) * (({ m: 1 / 60, h: 1, d: 24, w: 168 } as Record<string, number>)[w[2] as string] as number);
  return hours >= 1;
}

/** The next working-day morning at or after `d` (local time). */
function workingMorning(d: any) {
  const t = new Date(d);
  if (t.getHours() >= 17) {
    t.setDate(t.getDate() + 1);
    t.setHours(MORNING_HOUR, 0, 0, 0);
  } else if (t.getHours() < MORNING_HOUR) t.setHours(MORNING_HOUR, 0, 0, 0);
  while (t.getDay() === 0 || t.getDay() === 6) {
    t.setDate(t.getDate() + 1);
    t.setHours(MORNING_HOUR, 0, 0, 0);
  }
  return t;
}

/**
 * When to chase first: a little after it was due, or two days after the
 * promise — on a working morning, and never in the past.
 * @param {object} c {due_at, asked_at}
 */
function firstChaseAt(c: any, now: any = new Date()) {
  const due = c.due_at ? new Date(c.due_at) : null;
  const base = due ? new Date(due.getTime() + 2 * 3600_000) : new Date(new Date(c.asked_at).getTime() + FIRST_WAIT_HOURS * 3600_000);
  return workingMorning(base < now ? now : base);
}

function secondChaseAt(nudgedAt: any, value: any | null = null) {
  return workingMorning(new Date(new Date(nudgedAt).getTime() + secondGapHours(value) * 3600_000));
}

/**
 * Whether to chase this one at all: someone owes me, in a chat or mail
 * thread I can answer in, recent enough to still be a live ask.
 */
function worthChasing(c: any, now: any = new Date()) {
  if (!c || c.status !== 'open' || c.direction !== 'owed_to_me') return false;
  if (!c.counterparty_person_id || c.counterparty_is_me) return false;
  if (!CHANNELS.has(c.source)) return false;
  return now - Number(new Date(c.asked_at)) <= MAX_AGE_DAYS * 86400_000;
}

/** Seconds from `now` until `at`, at least one. */
function secondsUntil(at: any, now: any = new Date()) {
  return Math.max(1, Math.ceil((Number(new Date(at)) - now) / 1000));
}

module.exports = { CADENCES, cadenceOptions, chaseAtFor, cadenceAnswer, usualWorthy, secondGapHours, firstChaseAt, secondChaseAt, worthChasing, workingMorning, secondsUntil, MAX_NUDGES_PER_DAY, MAX_AGE_DAYS };
