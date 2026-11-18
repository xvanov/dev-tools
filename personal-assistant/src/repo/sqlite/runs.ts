'use strict';

// SQLite twin of src/repo/runs.js (run). One live run per commitment holds as
// on Postgres: the check and the insert share a transaction, and BEGIN
// IMMEDIATE (src/db/sqlite.js) serialises it against every other writer, which
// is what the advisory lock did there.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const { LiveRunError } = require('../runs.ts');
const { NOW, DAY, sinceMs } = require('./_sql.ts');

const LIVE = "('starting','running','waiting')";
const ids = (list: unknown[]) => (list || []).map(Number);

function create(db: Db) {
  async function guarded(sql: string, params: unknown[], { commitmentId = null, again = false, externalId = null }: { commitmentId?: number | string | null; again?: boolean; externalId?: ((row: Row) => string) | null } = {}) {
    if ((!commitmentId || again) && !externalId) return db.one(sql, params);
    return db.withTx(async (c) => {
      if (commitmentId && !again) {
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
    /** A Claude Code run (route claude), status starting. Guarded (see src/repo/runs.js). */
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
    async recentForCommitment(commitmentId: number | string) {
      return db.rows(
        'select id, status, mode, branch, mr_url, started_at from run where commitment_id = $1 order by started_at desc, id desc limit 3',
        [commitmentId]
      );
    },

    /** A commitment's runs for the dashboard's detail view, newest first. */
    async detailsForCommitment(commitmentId: number | string) {
      return db.rows(
        `select id, status, mode, machine, branch, started_at, termhub_session_id, route, route_reason,
              factory_job_id, factory_state, factory_warnings, delivery, cost_usd, mr_url from run
        where commitment_id = $1 order by started_at desc, id desc`,
        [commitmentId]
      );
    },


    /** The mode of the newest run that used a worktree, or null. */
    async modeByWorktree(worktreePath: string) {
      return db.one('select mode from run where worktree_path = $1 order by started_at desc, id desc limit 1', [worktreePath]);
    },

    /** Runs of these commitments that have a PR or MR link, newest first. */
    async mrLinksFor(commitmentIds: unknown[]) {
      return db.rows(
        `select id, commitment_id, mr_url from run where commitment_id in (select value from json_each($1)) and mr_url is not null
          order by started_at desc, id desc`,
        [(commitmentIds || []).map(Number)]
      );
    },

    /** The newest `perCard` runs of each commitment, newest first, numbered (`n`). */
    async newestPerCommitment(commitmentIds: unknown[], perCard: number) {
      return db.rows(
        `select * from (
       select id, commitment_id, status, route, machine, termhub_session_id, factory_job_id, factory_state, mr_url,
              row_number() over (partition by commitment_id order by started_at desc, id desc) as n
         from run where commitment_id in (select value from json_each($1))) r
      where n <= $2 order by commitment_id, n`,
        [(commitmentIds || []).map(Number), perCard]
      );
    },

    /** Live runs' repo and worktree paths: {id, repo_path, worktree_path}. */
    async livePaths() {
      return db.rows(`select id, repo_path, worktree_path from run where status in ${LIVE}`);
    },

    // --- for src/dispatch/index.ts

    /** The newest live run of a commitment: {id, machine}, or null. */
    async liveForCommitment(commitmentId: number | string) {
      return db.one(`select id, machine from run where commitment_id = $1 and status in ${LIVE} order by started_at desc, id desc limit 1`, [commitmentId]);
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
      await db.query(`update run set status = 'failed', outcome = 'failed', outcome_at = ${NOW}, ended_at = ${NOW}, exit_note = $2 where id = $1`, [id, note]);
    },

    /** A remote start failed: failed, with the session that was opened (or null) and the note. */
    async markRemoteStartFailed(id: number | string, sessionId: number | string, note: string) {
      await db.query(
        `update run set status = 'failed', outcome = 'failed', outcome_at = ${NOW}, termhub_session_id = $2, exit_note = $3, ended_at = ${NOW} where id = $1`,
        [id, sessionId, note]
      );
    },

    /** A remote run's session is up: running with its session, brief, worktree and branch. */
    async markRemoteRunning(id: number | string, { sessionId, briefPath, worktreePath, branch }: { sessionId?: number | string | null; briefPath?: unknown; worktreePath?: string | null; branch?: string | null }) {
      await db.query(
        `update run set termhub_session_id = $2, brief_path = $3, worktree_path = $4, branch = $5, status = 'running' where id = $1`,
        [id, sessionId, briefPath, worktreePath, branch]
      );
    },

    /** Runs, newest first: all of them, or those still on your plate. */
    async recent(all: boolean, limit: number) {
      return db.rows(
        all
          ? 'select * from run order by started_at desc, id desc limit $1'
          : `select * from run where status in ('starting','running','waiting','done','blocked') order by started_at desc, id desc limit $1`,
        [limit]
      );
    },

    /** Stores the diff stat of a run's worktree ({stat, commits, uncommitted}). */
    async setDiffStat(id: number | string, diffStat: unknown) {
      await db.query('update run set diff_stat = $2 where id = $1', [id, diffStat]);
    },

    /** A branch was pushed and an MR opened (or not): landed, delivered. */
    async markLanded(id: number | string, mrUrl: unknown) {
      await db.query(`update run set status = 'landed', mr_url = $2, ended_at = ${NOW}, outcome = 'delivered', outcome_at = ${NOW} where id = $1`, [id, mrUrl]);
    },

    /** A run's commit went to the default branch: landed, merged, with a note when given. */
    async markPushedToMain(id: number | string, note: string) {
      await db.query(
        `update run set status = 'landed', ended_at = coalesce(ended_at, ${NOW}), outcome = 'merged', outcome_at = ${NOW},
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
        `update run set status = 'dropped', ended_at = coalesce(ended_at, ${NOW}),
                      outcome = coalesce(outcome, 'dropped'), outcome_at = coalesce(outcome_at, ${NOW}) where id = $1`,
        [id]
      );
    },

    /** A run was dropped (the outcome is kept when already set). */
    async markDropped(id: number | string) {
      await db.query(
        `update run set status = 'dropped', ended_at = ${NOW}, outcome = coalesce(outcome, 'dropped'), outcome_at = coalesce(outcome_at, ${NOW}) where id = $1`,
        [id]
      );
    },

    /** A run finished and awaits review. */
    async markDone(id: number | string, note: string) {
      await db.query(`update run set status = 'done', ended_at = ${NOW}, exit_note = $2 where id = $1`, [id, note]);
    },

    /** Non-factory runs that are starting, running or waiting. */
    async activeForReconcile() {
      return db.rows(`select id, task, status, termhub_session_id, machine from run where status in ${LIVE} and route <> 'factory'`);
    },

    /** Sets a run's status. */
    async setStatus(id: number | string, status: string) {
      await db.query('update run set status = $2 where id = $1', [id, status]);
    },

    // --- for src/dispatch/stats.ts

    /** Runs started in the last `days` days with their commitment's kind, for the route summary. */
    async forRouteStats(days: number) {
      return db.rows(
        `select r.route, coalesce(r.kind, c.kind) as kind, r.outcome, r.status, r.cost_usd
       from run r left join commitment c on c.id = r.commitment_id
      where r.started_at > $1`,
        [sinceMs(Number(days) * DAY)]
      );
    },

    // --- for src/durable/tasks/runReview.ts

    /** What a run review needs. */
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

    /** Forces a run's mode to `mr`. */
    async setModeMr(id: number | string) {
      await db.query(`update run set mode = 'mr' where id = $1`, [id]);
    },

    /** Stamps the measured outcome `merged`, keeping the note when none is given. */
    async markMergedOutcome(id: number | string, note: string) {
      await db.query(`update run set outcome = 'merged', outcome_at = ${NOW}, exit_note = coalesce($2, exit_note) where id = $1`, [id, note]);
    },

    // --- for src/dashboard/factory.js, src/mcp



    /** A commitment's five newest runs for the chat's card view. */
    async cardRuns(commitmentId: number | string) {
      return db.rows(
        `select id, status, mode, route, factory_job_id, factory_state, delivery, cost_usd, mr_url, termhub_session_id, machine, started_at
         from run where commitment_id = $1 order by started_at desc, id desc limit 5`,
        [commitmentId]
      );
    },

    /** Runs with a session started in the last 30 days. */
    async withSessions() {
      return db.rows(
        `select id, termhub_session_id, status, route, factory_job_id, commitment_id from run where termhub_session_id is not null and started_at > $1`,
        [sinceMs(30 * DAY)]
      );
    },


    /** The ten newest runs in a repo folder. */
    async inRepo(repoPath: string) {
      return db.rows(
        `select id, task, mode, status, branch, mr_url, started_at, route, factory_job_id from run
          where repo_path = $1 order by started_at desc, id desc limit 10`,
        [repoPath]
      );
    },

  };
}

module.exports = { create };
