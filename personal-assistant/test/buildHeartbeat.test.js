'use strict';

// Build heartbeat (src/build/heartbeat.ts): a run silent past ITS idle_after_s goes
// idle with what Jarvis needs, an open ask never is, life (or a longer limit) brings
// it back, a dead session fails it at once; build_start / build_set_idle; the kept
// logs and `run export`. SQLite store, termhub stubbed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-build-hb-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_build_hb.sqlite');
process.env.PA_SQLITE_KEY = 'build-hb-test-key';
process.env.PA_WORKTREES_ROOT = dir;
process.env.PA_DATA_DIR = path.join(dir, 'data');

const H = require('../src/build/heartbeat.ts');
const T = require('../src/build/track.ts');
const B = require('../src/build/index.ts');
const termhub = require('../src/dispatch/termhub.ts');
const notify = require('../src/notify/notify.ts');
const { available } = require('../src/db/sqlite.ts');

assert.deepStrictEqual(H.idleness(1000, 241_000, 240), { idle_s: 240, over: true });
assert.deepStrictEqual(H.idleness(1000, 100_000, 240), { idle_s: 99, over: false });
assert.strictEqual(H.lastTool({ track: JSON.stringify({ agents: [{ calls: [{ name: 'Bash', args: 'ls', at: '2026-01-01T00:00:01Z', ok: true }, { name: 'Edit', args: 'a.md', at: '2026-01-01T00:00:02Z', ok: false }] }] }) }), 'Edit a.md (failed)');
assert.strictEqual(H.lastTool({ track: null }), null);

