'use strict';

// Aggregate: system. Tables: setting, pa_install, and diagnostics about the
// store itself (extensions, server version, counts, liveness).
// Owner while plan 1.2 is converting: chunk G (cli, dashboard, eval).

function create(db) {
  return {
    // --- for src/backup.js

    /** Which of these extensions are installed in this database (names). */
    async installedExtensions(names) {
      const r = await db.query(`select extname from pg_extension where extname = any($1::text[])`, [names]);
      return r.rows.map((x) => x.extname);
    },

    /** The server's major version (16 for 16.4). */
    async serverMajor() {
      const r = await db.query(`select current_setting('server_version_num')::int / 10000 as major`);
      return Number(r.rows[0].major);
    },
  };
}

module.exports = { create };
