'use strict';

// Contract: src/repo/routines.js (see test/repoContract.test.js).

const R = (o = {}) => ({
  title: 'Sync repos', description: 'd', schedule: '0 9 * * *', action: 'repo_sync', params: { fetch: true }, enabled: true,
  origin: 'user', status: 'active', why: null, evidence: [{ id: 1 }], nextRunAt: new Date(Date.now() + 3600_000), ...o,
});

module.exports = {
  'insert: the row with params and evidence': async ({ repos, assert }) => {
    const r = await repos.routines.insert(R());
    assert.deepStrictEqual([r.title, r.action, r.params, r.enabled, r.origin, r.status], ['Sync repos', 'repo_sync', { fetch: true }, true, 'user', 'active']);
    assert.deepStrictEqual(typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence, [{ id: 1 }]);
    assert.ok(r.next_run_at instanceof Date);
  },

  'byId: the row, or null': async ({ repos, assert }) => {
    const r = await repos.routines.insert(R());
    assert.strictEqual(String((await repos.routines.byId(r.id)).id), String(r.id));
    assert.strictEqual(await repos.routines.byId(-1), null);
  },

  'list: with the newest run, proposed first, by status filter': async ({ repos, assert, uniq }) => {
    const p = await repos.routines.insert(R({ title: uniq('p'), status: 'proposed', enabled: false, nextRunAt: null }));
    const a = await repos.routines.insert(R({ title: uniq('a') }));
    const run = await repos.routines.startRun(a.id, false);
    const all = await repos.routines.list();
    const ia = all.findIndex((x) => String(x.id) === String(a.id));
    const ip = all.findIndex((x) => String(x.id) === String(p.id));
    assert.ok(ip >= 0 && ip < ia, 'proposed before active');
    assert.deepStrictEqual([String(all[ia].last_run_id), all[ia].running], [String(run.id), true]);
    const only = await repos.routines.list({ statuses: ['proposed'] });
    assert.ok(only.every((x) => x.status === 'proposed') && only.some((x) => String(x.id) === String(p.id)));
  },

  'runs: newest first, of one routine or all, with title and action': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R());
    const r1 = await repos.routines.startRun(a.id, true);
    await new Promise((x) => setTimeout(x, 5));
    const r2 = await repos.routines.startRun(a.id, false);
    const mine = await repos.routines.runs({ limit: 10, routineId: a.id });
    assert.deepStrictEqual(mine.map((x) => String(x.id)), [String(r2.id), String(r1.id)]);
    assert.deepStrictEqual([mine[0].title, mine[0].action], ['Sync repos', 'repo_sync']);
    assert.strictEqual((await repos.routines.runs({ limit: 1 })).length, 1);
  },

  'setStatus: status, enabled and next run': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R());
    const r = await repos.routines.setStatus(a.id, 'paused', false, null);
    assert.deepStrictEqual([r.status, r.enabled, r.next_run_at], ['paused', false, null]);
  },

  'reject: rejected and off': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R({ origin: 'suggested', status: 'proposed' }));
    await repos.routines.reject(a.id);
    const r = await repos.routines.byId(a.id);
    assert.deepStrictEqual([r.status, r.enabled, r.next_run_at], ['rejected', false, null]);
  },

  'remove: gone': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R());
    await repos.routines.remove(a.id);
    assert.strictEqual(await repos.routines.byId(a.id), null);
  },

  'startRun: an open run': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R());
    const run = await repos.routines.startRun(a.id, true);
    assert.deepStrictEqual([String(run.routine_id), run.dry_run, run.ended_at], [String(a.id), true, null]);
  },

  'endRun: verdict, summary, detail': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R());
    const run = await repos.routines.startRun(a.id, false);
    const done = await repos.routines.endRun(run.id, false, 'failed: x', { lines: ['a'], ms: 5 });
    assert.deepStrictEqual([done.ok, done.summary, done.detail], [false, 'failed: x', { lines: ['a'], ms: 5 }]);
    assert.ok(done.ended_at instanceof Date);
  },

  'closeInterrupted: open runs end as failed': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R());
    const run = await repos.routines.startRun(a.id, false);
    await repos.routines.closeInterrupted();
    const [r] = await repos.routines.runs({ limit: 1, routineId: a.id });
    assert.deepStrictEqual([String(r.id), r.ok, /interrupted/.test(r.summary)], [String(run.id), false, true]);
  },

  'touchLastRun: stamps last_run_at': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R());
    await repos.routines.touchLastRun(a.id);
    assert.ok((await repos.routines.byId(a.id)).last_run_at instanceof Date);
  },

  'due: active, enabled, next run passed, soonest first': async ({ repos, assert }) => {
    const late = await repos.routines.insert(R({ nextRunAt: new Date(Date.now() - 120_000) }));
    const later = await repos.routines.insert(R({ nextRunAt: new Date(Date.now() - 60_000) }));
    const future = await repos.routines.insert(R());
    const off = await repos.routines.insert(R({ enabled: false, nextRunAt: new Date(Date.now() - 60_000) }));
    const ids = (await repos.routines.due()).map((x) => String(x.id));
    assert.ok(ids.indexOf(String(late.id)) >= 0 && ids.indexOf(String(late.id)) < ids.indexOf(String(later.id)));
    assert.ok(!ids.includes(String(future.id)) && !ids.includes(String(off.id)));
  },

  'pauseForever: paused, off, no next run': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R());
    await repos.routines.pauseForever(a.id);
    const r = await repos.routines.byId(a.id);
    assert.deepStrictEqual([r.status, r.enabled, r.next_run_at], ['paused', false, null]);
  },

  'claimNext: only from the expected time, once': async ({ repos, assert }) => {
    const at = new Date(Date.now() - 60_000);
    const a = await repos.routines.insert(R({ nextRunAt: at }));
    const next = new Date(Date.now() + 86400_000);
    assert.ok(await repos.routines.claimNext(a.id, next, at));
    assert.strictEqual(await repos.routines.claimNext(a.id, next, at), null, 'another process claimed it');
  },

  'setNextRun: puts the time back': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R());
    const at = new Date('2026-12-01T09:00:00Z');
    await repos.routines.setNextRun(a.id, at);
    assert.strictEqual((await repos.routines.byId(a.id)).next_run_at.toISOString(), at.toISOString());
  },

  'summaries: title, schedule, action, params and status': async ({ repos, assert }) => {
    const a = await repos.routines.insert(R());
    const row = (await repos.routines.summaries()).find((x) => String(x.id) === String(a.id));
    assert.deepStrictEqual(Object.keys(row).sort(), ['action', 'id', 'params', 'schedule', 'status', 'title']);
  },
};
