'use strict';

// SQLite twin of src/repo/backupDrill.js. Counting tables is the same
// question; creating and dropping a database is a Postgres-server concept (a
// SQLite store is a file, and its drill restores into a scratch file with no
// server to ask), so those answer honestly: nothing exists, and creating one
// is refused. The drill for a SQLite store lands with its file backups (3.x).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

function create(db: Db) {
  const notHere = () => new Error('not applicable to a SQLite store: it has no databases to create (a scratch file is the drill target)');
  return {
    /** Exact row count of every ordinary table, by name (SQLite's own and FTS shadow tables left out). */
    async tableCounts() {
      const tables = await db.rows(
        `select name, sql from sqlite_master
          where type = 'table' and name not like 'sqlite\\_%' escape '\\' order by name`
      );
      const out: Record<string, number> = {};
      for (const { name, sql } of tables) {
        // An FTS5 table over a content table (chunk_fts over chunk) has its rows,
        // and counting it reads each one whole: the vectors too, 2.5 s on the work
        // stack, on the event loop. The content table's count is the same number.
        const over = /\bfts5\s*\(.*\bcontent\s*=\s*'([A-Za-z_][A-Za-z0-9_]*)'/is.exec(String(sql || ''));
        const from = (over && over[1]) || String(name);
        const r = await db.one(`select count(*) as n from "${from.replace(/"/g, '""')}"`);
        out[String(name)] = Number(r?.n);
      }
      return out;
    },

    /**
     * What is wrong with this store file, if anything (the SQLite backup drill,
     * src/backupSqlite.js): integrity_check, each FTS index's integrity-check,
     * foreign_key_check. [] when it can be trusted.
     */
    async integrityProblems() {
      const problems = [];
      const ic = await db.rows('pragma integrity_check');
      if (!(ic.length === 1 && ic[0]?.integrity_check === 'ok')) problems.push(`integrity_check: ${ic.slice(0, 3).map((r) => r.integrity_check).join('; ')}`);
      for (const t of ['chunk_fts', 'chunk_fts_exact', 'claim_fts', 'memory_page_fts']) {
        await db.query(`insert into ${t} (${t}) values ('integrity-check')`).catch((err) => problems.push(`${t}: ${err.message}`));
      }
      const fk = await db.rows('select * from pragma_foreign_key_check limit 5');
      if (fk.length) problems.push(`foreign keys: ${JSON.stringify(fk)}`);
      return problems;
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
