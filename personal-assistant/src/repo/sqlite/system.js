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

    /** Makes `id` the install id (a restored store is a new install). */
    async replaceInstallId(id) {
      await db.query('delete from pa_install');
      await db.query('insert into pa_install (id) values ($1)', [id]);
    },

    /** Liveness: resolves when the store answers `select 1`. */
    async ping() {
      return db.one('select 1 as ok');
    },

    /** The migrations applied, oldest first: here the sql-sqlite file names. */
    async appliedMigrations() {
      return db.rows('select version from schema_migration order by version');
    },

    /** Reply drafts to send and memory items to review. */
    async pendingCounts() {
      return db.one(
        `select (select count(*) from draft where status in ('pending','edited')) as drafts,
                (select count(*) from claim where status = 'pending_review') as review`
      );
    },

    /** Drafts, memory items to review and live runs. */
    async waitingCounts() {
      return db.one(
        `select (select count(*) from draft where status in ('pending','edited')) as drafts,
                (select count(*) from claim where status = 'pending_review') as review,
                (select count(*) from run where status in ('starting','running','waiting')) as runs`
      );
    },

    /** For `pa doctor`: the size of the store and the work in it (counts as strings, as pg's bigint). */
    async counts() {
      const r = await db.one(
        `select (select count(*) from source_item) as items,
                (select count(*) from commitment where status = 'open') as open_commitments,
                (select count(*) from run where status in ('running','waiting')) as live_runs,
                (select count(*) from draft where status = 'pending') as pending_drafts,
                (select count(*) from distillation where error is not null) as failed_items`
      );
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]));
    },

    /** For `pa doctor`: pushes since `start`, notifications held for the digest, the last digest's time. */
    async attention(start) {
      const r = await db.one(
        `select (select count(*) from notification where delivery = 'push' and kind <> 'digest' and created_at >= $1) as pushed,
                (select count(*) from notification where delivery = 'digest' and digest_id is null) as held,
                (select max(created_at) from digest) as last_digest`,
        [start]
      );
      return { ...r, last_digest: r.last_digest == null ? null : new Date(r.last_digest) };
    },
  };
}

module.exports = { create };
