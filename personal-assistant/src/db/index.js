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

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 8,
      idleTimeoutMillis: 30_000,
      // A dead Postgres should fail the command, not hang the CLI.
      connectionTimeoutMillis: 5_000,
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

module.exports = { getPool, query, rows, one, withTx, close, probe };
