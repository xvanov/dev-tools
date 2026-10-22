'use strict';

// A small 5-field cron: minute hour day-of-month month day-of-week, read in
// the machine's local time. Hand-written rather than a dependency because the
// grammar is twenty lines and the edge cases worth having are the ones tested
// in test/routines.test.js.
//
// Supported: `*`, numbers, lists (`1,3,5`), ranges (`1-5`), steps (`*/15`,
// `0-30/10`, `5/10`), month and weekday names (`jan`, `mon-fri`), 7 as Sunday,
// and the @hourly/@daily/@weekly/@monthly/@yearly shorthands.
//
// Classic cron rule kept on purpose: when both day-of-month and day-of-week are
// restricted, a day matches if EITHER does ("the 1st, and every Monday").
//
// Pure: no clock, no I/O. `next(expr, from)` is the only thing the scheduler
// needs, and it is a function of its arguments.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];

const ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

function value(token, f) {
  const t = token.toLowerCase();
  if (f.names) {
    const i = f.names.indexOf(t);
    if (i >= 0) return f.name === 'month' ? i + 1 : i;
  }
  if (!/^\d+$/.test(t)) throw new Error(`cron ${f.name}: "${token}" is not a number`);
  const n = Number(t);
  if (n < f.min || n > f.max) throw new Error(`cron ${f.name}: ${n} is outside ${f.min}-${f.max}`);
  return n;
}

function parseField(text, f) {
  const out = new Set();
  for (const part of text.split(',')) {
    if (!part) throw new Error(`cron ${f.name}: empty list item in "${text}"`);
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`cron ${f.name}: bad step in "${part}"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`cron ${f.name}: bad step "${stepText}"`);
      step = Number(stepText);
    }
    let lo;
    let hi;
    if (range === '*') {
      lo = f.min;
      hi = f.max;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined || !a || !b) throw new Error(`cron ${f.name}: bad range "${range}"`);
      lo = value(a, f);
      hi = value(b, f);
      if (lo > hi) throw new Error(`cron ${f.name}: range ${range} runs backwards`);
    } else {
      lo = value(range, f);
      // `5/10` means "from 5, every 10" — to the end of the field.
      hi = stepText !== undefined ? f.max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parses a cron expression; throws an Error naming the bad field. */
function parse(expr) {
  const raw = String(expr ?? '').trim().toLowerCase();
  const text = ALIASES[raw] || raw;
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields (minute hour day month weekday), got ${parts.length}: "${expr}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    source: parts.join(' '),
    minute,
    hour,
    dom,
    month,
    dow,
    // A field that starts with `*` (including `*/2`) is unrestricted for the
    // OR rule, as in Vixie cron.
    domStar: parts[2].startsWith('*'),
    dowStar: parts[4].startsWith('*'),
  };
}

function valid(expr) {
  try {
    parse(expr);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(c, d) {
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domStar || c.dowStar) return domOk && dowOk;
  return domOk || dowOk;
}

/**
 * The first matching minute strictly after `from`, in local time.
 * Returns null when nothing matches within ~5 years (e.g. 31 February).
 */
function next(expr, from = new Date()) {
  const c = typeof expr === 'string' ? parse(expr) : expr;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 5 * 366 * 86400_000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      const h = d.getHours();
      d.setHours(h + 1, 0, 0, 0);
      // Daylight saving can make setHours land on the same hour again.
      if (d.getHours() === h) d.setTime(d.getTime() + 3600_000);
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(d.getTime());
  }
  return null;
}

/** The next `n` run times after `from`. */
function upcoming(expr, n = 3, from = new Date()) {
  const c = parse(expr);
  const out = [];
  let t = from;
  while (out.length < n) {
    t = next(c, t);
    if (!t) break;
    out.push(t);
  }
  return out;
}

// ------------------------------------------------------------ in words ----

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

const pad = (n) => String(n).padStart(2, '0');
const sorted = (s) => [...s].sort((a, b) => a - b);

function listWords(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function daysPhrase(c) {
  const dow = sorted(c.dow);
  const dowText = (() => {
    if (c.dow.size === 7) return null;
    const key = dow.join(',');
    if (key === '1,2,3,4,5') return 'Weekdays';
    if (key === '0,6') return 'Weekends';
    return listWords(dow.map((d) => `${DAY_NAMES[d]}s`));
  })();
  const domText = c.dom.size === 31 ? null : `on day ${listWords(sorted(c.dom).map(String))} of the month`;
  let text;
  if (dowText && domText) text = c.domStar || c.dowStar ? `${dowText} ${domText}` : `${dowText}, and ${domText}`;
  else text = dowText || (domText ? domText[0].toUpperCase() + domText.slice(1) : 'Every day');
  if (c.month.size !== 12) text += ` in ${listWords(sorted(c.month).map((m) => MONTH_NAMES[m - 1]))}`;
  return text;
}

function stepOf(set, min, max) {
  const v = sorted(set);
  if (v.length < 2 || v[0] !== min) return null;
  const step = v[1] - v[0];
  for (let i = 1; i < v.length; i++) if (v[i] - v[i - 1] !== step) return null;
  return v[v.length - 1] + step > max ? step : null;
}

/** "Weekdays 08:00", "Every day every 15 minutes", "Mondays 09:30 and 14:30". */
function describe(expr) {
  let c;
  try {
    c = parse(expr);
  } catch {
    return `cron "${expr}"`;
  }
  const days = daysPhrase(c);
  const minutes = sorted(c.minute);
  const hours = sorted(c.hour);
  if (c.minute.size === 60 && c.hour.size === 24) return `${days}, every minute`;
  const minStep = stepOf(c.minute, 0, 59);
  if (minStep && minutes.length > 1) {
    const span = c.hour.size === 24 ? '' : ` between ${pad(hours[0])}:00 and ${pad(hours[hours.length - 1])}:59`;
    return `${days}, every ${minStep} minutes${span}`;
  }
  if (c.hour.size === 24 && minutes.length === 1) return `${days}, hourly at :${pad(minutes[0])}`;
  const times = [];
  for (const h of hours) for (const m of minutes) times.push(`${pad(h)}:${pad(m)}`);
  if (times.length > 6) return `${days}, ${times.length} times a day (cron "${c.source}")`;
  return `${days} ${listWords(times)}`;
}

module.exports = { parse, valid, next, upcoming, describe };
