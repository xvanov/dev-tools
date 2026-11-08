'use strict';

// The one connection pool. Everything that touches Postgres goes through here.
//
// `withTx` exists because the ingest path has a genuine invariant to protect:
// a source item and its sync cursor advance together or not at all. Writing the
// item, crashing, and then advancing the cursor on restart loses the item
// silently — the cursor says we already have it. So they share a transaction.

const { Pool } = require('pg');
const { config } = require('../config');

let pool = null;

// A test process must never reach the operator's real database: a test once wrote its stub's error
// into the live factory_board row on every run. A process counts as a test when the shared runner
// set PA_TESTING, or when it was started as `node ...test.js`. It may connect only to a database
// whose name starts with `pa_test_` (a throwaway DB or one the test created); anything else
// throws before a connection is attempted. The runner points PA_DATABASE_URL at a blocked name,
// so a stray query in a test fails loudly instead of reading or writing real rows.
function isTestProcess() {
  return Boolean(process.env.PA_TESTING) || /\.test\.js$/i.test(process.argv[1] || '');
}

function assertSafeForTests(url) {
  if (!isTestProcess()) return;
  let dbName = '';
  try { dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch { /* unparseable: refused below */ }
  if (!/^pa_test_/i.test(dbName)) {
    throw new Error(`refusing to connect a test process to database "${dbName || '?'}": tests may only use a database named pa_test_* (set PA_DATABASE_URL to a throwaway one), and most should stub src/db instead`);
  }
}

function getPool() {
  if (!pool) {
    assertSafeForTests(config.databaseUrl);
    pool = new Pool({
      connectionString: config.databaseUrl,
      // The worker runs a dozen passes concurrently (one every 5 s for the
      // Teams cache), holds one connection for its single-instance lock, and
      // serves the dashboard. Eight was enough before that; passes then queued
      // for a client past the timeout and failed with "Connection terminated
      // due to connection timeout" — a pool wait, not a dead database.
      max: 20,
      idleTimeoutMillis: 30_000,
      // A dead Postgres should fail the command, not hang the CLI. The
      // timeout also bounds the wait for a free pool slot, hence not 5 s.
      connectionTimeoutMillis: 15_000,
    });
    pool.on('error', () => {
      // An idle client dying is not fatal; pg will make another. Swallowing it
      // here stops it from taking the process down as an unhandled 'error'.
    });
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function rows(text, params) {
  const r = await query(text, params);
  return r.rows;
}

async function one(text, params) {
  const r = await query(text, params);
  return r.rows[0] ?? null;
}

async function withTx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The rollback failing means the connection is gone; the original error
      // is the one worth reporting.
    }
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

// Cheap liveness + capability probe for `pa doctor`.
async function probe() {
  const r = await query(
    `select current_database() as db,
            (select count(*) from pg_extension where extname = 'vector') > 0 as has_vector`
  );
  return r.rows[0];
}

module.exports = { assertSafeForTests, getPool, query, rows, one, withTx, close, probe };