// The Plan card's Build line: newest run's chip data, and the aggregate for a big task.
{
  const { buildSummary } = require('../src/dashboard/cards.ts');
  const at = (m) => new Date(Date.UTC(2026, 10, 10, 10, m)).toISOString();
  const r1 = { id: 4, state: 'failed', model: 'haiku', started_at: at(0), ended_at: at(30), cost_usd: 0.5, session_id: 's' };
  const r2 = { id: 7, state: 'done', model: 'sonnet', started_at: at(40), ended_at: at(100), cost_usd: 1.25, result: 'PR', session_id: 's' };
  assert.strictEqual(buildSummary([]), null);
  const one = buildSummary([r1], Date.now(), null);
  assert.deepStrictEqual([one.run, one.state, one.elapsed_s, one.runs, one.span_s, one.board], [4, 'failed', 1800, 1, 1800, 'factory#run-4']);
  const two = buildSummary([r1, r2], Date.now(), 'http://hub/#session=s');
  assert.deepStrictEqual([two.run, two.state, two.elapsed_s, two.runs, two.span_s, two.total_cost_usd, two.session_url], [7, 'done', 3600, 2, 6000, 1.75, 'http://hub/#session=s']);
  const liveRun = buildSummary([{ ...r2, state: 'running', ended_at: null }], Date.parse(at(70)), null);
  assert.deepStrictEqual([liveRun.state, liveRun.elapsed_s, liveRun.span_s], ['running', 1800, 1800]);
}

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP build heartbeat: no SQLite driver');
  }
  const db = require('../src/db');
  const repo = require('../src/repo');
  const notices = [];
  notify.notify = async (n) => { notices.push(n); return null; };
  let sessions = [{ id: 's1', busy: false }, { id: 's2', busy: false }, { id: 's3', busy: false }];
  termhub.listSessions = async () => sessions;
  termhub.screen = async () => 'working...\n\n> still thinking about it\n';
  termhub.sessionUrl = async () => null;
  termhub.killSession = async () => true;
  try {
    await require('../src/db/migrate.ts').migrate();
    const mk = async (task, session, idle) => {
      const r = await repo.buildRuns.insert({ task, model: 'haiku', costCapUsd: 5, wallCapMin: 120, idleAfterS: idle });
      await repo.buildRuns.update(r.id, { state: 'running', session_id: session });
      return r;
    };
    const quick = await mk('quick', 's1', 120);
    const long = await mk('long', 's2', 900);
    const asker = await mk('asking', 's3', 120);
    await repo.buildRuns.update(asker.id, { state: 'waiting' });
    assert.strictEqual(Number((await repo.buildRuns.byId(long.id)).idle_after_s), 900);

    // All three started 5 minutes ago and have been quiet since.
    const old = new Date(Date.now() - 300_000).toISOString();
    for (const r of [quick, long, asker]) await db.query('update build_run set started_at = $2 where id = $1', [r.id, old]);
    const t1 = await H.tick();
    assert.deepStrictEqual([t1.idle, t1.failed], [1, 0]);
    assert.strictEqual((await repo.buildRuns.byId(quick.id)).state, 'idle', 'past its own 120 s');
    assert.strictEqual((await repo.buildRuns.byId(long.id)).state, 'running', 'inside its own 900 s');
    assert.strictEqual((await repo.buildRuns.byId(asker.id)).state, 'waiting', 'an open ask is not idle');
    const act = JSON.parse((await repo.buildRuns.byId(quick.id)).activity);
    assert.deepStrictEqual([act.state, act.last_line, act.idle_s >= 299], ['idle', '> still thinking about it', true]);
    assert.strictEqual(notices.length, 1);
    assert.strictEqual(notices[0].priority, 'urgent');
    assert.match(notices[0].body, /Last output: > still thinking about it/);
    const need = await require('../src/build/messages.ts').needsYou();
    assert.deepStrictEqual(need.map((n) => [n.run, n.kind]), [[quick.id, 'idle']]);
    assert.match(need[0].question, /Idle 5 min.*Last output/);
    assert.ok(B.LIVE.includes('idle'));
    await H.tick();
    assert.strictEqual(notices.length, 1, 'one notice per silence');

    // Jarvis lengthens the limit: 300 s of silence is fine under 600 s.
    await B.setIdle(quick.id, 600);
    await assert.rejects(() => B.setIdle(quick.id, 5), /30 to 21600/);
    await H.tick();
    assert.strictEqual((await repo.buildRuns.byId(quick.id)).state, 'running');
    // Tighten it: idle again; then the PTY writing is a sign of life.
    await B.setIdle(quick.id, 120);
    await H.tick();
    assert.strictEqual((await repo.buildRuns.byId(quick.id)).state, 'idle');
    sessions = [{ id: 's1', busy: true }, { id: 's2', busy: false }, { id: 's3', busy: false }];
    await H.tick();
    assert.strictEqual((await repo.buildRuns.byId(quick.id)).state, 'running', 'life returns');

    // A dead session without `pa run done` fails at once, with a notice.
    sessions = [{ id: 's1', busy: true }, { id: 's3', busy: false }];
    const before = notices.length;
    assert.strictEqual((await H.tick()).failed, 1);
    const dead = await repo.buildRuns.byId(long.id);
    assert.deepStrictEqual([dead.state, /without/.test(dead.error)], ['failed', true]);
    assert.ok(notices.length > before);

    // The chat's tools.
    const chat = require('../src/mcp/chatTools.ts');
    assert.ok(chat.CHAT_ACTION_TOOL_NAMES.includes('build_start') && chat.CHAT_ACTION_TOOL_NAMES.includes('build_set_idle'));
    assert.deepStrictEqual(await chat.handle('build_set_idle', { run: quick.id, seconds: 150 }), { run: quick.id, idle_after_s: 150 });
    await assert.rejects(() => chat.handle('build_start', { model: 'gpt-9', task: 'x' }), /model must be/);
    await assert.rejects(() => chat.handle('build_start', {}), /nothing to do|card/);
    const runs = await chat.handle('build_runs', { all: true });
    assert.strictEqual(runs.runs.find((r) => r.id === quick.id).idle_after_s, 150);

    // An ended run is kept: summary.json + messages.json; `export` lists it.
    await repo.buildRuns.addMsg({ runId: long.id, dir: 'agent', kind: 'note', body: 'hi' });
    await T.tick();
    const kept = path.join(dir, 'data', 'build-runs', `run-${long.id}`);
    const sum = JSON.parse(fs.readFileSync(path.join(kept, 'summary.json'), 'utf8'));
    assert.deepStrictEqual([sum.run, sum.state, sum.model, sum.messages, sum.tool_calls_total], [long.id, 'failed', 'haiku', 1, 0]);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(kept, 'messages.json'), 'utf8'))[0].body, 'hi');
    assert.deepStrictEqual(T.exportSummaries().map((s) => s.run), [long.id]);
    assert.deepStrictEqual(T.exportSummaries('2999-01-01'), []);

    // A run that ends takes its "needs you" and "gone quiet" notices with it (they kept
    // the chat re-announcing finished runs, 2026-11-10); another run's stay unread.
    const ended = await mk('ends', 's9', 120);
    const ask = await repo.buildRuns.addMsg({ runId: ended.id, dir: 'agent', kind: 'ask', body: 'which branch?' });
    const ins = (key) => repo.notifications.insert({ kind: 'info', title: key, body: '', dedupeKey: key, priority: 'urgent', delivery: 'toast' });
    await ins(`build-ask:${ask.id}`);
    await ins(`build-idle:${ended.id}:2026-11-10T19:00:00Z`);
    await ins(`build-idle:${ended.id}0:2026-11-10T19:00:00Z`); // run #<id>0, a different run
    await B.finish(ended.id, 'done', { result: 'ok' });
    const unread = async (key) => (await db.one('select read_at from notification where dedupe_key = $1', [key])).read_at == null;
    assert.strictEqual(await unread(`build-ask:${ask.id}`), false, 'the ask notice is read');
    assert.strictEqual(await unread(`build-idle:${ended.id}:2026-11-10T19:00:00Z`), false, 'the idle notice is read');
    assert.strictEqual(await unread(`build-idle:${ended.id}0:2026-11-10T19:00:00Z`), true, 'another run keeps its notice');
  } finally {
    await db.close?.().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('build heartbeat ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
