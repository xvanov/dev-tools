'use strict';

// "When?" in the words a person types: the follow-up box on the dashboard,
// `pa answer <id> <when>`. Pure: no clock of its own (pass `now`), no
// database, local time throughout.
//
//   parseWhen('5m', now)            → { at, kind: 'duration', canonical: '5m', ms }
//   parseWhen('tomorrow 3pm', now)  → { at, kind: 'absolute', canonical: 'at:<ISO>' }
//   parseWhen('fortnight', now)     → null
//
// Understood: a duration ("5m", "90 min", "2h", "2 hours", "2d", "1w", "in 3
// days"); "tomorrow" / "today" / a weekday ("mon", "next fri") with an
// optional time ("9", "9:30", "3pm", "15:00"; 09:00 when none); "next week"
// (Monday 09:00); a bare time ("3pm": today, or tomorrow once it has passed);
// an ISO date or date-time ("2026-11-10", "2026-11-10 14:00", and the
// "2026-11-10T14:00" a date-time picker sends); and its own canonical forms
// back ("at:<ISO>"). Anything in the past, or more than a year out, is null.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Unit = 'm' | 'h' | 'd' | 'w';
type HourMinute = [number, number];

interface When {
  at: Date;
  kind: 'duration' | 'absolute';
  canonical: string;
  ms?: number;
}

const UNIT_MS: Record<Unit, number> = { m: 60_000, h: 3600_000, d: 86400_000, w: 7 * 86400_000 };
const UNIT_WORDS: Array<[RegExp, Unit]> = [
  [/^(m|min|mins|minute|minutes)$/, 'm'],
  [/^(h|hr|hrs|hour|hours)$/, 'h'],
  [/^(d|day|days)$/, 'd'],
  [/^(w|wk|wks|week|weeks)$/, 'w'],
];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MORNING = 9;
const MAX_AHEAD_MS = 366 * 86400_000;

function unitOf(word: string): Unit | null {
  for (const [re, u] of UNIT_WORDS) if (re.test(word)) return u;
  return null;
}

// "9", "9:30", "3pm", "3:30 pm", "15:00", "at 15:00" → [h, m] or null.
function timeOf(text: string): HourMinute | null {
  const m = /^(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  } else if (h > 23) return null;
  return [h, min];
}

// "mon", "tues", "thurs", "friday": three letters or more of the day's name.
function dayIndex(word: string): number {
  if (word.length < 3) return -1;
  return DAYS.findIndex((full) => full.startsWith(word));
}

function at(base: Date, [h, m]: HourMinute): Date {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

function result(date: Date | null, now: Date, kind: When['kind'], extra: { canonical?: string; ms?: number } = {}): When | null {
  if (!date || Number.isNaN(+date) || date <= now || +date - +now > MAX_AHEAD_MS) return null;
  return { at: date, kind, canonical: kind === 'duration' ? extra.canonical ?? '' : `at:${date.toISOString()}`, ...extra };
}

/** What was typed, as a time after `now`; null when it is not one, is past, or is over a year out. */
function parseWhen(text: string | null | undefined, now: Date | number | string = new Date()): When | null {
  now = new Date(now);
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t || t.length > 60) return null;

  // Our own canonical form, and ISO from a date-time picker or a hand.
  if (t.startsWith('at:')) return result(new Date(String(text).trim().slice(3)), now, 'absolute');
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2}))?$/.exec(t);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : MORNING, m[5] ? Number(m[5]) : 0);
    if (d.getMonth() !== Number(m[2]) - 1) return null; // 2026-02-31
    return result(d, now, 'absolute');
  }

  // A duration: "5m", "5 min", "in 2 hours", "1.5h".
  m = /^(?:in )?(\d+(?:\.\d+)?) ?([a-z]+)$/.exec(t);
  const durationUnit = m ? unitOf(m[2] as string) : null;
  if (m && durationUnit) {
    const u = durationUnit;
    const n = Number(m[1]);
    if (!(n > 0)) return null;
    const ms = Math.round(n * UNIT_MS[u]);
    const canonical = Number.isInteger(n) ? `${n}${u}` : `${Math.round(ms / 60_000)}m`;
    return result(new Date(now.getTime() + ms), now, 'duration', { canonical, ms });
  }
  // "an hour", "a day", "a week".
  m = /^(?:in )?an? ([a-z]+)$/.exec(t);
  const oneUnit = m ? unitOf(m[1] as string) : null;
  if (m && oneUnit) {
    const u = oneUnit;
    return result(new Date(now.getTime() + UNIT_MS[u]), now, 'duration', { canonical: `1${u}`, ms: UNIT_MS[u] });
  }

  if (t === 'next week') {
    const d = new Date(now);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    return result(at(d, [MORNING, 0]), now, 'absolute');
  }

  // "<day word> [time]".
  m = /^(today|tonight|tomorrow|tmrw|tmr|(?:next )?[a-z]+)(?: (?:at )?(.+))?$/.exec(t);
  if (m) {
    const word = m[1] as string;
    const time = m[2] ? timeOf(m[2]) : null;
    if (m[2] && !time) return null;
    const d = new Date(now);
    if (word === 'today' || word === 'tonight') {
      if (!time && word === 'today') return null; // "today" alone says nothing
      return result(at(d, time || [20, 0]), now, 'absolute');
    }
    if (word === 'tomorrow' || word === 'tmrw' || word === 'tmr') {
      d.setDate(d.getDate() + 1);
      return result(at(d, time || [MORNING, 0]), now, 'absolute');
    }
    const name = word.replace(/^next /, '');
    const i = dayIndex(name);
    if (i >= 0) {
      // The next one strictly after today; "next fri" on a Thursday is still tomorrow.
      d.setDate(d.getDate() + ((i - d.getDay() + 7) % 7 || 7));
      return result(at(d, time || [MORNING, 0]), now, 'absolute');
    }
  }

  // A bare time: today, or tomorrow once it has passed.
  const time = timeOf(t);
  if (time && (/[ap]m$/.test(t) || t.includes(':') || t.startsWith('at '))) {
    let d = at(now, time);
    if (d <= now) {
      d = new Date(d);
      d.setDate(d.getDate() + 1);
    }
    return result(d, now, 'absolute');
  }
  return null;
}

module.exports = { parseWhen, timeOf };
