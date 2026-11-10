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
    assert.deepStrictEqual([notices[0].kind, notices[0].priority], ['info', 'urgent']);
    assert.match(notices[0].title, new RegExp(`#${r.id} needs you`));
    assert.deepStrictEqual((await repo.buildRuns.msgs(r.id)).map((m) => `${m.dir}:${m.kind}`), ['agent:note', 'agent:ask', 'jarvis:reply']);

    // No answer in time: the agent is told so and runs on.
    const late = await M.ask(r.id, 'anyone?', { timeoutMs: 5, pollMs: 1, sleep: (ms) => new Promise((x) => setTimeout(x, ms)) });
    assert.deepStrictEqual([late.answered, late.answer], [false, null]);
    assert.strictEqual((await repo.buildRuns.byId(r.id)).state, 'running');

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
