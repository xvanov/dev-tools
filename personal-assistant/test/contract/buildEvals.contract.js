'use strict';

// Contract: src/repo/buildEvals.ts (see test/repoContract.test.js). The same on Postgres and SQLite:
// this is also what proves sql/050 and sql-sqlite/022 create build_eval_trial and build_run.base_sha.

const trial = (o = {}) => ({ evalId: 'contract-e1', runId: 7, profile: 'chore', status: 'ok', model: 'sonnet', effort: 'low', kind: 'pr', passed: 1, tests: 'pass', files_changed: 2, lines_added: 10, lines_removed: 3, cost_usd: 0.42, tokens_in: 1000, tokens_out: 200, turns: 9, wall_s: 61.5, original_state: 'done', original_verdict: 'merged', repo_path: 'C:\\r', base_sha: 'abc123', ...o });

module.exports = {
  'insert: saves a trial, a missing field is null': async ({ repos, assert }) => {
    const t = await repos.buildEvals.insert(trial());
    assert.deepStrictEqual([t.eval_id, Number(t.run_id), t.profile, t.status, Number(t.passed), t.tests, Number(t.files_changed), Number(t.cost_usd), Number(t.turns), t.base_sha], ['contract-e1', 7, 'chore', 'ok', 1, 'pass', 2, 0.42, 9, 'abc123']);
    assert.ok(t.id && t.created_at);
    const bare = await repos.buildEvals.insert({ evalId: 'contract-e1', runId: 8, profile: 'quick', status: 'skipped', reason: 'no repo' });
    assert.deepStrictEqual([bare.reason, bare.passed, bare.cost_usd, bare.tests], ['no repo', null, null, null]);
  },

  'list: newest first, one launch or all, limited': async ({ repos, assert }) => {
    await repos.buildEvals.insert(trial({ evalId: 'contract-e2', runId: 1 }));
    await repos.buildEvals.insert(trial({ evalId: 'contract-e2', runId: 2 }));
    await repos.buildEvals.insert(trial({ evalId: 'contract-e3', runId: 3 }));
    assert.deepStrictEqual((await repos.buildEvals.list({ evalId: 'contract-e2' })).map((r) => Number(r.run_id)), [2, 1]);
    assert.strictEqual((await repos.buildEvals.list({ evalId: 'contract-e3', limit: 1 })).length, 1);
    assert.strictEqual(Number((await repos.buildEvals.list({ limit: 1 }))[0].run_id), 3);
  },

  'latestEvalId: the newest launch, or null': async ({ repos, assert }) => {
    await repos.buildEvals.insert(trial({ evalId: 'contract-e9', runId: 99 }));
    assert.strictEqual(await repos.buildEvals.latestEvalId(), 'contract-e9');
  },

  'build_run: base_sha is settable and starts null': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert({ task: 't', model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
    assert.strictEqual(r.base_sha, null);
    await repos.buildRuns.update(r.id, { base_sha: 'deadbeef' });
    assert.strictEqual((await repos.buildRuns.byId(r.id)).base_sha, 'deadbeef');
  },
};
