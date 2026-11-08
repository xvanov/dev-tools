'use strict';

// SQLite twin of src/repo/backupDrill.js. Counting tables is the same
// question; creating and dropping a database is a Postgres-server concept (a
// SQLite store is a file, and its drill restores into a scratch file with no
// server to ask), so those answer honestly: nothing exists, and creating one
// is refused. The drill for a SQLite store lands with its file backups (3.x).

function create(db) {
  const notHere = () => new Error('not applicable to a SQLite store: it has no databases to create (a scratch file is the drill target)');
  return {
    /** Exact row count of every ordinary table, by name (SQLite's own and FTS shadow tables left out). */
    async tableCounts() {
      const tables = await db.rows(
        `select name from sqlite_master
          where type = 'table' and name not like 'sqlite\\_%' escape '\\' order by name`
      );
      const out = {};
      for (const { name } of tables) {
        const r = await db.one(`select count(*) as n from "${String(name).replace(/"/g, '""')}"`);
        out[name] = Number(r.n);
      }
      return out;
    },

    async createDatabase() {
      throw notHere();
    },

    async dropDatabase() {},

    async databaseExists() {
      return false;
    },

    /** Nothing to create: the modules are compiled in or loaded with the connection. */
    async ensureExtensions() {},
  };
}

module.exports = { create };
