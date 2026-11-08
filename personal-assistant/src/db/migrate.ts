'use strict';

// Migrations are numbered SQL files applied in order and recorded by filename.
// No ORM, no framework: the schema is small, it is read by hand as often as by
// code, and a migration you can `cat` is a migration you can trust at 2am.
//
// Each file runs inside one transaction, so a half-applied migration is not a
// state this tool can reach.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Db = import('../repo/types.ts').Db;
/** What migrating needs of a backend: the pool (src/db) or a contract test's. */
type Target = Pick<Db, 'query' | 'withTx'> & { dialect?: string };

const fs = require('fs');
const path = require('path');
const { withTx, query, close } = require('./index');
const { logger } = require('../log.ts');

const log = logger('migrate');
const SQL_DIR = path.resolve(__dirname, '..', '..', 'sql');

// `db` defaults to the process's pool (src/db); the contract tests pass a
// backend for their throwaway database (src/db createBackend).
const POOL: Target = { withTx, query };

async function ensureRegistry(db: Target = POOL) {
  await db.query(`
    create table if not exists schema_migration (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

function migrationFiles() {
  return fs
    .readdirSync(SQL_DIR)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();
}

async function applied(db: Target = POOL) {
  const r = await db.query('select version from schema_migration');
  return new Set(r.rows.map((row) => row.version));
}

// A vendored schema (vendor/absurd/absurd.sql) is applied by a migration
// holding one `-- include: <path relative to sql/>` line, so the upstream
// file stays byte-for-byte as published and the migration that applied it is
// still a numbered, recorded file in this directory.
function expandIncludes(sql: string) {
  return sql.replace(/^-- include: (\S+)\s*$/gm, (_: string, rel: string) => fs.readFileSync(path.resolve(SQL_DIR, rel), 'utf8'));
}

async function migrate(db: Target = POOL) {
  // SQLite (PA_DB=sqlite, plan 3.1) has its own schema files: sql-sqlite/.
  if (db.dialect === 'sqlite') return require('./sqlite.ts').migrate(db);
  if (db === POOL && require('./index').dialect === 'sqlite') return require('./sqlite.ts').migrate(require('./index').sqliteBackend());
  await ensureRegistry(db);
  const done = await applied(db);
  const pending = migrationFiles().filter((f: string) => !done.has(f));

  if (!pending.length) {
    log.info('schema up to date', { applied: done.size });
    return { applied: [] };
  }

  for (const file of pending) {
    // A byte-order mark (an editor's, on Windows) is a syntax error to Postgres:
    // 032 shipped with one and stopped every worker that had not applied it yet.
    const sql = expandIncludes(fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/^﻿/, ''));
    await db.withTx(async (client) => {
      await client.query(sql);
      await client.query('insert into schema_migration (version) values ($1)', [file]);
    });
    log.info('applied', { file });
  }
  return { applied: pending };
}

module.exports = { migrate, migrationFiles, expandIncludes };

if (require.main === module) {
  migrate()
    .then(() => close())
    .catch(async (err) => {
      log.error('migration failed', { message: err.message });
      await close();
      process.exitCode = 1;
    });
}
