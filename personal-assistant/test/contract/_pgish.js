'use strict';

// Test-only: lets the contract's seeds (_seed.js) and the few cases that read
// or poke a row directly (t.db) run their plain Postgres SQL on the SQLite
// backend, so a seed is written once. It rewrites the handful of pg-isms
// seeds use; the repositories never go through here (src/repo/sqlite holds
// real SQLite SQL, and that is what the contract checks).
//
//   now()                        strftime('%Y-%m-%dT%H:%M:%fZ','now')
//   now() - interval '2 days'    strftime(..., 'now', '-2 days')
//   $n::vector                   pa_vector($n)  ('[0.1, ...]' text -> float32 BLOB)
//   = any($n[::type[]])          in (select value from json_each($n))
//   ::type, ::type[] casts       dropped
//   for update                   dropped (a SQLite transaction locks the file)
//   md5(x)                       as is: src/db/sqlite.js registers md5 and pa_vector
//
// A seed that needs more than this gets a helper with real SQLite SQL instead.

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** `text` with pg-isms rewritten (casts and clauses outside single quotes). */
function rewrite(text) {
  let out = text.replace(/now\(\)\s*([-+])\s*interval\s*'(\d+)\s*([a-z]+?)s?'/gi, (_, sign, n, unit) => `strftime('%Y-%m-%dT%H:%M:%fZ','now','${sign}${n} ${unit}s')`);
  const parts = out.split(/('(?:[^']|'')*')/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/\$(\d+)::vector\b/gi, 'pa_vector($$$1)')
      .replace(/=\s*any\(\s*(\$\d+)(?:::[a-z_0-9]+\[\])?\s*\)/gi, 'in (select value from json_each($1))')
      .replace(/::[a-z_0-9]+(?:\[\])?/gi, '')
      .replace(/\bfor update\b/gi, '')
      .replace(/\bnow\(\)/gi, NOW);
  }
  out = parts.join('');
  return out;
}

/** A backend like `db` whose query/rows/one take pg-flavoured seed SQL. */
function pgish(db) {
  const q = (text, params) => db.query(rewrite(text), params);
  return {
    ...db,
    query: q,
    rows: async (text, params) => (await q(text, params)).rows,
    one: async (text, params) => (await q(text, params)).rows[0] ?? null,
    pool: db.pool,
  };
}

module.exports = { pgish, rewrite };
