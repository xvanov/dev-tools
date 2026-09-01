'use strict';

// Migrations are numbered SQL files applied in order and recorded by filename.
// No ORM, no framework: the schema is small, it is read by hand as often as by
// code, and a migration you can `cat` is a migration you can trust at 2am.
//
// Each file runs inside one transaction, so a half-applied migration is not a
// state this tool can reach.

const fs = require('fs');
const path = require('path');
const { withTx, query, close } = require('./index');
const { logger } = require('../log');

const log = logger('migrate');
const SQL_DIR = path.resolve(__dirname, '..', '..', 'sql');

async function ensureRegistry() {
  await query(`
    create table if not exists schema_migration (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

function migrationFiles() {
  return fs
    .readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function applied() {
  const r = await query('select version from schema_migration');
  return new Set(r.rows.map((row) => row.version));
}

async function migrate() {
  await ensureRegistry();
  const done = await applied();
  const pending = migrationFiles().filter((f) => !done.has(f));

  if (!pending.length) {
    log.info('schema up to date', { applied: done.size });
    return { applied: [] };
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
    await withTx(async (client) => {
      await client.query(sql);
      await client.query('insert into schema_migration (version) values ($1)', [file]);
    });
    log.info('applied', { file });
  }
  return { applied: pending };
}

module.exports = { migrate, migrationFiles };

if (require.main === module) {
  migrate()
    .then(() => close())
    .catch(async (err) => {
      log.error('migration failed', { message: err.message });
      await close();
      process.exitCode = 1;
    });
}
