'use strict';

// The follow-up box's words (src/util/when.js) and how a chase uses them
// (src/durable/tasks/chaseCore.js): pure, local time, a fixed `now`.

const assert = require('assert');
const { parseWhen } = require('../src/util/when');
const C = require('../src/durable/tasks/chaseCore');

const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const thu = local(2026, 11, 5, 14, 10); // a Thursday afternoon
const p = (t, now = thu) => parseWhen(t, now);
const atOf = (t, now = thu) => +p(t, now).at;

{
  // Durations: literal, from now.
  assert.strictEqual(atOf('5m'), +thu + 5 * 60_000);
  assert.strictEqual(atOf('5 min'), +thu + 5 * 60_000);
  assert.strictEqual(atOf('in 90 minutes'), +thu + 90 * 60_000);
  assert.strictEqual(atOf('2h'), +thu + 2 * 3600_000);
  assert.strictEqual(atOf('2 Hours'), +thu + 2 * 3600_000);
  assert.strictEqual(atOf('1.5h'), +thu + 90 * 60_000);
  assert.strictEqual(atOf('an hour'), +thu + 3600_000);
  assert.strictEqual(atOf('2d'), +thu + 2 * 86400_000);
  assert.strictEqual(atOf('1w'), +thu + 7 * 86400_000);
  assert.deepStrictEqual([p('5m').kind, p('5m').canonical, p('5m').ms], ['duration', '5m', 300_000]);
  assert.strictEqual(p('1.5h').canonical, '90m');
  assert.strictEqual(p('2 days').canonical, '2d');
}

{
  // Days and times.
  assert.strictEqual(atOf('tomorrow'), +local(2026, 11, 6, 9));
  assert.strictEqual(atOf('tomorrow 3pm'), +local(2026, 11, 6, 15));
  assert.strictEqual(atOf('tomorrow at 15:30'), +local(2026, 11, 6, 15, 30));
  assert.strictEqual(atOf('tmrw 9'), +local(2026, 11, 6, 9));
  assert.strictEqual(atOf('today 5pm'), +local(2026, 11, 5, 17));
  assert.strictEqual(p('today 9am'), null); // already past
  assert.strictEqual(p('today'), null);
  assert.strictEqual(atOf('mon'), +local(2026, 11, 9, 9));
  assert.strictEqual(atOf('Monday 2pm'), +local(2026, 11, 9, 14));
  assert.strictEqual(atOf('thu'), +local(2026, 11, 12, 9)); // today's weekday: next week's
  assert.strictEqual(atOf('next fri'), +local(2026, 11, 6, 9));
  assert.strictEqual(atOf('tues'), +local(2026, 11, 10, 9));
  assert.strictEqual(atOf('next week'), +local(2026, 11, 9, 9));
  assert.strictEqual(atOf('3pm'), +local(2026, 11, 5, 15));
  assert.strictEqual(atOf('9:00'), +local(2026, 11, 6, 9)); // passed today: tomorrow
  assert.strictEqual(atOf('12am'), +local(2026, 11, 6, 0));
  assert.strictEqual(atOf('12pm'), +local(2026, 11, 6, 12));
  assert.strictEqual(p('tomorrow 3pm').kind, 'absolute');
  assert.ok(/^at:\d{4}-/.test(p('tomorrow 3pm').canonical));
}

{
  // Dates, a date-time picker's value, and the canonical form back.
  assert.strictEqual(atOf('2026-11-10'), +local(2026, 11, 10, 9));
  assert.strictEqual(atOf('2026-11-10 14:00'), +local(2026, 11, 10, 14));
  assert.strictEqual(atOf('2026-11-10T14:00'), +local(2026, 11, 10, 14));
  const c = p('fri 4pm').canonical;
  assert.strictEqual(atOf(c), +local(2026, 11, 6, 16));
  assert.strictEqual(p('2026-02-31'), null);
  assert.strictEqual(p('2026-11-01'), null); // past
  assert.strictEqual(p('2028-01-01'), null); // more than a year out
}

{
  // Nonsense is null, never a guess.
  for (const t of ['', '   ', 'fortnight', 'soon', '0m', '-2h', 'tomorrow 25:00', 'mo', 'tomorrow 13pm', '7', 'x'.repeat(80), null, undefined]) {
    assert.strictEqual(p(t), null, `"${t}" should not parse`);
  }
}

{
  // In a chase: fixed answers keep their working-hours rule, typed ones are literal.
  assert.strictEqual(C.cadenceAnswer('1d'), '1d');
  assert.strictEqual(C.cadenceAnswer('never'), 'never');
  assert.strictEqual(C.cadenceAnswer('5 min', thu), '5m');
  assert.ok(C.cadenceAnswer('tomorrow 3pm', thu).startsWith('at:'));
  assert.strictEqual(C.cadenceAnswer('whenever'), null);
  assert.strictEqual(+C.chaseAtFor('5m', thu), +thu + 5 * 60_000);
  assert.strictEqual(+C.chaseAtFor(C.cadenceAnswer('tomorrow 3pm', thu), thu), +local(2026, 11, 6, 15));
  const evening = local(2026, 11, 5, 18);
  assert.strictEqual(+C.chaseAtFor('1h', evening), +local(2026, 11, 5, 19)); // literal
  assert.strictEqual(+C.chaseAtFor('4h', evening), +local(2026, 11, 6, 9)); // fixed: next working morning
  assert.strictEqual(C.chaseAtFor('fortnight', thu), undefined);
  assert.strictEqual(C.secondGapHours('2h'), 4);
  assert.strictEqual(C.secondGapHours('3d'), 108);
  assert.strictEqual(C.secondGapHours(C.cadenceAnswer('mon', thu)), 72);
  // Only a span of an hour or more becomes someone's usual.
  assert.deepStrictEqual(['1d', '4h', '3h', '1w', '2d'].map(C.usualWorthy), [true, true, true, true, true]);
  assert.deepStrictEqual(['never', '5m', '30m', 'at:2026-11-06T15:00:00.000Z', null].map(C.usualWorthy), [false, false, false, false, false]);
}

console.log('when: ok');
