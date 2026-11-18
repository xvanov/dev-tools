'use strict';

// Aggregate: buildEvals. Table: build_eval_trial (one replay of a finished Build run on a profile, with its
// score; BUILD-ENRICHMENT.md F). Callers: src/eval/buildEval.ts. Times are ISO text the app writes, so the
// SQL is the same on Postgres and SQLite and src/repo/sqlite/buildEvals.ts re-exports this file.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('./types.ts').Db;
type Row = import('./types.ts').Row;

/** The columns `insert` writes after eval_id, run_id, profile, status and created_at. */
const FIELDS = [
  'model', 'effort', 'kind', 'reason', 'passed', 'tests', 'tests_note', 'files_changed', 'lines_added', 'lines_removed',
  'cost_usd', 'tokens_in', 'tokens_out', 'turns', 'wall_s', 'original_state', 'original_verdict', 'repo_path', 'base_sha',
];

const iso = (): string => new Date().toISOString();

function create(db: Db) {
  return {
    /** Saves a trial ({evalId, runId, profile, status, ...the FIELDS}); a missing field is null. The row. */
    async insert(v: Row): Promise<Row> {
      const ph = FIELDS.map((_, i) => `$${i + 6}`);
      const r = await db.query(
        `insert into build_eval_trial (eval_id, run_id, profile, status, created_at, ${FIELDS.join(', ')}) values ($1,$2,$3,$4,$5,${ph.join(',')}) returning *`,
        [v.evalId, v.runId, v.profile, v.status, iso(), ...FIELDS.map((f) => (v[f] === undefined ? null : v[f]))]
      );
      return r.rows[0] as Row;
    },

    /** Trials, newest first: one launch's (`evalId`) or all; at most `limit`. */
    async list({ evalId = null, limit = 2000 }: { evalId?: string | null; limit?: number } = {}): Promise<Row[]> {
      return evalId
        ? db.rows('select * from build_eval_trial where eval_id = $1 order by id desc limit $2', [evalId, limit])
        : db.rows('select * from build_eval_trial order by id desc limit $1', [limit]);
    },

    /** The newest launch's id, or null before any. */
    async latestEvalId(): Promise<string | null> {
      const r = await db.one('select eval_id from build_eval_trial order by id desc limit 1');
      return r ? String(r.eval_id) : null;
    },
  };
}

module.exports = { create, FIELDS };
