'use strict';

// The turn log (src/chat/turnLog.ts) on a throwaway SQLite store: a voice turn
// answered by the fast lane, one handed to the PA chat (the SDK feed adds the
// answer and tools to the same row), a typed one, a failed and an abandoned
// chat turn, the sweep, the read view, eval cases and `pa turns`.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-turns-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_turns.sqlite');
process.env.PA_SQLITE_KEY = 'turns-test-key';
process.env.PA_DATA_DIR = dir;
process.env.PA_TURN_LOG = 'on';

const { config } = require('../src/config.ts');
const L = require('../src/chat/turnLog.ts');
const S = require('../src/chat/sdkFeed.ts');
const { available } = require('../src/db/sqlite.ts');

const tick = () => new Promise((r) => setTimeout(r, 20));

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP turn log: no SQLite driver');
  }
  const db = require('../src/db');
  const repo = require('../src/repo');
  try {
    await require('../src/db/migrate.ts').migrate();
    assert.strictEqual(L.enabled(), true);

    // A voice turn the fast lane answered itself.
    const ev = { type: 'decision', route: 'answer', router: 'decision', ms: 214, p: { answer_here: 0.97, hand_off: 0.02, action: 0.01 }, signals: { tool: 'calendar', effort: 0 }, reason: 'decision/decision-1: answer' };
    const ref = L.voiceDecided("what's next?", ev, { context: 'Now: Saturday', history: [{ type: 'user', text: 'hi' }, { type: 'assistant', text: 'hello' }, { type: 'user', text: 'x' }] });
    await L.voiceDone(ref, { say: 'Standup at nine.', model: 'local/llama3.2:3b', firstTokenMs: 400, ms: 900, handoff: null });
    let t = L.view(await repo.turns.byId(await ref));
    assert.deepStrictEqual([t.channel, t.route, t.status, t.fastSay, t.decisionMs, t.handedOff, t.context], ['voice', 'answer', 'done', 'Standup at nine.', 214, false, 'Now: Saturday']);
    assert.deepStrictEqual(t.p, ev.p);
    assert.deepStrictEqual(t.signals, ev.signals);
    assert.deepStrictEqual(t.history.map((h) => h.text), ['hello', 'x'], 'the last two turns');
    assert.ok(t.endedAt);

    // A voice turn handed to the PA chat: the SDK feed finishes the same row.
    const home = path.join(dir, 'pa-home');
    fs.mkdirSync(home, { recursive: true });
    const feed = S.createSdkFeed({
      loadSdk: async () => ({ query: () => (async function* () { await new Promise(() => {}); })() }),
      prepare: () => ({ home, mcpServers: {} }),
      policy: () => ({}),
      root: () => path.join(dir, 'projects'),
      stateDir: () => home,
      model: () => null,
      env: () => ({}),
      hub: () => ({ listSessions: async () => [], createSession: async () => ({ id: 'view-1' }), sessionUrl: async (id) => `http://hub/#session=${id}` }),
      viewCommand: (f) => `node view "${f}"`,
    });
    const href = L.voiceDecided('check my mail from Person A', { route: 'handoff', router: 'decision', ms: 200, p: { answer_here: 0.1, hand_off: 0.85, action: 0.05 } });
    await feed.send({ text: 'check my mail from Person A', source: 'voice', turn: href });
    await L.voiceDone(href, { say: 'One moment.', model: 'local/llama3.2:3b', ms: 300, handoff: { id: 'u-1' } });
    feed.onMessage({ type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'mcp__personal-assistant__mail_search', input: {} }], stop_reason: 'tool_use' } });
    feed.onMessage({ type: 'assistant', uuid: 'a2', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'Two mails from Person A.' }], stop_reason: 'end_turn' } });
    feed.onMessage({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 5, total_cost_usd: 0.02, parent_tool_use_id: null });
    await tick();
    t = L.view(await repo.turns.byId(await href));
    assert.deepStrictEqual([t.status, t.handedOff, t.fastSay, t.reply, t.chatTurns], ['done', true, 'One moment.', 'Two mails from Person A.', 2], 'the answer only, not the step before a tool');
    assert.deepStrictEqual(t.tools, ['mcp__personal-assistant__mail_search']);
    assert.ok(t.replyMs >= 0 && Math.abs(t.chatCostUsd - 0.02) < 1e-9);

    // A typed message opens its own row; a failed chat turn is an error.
    await feed.send({ text: 'close card 12', source: 'typed' });
    feed.onMessage({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 9, parent_tool_use_id: null });
    await tick();
    const [typed] = await L.list({ channel: 'typed', limit: 1 });
    assert.deepStrictEqual([typed.text, typed.status, typed.error, typed.route], ['close card 12', 'error', 'error_max_turns', null]);

    // A session that dies with a message unanswered.
    const tr = L.chatTracker();
    tr.sent({ text: 'are you there', channel: 'typed' });
    tr.text('half an');
    await tr.ended('the chat session ended before answering');
    const [gone] = await L.list({ q: 'are you there', limit: 1 });
    assert.deepStrictEqual([gone.status, gone.reply, gone.error], ['error', 'half an', 'the chat session ended before answering']);
    assert.strictEqual(tr.pending(), 0);

    // A failed hand-off ends the voice turn as an error.
    const fref = L.voiceDecided('book a room', { route: 'handoff', router: 'decision', ms: 1 });
    await L.voiceDone(fref, { say: 'On it.', ms: 50, handoff: { error: 'the PA is restarting', status: 503 } });
    t = L.view(await repo.turns.byId(await fref));
    assert.deepStrictEqual([t.status, t.handedOff, t.handoffError], ['error', false, 'the PA is restarting']);

    // The sweep: old rows go, stale open ones close.
    const old = await repo.turns.insert({ channel: 'typed', text: 'ancient', at: '2001-01-01T00:00:00.000Z' });
    const stale = await repo.turns.insert({ channel: 'typed', text: 'never answered', at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const swept = await L.sweep();
    assert.ok(swept.pruned >= 1 && swept.closed >= 1);
    assert.strictEqual(await repo.turns.byId(old.id), null);
    assert.strictEqual((await repo.turns.byId(stale.id)).status, 'error');

    // Eval cases: voice turns only, labelled from what happened.
    const all = await L.list({ limit: 50 });
    const cases = all.map(L.evalCase).filter(Boolean);
    assert.deepStrictEqual(cases.map((c) => [c.text, c.expect]).sort(), [['book a room', 'handoff'], ['check my mail from Person A', 'handoff'], ["what's next?", 'answer']]);
    assert.strictEqual(L.evalCase({ channel: 'voice', route: 'handoff', tools: ['mcp__pa-chat__card_edit'], text: 'x', id: 1 }).expect, 'action');
    assert.strictEqual(cases.find((c) => c.text === "what's next?").history.length, 2);

    // pa turns
    const lines = [];
    const cli = require('../src/cli/turns.ts').make((s) => lines.push(s), (s) => { throw new Error(s); });
    await cli.turns([], { limit: '10' });
    const text = lines.join('\n');
    assert.match(text, /you: {4}check my mail from Person A/);
    assert.match(text, /route: {2}handoff by decision in 200 ms p answer 0\.10 \/ hand 0\.85 \/ action 0\.05/);
    assert.match(text, /chat: {3}Two mails from Person A\./);
    lines.length = 0;
    await cli.turns(['show', String(await ref)], {});
    assert.match(lines.join('\n'), /snapshot:\n {4}Now: Saturday/);

    // Off: nothing is written, nothing waits.
    config.turnLog.enabled = false;
    assert.strictEqual(await L.open({ channel: 'typed', text: 'secret' }), null);
    config.turnLog.enabled = true;
  } finally {
    await db.close?.().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('turnLog ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
