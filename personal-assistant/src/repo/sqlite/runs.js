'use strict';

// SQLite twin of src/repo/runs.js (run). One live run per commitment holds as
// on Postgres: the check and the insert share a transaction, and BEGIN
// IMMEDIATE (src/db/sqlite.js) serialises it against every other writer, which
// is what the advisory lock did there.

const { LiveRunError } = require('../runs');

const LIVE = "('starting','running','waiting')";

function create(db) {
  async function guarded(sql, params, { commitmentId = null, again = false, externalId = null } = {}) {
    if ((!commitmentId || again) && !externalId) return db.one(sql, params);
    return db.withTx(async (c) => {
      if (commitmentId && !again) {
        const live = await c.query(`select id from run where commitment_id = $1 and status in ${LIVE} order by started_at desc limit 1`, [commitmentId]);
        if (live.rows && live.rows.length) throw new LiveRunError(commitmentId, live.rows[0].id);
      }
      const row = (await c.query(sql, params)).rows[0];
      if (externalId && row) {
        const key = externalId(row);
        await c.query('update run set external_id = $2 where id = $1', [row.id, key]);
        row.external_id = key;
      }
      return row;
    });
  }

  return {
    /** A Claude Code run (route claude), status starting. Guarded (see src/repo/runs.js). */
    async insertClaude(v, guard) {
      return guarded(
        `insert into run (commitment_id, mode, task, repo_path, status, machine, route, route_reason, kind,
                      delivery, delivery_requested, delivery_source)
     values ($1,$2,$3,$4,'starting',$5,'claude',$6,$7,$8,$8,$9) returning *`,
        [v.commitmentId, v.mode, v.task, v.repoPath, v.machine, v.routeReason, v.kind, v.delivery, v.deliverySource],
        guard
      );
    },

    /** A factory run (route factory), status starting. Guarded. */
    async insertFactory(v, guard) {
      return guarded(
        `insert into run (commitment_id, mode, task, repo_path, status, machine, route, route_reason, kind,
                      pipeline, delivery_requested, models, delivery_source, job_kind, runtime)
     values ($1,$2,$3,$4,'starting',$5,'factory',$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
        [v.commitmentId, v.mode, v.task, v.repoPath, v.machine, v.routeReason, v.kind,
          v.pipeline, v.deliveryRequested, v.models, v.deliverySource, v.jobKind, v.runtime],
        guard
      );
    },

    /** One run row, or null. */
    async byId(id) {
      return db.one('select * from run where id = $1', [id]);
    },

    /** The runs in flight (starting, running, waiting), newest first (10). */
    async activeForBrief() {
      return db.rows(
        `select id, task, mode, status, repo_path, termhub_session_id, started_at, route, factory_job_id, factory_state
       from run where status in ${LIVE}
      order by started_at desc limit 10`
      );
    },

    /** Runs finished or blocked and waiting for a look, newest first (10). */
    async reviewForBrief() {
      return db.rows(
        `select id, task, mode, status, exit_note, repo_path, mr_url, ended_at
       from run where status in ('done', 'blocked')
      order by ended_at desc nulls last limit 10`
      );
    },
  };
}

module.exports = { create };
