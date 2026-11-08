'use strict';

// The backends the repository contract runs against (plan 1.3). Each entry
// makes a fresh, empty, migrated store and returns {db, repos, seed, teardown},
// or {skip: reason} when it cannot run here: `postgres` and (phase 3) `sqlite`.
// The contract files (test/contract/*.contract.js) are the same for both.
//
// postgres: a throwaway database `pa_test_contract_<pid>_<rand>` on the server
// PA_TEST_PG_URL names (any database on it, e.g. .../postgres), created from
// the template `pa_test_template` when it exists (it holds the
// superuser-only extensions, vector and pg_trgm, so a role with CREATEDB is
// enough; scripts/README.md), migrated with src/db/migrate.js, dropped after.
// Without PA_TEST_PG_URL it tries the work stack's local server
// (127.0.0.1:5433) and SKIPS when that is not reachable or refuses; with it,
// any failure is a failure (CI sets it). Only pa_test_* names are created or
// dropped, and src/db's test guard refuses anything else for the backend.

const crypto = require('crypto');

const DEFAULT_ADMIN = 'postgres://pa:pa@127.0.0.1:5433/postgres';

function withDb(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function postgres() {
  const { Client } = require('pg');
  const explicit = process.env.PA_TEST_PG_URL || '';
  const admin = explicit || DEFAULT_ADMIN;
  const name = `pa_test_contract_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  if (!/^pa_test_/.test(name)) throw new Error('unreachable');

  const c = new Client({ connectionString: admin, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    const tpl = await c.query(`select 1 from pg_database where datname = 'pa_test_template'`);
    await c.query(`create database ${name}${tpl.rows.length ? ' template pa_test_template' : ''}`);
  } catch (err) {
    await c.end().catch(() => {});
    if (explicit) throw err;
    return { skip: `no Postgres to create a pa_test_* database on (${err.code || err.message}); set PA_TEST_PG_URL` };
  }

  const dbmod = require('../../src/db');
  const db = dbmod.createBackend(withDb(admin, name));
  const teardown = async () => {
    await db.close().catch(() => {});
    await c.query(`drop database if exists ${name} with (force)`).catch(() => {});
    await c.end().catch(() => {});
  };
  try {
    await require('../../src/db/migrate').migrate(db);
  } catch (err) {
    await teardown();
    throw err;
  }
  const { createRepos } = require('../../src/repo');
  return { name: 'postgres', db, repos: createRepos(db), seed: require('./_seed').postgres(db), teardown };
}

// sqlite (plan 3.2): a throwaway encrypted file pa_test_contract_<pid>.sqlite
// in a fresh temp directory, migrated from sql-sqlite/, deleted after. Needs
// no server, so it runs wherever the optional driver is installed (CI's
// matrix job on Linux and Windows); it SKIPS without the driver. Seeds and
// t.db take the same pg-flavoured SQL as on Postgres (_pgish.js).
async function sqlite() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { available, createSqliteBackend } = require('../../src/db/sqlite');
  if (!available()) return { skip: 'better-sqlite3-multiple-ciphers is not installed (an optional dependency; npm install)' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-contract-'));
  const db = createSqliteBackend(path.join(dir, `pa_test_contract_${process.pid}.sqlite`), { key: 'contract-test-key' });
  const teardown = async () => {
    await db.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    await db.migrate();
  } catch (err) {
    await teardown();
    throw err;
  }
  const { createRepos } = require('../../src/repo');
  const { pgish } = require('./_pgish');
  const tdb = pgish(db);
  return { name: 'sqlite', db: tdb, repos: createRepos(db), seed: require('./_seed').postgres(tdb), teardown };
}

module.exports = { postgres, sqlite };
