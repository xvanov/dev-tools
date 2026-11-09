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

  // --- for chunk F (routines/actions/repoSync.js)
  'livePaths: live runs\' repo and worktree paths': async ({ repos, seed, db, assert }) => {
    const live = await seed.run({ status: 'running' });
    const done = await seed.run({ status: 'done' });
    await db.query(`update run set repo_path = '/w/r', worktree_path = '/wt/1' where id = any($1::bigint[])`, [[live, done]]);
    const rows = await repos.runs.livePaths();
    const r = rows.find((x) => Number(x.id) === live);
    assert.deepStrictEqual([r.repo_path, r.worktree_path], ['/w/r', '/wt/1']);
    assert.ok(!rows.some((x) => Number(x.id) === done));
  },

  // --- for dispatch, durable, mcp, e2e (chunk E)

  'liveForCommitment: the newest live run of a commitment; null when none live': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    assert.strictEqual(await repos.runs.liveForCommitment(c), null);
    await seed.run({ commitmentId: c, status: 'done' });
    const live = await seed.run({ commitmentId: c, status: 'waiting' });
    const got = await repos.runs.liveForCommitment(c);
    assert.strictEqual(Number(got.id), live);
    assert.ok('machine' in got);
  },

  'setWorktree: records worktree and branch': async ({ repos, seed, db, assert }) => {
    const id = await seed.run();
    await repos.runs.setWorktree(id, '/w/x', 'pa/1-x');
    const r = await db.one('select worktree_path, branch from run where id = $1', [id]);
    assert.deepStrictEqual([r.worktree_path, r.branch], ['/w/x', 'pa/1-x']);
  },

  'markRunning: session, brief, status running': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'starting' });
    await repos.runs.markRunning(id, 'sess-1', '/b.md');
    const r = await db.one('select status, termhub_session_id, brief_path from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.termhub_session_id, r.brief_path], ['running', 'sess-1', '/b.md']);
  },

  'markStartFailed: failed with outcome, end time and note': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'starting' });
    await repos.runs.markStartFailed(id, 'start failed: x');
    const r = await db.one('select status, outcome, exit_note, ended_at from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.outcome, r.exit_note, r.ended_at instanceof Date], ['failed', 'failed', 'start failed: x', true]);
  },

  'markRemoteStartFailed: failed, keeping the session that was opened': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'starting' });
    await repos.runs.markRemoteStartFailed(id, 'sess-r', 'boom');
    const r = await db.one('select status, termhub_session_id, exit_note from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.termhub_session_id, r.exit_note], ['failed', 'sess-r', 'boom']);
  },

  'markRemoteRunning: running with session, brief, worktree and branch': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'starting' });
    await repos.runs.markRemoteRunning(id, { sessionId: 's', briefPath: '/b', worktreePath: '/w', branch: 'br' });
    const r = await db.one('select status, termhub_session_id, brief_path, worktree_path, branch from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.termhub_session_id, r.brief_path, r.worktree_path, r.branch], ['running', 's', '/b', '/w', 'br']);
  },

  'recent: all runs, or those on your plate, newest first, limited': async ({ repos, seed, assert }) => {
    const live = await seed.run({ status: 'running' });
    const failed = await seed.run({ status: 'failed' });
    const plate = (await repos.runs.recent(false, 500)).map((r) => Number(r.id));
    assert.ok(plate.includes(live) && !plate.includes(failed));
    assert.ok((await repos.runs.recent(true, 500)).map((r) => Number(r.id)).includes(failed));
    assert.strictEqual((await repos.runs.recent(true, 1)).length, 1);
    const times = (await repos.runs.recent(true, 50)).map((r) => new Date(r.started_at).getTime());
    assert.deepStrictEqual(times, [...times].sort((a, b) => b - a));
  },

  'setDiffStat: stores the stat as json': async ({ repos, seed, db, assert }) => {
    const id = await seed.run();
    await repos.runs.setDiffStat(id, { stat: '1 file', commits: 2, uncommitted: 0 });
    assert.deepStrictEqual((await db.one('select diff_stat from run where id = $1', [id])).diff_stat, { stat: '1 file', commits: 2, uncommitted: 0 });
  },

  'markLanded: landed, delivered, with the MR link': async ({ repos, seed, db, assert }) => {
    const id = await seed.run();
    await repos.runs.markLanded(id, 'https://pr/1');
    const r = await db.one('select status, mr_url, outcome, ended_at from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.mr_url, r.outcome, r.ended_at instanceof Date], ['landed', 'https://pr/1', 'delivered', true]);
  },

  'markPushedToMain: landed, merged; keeps an end time and a note when none given': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ endedAt: new Date('2026-01-01T00:00:00Z') });
    await db.query(`update run set exit_note = 'kept' where id = $1`, [id]);
    await repos.runs.markPushedToMain(id, null);
    const r = await db.one('select status, outcome, exit_note, ended_at from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.outcome, r.exit_note, r.ended_at.toISOString()], ['landed', 'merged', 'kept', '2026-01-01T00:00:00.000Z']);
    await repos.runs.markPushedToMain(id, 'ci green');
    assert.strictEqual((await db.one('select exit_note from run where id = $1', [id])).exit_note, 'ci green');
  },

  'block: blocked with a reason, unless landed or dropped': async ({ repos, seed, db, assert }) => {
    const a = await seed.run({ status: 'running' });
    const b = await seed.run({ status: 'landed' });
    await repos.runs.block(a, 'CI failed');
    await repos.runs.block(b, 'late');
    const s = async (id) => (await db.one('select status, exit_note from run where id = $1', [id]));
    assert.deepStrictEqual([(await s(a)).status, (await s(a)).exit_note, (await s(b)).status], ['blocked', 'CI failed', 'landed']);
  },

  'markFactoryDropped: dropped, keeping an earlier end time and outcome': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ endedAt: new Date('2026-01-01T00:00:00Z') });
    await db.query(`update run set outcome = 'delivered' where id = $1`, [id]);
    await repos.runs.markFactoryDropped(id);
    const r = await db.one('select status, outcome, ended_at from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.outcome, r.ended_at.toISOString()], ['dropped', 'delivered', '2026-01-01T00:00:00.000Z']);
  },

  'markDropped: dropped with outcome dropped unless one is set': async ({ repos, seed, db, assert }) => {
    const id = await seed.run();
    await repos.runs.markDropped(id);
    const r = await db.one('select status, outcome from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.outcome], ['dropped', 'dropped']);
  },

  'markDone: done with the end time and note': async ({ repos, seed, db, assert }) => {
    const id = await seed.run();
    await repos.runs.markDone(id, 'finished');
    const r = await db.one('select status, exit_note, ended_at from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.exit_note, r.ended_at instanceof Date], ['done', 'finished', true]);
  },

  'activeForReconcile: live runs that are not factory runs': async ({ repos, seed, db, assert }) => {
    const a = await seed.run({ status: 'running' });
    const f = await seed.run({ status: 'running' });
    await db.query(`update run set route = 'factory' where id = $1`, [f]);
    const d = await seed.run({ status: 'done' });
    const ids = (await repos.runs.activeForReconcile()).map((r) => Number(r.id));
    assert.ok(ids.includes(a) && !ids.includes(f) && !ids.includes(d));
  },

  'setStatus: sets the status': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'running' });
    await repos.runs.setStatus(id, 'waiting');
    assert.strictEqual((await db.one('select status from run where id = $1', [id])).status, 'waiting');
  },

  'markSubmitRefused: failed with the note, brief path and author': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'starting' });
    await repos.runs.markSubmitRefused(id, 'refused', '/b', 'agent');
    const r = await db.one('select status, exit_note, brief_path, brief_by from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.exit_note, r.brief_path, r.brief_by], ['failed', 'refused', '/b', 'agent']);
  },

  'setSession: stores the follow session': async ({ repos, seed, db, assert }) => {
    const id = await seed.run();
    await repos.runs.setSession(id, 'follow-1');
    assert.strictEqual((await db.one('select termhub_session_id from run where id = $1', [id])).termhub_session_id, 'follow-1');
  },

  'recordJob: running and queued while live; false once the run ended': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'starting' });
    const ok = await repos.runs.recordJob(id, { jobId: 'app:0001', delivery: 'pr', pipeline: 'solo', briefPath: '/b', warnings: ['w1'], exitNote: 'factory warned: w1', by: 'me' });
    assert.strictEqual(ok, true);
    const r = await db.one('select status, factory_job_id, factory_state, delivery, pipeline, factory_warnings, exit_note, brief_by from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.factory_job_id, r.factory_state, r.delivery, r.pipeline, r.factory_warnings, r.exit_note, r.brief_by], ['running', 'app:0001', 'queued', 'pr', 'solo', ['w1'], 'factory warned: w1', 'me']);
    const ended = await seed.run({ status: 'done' });
    assert.strictEqual(await repos.runs.recordJob(ended, { jobId: 'app:0002', delivery: null, pipeline: null, briefPath: null, warnings: [], exitNote: null, by: null }), false);
  },

  'markLateJobCancelled: remembers the job, state cancelled': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'done' });
    await repos.runs.markLateJobCancelled(id, 'app:0009');
    const r = await db.one('select factory_job_id, factory_state from run where id = $1', [id]);
    assert.deepStrictEqual([r.factory_job_id, r.factory_state], ['app:0009', 'cancelled']);
  },

  'markSubmitFailed: failed only while no job is recorded': async ({ repos, seed, db, assert }) => {
    const a = await seed.run({ status: 'starting' });
    const b = await seed.run({ status: 'starting' });
    await db.query(`update run set factory_job_id = 'app:1' where id = $1`, [b]);
    await repos.runs.markSubmitFailed(a, 'no job');
    await repos.runs.markSubmitFailed(b, 'no job');
    const s = async (id) => (await db.one('select status, factory_state from run where id = $1', [id]));
    assert.deepStrictEqual([(await s(a)).status, (await s(a)).factory_state, (await s(b)).status], ['failed', 'not_submitted', 'starting']);
  },

  'markSubmitUnknown: waiting, submit_unknown, only while no job is recorded': async ({ repos, seed, db, assert }) => {
    const a = await seed.run({ status: 'starting' });
    await repos.runs.markSubmitUnknown(a, 'lost', '/b');
    const r = await db.one('select status, factory_state, exit_note, brief_path from run where id = $1', [a]);
    assert.deepStrictEqual([r.status, r.factory_state, r.exit_note, r.brief_path], ['waiting', 'submit_unknown', 'lost', '/b']);
  },

  'applyFactoryState: status, outcome, cost, MR; end time stamped once when ended': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'running' });
    await repos.runs.applyFactoryState(id, { status: 'done', outcome: 'delivered', factoryState: 'delivered', costUsd: 1.5, mrUrl: 'https://pr/9', exitNote: null, delivery: 'pr', ended: true });
    const r = await db.one('select status, outcome, factory_state, cost_usd, mr_url, delivery, ended_at, outcome_at from run where id = $1', [id]);
    assert.deepStrictEqual([r.status, r.outcome, r.factory_state, Number(r.cost_usd), r.mr_url, r.delivery, r.ended_at instanceof Date, r.outcome_at instanceof Date], ['done', 'delivered', 'delivered', 1.5, 'https://pr/9', 'pr', true, true]);
    await repos.runs.applyFactoryState(id, { status: 'done', outcome: 'delivered', factoryState: 'delivered', costUsd: null, mrUrl: null, exitNote: null, delivery: null, ended: true });
    assert.strictEqual(Number((await db.one('select cost_usd from run where id = $1', [id])).cost_usd), 1.5, 'null keeps');
  },

  'applyFactoryState whileStatus: written only while the run still has that status': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'running' });
    const end = { status: 'landed', outcome: 'delivered', factoryState: 'done', costUsd: null, mrUrl: null, exitNote: null, delivery: null, ended: true, whileStatus: 'running' };
    assert.strictEqual(await repos.runs.applyFactoryState(id, end), true);
    const first = await db.one('select status, ended_at from run where id = $1', [id]);
    assert.strictEqual(first.status, 'landed');
    // A second writer that read the run while it was still running loses.
    assert.strictEqual(await repos.runs.applyFactoryState(id, { ...end, status: 'running', outcome: null, factoryState: 'in_progress', ended: false }), false);
    const after = await db.one('select status, factory_state, ended_at from run where id = $1', [id]);
    assert.deepStrictEqual([after.status, after.factory_state, String(after.ended_at)], ['landed', 'done', String(first.ended_at)]);
    assert.strictEqual(await repos.runs.applyFactoryState(id, { ...end, factoryState: 'done', whileStatus: null }), true, 'no guard: written');
  },

  'setSubscriptionEquiv: stores the figure': async ({ repos, seed, db, assert }) => {
    const id = await seed.run();
    await repos.runs.setSubscriptionEquiv(id, 2.25);
    assert.strictEqual(Number((await db.one('select subscription_equiv_usd from run where id = $1', [id])).subscription_equiv_usd), 2.25);
  },

  'upsertPr: records a PR; a repeat updates what changed': async ({ repos, seed, assert }) => {
    const id = await seed.run();
    await repos.runs.upsertPr(id, { url: 'https://pr/1', number: 1, story_id: 11, state: 'open', ci_state: 'pending', ci_failing: null });
    await repos.runs.upsertPr(id, { url: 'https://pr/1', number: 1, story_id: 11, state: 'merged', ci_state: 'passed', ci_failing: ['lint'] });
    const prs = await repos.runs.prsOf([id]);
    assert.strictEqual(prs.length, 1);
    assert.deepStrictEqual([prs[0].state, prs[0].ci_state, prs[0].ci_failing], ['merged', 'passed', ['lint']]);
  },

  'upsertStep: records a step; a repeat updates what changed': async ({ repos, seed, assert }) => {
    const id = await seed.run();
    const step = (over = {}) => ({ step_id: 'dev-1', job_id: 'app:1', story_id: 12, persona: 'dev', runtime: 'api', model: 'm', state: 'running', started_at: '2026-01-01T00:00:00Z', ended_at: null, machine: null, termhub_session_id: 'sess', url: null, ...over });
    await repos.runs.upsertStep(id, step());
    await repos.runs.upsertStep(id, step({ state: 'done', ended_at: '2026-01-01T01:00:00Z' }));
    const steps = await repos.runs.stepsOf([id]);
    assert.strictEqual(steps.length, 1);
    assert.deepStrictEqual([steps[0].state, steps[0].termhub_session_id, steps[0].ended_at instanceof Date], ['done', 'sess', true]);
  },

  'prsOf: the PRs of runs by run then number': async ({ repos, seed, assert }) => {
    const id = await seed.run();
    await repos.runs.upsertPr(id, { url: 'https://pr/b', number: 2, story_id: null, state: 'open', ci_state: null, ci_failing: null });
    await repos.runs.upsertPr(id, { url: 'https://pr/a', number: 1, story_id: null, state: 'open', ci_state: null, ci_failing: null });
    assert.deepStrictEqual((await repos.runs.prsOf([id])).map((p) => p.number), [1, 2]);
    assert.deepStrictEqual(await repos.runs.prsOf([]), []);
  },

  'stepsOf: the steps of runs, newest first within a run': async ({ repos, seed, assert }) => {
    const id = await seed.run();
    const mk = (step_id, at) => ({ step_id, job_id: 'j', story_id: null, persona: 'dev', runtime: 'api', model: 'm', state: 'done', started_at: at, ended_at: null, machine: null, termhub_session_id: null, url: null });
    await repos.runs.upsertStep(id, mk('old', '2026-01-01T00:00:00Z'));
    await repos.runs.upsertStep(id, mk('new', '2026-01-02T00:00:00Z'));
    assert.deepStrictEqual((await repos.runs.stepsOf([id])).map((s) => s.step_id), ['new', 'old']);
  },

  'watchedFactoryRuns: factory runs with a job that are live or were delivered lately': async ({ repos, seed, db, assert, uniq }) => {
    const mk = async (status, extra = '') => {
      const id = await seed.run({ status });
      await db.query(`update run set route = 'factory', factory_job_id = $2 ${extra} where id = $1`, [id, uniq('job')]);
      return id;
    };
    const live = await mk('running');
    const delivered = await mk('done', ", outcome = 'delivered', ended_at = now()");
    const old = await mk('done', ", outcome = 'delivered', ended_at = now() - interval '30 days'");
    const failed = await mk('failed');
    // 8.4.23: ended on the PA's side while the job still moved.
    const dropped = await mk('dropped', ", factory_state = 'in_progress'");
    const settled = await mk('dropped', ", factory_state = 'cancelled'");
    const ids = (await repos.runs.watchedFactoryRuns()).map((r) => Number(r.id));
    assert.ok(ids.includes(live) && ids.includes(delivered) && !ids.includes(old) && !ids.includes(failed));
    assert.ok(ids.includes(dropped) && !ids.includes(settled), 'asked until the factory has ended the job');
  },

  'distinctFactoryJobIds: the job ids of factory runs': async ({ repos, seed, db, assert, uniq }) => {
    const job = uniq('job');
    await db.query(`update run set route = 'factory', factory_job_id = $2 where id = $1`, [await seed.run(), job]);
    await db.query(`update run set route = 'factory' where id = $1`, [await seed.run()]);
    const got = (await repos.runs.distinctFactoryJobIds()).map((r) => r.factory_job_id);
    assert.strictEqual(got.filter((j) => j === job).length, 1);
    assert.ok(!got.includes(null));
  },

  'liveRunOfJob: the newest live run of a job; null once ended': async ({ repos, seed, db, assert, uniq }) => {
    const job = uniq('job');
    const a = await seed.run({ status: 'running' });
    await db.query(`update run set route = 'factory', factory_job_id = $2 where id = $1`, [a, job]);
    assert.strictEqual(Number((await repos.runs.liveRunOfJob(job)).id), a);
    await db.query(`update run set status = 'done' where id = $1`, [a]);
    assert.strictEqual(await repos.runs.liveRunOfJob(job), null);
  },

  'unsettledFactory: factory runs whose submit was never confirmed, with their age': async ({ repos, seed, db, assert }) => {
    const unknown = await seed.run({ status: 'waiting' });
    await db.query(`update run set route = 'factory', factory_state = 'submit_unknown' where id = $1`, [unknown]);
    const stale = await seed.run({ status: 'starting' });
    await db.query(`update run set route = 'factory', started_at = now() - interval '10 minutes' where id = $1`, [stale]);
    const fresh = await seed.run({ status: 'starting' });
    await db.query(`update run set route = 'factory' where id = $1`, [fresh]);
    const got = await repos.runs.unsettledFactory();
    const ids = got.map((r) => Number(r.id));
    assert.ok(ids.includes(unknown) && ids.includes(stale) && !ids.includes(fresh));
    assert.ok(Number(got.find((r) => Number(r.id) === stale).age_ms) > 9 * 60_000);
  },

  'forRouteStats: runs of the last days with their commitment kind': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment();
    await seed.commitmentSet(c, { kind: 'coding' });
    const id = await seed.run({ commitmentId: c, status: 'done' });
    const old = await seed.run({ status: 'done' });
    await db.query(`update run set started_at = now() - interval '200 days' where id = $1`, [old]);
    const got = await repos.runs.forRouteStats(90);
    assert.ok(got.some((r) => r.kind === 'coding' && r.status === 'done'));
    assert.ok(['route', 'kind', 'outcome', 'status', 'cost_usd'].every((k) => k in got[0]));
    assert.ok(id);
  },

  'forReview: the run fields a review needs; null when gone': async ({ repos, seed, assert }) => {
    const id = await seed.run({ task: 'review me' });
    const r = await repos.runs.forReview(id);
    assert.deepStrictEqual([r.task, r.status, r.mode], ['review me', 'running', 'plan']);
    assert.ok(['commitment_id', 'machine', 'mr_url', 'delivery'].every((k) => k in r));
    assert.strictEqual(await repos.runs.forReview(999999999), null);
  },

  'repoPathOf: a run\'s repo folder': async ({ repos, seed, db, assert }) => {
    const id = await seed.run();
    await db.query(`update run set repo_path = '/r/x' where id = $1`, [id]);
    assert.strictEqual((await repos.runs.repoPathOf(id)).repo_path, '/r/x');
  },

  'modeStatusMr: mode, status and MR link': async ({ repos, seed, db, assert }) => {
    const id = await seed.run({ status: 'landed' });
    await db.query(`update run set mr_url = 'https://pr/3' where id = $1`, [id]);
    const r = await repos.runs.modeStatusMr(id);
    assert.deepStrictEqual([r.mode, r.status, r.mr_url], ['plan', 'landed', 'https://pr/3']);
  },

  'setModeMr: forces the mode to mr': async ({ repos, seed, db, assert }) => {
    const id = await seed.run();
    await repos.runs.setModeMr(id);
    assert.strictEqual((await db.one('select mode from run where id = $1', [id])).mode, 'mr');
  },

  'markMergedOutcome: outcome merged, keeping the note when none given': async ({ repos, seed, db, assert }) => {
    const id = await seed.run();
    await db.query(`update run set exit_note = 'keep' where id = $1`, [id]);
    await repos.runs.markMergedOutcome(id, null);
    let r = await db.one('select outcome, exit_note, outcome_at from run where id = $1', [id]);
    assert.deepStrictEqual([r.outcome, r.exit_note, r.outcome_at instanceof Date], ['merged', 'keep', true]);
    await repos.runs.markMergedOutcome(id, 'ci green');
    r = await db.one('select exit_note from run where id = $1', [id]);
    assert.strictEqual(r.exit_note, 'ci green');
  },

  'latestRunPerJob: for each job id its run': async ({ repos, seed, db, assert, uniq }) => {
    const job = uniq('job');
    const a = await seed.run();
    await db.query(`update run set route = 'factory', factory_job_id = $2 where id = $1`, [a, job]);
    const got = await repos.runs.latestRunPerJob([job, uniq('none')]);
    assert.deepStrictEqual(got.map((r) => [Number(r.id), r.factory_job_id]), [[a, job]]);
    assert.deepStrictEqual(await repos.runs.latestRunPerJob([]), []);
  },

  'newestOfJob: the run of one factory job; null for none': async ({ repos, seed, db, assert, uniq }) => {
    const job = uniq('job');
    const a = await seed.run();
    await db.query(`update run set route = 'factory', factory_job_id = $2 where id = $1`, [a, job]);
    assert.strictEqual(Number((await repos.runs.newestOfJob(job)).id), a);
    assert.strictEqual(await repos.runs.newestOfJob(uniq('none')), null);
  },

  'cardRuns: a commitment\'s five newest runs': async ({ repos, seed, assert }) => {
    const c = await seed.commitment();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await seed.run({ commitmentId: c, status: 'done' }));
    const got = await repos.runs.cardRuns(c);
    assert.strictEqual(got.length, 5);
    assert.ok(['route', 'factory_job_id', 'delivery', 'cost_usd', 'termhub_session_id'].every((k) => k in got[0]));
  },

  'withSessions: runs with a session started in the last 30 days': async ({ repos, seed, db, assert }) => {
    const a = await seed.run();
    await db.query(`update run set termhub_session_id = 'ws-1' where id = $1`, [a]);
    const old = await seed.run();
    await db.query(`update run set termhub_session_id = 'ws-2', started_at = now() - interval '60 days' where id = $1`, [old]);
    await seed.run();
    const ids = (await repos.runs.withSessions()).map((r) => Number(r.id));
    assert.ok(ids.includes(a) && !ids.includes(old));
  },

  'stepsBySessions: the steps whose sessions are listed, with their run': async ({ repos, seed, assert }) => {
    const id = await seed.run({ status: 'running' });
    await repos.runs.upsertStep(id, { step_id: 'dev', job_id: 'app:5', story_id: null, persona: 'dev', runtime: 'api', model: 'm', state: 'running', started_at: null, ended_at: null, machine: null, termhub_session_id: 'bs-1', url: null });
    const got = await repos.runs.stepsBySessions(['bs-1', 'bs-none']);
    assert.deepStrictEqual(got.map((r) => [r.termhub_session_id, r.step_id, Number(r.run_id), r.status]), [['bs-1', 'dev', id, 'running']]);
  },

  'inRepo: the ten newest runs in a repo folder': async ({ repos, seed, db, assert, uniq }) => {
    const path = `/r/${uniq('repo')}`;
    for (let i = 0; i < 11; i++) await db.query(`update run set repo_path = $2 where id = $1`, [await seed.run(), path]);
    assert.strictEqual((await repos.runs.inRepo(path)).length, 10);
    assert.deepStrictEqual(await repos.runs.inRepo(`${path}-none`), []);
  },

  'jobsOfCommitments: the runs of the commitments with job and state': async ({ repos, seed, db, assert }) => {
    const c = await seed.commitment();
    const id = await seed.run({ commitmentId: c });
    await db.query(`update run set factory_job_id = 'app:7', factory_state = 'in_progress', termhub_session_id = 'fs-1', machine = 'box' where id = $1`, [id]);
    const got = await repos.runs.jobsOfCommitments([c]);
    assert.deepStrictEqual(
      got.map((r) => [Number(r.id), Number(r.commitment_id), r.factory_job_id, r.factory_state, r.termhub_session_id, r.machine]),
      [[id, c, 'app:7', 'in_progress', 'fs-1', 'box']]
    );
    assert.ok(!Number.isNaN(new Date(got[0].started_at).getTime()), 'started_at is a time');
  },

  'prLinksOf: the distinct PRs of runs': async ({ repos, seed, assert }) => {
    const id = await seed.run();
    await repos.runs.upsertPr(id, { url: 'https://pr/5', number: 5, story_id: null, state: 'open', ci_state: null, ci_failing: null });
    assert.deepStrictEqual((await repos.runs.prLinksOf([id])).map((r) => [Number(r.run_id), r.pr_number, r.pr_url]), [[id, 5, 'https://pr/5']]);
  },

  'stepSessionsOf: the sessions of runs\' steps': async ({ repos, seed, assert }) => {
    const id = await seed.run();
    const step = (step_id, sess) => ({ step_id, job_id: 'j', story_id: null, persona: 'dev', runtime: 'api', model: 'm', state: 'running', started_at: null, ended_at: null, machine: 'box', termhub_session_id: sess, url: null });
    await repos.runs.upsertStep(id, step('a', 'ss-1'));
    await repos.runs.upsertStep(id, step('b', null));
    assert.deepStrictEqual((await repos.runs.stepSessionsOf([id])).map((r) => [Number(r.run_id), r.termhub_session_id, r.machine]), [[id, 'ss-1', 'box']]);
  },
};