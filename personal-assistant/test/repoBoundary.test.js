'use strict';

// Plan 1.2: SQL lives only in src/repo (the repositories) and src/db (the pool
// and migrations). A module elsewhere that requires src/db, or calls
// .query/.rows/.one with a SQL literal, has not been converted. PENDING lists
// the modules not converted yet; it may only shrink. A file not on it that has
// SQL fails, and so does a file on it that no longer has any (delete its line).
// Exit 1 needs PENDING empty.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const PENDING = new Set([
  'src/dashboard/factory.js',
  'src/dispatch/delivery.js',
  'src/dispatch/factory.js',
  'src/dispatch/index.js',
  'src/dispatch/stats.js',
  'src/durable/index.js',
  'src/durable/spawners.js',
  'src/durable/tasks/chase.js',
  'src/durable/tasks/runReview.js',
  'src/e2e/deployTest.js',
  'src/e2e/goldenPath.js',
  'src/ingest/githubReconcile.js',
  'src/ingest/graphChat.js',
  'src/ingest/health.js',
  'src/ingest/jira.js',
  'src/ingest/store.js',
  'src/ingest/teamsLocal.js',
  'src/mcp/chatTools.js',
  'src/mcp/server.js',
  'src/repos/index.js',
  'src/repos/sources.js',
  'src/routines/actions/repoSync.js',
  'src/routines/index.js',
  'src/routines/suggest.js',
]);

// May require src/db for the pool's lifecycle (a dedicated connection, close
// on exit), never to run a statement; a SQL call in them still fails.
const POOL_ONLY = new Map([
  ['src/worker.js', 'the lease connection (getPool().connect) and close on exit'],
  ['src/cli/index.js', 'the pool lifecycle (db.probe for pa doctor, db.close on exit); its statements are repository methods'],
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
const notListed = unconverted.filter((f) => !PENDING.has(f));
const stale = [...PENDING].filter((f) => !fs.existsSync(path.join(ROOT, f)) || !hasSql(f));

assert.deepStrictEqual(notListed, [], `SQL outside src/repo (move it into a repository method):\n  ${notListed.join('\n  ')}`);
assert.deepStrictEqual(stale, [], `converted (or gone): delete these lines from PENDING in test/repoBoundary.test.js:\n  ${stale.join('\n  ')}`);
console.log(`repoBoundary: ok (${PENDING.size} module(s) still to convert)`);
