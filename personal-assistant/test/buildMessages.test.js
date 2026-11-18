'use strict';

// Agent <-> Jarvis messages (src/build/messages.ts, `pa run`): note, an ask that
// blocks until Jarvis replies, reply, send into the session, needs-you, the
// chat's build_* tools, and the CLI's run-id rule. SQLite store, termhub stubbed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-build-msg-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_build_msg.sqlite');
process.env.PA_SQLITE_KEY = 'build-msg-test-key';
process.env.PA_WORKTREES_ROOT = dir;
delete process.env.JARVIS_RUN_ID;

const M = require('../src/build/messages.ts');
const termhub = require('../src/dispatch/termhub.ts');
const notify = require('../src/notify/notify.ts');
const { available } = require('../src/db/sqlite.ts');

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP build messages: no SQLite driver');
  }
  const db = require('../src/db');
  const repo = require('../src/repo');
  const typed = [];
  termhub.say = async (id, text, o) => { typed.push([id, text, o && o.submit]); };
  termhub.sessionUrl = async (id) => `http://hub/#session=${id}`;
  const notices = [];
  notify.notify = async (n) => { notices.push(n); return null; };
  try {
    await require('../src/db/migrate.ts').migrate();
    const r = await repo.buildRuns.insert({ task: 'port the parser', model: 'haiku', costCapUsd: 5, wallCapMin: 120 });
    await repo.buildRuns.update(r.id, { state: 'running', session_id: 'sess-1' });

    await M.note(r.id, '  half way  ');
    assert.deepStrictEqual((await repo.buildRuns.msgs(r.id)).map((m) => [m.dir, m.kind, m.body]), [['agent', 'note', 'half way']]);
    await assert.rejects(() => M.note(r.id, '   '), /empty/);
    await assert.rejects(() => M.note(9999, 'x'), /no run #9999/);

    // reply with nothing open
    await assert.rejects(() => M.reply(r.id, 'hm'), /no open question/);

    // The agent asks and waits; Jarvis answers from outside.
    let polls = 0;
    const waiting = M.ask(r.id, 'which database?', {
      pollMs: 1,
      sleep: async () => {
        polls++;
        if (polls === 2) {
          assert.strictEqual((await repo.buildRuns.byId(r.id)).state, 'waiting', 'waiting while it is asked');
          assert.deepStrictEqual((await M.needsYou()).map((n) => [n.run, n.question]), [[r.id, 'which database?']]);
          await M.reply(r.id, 'sqlite');
        }
      },
    });
    const got = await waiting;
    assert.deepStrictEqual([got.answered, got.answer], [true, 'sqlite']);
    assert.strictEqual((await repo.buildRuns.byId(r.id)).state, 'running', 'back to running once answered');
    assert.deepStrictEqual(await M.needsYou(), []);
    assert.strictEqual(notices.length, 1);
    assert.deepStrictEqual([notices[0].kind, notices[0].priority], ['info', 'normal'], 'an ask spends the interrupt budget like any push');
    assert.match(notices[0].title, new RegExp(`#${r.id} needs you`));
    assert.deepStrictEqual((await repo.buildRuns.msgs(r.id)).map((m) => `${m.dir}:${m.kind}`), ['agent:note', 'agent:ask', 'jarvis:reply']);

    // No answer in time: the agent is told so and runs on; the ask is closed, so it no longer needs you.
    const late = await M.ask(r.id, 'anyone?', { timeoutMs: 5, pollMs: 1, sleep: (ms) => new Promise((x) => setTimeout(x, ms)) });
    assert.deepStrictEqual([late.answered, late.answer], [false, null]);
    assert.strictEqual((await repo.buildRuns.byId(r.id)).state, 'running');
    assert.deepStrictEqual(await M.needsYou(), [], 'a timed-out ask leaves Needs you');
    assert.strictEqual((await repo.buildRuns.byId(r.id)).waiting_since, null);
    assert.ok(Number((await repo.buildRuns.byId(r.id)).waiting_ms) >= 0);

    // The timeout is configurable.
    process.env.PA_BUILD_ASK_TIMEOUT_MIN = '90';
    assert.strictEqual(M.askTimeoutMs(), 90 * 60_000);
    delete process.env.PA_BUILD_ASK_TIMEOUT_MIN;
    assert.strictEqual(M.askTimeoutMs(), 240 * 60_000);

    // A questionnaire: one ask, one reply, answers keyed by question id.
    const form = { questions: [{ id: 'db', text: 'Which database?', options: ['sqlite', 'postgres'], allowFree: false }, { text: 'Anything else to keep?' }] };
    let n = 0;
    const decided = await M.ask(r.id, form, {
      pollMs: 1,
      sleep: async () => {
        if (++n !== 2) return;
        const need = await M.needsYou();
        assert.deepStrictEqual([need[0].kind, need[0].questions.map((q) => q.id)], ['decisions', ['db', 'q2']]);
        assert.match(need[0].question, /db: Which database\? \[sqlite \| postgres\]/);
        await assert.rejects(() => M.reply(r.id, null, null, { db: 'mysql' }), /takes one of/);
        await assert.rejects(() => M.reply(r.id, null, null, { nope: 'x' }), /no question "nope"/);
        await assert.rejects(() => M.reply(r.id, null, null, {}), /answer at least one/);
        await M.reply(r.id, null, null, { db: 'POSTGRES', q2: 'the index' });
      },
    });
    assert.strictEqual(decided.answered, true);
    assert.deepStrictEqual(decided.answers, { db: 'postgres', q2: 'the index' });
    assert.match(decided.answer, /db: Which database\?\n {2}-> postgres/);
    assert.match(decided.answer, /JSON: \{"answers":\{"db":"postgres","q2":"the index"\}\}/);
    assert.strictEqual(notices[notices.length - 1].priority, 'normal');
    assert.match(notices[notices.length - 1].title, /needs 2 decisions/);

    // A free-text reply to a lone question maps onto it; to several it travels as it is; a skipped question says so.
    let m = 0;
    const lone = await M.ask(r.id, { questions: [{ id: 'x', text: 'Name?' }] }, { pollMs: 1, sleep: async () => { if (++m === 1) await M.reply(r.id, 'Ada'); } });
    assert.deepStrictEqual(lone.answers, { x: 'Ada' });
    let k = 0;
    const loose = await M.ask(r.id, { questions: [{ id: 'a', text: 'A?' }, { id: 'b', text: 'B?' }] }, { pollMs: 1, sleep: async () => { if (++k === 1) await M.reply(r.id, 'go with a, skip b'); } });
    assert.deepStrictEqual(loose.answers, {});
    assert.match(loose.answer, /Free-text reply: go with a, skip b/);
    assert.match(loose.answer, /a: A\?\n {2}-> \(no answer/);
    await assert.rejects(() => M.ask(r.id, { questions: [] }), /at least one question/);
    await assert.rejects(() => M.ask(r.id, { questions: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }), /share the id/);
    // An answer to a plain ask refuses the per-question form.
    const plain = await repo.buildRuns.addMsg({ runId: r.id, dir: 'agent', kind: 'ask', body: 'plain?' });
    await assert.rejects(() => M.reply(r.id, null, plain.id, { a: 'b' }), /plain question/);
    await M.reply(r.id, 'ok', plain.id);

    // Two open asks on one run (a subagent asks too): the run stays waiting, and keeps its wait on the
    // books, until the LAST one closes — answering the first must not send it back to running.
    {
      const nap = (ms) => new Promise((x) => setTimeout(x, ms));
      const opts = { pollMs: 5, sleep: nap };
      const first = M.ask(r.id, 'first?', opts);
      await nap(30);
      const second = M.ask(r.id, 'second?', opts);
      await nap(30);
      const open = (await repo.buildRuns.openAsks()).filter((a) => String(a.run_id) === String(r.id)).sort((a, b) => a.id - b.id);
      assert.deepStrictEqual(open.map((a) => a.body), ['first?', 'second?']);
      assert.strictEqual((await repo.buildRuns.byId(r.id)).state, 'waiting');
      await M.reply(r.id, 'one', open[0].id);
      assert.strictEqual((await first).answer, 'one');
      const mid = await repo.buildRuns.byId(r.id);
      assert.strictEqual(mid.state, 'waiting', 'one ask is still open: still waiting');
      assert.ok(mid.waiting_since, 'its clock keeps running');
      assert.deepStrictEqual((await M.needsYou()).map((n) => n.question), ['second?']);
      await M.reply(r.id, 'two', open[1].id);
      assert.strictEqual((await second).answer, 'two');
      const end = await repo.buildRuns.byId(r.id);
      assert.deepStrictEqual([end.state, end.waiting_since], ['running', null], 'the last answer sends it back to work');
    }

    // Waiting is not the agent's time: the wall-clock cap leaves it out.
    const T = require('../src/build/track.ts');
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const base = { started_at: '2026-01-01T00:00:00Z', wall_cap_min: 60, cost_cap_usd: 0 };
    const at = (min) => t0 + min * 60_000;
    assert.match(T.overCap(base, null, at(61)), /time cap reached/);
    assert.strictEqual(T.overCap({ ...base, waiting_ms: 40 * 60_000 }, null, at(61)), null, 'finished waits come off');
    assert.strictEqual(T.overCap({ ...base, state: 'waiting', waiting_since: new Date(at(10)).toISOString() }, null, at(600)), null, 'an ask in progress comes off');
    assert.match(T.overCap({ ...base, state: 'running', waiting_since: new Date(at(10)).toISOString() }, null, at(61)), /time cap/, 'a stale marker on a running run is ignored');
    assert.match(T.overCap({ ...base, waiting_ms: 40 * 60_000 }, null, at(101)), /time cap reached: 61 of 60/);

    // Stopped while waiting: the ask ends unanswered.
    const stopped = await M.ask(r.id, 'still there?', { pollMs: 1, sleep: async () => { await repo.buildRuns.update(r.id, { state: 'stopped' }); } });
    assert.strictEqual(stopped.answered, false);
    assert.strictEqual((await repo.buildRuns.byId(r.id)).state, 'stopped', 'a stopped run stays stopped');
    await assert.rejects(() => M.send(r.id, 'hello'), /is stopped/);

    // send types into the session and records it; reply by explicit ask id.
    const r2 = await repo.buildRuns.insert({ task: 'second', model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
    await assert.rejects(() => M.send(r2.id, 'too early'), /no session yet/);
    await repo.buildRuns.update(r2.id, { state: 'running', session_id: 'sess-2' });
    await M.send(r2.id, 'use the v2 api');
    assert.deepStrictEqual(typed, [['sess-2', 'use the v2 api', true]]);
    const q1 = await repo.buildRuns.addMsg({ runId: r2.id, dir: 'agent', kind: 'ask', body: 'one?' });
    const q2 = await repo.buildRuns.addMsg({ runId: r2.id, dir: 'agent', kind: 'ask', body: 'two?' });
    await M.reply(r2.id, 'for two', q2.id);
    assert.strictEqual((await repo.buildRuns.msgById(q2.id)).answer, 'for two');
    assert.strictEqual((await repo.buildRuns.msgById(q1.id)).answer, null);
    await assert.rejects(() => M.reply(r2.id, 'again', q2.id), /is not open/);
    assert.deepStrictEqual((await M.needsYou()).map((n) => n.question), ['one?']);

    // The chat's tools.
    const chat = require('../src/mcp/chatTools.ts');
    const runs = await chat.handle('build_runs', {});
    assert.deepStrictEqual(runs.runs.map((x) => x.id), [r2.id]);
    assert.strictEqual(runs.needs_you[0].question, 'one?');
    const one = await chat.handle('build_run', { run: r2.id });
    assert.deepStrictEqual([one.id, one.url, one.messages.map((m) => m.kind)], [r2.id, 'http://hub/#session=sess-2', ['send', 'ask', 'ask', 'reply']]);
    assert.deepStrictEqual(await chat.handle('build_reply', { run: r2.id, text: 'for one' }), { run: r2.id, answered: q1.id });
    assert.deepStrictEqual(await chat.handle('build_send', { run: r2.id, text: 'go' }), { run: r2.id, sent: true });
    termhub.killSession = async () => true;
    assert.deepStrictEqual(await chat.handle('build_stop', { run: r2.id }), { run: r2.id, state: 'stopped' });
    for (const t of ['build_runs', 'build_run']) assert.ok(chat.CHAT_READ_TOOL_NAMES.includes(t));
    for (const t of ['build_reply', 'build_send', 'build_stop']) assert.ok(chat.CHAT_ACTION_TOOL_NAMES.includes(t));

    // The CLI: an agent's run id is $JARVIS_RUN_ID (a number in its text is text);
    // Jarvis's verbs take the id first.
    const { commands } = require('../src/cli/index.ts');
    const r3 = await repo.buildRuns.insert({ task: 'cli', model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
    await repo.buildRuns.update(r3.id, { state: 'running', session_id: 'sess-3' });
    const lines = [];
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = (t) => { lines.push(String(t)); return true; };
    try {
      process.env.JARVIS_RUN_ID = String(r3.id);
      await commands.run(['note', 'step', '2', 'of', '5'], {}, {});
      await commands.run(['done'], { result: 'https://example.test/pr/9' }, {});
      delete process.env.JARVIS_RUN_ID;
      await commands.run(['list'], { all: true }, {});
      await commands.run(['status', String(r3.id)], {}, {});
    } finally {
      process.stdout.write = w;
    }
    assert.strictEqual((await repo.buildRuns.msgs(r3.id))[0].body, 'step 2 of 5');
    const row = await repo.buildRuns.byId(r3.id);
    assert.deepStrictEqual([row.state, row.result], ['done', 'https://example.test/pr/9']);
    assert.ok(lines.join('').includes(`#${r3.id}  done`));

    // `pa run ask --q … --option …` builds the questionnaire in argv order; `pa run reply --answer id=text` answers it.
    const { parseArgs } = require('../src/cli/parseArgs.ts');
    const r4 = await repo.buildRuns.insert({ task: 'ask cli', model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
    await repo.buildRuns.update(r4.id, { state: 'running', session_id: 'sess-4' });
    const printed = [];
    process.stdout.write = (t) => { printed.push(String(t)); return true; };
    try {
      process.env.JARVIS_RUN_ID = String(r4.id);
      const p = parseArgs(['run', 'ask', '--q', 'Which database?', '--option', 'sqlite', '--option', 'postgres', '--q', 'Keep the old endpoint?']);
      const asking = commands.run(p.args, p.flags, p.lists, p.ordered);
      let open = [];
      for (let i = 0; i < 100 && !open.length; i++) { open = (await repo.buildRuns.openAsks()).filter((a) => a.run_id === r4.id); if (!open.length) await new Promise((x) => setTimeout(x, 20)); }
      assert.strictEqual(open.length, 1, 'the ask is open');
      assert.deepStrictEqual(JSON.parse(open[0].body).questions.map((q) => [q.id, q.options]), [['q1', ['sqlite', 'postgres']], ['q2', []]]);
      const a = parseArgs(['run', 'reply', String(r4.id), '--answer', 'q1=sqlite', '--answer', 'q2=yes, keep it']);
      delete process.env.JARVIS_RUN_ID;
      await commands.run(a.args, a.flags, a.lists, a.ordered);
      await asking;
    } finally {
      process.stdout.write = w;
      delete process.env.JARVIS_RUN_ID;
    }
    assert.match(printed.join(''), /q1: Which database\?\n {2}-> sqlite\nq2: Keep the old endpoint\?\n {2}-> yes, keep it\nJSON: /);
  } finally {
    await db.close?.().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('build messages ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
