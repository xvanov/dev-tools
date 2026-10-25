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

function secondChaseAt(nudgedAt) {
  return workingMorning(new Date(new Date(nudgedAt).getTime() + SECOND_WAIT_HOURS * 3600_000));
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

module.exports = { firstChaseAt, secondChaseAt, worthChasing, workingMorning, secondsUntil, MAX_NUDGES_PER_DAY, MAX_AGE_DAYS };
