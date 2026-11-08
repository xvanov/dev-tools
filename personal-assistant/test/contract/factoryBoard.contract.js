'use strict';

// Contract: src/repo/factoryBoard.js (see test/repoContract.test.js). One row, shared by the cases in order.

const job = (id, state) => ({ job_id: id, state, why: null });

module.exports = {
  'store: keeps the list and clears the error; row() reads it back': async ({ repos, assert }) => {
    await repos.factoryBoard.recordError('listing failed');
    await repos.factoryBoard.store([job('app:1', 'queued'), job('app:2', 'running')]);
    const r = await repos.factoryBoard.row();
    assert.deepStrictEqual(r.jobs.map((j) => j.job_id), ['app:1', 'app:2']);
    assert.ok(r.polled_at instanceof Date);
    assert.deepStrictEqual([r.error, r.error_at], [null, null]);
  },

  'recordError: keeps the stored jobs and records the error': async ({ repos, assert }) => {
    await repos.factoryBoard.store([job('app:9', 'queued')]);
    await repos.factoryBoard.recordError('boom');
    const r = await repos.factoryBoard.row();
    assert.deepStrictEqual([r.error, r.error_at instanceof Date, r.jobs.map((j) => j.job_id)], ['boom', true, ['app:9']]);
  },

  'row: the stored list with its time and error': async ({ repos, assert }) => {
    await repos.factoryBoard.store([job('app:5', 'queued')]);
    const r = await repos.factoryBoard.row();
    assert.ok(['jobs', 'polled_at', 'error', 'error_at'].every((k) => k in r));
  },

  'patchJob: merges into one job when its state changes; 0 when it would not': async ({ repos, assert }) => {
    await repos.factoryBoard.store([job('app:1', 'queued'), job('app:2', 'queued')]);
    assert.strictEqual(await repos.factoryBoard.patchJob('app:1', { state: 'running', why: 'started' }, 'running'), 1);
    const jobs = (await repos.factoryBoard.row()).jobs;
    assert.deepStrictEqual(jobs.map((j) => [j.job_id, j.state, j.why]), [['app:1', 'running', 'started'], ['app:2', 'queued', null]]);
    assert.strictEqual(await repos.factoryBoard.patchJob('app:1', { state: 'running' }, 'running'), 0, 'same state');
    assert.strictEqual(await repos.factoryBoard.patchJob('app:none', { state: 'running' }, 'running'), 0, 'unknown job');
  },

  'notifyPush: publishes without throwing': async ({ repos }) => {
    await repos.factoryBoard.notifyPush(['app:1', 'app:2']);
    await repos.factoryBoard.notifyPush([]);
  },
};
