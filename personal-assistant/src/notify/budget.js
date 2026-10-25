'use strict';

// The interrupt budget: which notifications may interrupt you, and which
// wait for a digest (DURABLE.md §2.4). Pure — no clock, no database — so the
// rules are tested rather than trusted (test/attention.test.js).
//
// An assistant that toasts everything gets its toasts turned off, and then
// it cannot reach you for the one thing that mattered. So:
//
//   urgent  — someone or something cannot wait (a meeting in 30 minutes, a
//             credential a run is blocked on). Pushes past the budget, but
//             not in quiet hours: the evening is yours.
//   normal  — pushes while today's budget lasts (PA_PUSH_BUDGET, 4), unless
//             feedback has demoted its kind below 0.5; then it waits for the
//             digest. Every push counts, urgent ones included, so the budget
//             is the real number of interruptions in a day.
//   digest  — never pushes; it is collected by the next digest.
//
// A kind you have thumbed down to the floor (≤ FEED_BELOW) is not digested
// either: it goes to the dashboard feed and nowhere else. The feed always
// gets the row — the budget decides interruption, never existence.
//
// "Never the same subject twice without new evidence" is notify()'s
// `dedupe_key`, not a rule here: a second notify with the same key never
// reaches decide().

const PRIORITIES = ['urgent', 'normal', 'digest'];
const DELIVERIES = ['push', 'digest', 'feed'];

const DEMOTE_BELOW = 0.5;
const FEED_BELOW = 0.3;

// The feedback flywheel: one step per thumb, multiplicative so it takes as
// many downs to undo an up as it did to earn it, bounded so a kind can always
// climb back.
const WEIGHT_MIN = 0.2;
const WEIGHT_MAX = 2;
const STEP = 1.25;

/**
 * Quiet hours as "from-to" local hours ("19-08", "22-7", "13:00-14:30").
 * '' / 'off' / 'none' → null (never quiet). from == to → null.
 */
function parseQuietHours(spec) {
  const s = String(spec ?? '').trim().toLowerCase();
  if (!s || s === 'off' || s === 'none' || s === '0') return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/.exec(s);
  if (!m) throw new Error(`PA_QUIET_HOURS "${spec}" is not "HH-HH" (e.g. 19-08)`);
  const from = Number(m[1]) * 60 + Number(m[2] || 0);
  const to = Number(m[3]) * 60 + Number(m[4] || 0);
  if (from > 24 * 60 || to > 24 * 60) throw new Error(`PA_QUIET_HOURS "${spec}" has an hour past 24`);
  if (from === to) return null;
  return { from, to };
}

/** Is local time `now` inside the quiet window? Wraps midnight. */
function inQuietHours(quiet, now) {
  const q = typeof quiet === 'string' || quiet == null ? parseQuietHours(quiet) : quiet;
  if (!q) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return q.from < q.to ? t >= q.from && t < q.to : t >= q.from || t < q.to;
}

/**
 * @param {object} a
 * @param {string} [a.priority='normal']  urgent | normal | digest
 * @param {string} [a.kind]               attention kind (for the reason only)
 * @param {number} [a.weight=1]           attention_weight for the kind
 * @param {number} [a.pushedToday=0]      pushes since local midnight
 * @param {number} [a.budget=4]
 * @param {string|object|null} [a.quietHours]
 * @param {Date}   a.now
 * @returns {'push'|'digest'|'feed'}
 */
function decide(a) {
  return explain(a).delivery;
}

/** decide() with the reason, for logs and `pa notify why`. */
function explain({ priority = 'normal', weight = 1, pushedToday = 0, budget = 4, quietHours = null, now = new Date() } = {}) {
  const p = PRIORITIES.includes(priority) ? priority : 'normal';
  const w = Number.isFinite(Number(weight)) ? Number(weight) : 1;
  if (p !== 'urgent' && w <= FEED_BELOW) return { delivery: 'feed', reason: `weight ${w.toFixed(2)} at the floor` };
  if (p === 'digest') return { delivery: 'digest', reason: 'asked for the digest' };
  if (inQuietHours(quietHours, now)) return { delivery: 'digest', reason: 'quiet hours' };
  if (p === 'urgent') return { delivery: 'push', reason: 'urgent' };
  if (w < DEMOTE_BELOW) return { delivery: 'digest', reason: `weight ${w.toFixed(2)} below ${DEMOTE_BELOW}` };
  if (pushedToday >= budget) return { delivery: 'digest', reason: `budget ${budget} spent` };
  return { delivery: 'push', reason: 'within budget' };
}

/**
 * The weight after a thumb. `prev` is the feedback the notification already
 * had (changing your mind takes the old step back first); same twice is a
 * no-op. Bounded to [WEIGHT_MIN, WEIGHT_MAX].
 */
function nextWeight(weight, prev, next) {
  let w = Number.isFinite(Number(weight)) ? Number(weight) : 1;
  if (prev === next) return clamp(w);
  if (prev === 'up') w /= STEP;
  if (prev === 'down') w *= STEP;
  if (next === 'up') w *= STEP;
  if (next === 'down') w /= STEP;
  return clamp(w);
}

function clamp(w) {
  return Math.round(Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w)) * 1000) / 1000;
}

/**
 * What a weight is kept per. 'info' covers everything from "run ended" to
 * "disk almost full", and thumbing one down must not silence the other, so
 * info rows are split by their dedupe key's prefix ("run-wait:12:…" →
 * "info:run-wait"). Every other kind is already specific.
 */
function attentionKind({ kind, dedupeKey, dedupe_key: dk } = {}) {
  const key = dedupeKey ?? dk;
  if (kind === 'info' && key) {
    const prefix = String(key).split(':')[0].replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
    if (prefix) return `info:${prefix}`;
  }
  return String(kind || 'info');
}

/** Local midnight of `now` — where "today" starts for the budget. */
function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

module.exports = {
  decide, explain, nextWeight, attentionKind, parseQuietHours, inQuietHours, startOfLocalDay,
  PRIORITIES, DELIVERIES, WEIGHT_MIN, WEIGHT_MAX, STEP, DEMOTE_BELOW, FEED_BELOW,
};
