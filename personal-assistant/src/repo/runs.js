'use strict';

// Aggregate: runs. Tables: run (one dispatched piece of work: a Claude Code
// session or a factory job), run_pr and run_step (its id chain, plan E1,
// sql/033). Callers: src/dispatch, src/durable, src/mcp, src/dashboard.

// pg_advisory_xact_lock(LOCK_SPACE, commitment id) serialises run inserts
// per commitment. 7300 is the worker lease and 7301 its passes (src/util/lease):
// a different key pair, since the pass lock's second key is a name hash.
const LOCK_SPACE = 7301;
const LIVE = "('starting','running','waiting')";

class LiveRunError extends Error {
  constructor(commitmentId, runId) {
    super(`#${commitmentId} already has run #${runId} — attach to it (pa attach ${runId}), or drop it first`);
    this.code = 'live_run';
  }
}

/**
 * @typedef {object} Guard  one live run per commitment (see guarded())
 * @property {number|null} [commitmentId]
 * @property {boolean} [again]   `pa do --again`: a second run on purpose, no check
 * @property {((row: object) => string)|null} [externalId]  the factory idempotency key
 */

function create(db) {
  /**
   * Inserts a run row and returns it. One live run per commitment, race-free:
   * with a `commitmentId` (and not `again`) the insert runs in a transaction
   * holding an advisory lock on the commitment, re-checks for a live run under
   * it and throws LiveRunError. `externalId(row)` is written in the SAME
   * transaction, so no row exists without its key.
   */
  async function guarded(sql, params, { commitmentId = null, again = false, externalId = null } = {}) {
    if ((!commitmentId || again) && !externalId) return db.one(sql, params);
    return db.withTx(async (c) => {
      if (commitmentId && !again) {
        await c.query('select pg_advisory_xact_lock($1, $2)', [LOCK_SPACE, Number(commitmentId)]);
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
    /**
     * A Claude Code run (route claude), status starting. Guarded (see guarded()).
     * @param {{commitmentId: number|null, mode: string, task: string, repoPath: string|null, machine: string,
     *   routeReason: string|null, kind: string|null, delivery: string, deliverySource: string}} v
     * @param {Guard} [guard]
     */
    async insertClaude(v, guard) {
      return guarded(
        `insert into run (commitment_id, mode, task, repo_path, status, machine, route, route_reason, kind,
                      delivery, delivery_requested, delivery_source)
     values ($1,$2,$3,$4,'starting',$5,'claude',$6,$7,$8,$8,$9) returning *`,
        [v.commitmentId, v.mode, v.task, v.repoPath, v.machine, v.routeReason, v.kind, v.delivery, v.deliverySource],
        guard
      );
    },

    /**
     * A factory run (route factory), status starting; delivery is only
     * requested until the factory answers. Guarded (see guarded()).
     * @param {{commitmentId: number|null, mode: string, task: string, repoPath: string|null, machine: string,
     *   routeReason: string|null, kind: string|null, pipeline: string|null, deliveryRequested: string,
     *   models: object|null, deliverySource: string, jobKind: string, runtime: string}} v
     * @param {Guard} [guard]
     */
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

    // --- for brief/index.js

    /** The runs in flight (starting, running, waiting), newest first (10). */
    async activeForBrief() {
      return db.rows(
        `select id, task, mode, status, repo_path, termhub_session_id, started_at, route, factory_job_id, factory_state
       from run where status in ('starting','running','waiting')
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

    // --- for src/commitments/context.js

    /**
     * A commitment's three newest runs.
     * @returns {Promise<Array<{id, status, mode, branch, mr_url, started_at}>>}
     */
    async recentForCommitment(commitmentId) {
      return db.rows(
        `select id, status, mode, branch, mr_url, started_at from run where commitment_id = $1 order by started_at desc limit 3`,
        [commitmentId]
      );
    },

    // --- for cli/index.js, dashboard/cards.js, dashboard/server.js

    /** The factory runs that have a job: {id, factory_job_id}. */
    async factoryJobs() {
      return db.rows(`select id, factory_job_id from run where route = 'factory' and factory_job_id is not null`);
    },

    /**
     * Runs of these commitments that have a PR or MR link, newest first.
     * @param {Array<number|string>} commitmentIds
     * @returns {Promise<Array<{id, commitment_id, mr_url}>>}
     */
    async mrLinksFor(commitmentIds) {
      return db.rows(
        `select id, commitment_id, mr_url from run where commitment_id = any($1::bigint[]) and mr_url is not null order by started_at desc`,
        [commitmentIds]
      );
    },

    /**
     * The newest `perCard` runs of each commitment, newest first, numbered (`n`).
     * @param {Array<number|string>} commitmentIds
     * @param {number} perCard
     */
    async newestPerCommitment(commitmentIds, perCard) {
      return db.rows(
        `select * from (
       select id, commitment_id, status, route, machine, termhub_session_id, factory_job_id, factory_state, mr_url,
              row_number() over (partition by commitment_id order by started_at desc) as n
         from run where commitment_id = any($1::bigint[])) r
      where n <= $2 order by commitment_id, n`,
        [commitmentIds, perCard]
      );
    },

    /** The mode of the newest run that used a worktree, or null. @returns {Promise<{mode: string}|null>} */
    async modeByWorktree(worktreePath) {
      return db.one(`select mode from run where worktree_path = $1 order by started_at desc limit 1`, [worktreePath]);
    },

    /** A commitment's runs for the dashboard's detail view, newest first. */
    async detailsForCommitment(commitmentId) {
      return db.rows(
        `select id, status, mode, machine, branch, started_at, termhub_session_id, route, route_reason,
              factory_job_id, factory_state, factory_warnings, delivery, cost_usd, mr_url from run
        where commitment_id = $1 order by started_at desc`,
        [commitmentId]
      );
    },
  };
}

module.exports = { create, LiveRunError, LOCK_SPACE };