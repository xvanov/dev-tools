'use strict';

// A factory's pushed job end settles its run at once (8.4.44): POST
// /api/factory/events with done (or failed, cancelled) closes the run, clears
// its card's context and raises "Factory run #N: …" through the poll's own
// apply, within a second of the push and once; the next poll changes nothing,
// nor does a poll that read the run before the push; a non-terminal push only
// patches the board. On a throwaway SQLite store (PA_DB=sqlite) with the
// ledger, the notifier and the factory CLI stubbed; skips without the driver.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-push-settle-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_push_settle.sqlite');
process.env.PA_SQLITE_KEY = 'push-settle-test-key';
process.env.PA_FACTORY_PATH = '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';
process.env.PA_WORKTREES_ROOT = dir;

const { available } = require('../src/db/sqlite.ts');

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', 'src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP factoryPushSettle: no SQLite driver');
  }
  const transitions = [];
  stub('ledger', { async transition(t) { transitions.push(t); return { changed: true }; } });
  const notes = [];
  stub('notify', { async notify(n) { notes.push({ ...n, at: Date.now() }); return { id: notes.length }; } });

  const db = require('../src/db');
  const repo = require('../src/repo');
  const factory = require('../src/dispatch/factory.ts');
  const calls = [];
  let answers = {};
  factory._setRunner(async (machine, argv) => {
    calls.push(argv.slice(3).join(' '));
    const a = answers[argv.slice(3, 5).join(' ')];
    if (!a) throw new Error(`unexpected factory call ${argv.join(' ')}`);
    return { code: 0, stdout: JSON.stringify(a), stderr: '' };
  });
  try {
    assert.strictEqual(db.dialect, 'sqlite');
    await require('../src/db/migrate.ts').migrate();
    const seed = require('./contract/_seed').postgres(require('./contract/_pgish').pgish(db.sqliteBackend()));
    const card = await seed.commitment({ status: 'dispatched' });
    await db.query(`update commitment set context = 'run #1 is still running' where id = $1`, [card]);
    const mkRun = async (jobId, key) => {
      const r = await db.one(
        `insert into run (commitment_id, mode, task, status, route, factory_job_id, factory_state, external_id, delivery)
         values ($1, 'mr', 'Add retries', 'running', 'factory', $2, 'in_progress', $3, 'draft_pr') returning id`,
        [card, jobId, key]
      );
      return Number(r.id);
    };
    const runId = await mkRun('widget:042', 'install-1');
    const pr = 'https://github.com/acme/widget/pull/12';
    const listed = (o) => ({ job_id: 'widget:042', source: 'pa', external_id: 'install-1', state: 'in_progress', terminal: false, why: 'story 7 is ci_watch',
      delivery: 'draft_pr', merged: false, pr_urls: [pr], cost_usd: 2.1, title: 'Add retries', ...o });
    // The board as the last `job list` left it.
    await repo.factoryBoard.store([listed()]);
    const runRow = () => db.one('select status, outcome, factory_state, mr_url, ended_at, exit_note from run where id = $1', [runId]);
    const outbox = async () => (await db.rows(`select payload from event_outbox where topic = 'run' order by seq`)).map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));

    // A non-terminal push: the board moves, the run and the card do not.
    const runEventsBefore = (await outbox()).length;
    const step = await factory.pushed({ jobs: [{ job_id: 'widget:042', state: 'in_progress', why: 'story 7 is delivering', updated_at: '2026-11-08T23:00:00Z' }] });
    assert.deepStrictEqual(step, { ok: true, received: 1, patched: 0 }, 'same state: the board row is not rewritten');
    await factory._settled();
    const still = await runRow();
    assert.deepStrictEqual([still.status, still.factory_state, still.ended_at], ['running', 'in_progress', null]);
    assert.deepStrictEqual([notes.length, transitions.length, (await outbox()).length], [0, 0, runEventsBefore], 'no settle for a job still going');

    // A poll that read the run before the push (its `job list` still running).
    const staleRun = (await repo.runs.watchedFactoryRuns()).find((r) => Number(r.id) === runId);
    assert.strictEqual(staleRun.status, 'running');

    // The job's end, pushed: settled within a second, on its own.
    const t0 = Date.now();
    const answer = await factory.pushed({ jobs: [{ job_id: 'widget:042', state: 'done', why: '', updated_at: '2026-11-08T23:00:05Z' }] });
    const answeredMs = Date.now() - t0;
    assert.deepStrictEqual(answer, { ok: true, received: 1, patched: 1 });
    let settledMs = null;
    while (Date.now() - t0 < 2000) {
      const r = await runRow();
      if (r.ended_at && notes.length) { settledMs = Date.now() - t0; break; }
      await sleep(5);
    }
    assert.ok(settledMs !== null, 'the run settled within 2 s of the push');
    assert.ok(settledMs < 1000, `push to settled took ${settledMs} ms`);
    const ended = await runRow();
    assert.deepStrictEqual([ended.status, ended.outcome, ended.factory_state, ended.mr_url], ['landed', 'delivered', 'done', pr]);
    assert.deepStrictEqual(notes.map((n) => [n.title, n.dedupeKey, n.url]), [[`Factory run #${runId}: done`, `factory-end:${runId}`, pr]]);
    assert.deepStrictEqual(transitions.map((t) => [t.commitmentId, t.to, t.actor, t.from]), [[card, 'done', 'factory', ['dispatched']]]);
    assert.strictEqual((await db.one('select context from commitment where id = $1', [card])).context, null, "the card's context is cleared");
    const ev = (await outbox()).slice(runEventsBefore);
    assert.ok(ev.some((e) => Number(e.id) === runId && e.status === 'landed' && e.factory_state === 'done'), `the run event is on the feed: ${JSON.stringify(ev)}`);
    assert.strictEqual(calls.length, 0, 'no factory call: the push and the stored list are enough');

    // The poll that read the run while it ran loses: no second end, no reopening.
    const late = await factory.apply(staleRun, listed({ state: 'done', terminal: true, why: null }));
    assert.deepStrictEqual(late, { changed: false, ended: false });
    const corrected = await factory.apply(staleRun, listed({ state: 'in_progress', why: 'PR #12 is open; waiting for its CI' }));
    assert.deepStrictEqual(corrected, { changed: false, ended: false });
    assert.strictEqual((await runRow()).status, 'landed');

    // The next poll reads the same job from the factory: nothing changes, nothing is said twice.
    const before = await runRow();
    answers = {
      'job list': { jobs: [] },
      'job status': listed({ state: 'done', terminal: true, why: null }),
    };
    const polled = await factory.poll();
    assert.deepStrictEqual(polled, { checked: 1, changed: 0, ended: 0 });
    assert.deepStrictEqual(calls, ['job list --json --source pa --active', 'job status widget:042 --json']);
    assert.deepStrictEqual(await runRow(), before);
    assert.deepStrictEqual([notes.length, transitions.length], [1, 1]);

    // The same end pushed again (GitHub's confirmation): settled already, nothing more.
    await factory.pushed({ jobs: [{ job_id: 'widget:042', state: 'done', why: 'confirmed', updated_at: '2026-11-08T23:00:08Z' }] });
    assert.strictEqual(await factory._settled(), 0);
    assert.deepStrictEqual([notes.length, transitions.length], [1, 1]);

    // An end pushed for a job no run of ours holds, or that the list does not hold yet: left to the poll.
    await repo.factoryBoard.store([listed(), { job_id: 'other:001', source: 'someone', state: 'in_progress', terminal: false }]);
    await factory.pushed({ jobs: [{ job_id: 'other:001', state: 'failed', why: 'x' }, { job_id: 'widget:099', state: 'done', why: '' }] });
    assert.strictEqual(await factory._settled(), 0);

    // A failed end with its why: the run fails and says why.
    const failRun = await mkRun('widget:043', 'install-2');
    await repo.factoryBoard.store([listed({ job_id: 'widget:043', external_id: 'install-2', pr_urls: [] })]);
    await factory.pushed({ job_id: 'widget:043', state: 'failed', why: 'story 8 ended dev_failed: tests red' });
    assert.strictEqual(await factory._settled(), 1);
    const failed = await db.one('select status, outcome, exit_note from run where id = $1', [failRun]);
    assert.deepStrictEqual([failed.status, failed.outcome, failed.exit_note], ['failed', 'failed', 'story 8 ended dev_failed: tests red']);
    assert.strictEqual(notes.at(-1).title, `Factory run #${failRun}: failed`);
    assert.match(notes.at(-1).body, /Why: story 8 ended dev_failed: tests red/);
    assert.deepStrictEqual([transitions.at(-1).to, transitions.length], ['open', 2]);

    console.log(`factoryPushSettle.test.js ok (push answered in ${answeredMs} ms, run settled and notified ${settledMs} ms after the push)`);
  } finally {
    factory._setRunner(null);
    await db.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
