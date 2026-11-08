'use strict';

// The SQLite durable queue (src/durable/sqliteQueue.js, D19) behaves as the
// tasks expect Absurd to: one task per idempotency key, steps run once across
// suspensions and retries, sleeps and event waits park the task and resume
// it, a timeout throws absurd-sdk's TimeoutError, failures retry with backoff
// up to max attempts, and two workers never run one task at once. Runs on a
// throwaway SQLite file; skips without the optional driver.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { available, createSqliteBackend } = require('../src/db/sqlite');

if (!available()) {
  if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
  console.log('SKIP durableSqlite: better-sqlite3-multiple-ciphers is not installed');
  process.exit(0);
}

const { TimeoutError } = require('absurd-sdk');
const { createRepos } = require('../src/repo');
const { SqliteQueue } = require('../src/durable/sqliteQueue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-durable-'));
  const db = createSqliteBackend(path.join(dir, 'pa_test_durable.sqlite'));
  const workers = [];
  try {
    await db.migrate();
    const repos = createRepos(db);
    const mk = () => new SqliteQueue({ queueName: 'pa', repos, connect: () => db.pool.connect() });
    const q = mk();
    const calls = { effect: 0, flaky: 0 };
    const state = (id) => repos.durable.taskById(id);

    // A step's effect runs once even though the task resumes twice.
    q.registerTask({ name: 'steps' }, async (p, ctx) => {
      const a = await ctx.step('effect', async () => {
        calls.effect++;
        return { at: new Date(0), n: p.n };
      });
      await ctx.sleepFor('nap', 0.2);
      const ev = await ctx.awaitEvent(`go:${p.n}`, { stepName: 'wait-go', timeout: 60 });
      return { a, ev };
    });
    q.registerTask({ name: 'times-out' }, async (p, ctx) => {
      try {
        await ctx.awaitEvent('never', { stepName: 'w', timeout: 0.2 });
        return 'got it';
      } catch (err) {
        if (err instanceof TimeoutError) return 'timed out';
        throw err; // as chase and runReview do: a suspension passes through
      }
    });
    q.registerTask({ name: 'flaky', defaultMaxAttempts: 2 }, async () => {
      calls.flaky++;
      throw new Error('boom');
    });
    q.registerTask({ name: 'early-event' }, async (p, ctx) => ctx.awaitEvent('already', { stepName: 'w' }));

    // Idempotency: the same key is the same task.
    const s1 = await q.spawn('steps', { n: 1 }, { idempotencyKey: 'steps:1' });
    const s2 = await q.spawn('steps', { n: 1 }, { idempotencyKey: 'steps:1' });
    assert.strictEqual(s1.taskID, s2.taskID);
    assert.deepStrictEqual([s1.created, s2.created], [true, false]);

    const w = await q.startWorker({ concurrency: 2, pollInterval: 0.05 });
    workers.push(w);

    // Sleeps, then parks on the event; emitting it wakes it with the payload.
    await until('steps parked on its event', async () => (await state(s1.taskID)).wait_event === 'go:1');
    assert.strictEqual((await state(s1.taskID)).state, 'sleeping');
    await q.emitEvent('go:1', { ok: true });
    const done = await until('steps completed', async () => {
      const t = await state(s1.taskID);
      return t.state === 'completed' && t;
    });
    assert.deepStrictEqual(done.result, { a: { at: new Date(0).toISOString(), n: 1 }, ev: { ok: true } });
    assert.strictEqual(calls.effect, 1, 'the step ran once across two resumes');

    // A wait past its timeout throws TimeoutError inside the task.
    const t = await q.spawn('times-out', {}, { idempotencyKey: 'to:1' });
    const timedOut = await until('times-out completed', async () => {
      const r = await state(t.taskID);
      return r.state === 'completed' && r;
    });
    assert.strictEqual(timedOut.result, 'timed out');

    // An event emitted before anyone waits is kept: the first emit wins.
    assert.strictEqual(await q.emitEvent('already', { first: true }), true);
    assert.strictEqual(await q.emitEvent('already', { first: false }), false);
    const e = await q.spawn('early-event', {}, { idempotencyKey: 'early:1' });
    const early = await until('early-event completed', async () => {
      const r = await state(e.taskID);
      return r.state === 'completed' && r;
    });
    assert.deepStrictEqual(early.result, { first: true });

    // Failures retry with backoff, then the task is failed for good.
    const f = await q.spawn('flaky', {}, { idempotencyKey: 'flaky:1' });
    await until('flaky first failure', async () => (await state(f.taskID)).attempts === 1);
    const after1 = await state(f.taskID);
    assert.strictEqual(after1.state, 'pending');
    assert.ok(new Date(after1.run_at) > new Date(), 'the retry waits (backoff)');
    await db.query(`update durable_task set run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = $1`, [f.taskID]);
    const failed = await until('flaky failed', async () => {
      const r = await state(f.taskID);
      return r.state === 'failed' && r;
    });
    assert.deepStrictEqual([failed.attempts, calls.flaky], [2, 2]);
    assert.match(failed.error, /boom/);

    // Two workers: a task runs once, under one lease.
    await w.close();
    workers.length = 0;
    let runs = 0;
    const q2 = mk();
    const q3 = mk();
    for (const x of [q2, q3]) {
      x.registerTask({ name: 'once' }, async () => {
        runs++;
        await sleep(150);
        return 'done';
      });
    }
    const o = await q2.spawn('once', {}, { idempotencyKey: 'once:1' });
    workers.push(await q2.startWorker({ pollInterval: 0.02 }), await q3.startWorker({ pollInterval: 0.02 }));
    await until('once completed', async () => (await state(o.taskID)).state === 'completed');
    await sleep(100);
    assert.strictEqual(runs, 1, 'one worker ran it');

    // A worker that dies mid-task: its lease goes with its session, and another resumes it.
    for (const x of workers) await x.close();
    workers.length = 0;
    const q4 = mk();
    let attempts = 0;
    q4.registerTask({ name: 'resumes' }, async (p, ctx) => {
      attempts++;
      return ctx.step('only', async () => 'ok');
    });
    const r = await q4.spawn('resumes', {}, { idempotencyKey: 'resumes:1' });
    await repos.durable.markRunning(r.taskID); // as if a worker took it and died: no lease held
    workers.push(await q4.startWorker({ pollInterval: 0.02 }));
    await until('orphaned task resumed', async () => (await state(r.taskID)).state === 'completed');
    assert.strictEqual(attempts, 1);

    // pa doctor's counts.
    const stats = await repos.durable.stats('pa');
    assert.ok(stats.some((s) => s.task_name === 'flaky' && s.state === 'failed' && s.n === 1));
    console.log('durableSqlite: ok');
  } finally {
    for (const x of workers) await x.close().catch(() => {});
    await db.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
