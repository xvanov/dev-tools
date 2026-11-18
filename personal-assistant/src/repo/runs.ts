'use strict';

// Aggregate: runs. Tables: run (one dispatched piece of work: a Claude Code session in a
// worktree, or a software-factory job from before the factory was removed, D32; Build's
// agents are in build_run, src/repo/buildRuns.ts). run_pr and run_step (sql/033) are no
// longer written. Callers: src/dispatch, src/durable, src/mcp, src/dashboard.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

// pg_advisory_xact_lock(LOCK_SPACE, commitment id) serialises run inserts
// per commitment. 7300 is the worker lease and 7301 its passes (src/util/lease):
// a different key pair, since the pass lock's second key is a name hash.
const LOCK_SPACE = 7301;
const LIVE = "('starting','running','waiting')";

class LiveRunError extends Error {
  code: string;
  constructor(commitmentId: number | string, runId: number | string) {
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

function create(db: Db) {
  /**
   * Inserts a run row and returns it. One live run per commitment, race-free:
   * with a `commitmentId` (and not `again`) the insert runs in a transaction
   * holding an advisory lock on the commitment, re-checks for a live run under
   * it and throws LiveRunError. `externalId(row)` is written in the SAME
   * transaction, so no row exists without its key.
   */
  async function guarded(sql: string, params: unknown[], { commitmentId = null, again = false, externalId = null }: { commitmentId?: number | string | null; again?: boolean; externalId?: ((row: Row) => string) | null } = {}) {
    if ((!commitmentId || again) && !externalId) return db.one(sql, params);
    return db.withTx(async (c) => {
      if (commitmentId && !again) {
        await c.query('select pg_advisory_xact_lock($1, $2)', [LOCK_SPACE, Number(commitmentId)]);
        const live = await c.query(`select id from run where commitment_id = $1 and status in ${LIVE} order by started_at desc limit 1`, [commitmentId]);
        if (live.rows && live.rows.length) throw new LiveRunError(commitmentId, live.rows[0]?.id as number | string);
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
    async insertClaude(v: Row, guard?: { commitmentId?: number | string | null; again?: boolean; externalId?: ((row: Row) => string) | null }) {
      return guarded(
        `insert into run (commitment_id, mode, task, repo_path, status, machine, route, route_reason, kind,
                      delivery, delivery_requested, delivery_source)
     values ($1,$2,$3,$4,'starting',$5,'claude',$6,$7,$8,$8,$9) returning *`,
        [v.commitmentId, v.mode, v.task, v.repoPath, v.machine, v.routeReason, v.kind, v.delivery, v.deliverySource],
        guard
      );
    },


    /** One run row, or null. */
    async byId(id: number | string) {
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
    async recentForCommitment(commitmentId: number | string) {
      return db.rows(
        `select id, status, mode, branch, mr_url, started_at from run where commitment_id = $1 order by started_at desc limit 3`,
        [commitmentId]
      );
    },

    // --- for cli/index.js, dashboard/cards.js, dashboard/server.js


    /**
     * Runs of these commitments that have a PR or MR link, newest first.
     * @param {Array<number|string>} commitmentIds
     * @returns {Promise<Array<{id, commitment_id, mr_url}>>}
     */
    async mrLinksFor(commitmentIds: unknown[]) {
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
    async newestPerCommitment(commitmentIds: unknown[], perCard: number) {
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
    async modeByWorktree(worktreePath: string) {
      return db.one(`select mode from run where worktree_path = $1 order by started_at desc limit 1`, [worktreePath]);
    },

    /** A commitment's runs for the dashboard's detail view, newest first. */
    async detailsForCommitment(commitmentId: number | string) {
      return db.rows(
        `select id, status, mode, machine, branch, started_at, termhub_session_id, route, route_reason,
              factory_job_id, factory_state, factory_warnings, delivery, cost_usd, mr_url from run
        where commitment_id = $1 order by started_at desc`,
        [commitmentId]
      );
    },

    // --- for src/routines/actions/repoSync.js (chunk F)

    /** Live runs' repo and worktree paths: {id, repo_path, worktree_path}. */
    async livePaths() {
      return db.rows(`select id, repo_path, worktree_path from run where status in ('starting','running','waiting')`);
    },

    // --- for src/dispatch/index.ts

    /** The newest live run (starting, running, waiting) of a commitment: {id, machine}, or null. */
    async liveForCommitment(commitmentId: number | string) {
      return db.one(
        `select id, machine from run where commitment_id = $1 and status in ('starting','running','waiting')
        order by started_at desc limit 1`,
        [commitmentId]
      );
    },

    /** Records where a run's worktree and branch are. */
    async setWorktree(id: number | string, worktreePath: string, branch: string) {
      await db.query('update run set worktree_path = $2, branch = $3 where id = $1', [id, worktreePath, branch]);
    },

    /** A local run's session is up: stores it and the brief, status running. */
    async markRunning(id: number | string, sessionId: number | string, briefPath: unknown) {
      await db.query(`update run set termhub_session_id = $2, brief_path = $3, status = 'running' where id = $1`, [id, sessionId, briefPath]);
    },

    /** A start failed and was rolled back: status failed with the note. */
    async markStartFailed(id: number | string, note: string) {
      await db.query(
        `update run set status = 'failed', outcome = 'failed', outcome_at = now(), ended_at = now(), exit_note = $2 where id = $1`,
        [id, note]
      );
    },

    /** A remote start failed: failed, with the session that was opened (or null) and the note. */
    async markRemoteStartFailed(id: number | string, sessionId: number | string, note: string) {
      await db.query(
        `update run set status = 'failed', outcome = 'failed', outcome_at = now(), termhub_session_id = $2, exit_note = $3, ended_at = now() where id = $1`,
        [id, sessionId, note]
      );
    },

    /**
     * A remote run's session is up: status running with its session, brief,
     * worktree and branch.
     * @param {number|string} id
     * @param {{sessionId: string, briefPath: string, worktreePath: string, branch: string}} v
     */
    async markRemoteRunning(id: number | string, { sessionId, briefPath, worktreePath, branch }: { sessionId?: number | string | null; briefPath?: unknown; worktreePath?: string | null; branch?: string | null }) {
      await db.query(
        `update run set termhub_session_id = $2, brief_path = $3, worktree_path = $4, branch = $5, status = 'running'
      where id = $1`,
        [id, sessionId, briefPath, worktreePath, branch]
      );
    },

    /**
     * Runs, newest first: all of them, or those still on your plate.
     * @param {boolean} all
     * @param {number} limit
     */
    async recent(all: boolean, limit: number) {
      return db.rows(
        all
          ? 'select * from run order by started_at desc limit $1'
          : `select * from run where status in ('starting','running','waiting','done','blocked') order by started_at desc limit $1`,
        [limit]
      );
    },

    /** Stores the diff stat of a run's worktree ({stat, commits, uncommitted}). */
    async setDiffStat(id: number | string, diffStat: unknown) {
      await db.query('update run set diff_stat = $2 where id = $1', [id, diffStat]);
    },

    /** A branch was pushed and an MR opened (or not): landed, delivered. */
    async markLanded(id: number | string, mrUrl: unknown) {
      await db.query(`update run set status = 'landed', mr_url = $2, ended_at = now(), outcome = 'delivered', outcome_at = now() where id = $1`, [id, mrUrl]);
    },

    /** A run's commit went to the default branch: landed, merged, with a note when given. */
    async markPushedToMain(id: number | string, note: string) {
      await db.query(
        `update run set status = 'landed', ended_at = coalesce(ended_at, now()), outcome = 'merged', outcome_at = now(),
                    exit_note = coalesce($2, exit_note) where id = $1`,
        [id, note]
      );
    },

    /** Blocks a run with a reason (not once landed or dropped). */
    async block(id: number | string, reason: string) {
      await db.query(`update run set status = 'blocked', exit_note = $2 where id = $1 and status not in ('landed', 'dropped')`, [id, reason]);
    },

    /** A factory run was dropped: the end time and outcome are kept when already set. */
    async markFactoryDropped(id: number | string) {
      await db.query(
        `update run set status = 'dropped', ended_at = coalesce(ended_at, now()),
                      outcome = coalesce(outcome, 'dropped'), outcome_at = coalesce(outcome_at, now()) where id = $1`,
        [id]
      );
    },

    /** A run was dropped (the outcome is kept when already set). */
    async markDropped(id: number | string) {
      await db.query(`update run set status = 'dropped', ended_at = now(), outcome = coalesce(outcome, 'dropped'), outcome_at = coalesce(outcome_at, now()) where id = $1`, [id]);
    },

    /** A run finished and awaits review. */
    async markDone(id: number | string, note: string) {
      await db.query(`update run set status = 'done', ended_at = now(), exit_note = $2 where id = $1`, [id, note]);
    },

    /** Non-factory runs that are starting, running or waiting. */
    async activeForReconcile() {
      return db.rows(
        // A software-factory run (removed, D32) has no live session to follow.
        `select id, task, status, termhub_session_id, machine from run
      where status in ('starting','running','waiting') and route <> 'factory'`
      );
    },

    /** Sets a run's status. */
    async setStatus(id: number | string, status: string) {
      await db.query('update run set status = $2 where id = $1', [id, status]);
    },

    // --- for src/dispatch/stats.ts

    /**
     * Runs started in the last `days` days with their commitment's kind, for
     * the route summary.
     * @returns {Promise<Array<{route, kind, outcome, status, cost_usd}>>}
     */
    async forRouteStats(days: number) {
      return db.rows(
        `select r.route, coalesce(r.kind, c.kind) as kind, r.outcome, r.status, r.cost_usd
       from run r left join commitment c on c.id = r.commitment_id
      where r.started_at > now() - make_interval(days => $1::int)`,
        [days]
      );
    },

    // --- for src/durable/tasks/runReview.ts

    /** What a run review needs: {id, status, mode, task, commitment_id, machine, mr_url, delivery}. */
    async forReview(id: number | string) {
      return db.one('select id, status, mode, task, commitment_id, machine, mr_url, delivery from run where id = $1', [id]);
    },

    /** A run's repo folder: {repo_path}. */
    async repoPathOf(id: number | string) {
      return db.one('select repo_path from run where id = $1', [id]);
    },

    /** A run's mode, status and MR link. */
    async modeStatusMr(id: number | string) {
      return db.one('select mode, status, mr_url from run where id = $1', [id]);
    },

    /** Forces a run's mode to `mr` (a run that may not push is landed through an MR). */
    async setModeMr(id: number | string) {
      await db.query(`update run set mode = 'mr' where id = $1`, [id]);
    },

    /** Stamps the measured outcome `merged` (sql/024), keeping the note when none is given. */
    async markMergedOutcome(id: number | string, note: string) {
      await db.query(`update run set outcome = 'merged', outcome_at = now(), exit_note = coalesce($2, exit_note) where id = $1`, [id, note]);
    },

    // --- for src/dashboard/factory.js, src/mcp



    /** A commitment's five newest runs for the chat's card view. */
    async cardRuns(commitmentId: number | string) {
      return db.rows(
        `select id, status, mode, route, factory_job_id, factory_state, delivery, cost_usd, mr_url, termhub_session_id, machine, started_at
         from run where commitment_id = $1 order by started_at desc limit 5`,
        [commitmentId]
      );
    },

    /** Runs with a session started in the last 30 days (for naming sessions). */
    async withSessions() {
      return db.rows(
        `select id, termhub_session_id, status, route, factory_job_id, commitment_id from run where termhub_session_id is not null and started_at > now() - interval '30 days'`
      );
    },


    /** The ten newest runs in a repo folder. */
    async inRepo(repoPath: string) {
      return db.rows(
        `select id, task, mode, status, branch, mr_url, started_at, route, factory_job_id from run
          where repo_path = $1 order by started_at desc limit 10`,
        [repoPath]
      );
    },

  };
}

module.exports = { create, LiveRunError, LOCK_SPACE };