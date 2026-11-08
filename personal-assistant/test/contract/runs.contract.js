'use strict';

// Contract: src/repo/runs.js (see test/repoContract.test.js).

const claude = (o = {}) => ({ commitmentId: null, mode: 'mr', task: 'a task', repoPath: '/w/repo', machine: 'box', routeReason: 'you chose', kind: 'coding', delivery: 'draft_pr', deliverySource: 'explicit', ...o });
const factory = (o = {}) => ({
  commitmentId: null, mode: 'mr', task: 'a job', repoPath: null, machine: 'box', routeReason: 'factory', kind: null,
  pipeline: 'solo', deliveryRequested: 'pr', models: { dev: 'deepseek/x' }, deliverySource: 'default', jobKind: 'code', runtime: 'api', ...o,
});

module.exports = {
  'insertClaude: a starting claude run with delivery requested = delivery': async ({ repos, assert }) => {
    const r = await repos.runs.insertClaude(claude());
    assert.ok(r.id);
    assert.deepStrictEqual(
      [r.status, r.route, r.mode, r.task, r.repo_path, r.machine, r.route_reason, r.kind, r.delivery, r.delivery_requested, r.delivery_source, r.commitment_id],
      ['starting', 'claude', 'mr', 'a task', '/w/repo', 'box', 'you chose', 'coding', 'draft_pr', 'draft_pr', 'explicit', null]
    );
    assert.ok(r.started_at instanceof Date);
  },

  'insertClaude: one live run per commitment, unless again': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const first = await repos.runs.insertClaude(claude({ commitmentId: c }), { commitmentId: c });
    await assert.rejects(repos.runs.insertClaude(claude({ commitmentId: c }), { commitmentId: c }), (e) => e.code === 'live_run' && new RegExp(`#${c} already has run #${first.id}`).test(e.message));
    const again = await repos.runs.insertClaude(claude({ commitmentId: c }), { commitmentId: c, again: true });
    assert.ok(Number(again.id) > Number(first.id));
  },

  'insertClaude: concurrent inserts for one commitment make exactly one run': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => repos.runs.insertClaude(claude({ commitmentId: c }), { commitmentId: c })));
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'live_run'));
  },

  'insertFactory: a starting factory run with models and the idempotency key in one transaction': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const r = await repos.runs.insertFactory(factory({ commitmentId: c }), { commitmentId: c, externalId: (row) => `install-${row.id}` });
    assert.deepStrictEqual(
      [r.status, r.route, r.pipeline, r.delivery_requested, r.delivery, r.job_kind, r.runtime, r.external_id],
      ['starting', 'factory', 'solo', 'pr', null, 'code', 'api', `install-${r.id}`]
    );
    assert.deepStrictEqual(r.models, { dev: 'deepseek/x' });
    assert.strictEqual((await repos.runs.byId(r.id)).external_id, `install-${r.id}`, 'stored, not only returned');
  },

  'insertFactory: a key that throws leaves no row behind': async ({ repos, seed, assert, uniq }) => {
    const c = await seed.commitment();
    const task = uniq('rolled-back');
    await assert.rejects(repos.runs.insertFactory(factory({ commitmentId: c, task }), { commitmentId: c, externalId: () => { throw new Error('no key'); } }), /no key/);
    const again = await repos.runs.insertFactory(factory({ commitmentId: c }), { commitmentId: c });
    assert.ok(again.id, 'the failed insert left no live run to block this one');
  },

  'byId: the row, or null': async ({ repos, assert }) => {
    const r = await repos.runs.insertClaude(claude());
    assert.strictEqual(String((await repos.runs.byId(r.id)).id), String(r.id));
    assert.strictEqual(await repos.runs.byId(-1), null);
  },

  'activeForBrief: runs starting, running or waiting, newest first, at most 10': async ({ repos, seed, assert }) => {
    const tag = `brief-active-${Math.random()}`;
    const a = await seed.run({ status: 'running', task: tag });
    const b = await seed.run({ status: 'waiting', task: tag });
    await seed.run({ status: 'done', task: tag });
    await seed.run({ status: 'blocked', task: tag });
    const got = await repos.runs.activeForBrief();
    assert.ok(got.length <= 10);
    const mine = got.filter((r) => r.task === tag).map((r) => Number(r.id));
    assert.ok(mine.every((id) => [a, b].includes(id)), 'only live statuses');
    assert.ok(['id', 'task', 'mode', 'status', 'repo_path', 'termhub_session_id', 'started_at', 'route', 'factory_job_id', 'factory_state'].every((k) => k in got[0]));
    const times = got.map((r) => new Date(r.started_at).getTime());
    assert.deepStrictEqual(times, [...times].sort((x, y) => y - x));
  },

  'reviewForBrief: runs done or blocked, latest ended first, at most 10': async ({ repos, seed, assert }) => {
    const tag = `brief-review-${Math.random()}`;
    const old = await seed.run({ status: 'done', task: tag, endedAt: new Date(Date.now() - 3 * 3600_000) });
    const recent = await seed.run({ status: 'blocked', task: tag, endedAt: new Date(Date.now() - 3600_000) });
    await seed.run({ status: 'running', task: tag });
    const got = await repos.runs.reviewForBrief();
    assert.ok(got.length <= 10);
    const mine = got.filter((r) => r.task === tag).map((r) => Number(r.id));
    assert.ok(mine.every((id) => [old, recent].includes(id)), 'only finished statuses');
    if (mine.length === 2) assert.deepStrictEqual(mine, [recent, old]);
    assert.ok(['id', 'task', 'mode', 'status', 'exit_note', 'repo_path', 'mr_url', 'ended_at'].every((k) => k in got[0]));
  },

    // --- for src/commitments/context.js

  'recentForCommitment: a commitment\'s three newest runs': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await repos.runs.insertClaude(claude({ commitmentId: c }), { commitmentId: c, again: true }));
    const got = await repos.runs.recentForCommitment(c);
    assert.strictEqual(got.length, 3);
    assert.deepStrictEqual(Object.keys(got[0]).sort(), ['branch', 'id', 'mode', 'mr_url', 'started_at', 'status']);
    assert.ok(!got.some((r) => String(r.id) === String(made[0].id)) || got.every((r) => r.started_at <= got[0].started_at), 'newest first');
    assert.deepStrictEqual(await repos.runs.recentForCommitment(await seed.commitment()), []);
  },
  // --- for cli, dashboard (chunk G)

  'factoryJobs: factory runs that have a job id': async ({ repos, seed, db, assert, uniq }) => {
    const withJob = await seed.run({ status: 'running' });
    const job = uniq('job');
    await db.query(`update run set route = 'factory', factory_job_id = $2 where id = $1`, [withJob, job]);
    const noJob = await seed.run({ status: 'running' });
    await db.query(`update run set route = 'factory' where id = $1`, [noJob]);
    const claude = await seed.run({ status: 'running' });
    await db.query(`update run set factory_job_id = $2 where id = $1`, [claude, uniq('stray')]);
    const got = await repos.runs.factoryJobs();
    assert.ok(got.some((r) => Number(r.id) === withJob && r.factory_job_id === job));
    assert.ok(!got.some((r) => [noJob, claude].includes(Number(r.id))));
  },

  'mrLinksFor: runs of the commitments with an MR link, newest first': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment();
    const old = await seed.run({ commitmentId: c, status: 'done' });
    const recent = await seed.run({ commitmentId: c, status: 'done' });
    const bare = await seed.run({ commitmentId: c, status: 'done' });
    await db.query(`update run set mr_url = 'https://pr/1', started_at = now() - interval '2 hours' where id = $1`, [old]);
    await db.query(`update run set mr_url = 'https://pr/2', started_at = now() - interval '1 hour' where id = $1`, [recent]);
    const got = await repos.runs.mrLinksFor([c]);
    assert.deepStrictEqual(got.map((r) => Number(r.id)), [recent, old]);
    assert.ok(!got.some((r) => Number(r.id) === bare));
    assert.deepStrictEqual(await repos.runs.mrLinksFor([]), []);
  },

  'newestPerCommitment: the newest runs of each commitment, numbered': async ({ repos, seed, db, assert }) => {
    const c1 = await seed.commitment();
    const c2 = await seed.commitment();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const id = await seed.run({ commitmentId: c1, status: 'done' });
      await db.query(`update run set started_at = now() - ($2 || ' hours')::interval where id = $1`, [id, String(10 - i)]);
      ids.push(id);
    }
    const other = await seed.run({ commitmentId: c2, status: 'running' });
    const got = await repos.runs.newestPerCommitment([c1, c2], 2);
    assert.deepStrictEqual(got.filter((r) => Number(r.commitment_id) === c1).map((r) => [Number(r.id), Number(r.n)]), [[ids[3], 1], [ids[2], 2]]);
    assert.deepStrictEqual(got.filter((r) => Number(r.commitment_id) === c2).map((r) => Number(r.id)), [other]);
    assert.ok(['status', 'route', 'machine', 'termhub_session_id', 'factory_job_id', 'factory_state', 'mr_url'].every((k) => k in got[0]));
  },

  'modeByWorktree: the mode of the newest run in a worktree; null for none': async ({ repos, seed, db, assert, uniq }) => {
    const wt = `/w/${uniq('wt')}`;
    const a = await seed.run({ status: 'done' });
    const b = await seed.run({ status: 'done' });
    await db.query(`update run set worktree_path = $2, mode = 'plan', started_at = now() - interval '2 hours' where id = $1`, [a, wt]);
    await db.query(`update run set worktree_path = $2, mode = 'branch', started_at = now() - interval '1 hour' where id = $1`, [b, wt]);
    assert.strictEqual((await repos.runs.modeByWorktree(wt)).mode, 'branch');
    assert.strictEqual(await repos.runs.modeByWorktree(`/w/${uniq('none')}`), null);
  },

  'detailsForCommitment: a commitment\'s runs for the dashboard, newest first': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment();
    const a = await seed.run({ commitmentId: c, status: 'done' });
    const b = await seed.run({ commitmentId: c, status: 'running' });
    await db.query(`update run set started_at = now() - interval '3 hours' where id = $1`, [a]);
    await seed.run({ status: 'running' });
    const got = await repos.runs.detailsForCommitment(c);
    assert.deepStrictEqual(got.map((r) => Number(r.id)), [b, a]);
    assert.ok(['status', 'mode', 'machine', 'branch', 'termhub_session_id', 'route', 'route_reason', 'factory_job_id', 'factory_state', 'factory_warnings', 'delivery', 'cost_usd', 'mr_url'].every((k) => k in got[0]));
  },
};