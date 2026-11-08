'use strict';

// Aggregate: runs. Tables: run (one dispatched piece of work: a Claude Code
// session or a factory job), run_pr and run_step (its id chain, plan E1,
// sql/033). Callers: src/dispatch, src/durable, src/mcp, src/dashboard.
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

    /**
     * A factory run (route factory), status starting; delivery is only
     * requested until the factory answers. Guarded (see guarded()).
     * @param {{commitmentId: number|null, mode: string, task: string, repoPath: string|null, machine: string,
     *   routeReason: string|null, kind: string|null, pipeline: string|null, deliveryRequested: string,
     *   models: object|null, deliverySource: string, jobKind: string, runtime: string}} v
     * @param {Guard} [guard]
     */
    async insertFactory(v: Row, guard?: { commitmentId?: number | string | null; again?: boolean; externalId?: ((row: Row) => string) | null }) {
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

    /** The factory runs that have a job: {id, factory_job_id}. */
    async factoryJobs() {
      return db.rows(`select id, factory_job_id from run where route = 'factory' and factory_job_id is not null`);
    },

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

    // --- for src/dispatch/index.js

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
        // A factory run's session only follows its job; the job's status is the
        // factory pass's to read (src/dispatch/factory.js poll), not termhub's.
        `select id, task, status, termhub_session_id, machine from run
      where status in ('starting','running','waiting') and route <> 'factory'`
      );
    },

    /** Sets a run's status. */
    async setStatus(id: number | string, status: string) {
      await db.query('update run set status = $2 where id = $1', [id, status]);
    },

    // --- for src/dispatch/factory.js

    /** A factory submit failed before it went out: failed, with the note and the brief's path and author. */
    async markSubmitRefused(id: number | string, note: string, briefPath: unknown, by: unknown) {
      await db.query(
        `update run set status = 'failed', outcome = 'failed', outcome_at = now(), ended_at = now(), exit_note = $2, brief_path = $3, brief_by = $4 where id = $1`,
        [id, note, briefPath, by]
      );
    },

    /** Stores the termhub session that follows a factory job. */
    async setSession(id: number | string, sessionId: number | string) {
      await db.query('update run set termhub_session_id = $2 where id = $1', [id, sessionId]);
    },

    /**
     * Records the job the factory made for a run: running, queued. Only while
     * the run is live; resolves whether a row changed.
     * @param {number|string} id
     * @param {object} v {jobId, delivery, pipeline, briefPath, warnings: string[]|null, exitNote, by}
     * @returns {Promise<boolean>}
     */
    async recordJob(id: number | string, { jobId, delivery, pipeline, briefPath, warnings, exitNote, by }: { jobId?: number | string | null; delivery?: string | null; pipeline?: unknown; briefPath?: unknown; warnings?: unknown[] | null; exitNote?: unknown; by?: unknown }) {
      const r = await db.query(
        `update run set factory_job_id = $2, delivery = $3, pipeline = $4, brief_path = coalesce($5, brief_path), status = 'running',
                    factory_state = 'queued', factory_warnings = $6, exit_note = $7, brief_by = coalesce($8, brief_by)
      where id = $1 and status in ('starting', 'waiting', 'running')`,
        [id, jobId, delivery, pipeline, briefPath, warnings && warnings.length ? JSON.stringify(warnings) : null, exitNote, by]
      );
      return (r.rowCount || 0) > 0;
    },

    /** A job turned up for a run that had ended: remembers it, state cancelled. */
    async markLateJobCancelled(id: number | string, jobId: number | string) {
      await db.query(`update run set factory_job_id = coalesce(factory_job_id, $2), factory_state = 'cancelled' where id = $1`, [id, jobId]);
    },

    /** The factory has no job for a submit that went unanswered: failed (only while no job is recorded). */
    async markSubmitFailed(id: number | string, note: string) {
      await db.query(
        `update run set status = 'failed', outcome = 'failed', outcome_at = now(), ended_at = now(), factory_state = 'not_submitted',
                        exit_note = $2 where id = $1 and factory_job_id is null`,
        [id, note]
      );
    },

    /** A submit's answer was lost: waiting, submit_unknown (only while no job is recorded). */
    async markSubmitUnknown(id: number | string, note: string, briefPath: unknown) {
      await db.query(
        `update run set status = 'waiting', factory_state = 'submit_unknown', exit_note = $2, brief_path = coalesce($3, brief_path)
          where id = $1 and factory_job_id is null`,
        [id, note, briefPath]
      );
    },

    /**
     * Writes what the factory now says about a job onto its run.
     * @param {number|string} id
     * @param {{status: string, outcome: string|null, factoryState: string|null, costUsd: number|null, mrUrl: string|null,
     *   exitNote: string|null, delivery: string|null, ended: boolean}} u  `ended`: stamp ended_at when unset
     */
    async applyFactoryState(id: number | string, { status, outcome, factoryState, costUsd, mrUrl, exitNote, delivery, ended }: { status?: string | null; outcome?: unknown; factoryState?: unknown; costUsd?: unknown; mrUrl?: unknown; exitNote?: unknown; delivery?: string | null; ended?: unknown }) {
      await db.query(
        `update run set status = $2, outcome = $3, outcome_at = case when $3::text is distinct from outcome then now() else outcome_at end,
                      factory_state = $4, cost_usd = coalesce($5, cost_usd), mr_url = coalesce($6, mr_url),
                      exit_note = coalesce($7, exit_note), delivery = coalesce($8, delivery),
                      ended_at = case when $9 and ended_at is null then now() else ended_at end
        where id = $1`,
        [id, status, outcome, factoryState, costUsd, mrUrl, exitNote, delivery, ended]
      );
    },

    /** Stores the subscription-equivalent cost (sql/031; throws on a store not yet migrated). */
    async setSubscriptionEquiv(id: number | string, usd: unknown) {
      await db.query('update run set subscription_equiv_usd = $2 where id = $1', [id, usd]);
    },

    /**
     * Records one PR of a run (run_pr); a repeat updates only what changed.
     * @param {number|string} runId
     * @param {{url: string, number: number|null, story_id: string|null, state: string|null, ci_state: string|null, ci_failing: object|null}} p
     */
    async upsertPr(runId: number | string, p: Row) {
      await db.query(
        `insert into run_pr (run_id, url, number, story_id, state, ci_state, ci_failing, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
       on conflict (run_id, url) do update set
         number = coalesce(excluded.number, run_pr.number), story_id = coalesce(excluded.story_id, run_pr.story_id),
         state = coalesce(excluded.state, run_pr.state), ci_state = coalesce(excluded.ci_state, run_pr.ci_state),
         ci_failing = coalesce(excluded.ci_failing, run_pr.ci_failing), updated_at = now()
       where (run_pr.number, run_pr.story_id, run_pr.state, run_pr.ci_state, run_pr.ci_failing)
             is distinct from (coalesce(excluded.number, run_pr.number), coalesce(excluded.story_id, run_pr.story_id),
                               coalesce(excluded.state, run_pr.state), coalesce(excluded.ci_state, run_pr.ci_state),
                               coalesce(excluded.ci_failing, run_pr.ci_failing))`,
        [runId, p.url, p.number, p.story_id, p.state, p.ci_state, p.ci_failing ? JSON.stringify(p.ci_failing) : null]
      );
    },

    /**
     * Records one step of a run (run_step); a repeat updates only what changed.
     * @param {number|string} runId
     * @param {object} s  step_id, job_id, story_id, persona, runtime, model, state, started_at, ended_at, machine, termhub_session_id, url
     */
    async upsertStep(runId: number | string, s: Row) {
      await db.query(
        `insert into run_step (run_id, step_id, job_id, story_id, persona, runtime, model, state, started_at, ended_at, machine, termhub_session_id, url, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       on conflict (run_id, step_id) do update set
         job_id = excluded.job_id, story_id = excluded.story_id, persona = excluded.persona, runtime = excluded.runtime,
         model = excluded.model, state = excluded.state, started_at = excluded.started_at, ended_at = excluded.ended_at,
         machine = coalesce(excluded.machine, run_step.machine),
         termhub_session_id = coalesce(excluded.termhub_session_id, run_step.termhub_session_id),
         url = coalesce(excluded.url, run_step.url), updated_at = now()
       where (run_step.state, run_step.ended_at, run_step.termhub_session_id, run_step.url, run_step.model)
             is distinct from (excluded.state, excluded.ended_at::timestamptz,
                               coalesce(excluded.termhub_session_id, run_step.termhub_session_id),
                               coalesce(excluded.url, run_step.url), excluded.model)`,
        [runId, s.step_id, s.job_id, s.story_id, s.persona, s.runtime, s.model, s.state, s.started_at, s.ended_at, s.machine, s.termhub_session_id, s.url]
      );
    },

    /** The PRs of these runs (run_pr), by run then number. */
    async prsOf(runIds: unknown[]) {
      return db.rows(
        `select run_id, url, number, story_id, state, ci_state, ci_failing from run_pr where run_id = any($1::bigint[]) order by run_id, number nulls last, url`,
        [runIds]
      );
    },

    /** The steps of these runs (run_step), newest first within a run. */
    async stepsOf(runIds: unknown[]) {
      return db.rows(
        `select run_id, step_id, job_id, story_id, persona, runtime, model, state, started_at, ended_at, machine, termhub_session_id, url
         from run_step where run_id = any($1::bigint[]) order by run_id, started_at desc nulls last, step_id desc`,
        [runIds]
      );
    },

    /** Factory runs with a job that are live, or were delivered in the last 14 days. */
    async watchedFactoryRuns() {
      return db.rows(
        `select * from run
      where route = 'factory' and factory_job_id is not null
        and (status in ('starting','running','waiting')
             or (outcome = 'delivered' and ended_at > now() - interval '14 days'))`
      );
    },

    /** The distinct job ids of factory runs: [{factory_job_id}]. */
    async distinctFactoryJobIds() {
      return db.rows(`select distinct factory_job_id from run where route = 'factory' and factory_job_id is not null`);
    },

    /** The newest live run of a factory job: {id}, or null. */
    async liveRunOfJob(jobId: number | string) {
      return db.one(
        `select id from run where route = 'factory' and factory_job_id = $1 and status in ('starting','running','waiting') order by id desc limit 1`,
        [jobId]
      );
    },

    /** Factory runs whose submit was never confirmed (with `age_ms`). */
    async unsettledFactory() {
      return db.rows(
        `select *, extract(epoch from (now() - started_at)) * 1000 as age_ms from run
      where route = 'factory' and factory_job_id is null
        and (factory_state = 'submit_unknown' and status = 'waiting'
             or status = 'starting' and started_at < now() - interval '2 minutes')`
      );
    },

    // --- for src/dispatch/stats.js

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

    /** For each factory job id, its newest run. */
    async latestRunPerJob(jobIds: unknown[]) {
      return db.rows(
        `select distinct on (factory_job_id) id, commitment_id, factory_job_id, termhub_session_id, machine from run
        where route = 'factory' and factory_job_id = any($1::text[]) order by factory_job_id, id desc`,
        [jobIds]
      );
    },

    /** The newest run of one factory job: {id, commitment_id, termhub_session_id, machine}, or null. */
    async newestOfJob(jobId: number | string) {
      return db.one(
        `select id, commitment_id, termhub_session_id, machine from run where route = 'factory' and factory_job_id = $1 order by id desc limit 1`,
        [jobId]
      );
    },

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

    /** The factory steps whose sessions are among `sessionIds`, with their run's status. */
    async stepsBySessions(sessionIds: unknown[]) {
      return db.rows(
        `select s.termhub_session_id, s.step_id, s.job_id, r.id as run_id, r.status, r.commitment_id
         from run_step s join run r on r.id = s.run_id where s.termhub_session_id = any($1::text[])`,
        [sessionIds]
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

    // --- for src/e2e/goldenPath.js

    /** Runs of these commitments: {id, factory_job_id, factory_state}. */
    async jobsOfCommitments(commitmentIds: unknown[]) {
      return db.rows(`select id, factory_job_id, factory_state from run where commitment_id = any($1::bigint[])`, [commitmentIds]);
    },

    /** The distinct PRs of these runs: {pr_number, pr_url}. */
    async prLinksOf(runIds: unknown[]) {
      return db.rows(`select distinct number as pr_number, url as pr_url from run_pr where run_id = any($1::bigint[])`, [runIds]);
    },

    /** The sessions of these runs' steps: {termhub_session_id, machine}. */
    async stepSessionsOf(runIds: unknown[]) {
      return db.rows(`select termhub_session_id, machine from run_step where run_id = any($1::bigint[]) and termhub_session_id is not null`, [runIds]);
    },
  };
}

module.exports = { create, LiveRunError, LOCK_SPACE };