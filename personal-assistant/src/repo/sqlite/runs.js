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

    /** A commitment's newest runs (3): {id, status, mode, branch, mr_url, started_at}. */
    async recentForCommitment(commitmentId) {
      return db.rows(
        'select id, status, mode, branch, mr_url, started_at from run where commitment_id = $1 order by started_at desc, id desc limit 3',
        [commitmentId]
      );
    },

    /** A commitment's runs for the dashboard's detail view, newest first. */
    async detailsForCommitment(commitmentId) {
      return db.rows(
        `select id, status, mode, machine, branch, started_at, termhub_session_id, route, route_reason,
              factory_job_id, factory_state, factory_warnings, delivery, cost_usd, mr_url from run
        where commitment_id = $1 order by started_at desc, id desc`,
        [commitmentId]
      );
    },

    /** The factory runs that have a job: {id, factory_job_id}. */
    async factoryJobs() {
      return db.rows(`select id, factory_job_id from run where route = 'factory' and factory_job_id is not null`);
    },

    /** The mode of the newest run that used a worktree, or null. */
    async modeByWorktree(worktreePath) {
      return db.one('select mode from run where worktree_path = $1 order by started_at desc, id desc limit 1', [worktreePath]);
    },

    /** Runs of these commitments that have a PR or MR link, newest first. */
    async mrLinksFor(commitmentIds) {
      return db.rows(
        `select id, commitment_id, mr_url from run where commitment_id in (select value from json_each($1)) and mr_url is not null
          order by started_at desc, id desc`,
        [(commitmentIds || []).map(Number)]
      );
    },

    /** The newest `perCard` runs of each commitment, newest first, numbered (`n`). */
    async newestPerCommitment(commitmentIds, perCard) {
      return db.rows(
        `select * from (
       select id, commitment_id, status, route, machine, termhub_session_id, factory_job_id, factory_state, mr_url,
              row_number() over (partition by commitment_id order by started_at desc, id desc) as n
         from run where commitment_id in (select value from json_each($1))) r
      where n <= $2 order by commitment_id, n`,
        [(commitmentIds || []).map(Number), perCard]
      );
    },
  };
}

module.exports = { create };
