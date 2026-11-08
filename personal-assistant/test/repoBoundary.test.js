'use strict';

// Plan 1.2 (done): SQL lives only in src/repo (the repositories) and src/db
// (the pool and migrations). A module elsewhere that requires src/db or the pg
// driver, or calls .query/.rows/.one with a SQL literal, fails here: put the
// statement in a repository method (with its contract case and SQLite twin).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// May require src/db for the pool's lifecycle (a dedicated connection, close
// on exit), never to run a statement; a SQL call in them still fails.
const POOL_ONLY = new Map([
  ['src/routines/index.js', "the routine lock's own connection (getPool().connect); its statements are repo.leases / repo.routines"],
  ['src/worker.js', 'the lease connection (getPool().connect) and close on exit'],
  ['src/cli/index.js', 'the pool lifecycle (db.probe for pa doctor, db.close on exit); its statements are repository methods'],
  ['src/durable/durable.ts','the pool, handed to absurd-sdk (the queue driver); its statements are repository methods'],
  ['src/e2e/deployTest.js', 'its own pg Client to the target store, the producer session; the statement is repo.events.publishProbe'],
  ['src/mcp/server.ts', 'closes the pool on exit; its statements are repository methods'],
  ['src/events/index.js', 'the dedicated LISTEN connection (pg Client); its statements are repo.events'],
]);

const REQUIRES_DB = /\brequire\(\s*['"](?:\.\.?\/)+db['"]\s*\)/;
// The driver itself: a statement built in a variable escapes the call patterns.
const REQUIRES_PG = /\brequire\(\s*['"]pg['"]\s*\)/;
const SQL_CALL = /\.(?:query|rows|one)\(\s*[`'"]\s*(?:select|insert|update|delete|with|create|alter|drop|lock|listen|notify|truncate)\b/i;
const BARE_SQL_CALL = /(?<![\w.])(?:query|rows|one)\(\s*[`'"]\s*(?:select|insert|update|delete|with)\b/i;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'bin'))]
  .map((p) => path.relative(ROOT, p).split(path.sep).join('/'))
  .filter((f) => !/^src\/(repo|db)\//.test(f));

const hasSql = (f) => {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  return (!POOL_ONLY.has(f) && (REQUIRES_DB.test(t) || REQUIRES_PG.test(t))) || SQL_CALL.test(t) || BARE_SQL_CALL.test(t);
};

const unconverted = files.filter(hasSql);

assert.deepStrictEqual(unconverted, [], `SQL outside src/repo (move it into a repository method):\n  ${unconverted.join('\n  ')}`);
console.log(`repoBoundary: ok (${files.length} modules, SQL only in src/repo and src/db)`);
