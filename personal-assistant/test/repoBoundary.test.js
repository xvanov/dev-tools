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
  'src/agent/planner.js',
  'src/audio/gate.js',
  'src/backup.js',
  'src/brief/index.js',
  'src/chat/fastLane.js',
  'src/cli/index.js',
  'src/commitments.js',
  'src/commitments/blocks.js',
  'src/commitments/context.js',
  'src/commitments/dedupe.js',
  'src/commitments/policyClose.js',
  'src/commitments/replyClose.js',
  'src/commitments/request.js',
  'src/commitments/selfNotes.js',
  'src/dashboard/architecture.js',
  'src/dashboard/cards.js',
  'src/dashboard/factory.js',
  'src/dashboard/server.js',
  'src/dispatch/delivery.js',
  'src/dispatch/factory.js',
  'src/dispatch/index.js',
  'src/dispatch/stats.js',
  'src/distill/identity.js',
  'src/distill/index.js',
  'src/draft/index.js',
  'src/durable/index.js',
  'src/durable/spawners.js',
  'src/durable/tasks/chase.js',
  'src/durable/tasks/runReview.js',
  'src/e2e/deployTest.js',
  'src/e2e/goldenPath.js',
  'src/eval/index.js',
  'src/eval/seed.js',
  'src/ingest/audio.js',
  'src/ingest/githubReconcile.js',
  'src/ingest/graphChat.js',
  'src/ingest/health.js',
  'src/ingest/jira.js',
  'src/ingest/store.js',
  'src/ingest/teamsLocal.js',
  'src/ledger/index.js',
  'src/ledger/reconcile.js',
  'src/mcp/chatTools.js',
  'src/mcp/server.js',
  'src/meetings/debrief.js',
  'src/meetings/index.js',
  'src/memory/consolidate.js',
  'src/memory/dream.js',
  'src/memory/extract.js',
  'src/memory/index.js',
  'src/memory/pages.js',
  'src/projects/index.js',
  'src/projects/rescore.js',
  'src/proposals/index.js',
  'src/recall/index.js',
  'src/repos/index.js',
  'src/repos/sources.js',
  'src/routines/actions/repoSync.js',
  'src/routines/index.js',
  'src/routines/suggest.js',
  'src/search/embedCache.js',
  'src/search/index.js',
  'src/secrets/index.js',
]);

// May require src/db for the pool's lifecycle (a dedicated connection, close
// on exit), never to run a statement; a SQL call in them still fails.
const POOL_ONLY = new Map([
  ['src/worker.js', 'the lease connection (getPool().connect) and close on exit'],
]);

const REQUIRES_DB =/\brequire\(\s*['"](?:\.\.?\/)+db['"]\s*\)/;
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
  return (!POOL_ONLY.has(f) && REQUIRES_DB.test(t)) || SQL_CALL.test(t) || BARE_SQL_CALL.test(t);
};

const unconverted = files.filter(hasSql);
const notListed = unconverted.filter((f) => !PENDING.has(f));
const stale = [...PENDING].filter((f) => !fs.existsSync(path.join(ROOT, f)) || !hasSql(f));

assert.deepStrictEqual(notListed, [], `SQL outside src/repo (move it into a repository method):\n  ${notListed.join('\n  ')}`);
assert.deepStrictEqual(stale, [], `converted (or gone): delete these lines from PENDING in test/repoBoundary.test.js:\n  ${stale.join('\n  ')}`);
console.log(`repoBoundary: ok (${PENDING.size} module(s) still to convert)`);
