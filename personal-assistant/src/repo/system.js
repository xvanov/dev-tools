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

    /**
     * Makes `id` the install id: a restored store is a new install (sql/026),
     * so the factory idempotency keys never collide with a live twin.
     * @param {string} id  a uuid
     */
    async replaceInstallId(id) {
      await db.query('delete from pa_install');
      await db.query('insert into pa_install (id) values ($1)', [id]);
    },

    // --- for src/cli, src/chat/fastLane.js, src/dashboard

    /** Liveness: resolves when the store answers `select 1`. */
    async ping() {
      return db.one('select 1 as ok');
    },

    /** The migrations applied, oldest first. @returns {Promise<Array<{version: string}>>} */
    async appliedMigrations() {
      return db.rows('select version from schema_migration order by version');
    },

    /**
     * What waits on you, for the chat's context: reply drafts to send and
     * memory items to review.
     * @returns {Promise<{drafts: number, review: number}>}
     */
    async pendingCounts() {
      return db.one(
        `select (select count(*) from draft where status in ('pending','edited'))::int as drafts,
                  (select count(*) from claim where status = 'pending_review')::int as review`
      );
    },

    /**
     * What waits on you, for `pa context`: drafts, memory items to review and
     * live runs.
     * @returns {Promise<{drafts: number, review: number, runs: number}>}
     */
    async waitingCounts() {
      return db.one(
        `select (select count(*) from draft where status in ('pending','edited'))::int as drafts,
              (select count(*) from claim where status = 'pending_review')::int as review,
              (select count(*) from run where status in ('starting','running','waiting'))::int as runs`
      );
    },

    /**
     * For `pa doctor`: the size of the store and the work in it.
     * @returns {Promise<{items: string, open_commitments: string, live_runs: string, pending_drafts: string, failed_items: string}>}
     */
    async counts() {
      return db.one(
        `select (select count(*) from source_item) as items,
              (select count(*) from commitment where status = 'open') as open_commitments,
              (select count(*) from run where status in ('running','waiting')) as live_runs,
              (select count(*) from draft where status = 'pending') as pending_drafts,
              (select count(*) from distillation where error is not null) as failed_items`
      );
    },

    /**
     * For `pa doctor`: pushes since `start`, notifications held for the digest,
     * and the time of the last digest.
     * @param {Date} start
     * @returns {Promise<{pushed: number, held: number, last_digest: Date|null}>}
     */
    async attention(start) {
      return db.one(
        `select (select count(*) from notification where delivery = 'push' and kind <> 'digest' and created_at >= $1)::int as pushed,
                (select count(*) from notification where delivery = 'digest' and digest_id is null)::int as held,
                (select max(created_at) from digest) as last_digest`,
        [start]
      );
    },

    // --- for src/routines (chunk F)

    /** A setting's row ({value}), or null. */
    async setting(key) {
      return db.one('select value from setting where key = $1', [key]);
    },

    /** Sets a setting (value stored as jsonb). */
    async setSetting(key, value) {
      await db.query(
        `insert into setting (key, value, updated_at) values ($1,$2,now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, value]
      );
    },

    // --- for src/dispatch/factory.js

    /** Makes `id` the install id when the store has none (a no-op otherwise). */
    async insertInstallIfNone(id) {
      await db.query('insert into pa_install (id) select $1 where not exists (select 1 from pa_install)', [id]);
    },

    /** The first install's id: {id}, or null. */
    async firstInstall() {
      return db.one('select id from pa_install order by created_at limit 1');
    },
  };
}

module.exports = { create };
