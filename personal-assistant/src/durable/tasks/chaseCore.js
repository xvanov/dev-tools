'use strict';

// The pure half of chasing (chase.js): when to look again, and whether a
// commitment is one worth chasing at all. No database, no clock of its own.

const FIRST_WAIT_HOURS = 48;
const SECOND_WAIT_HOURS = 72;
const MAX_NUDGES_PER_DAY = 3;
// Older than this when the chase would start: it is no longer a live ask, and
// a surprise nudge about it would read as noise.
const MAX_AGE_DAYS = 10;
const MORNING_HOUR = 9;

const CHANNELS = new Set(['graph_chat', 'graph_mail']);

// How long to wait before following up: I am asked once per ask (chase.js),
// and the answer I last gave for the same person is the one marked usual.
const CADENCES = [
  { value: '4h', label: 'In 4 hours', hours: 4 },
  { value: '1d', label: 'Tomorrow', hours: 24 },
  { value: '2d', label: 'In 2 days', hours: 48 },
  { value: '1w', label: 'In a week', hours: 168 },
  { value: 'never', label: "Don't chase", hours: null },
];

const cadence = (value) => CADENCES.find((c) => c.value === value) || null;

/** The buttons for the question, the usual answer marked. */
function cadenceOptions(usual) {
  return CADENCES.map((c) => ({ value: c.value, label: c.value === usual ? `${c.label} (usual)` : c.label }));
}

/**
 * When to chase for a cadence answer, counted from `from`: inside working
 * hours, so "in 4 hours" at 16:00 means the next morning. Null: don't chase.
 * Undefined: not a cadence I know.
 */
function chaseAtFor(value, from) {
  const c = cadence(value);
  if (!c) return undefined;
  if (c.hours == null) return null;
  return workingMorning(new Date(new Date(from).getTime() + c.hours * 3600_000));
}

/** The gap before the one reminder after a nudge: half as long again. */
function secondGapHours(value) {
  const c = cadence(value);
  return c && c.hours ? Math.max(4, c.hours * 1.5) : SECOND_WAIT_HOURS;
}

/** The next working-day morning at or after `d` (local time). */
function workingMorning(d) {
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
function firstChaseAt(c, now = new Date()) {
  const due = c.due_at ? new Date(c.due_at) : null;
  const base = due ? new Date(due.getTime() + 2 * 3600_000) : new Date(new Date(c.asked_at).getTime() + FIRST_WAIT_HOURS * 3600_000);
  return workingMorning(base < now ? now : base);
}

function secondChaseAt(nudgedAt, value = null) {
  return workingMorning(new Date(new Date(nudgedAt).getTime() + secondGapHours(value) * 3600_000));
}

/**
 * Whether to chase this one at all: someone owes me, in a chat or mail
 * thread I can answer in, recent enough to still be a live ask.
 */
function worthChasing(c, now = new Date()) {
  if (!c || c.status !== 'open' || c.direction !== 'owed_to_me') return false;
  if (!c.counterparty_person_id || c.counterparty_is_me) return false;
  if (!CHANNELS.has(c.source)) return false;
  return now - new Date(c.asked_at) <= MAX_AGE_DAYS * 86400_000;
}

/** Seconds from `now` until `at`, at least one. */
function secondsUntil(at, now = new Date()) {
  return Math.max(1, Math.ceil((new Date(at) - now) / 1000));
}

module.exports = { CADENCES, cadenceOptions, chaseAtFor, secondGapHours, firstChaseAt, secondChaseAt, worthChasing, workingMorning, secondsUntil, MAX_NUDGES_PER_DAY, MAX_AGE_DAYS };
