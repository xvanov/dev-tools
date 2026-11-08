'use strict';

// Shared bits of the SQLite repositories (src/repo/sqlite, plan 3.1). Each
// file there is the twin of src/repo/<aggregate>.js: the same methods, names,
// arguments and result shapes, over SQLite SQL (src/db/sqlite.js says how
// values go in and come back). The contract tests (test/contract) hold both
// to the same behaviour.
//
// Postgres -> SQLite, as these files use it:
//   now()                         NOW (UTC ISO text, ms: what timestamptz columns hold)
//   now() - interval 'N days'     sinceMs(N * DAY) computed in JS, or strftime(..., '-N days')
//   = any($1::bigint[])           in (select value from json_each($1))  (pass the array)
//   jsonb ->> / ->                json_extract(col, '$.key')
//   select ... for update         a plain select: a transaction already holds the write lock
//   pg_advisory_xact_lock         nothing: BEGIN IMMEDIATE serialises writers
//   count(*)::int, ::float8       count(*), total(): already numbers
//   (at at time zone tz)::date    pa_local_day(at, tz)
//   nulls last / nulls first      the same (SQLite >= 3.30)

// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** The instant `ms` milliseconds before now (or before `from`), as stored. */
function sinceMs(ms: number, from: Date | string | number = Date.now()) {
  return new Date(new Date(from).getTime() - ms).toISOString();
}

module.exports = { NOW, HOUR, DAY, sinceMs };
