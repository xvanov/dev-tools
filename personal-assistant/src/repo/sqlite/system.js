'use strict';

// SQLite twin of src/repo/system.js: diagnostics about the store itself.
// The Postgres probes get SQLite's honest answers: extensions are what this
// connection has (fts5 and json are compiled in; `vec` when sqlite-vec
// loaded), and the "server" version is SQLite's own (3 for 3.53). A pg-only
// name (vector, pg_trgm) is not reported as present: the caller that asks
// for them (src/backup.js restore) is Postgres-only.

function create(db) {
  async function has(name) {
    switch (name) {
      case 'fts5':
      case 'json':
      case 'json1':
        return true;
      case 'vec':
      case 'sqlite-vec':
        try {
          await db.one('select vec_version() as v');
          return true;
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  return {
    /** Which of these extensions this connection has (names). */
    async installedExtensions(names) {
      const out = [];
      for (const n of names || []) if (await has(n)) out.push(n);
      return out;
    },

    /** SQLite's major version (3 for 3.53.4). */
    async serverMajor() {
      const r = await db.one('select sqlite_version() as v');
      return Number(String(r.v).split('.')[0]);
    },
  };
}

module.exports = { create };
