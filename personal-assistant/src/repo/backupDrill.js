'use strict';

// Aggregate: backupDrill. The SQL behind `pa backup restore --to <scratch>`
// (src/backup.js): counting a database's tables, and creating/dropping the
// throwaway database the drill restores into. Bound to whichever backend it
// is created over: the live store (table counts at backup time), the scratch
// database (counts after the restore), or the server's maintenance database
// (create / drop).

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

function ident(name) {
  if (!NAME_RE.test(String(name))) throw new Error(`not a safe database name: ${name}`);
  return `"${name}"`;
}

function create(db) {
  return {
    /**
     * Exact row count of every ordinary table in `public` (the migration
     * bookkeeping included), by name. The drill compares these.
     * @returns {Promise<Record<string, number>>}
     */
    async tableCounts() {
      const tables = await db.rows(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`
      );
      const out = {};
      for (const { table_name: t } of tables) {
        const r = await db.one(`select count(*)::bigint as n from public."${String(t).replace(/"/g, '""')}"`);
        out[t] = Number(r.n);
      }
      return out;
    },

    /**
     * Creates a database (run over the maintenance database), empty or copied
     * from `template` (a database that already holds the extensions a role
     * without superuser cannot create). Throws when it exists.
     */
    async createDatabase(name, { template = null } = {}) {
      await db.query(`create database ${ident(name)}${template ? ` template ${ident(template)}` : ''}`);
    },

    /** Drops a database if it exists (run over the maintenance database). */
    async dropDatabase(name) {
      await db.query(`drop database if exists ${ident(name)} with (force)`);
    },

    /** Whether a database of that name exists. */
    async databaseExists(name) {
      const r = await db.one(`select 1 as x from pg_database where datname = $1`, [name]);
      return Boolean(r);
    },

    /**
     * Creates the extensions the schema needs in the connected database. Needs
     * a role allowed to (a superuser, or a trusted extension); the error says
     * which one failed.
     */
    async ensureExtensions() {
      await db.query('create extension if not exists vector');
      await db.query('create extension if not exists pg_trgm');
    },
  };
}

module.exports = { create, NAME_RE };
