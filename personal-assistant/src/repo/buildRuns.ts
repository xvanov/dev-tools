'use strict';

// Aggregate: buildRuns. Tables: build_run (one Claude Code agent run), build_msg
// (what the agent and Jarvis say to each other). PLAN.md D30.
// Callers: src/build. Times are ISO text the app writes, so the SQL is the same
// on Postgres and SQLite and src/repo/sqlite/buildRuns.ts re-exports this file.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

/** The columns `update` may set. */
const COLUMNS = [
  'commitment_id', 'task', 'model', 'repo_path', 'worktree_path', 'branch', 'cwd', 'machine', 'session_id',
  'claude_session', 'transcript_path', 'state', 'result', 'error', 'cost_cap_usd', 'wall_cap_min', 'cost_usd',
  'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write', 'track', 'ended_at', 'last_activity_at', 'activity', 'idle_after_s',
];
/** States where the agent is still working or waiting on Jarvis. */
const LIVE = ['starting', 'running', 'waiting', 'idle'];

const iso = (): string => new Date().toISOString();

function create(db: Db) {
  return {
    /** A new run, state `starting`: the row. */
    async insert(v: Row): Promise<Row> {
      const r = await db.query(
        `insert into build_run (commitment_id, task, model, repo_path, machine, cost_cap_usd, wall_cap_min, idle_after_s, started_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$9,$8,$8) returning *`,
        [v.commitmentId ?? null, v.task, v.model, v.repoPath ?? null, v.machine ?? null, v.costCapUsd, v.wallCapMin, iso(), v.idleAfterS ?? 240]
      );
      return r.rows[0] as Row;
    },

    /** One run, or null. */
    async byId(id: number | string): Promise<Row | null> {
      return db.one('select * from build_run where id = $1', [id]);
    },

    /** Newest first; `live` keeps only runs still working or waiting. */
    async list({ live = false, limit = 20, offset = 0 }: { live?: boolean; limit?: number; offset?: number } = {}): Promise<Row[]> {
      return db.rows(
        `select * from build_run ${live ? `where state in ('starting','running','waiting','idle')` : ''} order by id desc limit $1 offset $2`,
        [limit, offset]
      );
    },

    /** How many runs there are (live ones only when `live`). */
    async count({ live = false }: { live?: boolean } = {}): Promise<number> {
      const r = await db.one(`select count(*) as n from build_run ${live ? `where state in ('starting','running','waiting','idle')` : ''}`);
      return Number(r?.n || 0);
    },

    /** The live run of a card, or null. */
    async liveForCommitment(commitmentId: number | string): Promise<Row | null> {
      return db.one(`select * from build_run where commitment_id = $1 and state in ('starting','running','waiting','idle') order by id desc limit 1`, [commitmentId]);
    },

    /** Sets the named columns (unknown names are refused) and the update time. */
    async update(id: number | string, patch: Row): Promise<void> {
      const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
      for (const k of keys) if (!COLUMNS.includes(k)) throw new Error(`build_run has no settable column ${k}`);
      const sets = keys.map((k, i) => `${k} = $${i + 2}`);
      sets.push(`updated_at = $${keys.length + 2}`);
      await db.query(`update build_run set ${sets.join(', ')} where id = $1`, [id, ...keys.map((k) => patch[k]), iso()]);
    },

    /** Appends a message: dir `agent` or `jarvis`, kind note|ask|done|reply|send. */
    async addMsg(v: { runId: number | string; dir: string; kind: string; body: string }): Promise<Row> {
      const r = await db.query(
        'insert into build_msg (run_id, dir, kind, body, created_at) values ($1,$2,$3,$4,$5) returning *',
        [v.runId, v.dir, v.kind, v.body, iso()]
      );
      return r.rows[0] as Row;
    },

    /** One message, or null. */
    async msgById(id: number | string): Promise<Row | null> {
      return db.one('select * from build_msg where id = $1', [id]);
    },

    /** A run's messages, oldest first. */
    async msgs(runId: number | string): Promise<Row[]> {
      return db.rows('select * from build_msg where run_id = $1 order by id', [runId]);
    },

    /** Messages of several runs at once, oldest first. */
    async msgsFor(runIds: Array<number | string>): Promise<Row[]> {
      if (!runIds.length) return [];
      const ph = runIds.map((_, i) => `$${i + 1}`).join(',');
      return db.rows(`select * from build_msg where run_id in (${ph}) order by id`, runIds);
    },

    /** The runs of several cards (commitments), oldest first. */
    async forCards(ids: Array<number | string>): Promise<Row[]> {
      if (!ids.length) return [];
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      return db.rows(`select * from build_run where commitment_id in (${ph}) order by id`, ids);
    },

    /** Asks nobody has answered yet, oldest first. */
    async openAsks(): Promise<Row[]> {
      return db.rows(`select * from build_msg where kind = 'ask' and answered_at is null order by id`);
    },

    /** Stores the answer on an ask: 1 when it was open, else 0. */
    async answer(askId: number | string, answer: string): Promise<number> {
      const r = await db.query('update build_msg set answer = $2, answered_at = $3 where id = $1 and answered_at is null', [askId, answer, iso()]);
      return r.rowCount || 0;
    },
  };
}

module.exports = { create, COLUMNS, LIVE };
