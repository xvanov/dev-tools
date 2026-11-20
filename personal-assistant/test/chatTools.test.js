'use strict';

// The PA chat's structured tools (src/mcp/chatTools.ts): the compact views a
// model reads, the session_start → dispatch mapping (one Build agent), the
// permission split (reads allowed, actions ask), and what Talk shows while a
// prompt waits. The store and dispatch are stubbed; names are invented.

// These reach src/db only incidentally (board refresh, brief gather): never the real one.
require('./_fakeDb').install();
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PA_WORKTREES_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-chattools-test-'));

const T = require('../src/mcp/chatTools.ts');

const NOW = new Date(2026, 10, 7, 10, 0, 0).getTime();

async function main() {
  // --- due labels and card ids ---------------------------------------------------
  assert.strictEqual(T.dueLabel(null, NOW), null);
  assert.strictEqual(T.dueLabel(new Date(2026, 10, 7, 18), NOW), 'today');
  assert.strictEqual(T.dueLabel(new Date(2026, 10, 8, 9), NOW), 'tomorrow');
  assert.strictEqual(T.dueLabel(new Date(2026, 10, 5, 9), NOW), 'overdue (2026-11-05)');
  assert.strictEqual(T.dueLabel(new Date(2026, 10, 20, 9), NOW), '2026-11-20');
  assert.deepStrictEqual(T.parseCardId('412'), { commitment: 412 });
  assert.deepStrictEqual(T.parseCardId('#412'), { commitment: 412 });
  assert.deepStrictEqual(T.parseCardId('p37'), { proposal: 37 });
  assert.throws(() => T.parseCardId('412; drop table'), /not a card id/);

  // --- the board, grouped and compact ----------------------------------------------
  {
    const board = {
      counts: { waiting: 4 },
      onMe: [
        { id: 1, group: 'todo', summary: 'Ship the export retry fix', who: 'Dana Example', due_at: new Date(2026, 10, 7, 17), repo_path: '/src/widget', direction: 'owed_by_me', status: 'open', blockers: [], unblocked: [],
          asks: [{ id: 9, kind: 'dispatch', title: 'Start: export retry', payload: {} }] },
        { id: 2, group: 'blocked', summary: 'Release notes', blockers: [{ id: 5, who: 'Lee Sample', summary: 'Send the changelog' }], unblocked: [], asks: [] },
        { id: 3, group: 'todo', summary: 'Wire the new endpoint', blockers: [], unblocked: [{ blocker_id: '6', who: 'Lee Sample', summary: 'API spec' }], asks: [] },
        { id: 4, group: 'settled', summary: 'Reply to the vendor', blockers: [], unblocked: [], asks: [], settled: { id: 11, confidence: 0.8 } },
        { id: 'p50', standalone: true, group: 'todo', summary: 'Land run #3', blockers: [], unblocked: [], asks: [{ id: 50, kind: 'land', title: 'Land run #3' }] },
      ],
    };
    const extras = new Map([['1', { slug: 'acme/widget', run: { id: 7, status: 'running', route: 'build' } }]]);
    const v = T.boardView(board, { extras, now: NOW });
    assert.deepStrictEqual(v.counts, { todo: 2, blocked: 1, unblocked: 1, looks_done: 1, waiting_on_others: 4 });
    assert.deepStrictEqual(v.todo[0], {
      id: '1', summary: 'Ship the export retry fix', who: 'Dana Example', due: 'today', repo: 'acme/widget',
      run: { id: 7, status: 'running', route: 'build' }, offer: { proposal: 9, title: 'Start: export retry' },
    });
    assert.deepStrictEqual(v.blocked[0].blockers, [{ id: '5', who: 'Lee Sample', summary: 'Send the changelog' }]);
    assert.strictEqual(v.unblocked[0].id, '3');
    assert.deepStrictEqual(v.unblocked[0].unblocked, [{ id: '6', who: 'Lee Sample', summary: 'API spec' }]);
    assert.deepStrictEqual(v.looks_done[0].looks_done, { proposal: 11, confidence: 0.8 });
    assert.deepStrictEqual(v.todo[1].asks, [{ proposal: 50, kind: 'land', title: 'Land run #3' }]);
    assert.strictEqual(v.todo[1].standalone, true);
    // No repo slug: the checkout's folder name.
    assert.strictEqual(T.compactCard({ id: 8, summary: 'x', repo_path: 'C:\\src\\gadget' }, {}, NOW).repo, 'gadget');
    const many = { onMe: Array.from({ length: 30 }, (_, i) => ({ id: i, group: 'todo', summary: `t${i}` })) };
    const lim = T.boardView(many, { limit: 5, now: NOW });
    assert.strictEqual(lim.todo.length, 5);
    assert.strictEqual(lim.todo_more, 25);
    assert.ok(JSON.stringify(v).length < 2000, 'compact');
  }

  // --- actions: session_start hands one Build agent its task ----------------------------
  {
    const stub = (rel, exports) => {
      const file = require.resolve(rel);
      require.cache[file] = { id: file, filename: file, loaded: true, exports };
    };
    const started = [];
    stub('../src/dispatch', {
      start: async (o) => {
        started.push(o);
        return { route: 'build', id: 21, model: o.model || 'sonnet', branch: 'jarvis/21-x', url: 'http://hub/#session=s9', repoPath: o.repoPath };
      },
    });

    const r = await T.handle('session_start', { card: '412', repo: 'acme/widget', prompt: 'Look into the flaky export test', model: 'haiku' });
    assert.deepStrictEqual(r, { started: true, run: 21, route: 'build', model: 'haiku', branch: 'jarvis/21-x', session: 'http://hub/#session=s9', repo: 'acme/widget', profile: null });
    assert.deepStrictEqual(started[0], { commitmentId: 412, task: 'Look into the flaky export test', repoPath: 'acme/widget', model: 'haiku', profile: null, routeReason: 'the chat started a session' });
    await assert.rejects(() => T.handle('session_start', { card: 'p5', prompt: 'x' }), /an offer, not a card/);
    await assert.rejects(() => T.handle('session_start', { prompt: '  ' }), /needs a prompt/);
    for (const gone of ['factory_start', 'factory_continue', 'factory_resume', 'factory_cancel', 'factory_approve', 'factory_jobs', 'factory_job']) {
      assert.ok(![...T.CHAT_READ_TOOL_NAMES, ...T.CHAT_ACTION_TOOL_NAMES].includes(gone), `${gone} is gone with the factory (D32)`);
      assert.strictEqual(await T.handle(gone, {}), undefined);
    }
    delete require.cache[require.resolve('../src/dispatch')];
  }

  // --- the permission split -------------------------------------------------------------
  {
    const server = require('../src/mcp/server.ts');
    const names = (env) => server.listedTools(env).map((t) => t.name);
    for (const t of [...T.CHAT_READ_TOOL_NAMES, ...T.CHAT_ACTION_TOOL_NAMES]) {
      assert.ok(!names({}).includes(t), `${t}: chat-only — no other session lists it`);
      assert.ok(names({ PA_MCP_CHAT_TOOLS: '1' }).includes(t), `${t}: listed for the chat`);
    }
    assert.deepStrictEqual(T.ALL.map((t) => t.name).sort(), [...T.CHAT_READ_TOOL_NAMES, ...T.CHAT_ACTION_TOOL_NAMES].sort());
    for (const t of T.ALL) assert.strictEqual(t.inputSchema.additionalProperties, false, `${t.name}: closed schema`);

    const chat = require('../src/chat');
    const s = chat.settingsJson();
    for (const t of T.CHAT_READ_TOOL_NAMES) assert.ok(s.permissions.allow.includes(`mcp__pa-chat__${t}`), `${t} is allowed`);
    for (const t of T.CHAT_AUTO_TOOL_NAMES) assert.ok(s.permissions.allow.includes(`mcp__pa-chat__${t}`), `${t} runs unasked (D33)`);
    for (const t of T.CHAT_ASK_TOOL_NAMES) assert.ok(!s.permissions.allow.some((r) => r.endsWith(`__${t}`)), `${t} asks`);
    assert.deepStrictEqual([...T.CHAT_ASK_TOOL_NAMES].sort(), ['profile_delete', 'profile_reset']);
    assert.ok(s.permissions.allow.includes('ToolSearch'), 'loading tool schemas runs unasked');
    // The terminal engine's policy gate for built-in reads and shell commands (src/chat/toolHook.js).
    const pre = s.hooks.PreToolUse[0];
    assert.strictEqual(pre.matcher, 'Bash|Read|Grep|Glob');
    assert.match(pre.hooks[0].command, /^node .*src\/chat\/toolHook\.js$/);
    // Microsoft 365 reads run unasked, one by one; no wildcard that would let a send through.
    assert.ok(s.permissions.allow.includes('mcp__claude_ai_Microsoft_365__outlook_email_search'));
    assert.ok(s.permissions.allow.includes('mcp__claude_ai_Claude_Docs__read'), 'reading a shared Claude doc runs unasked');
    assert.ok(!s.permissions.allow.some((r) => /Claude_Docs__(batch|update|create|delete)/.test(r)), 'no Docs write is allowed');
    assert.ok(!s.permissions.allow.some((r) => /Microsoft_365(__\*)?$/.test(r)), 'no server-wide M365 rule');
    assert.ok(!s.permissions.allow.some((r) => /Microsoft_365__.*(send|create|update|delete|reply)/i.test(r)), 'no M365 write is allowed');
    const cmd = 'claude --permission-mode default';
    assert.deepStrictEqual(chat.verifyClaudeHome({ settings: s, command: cmd }), []);
    assert.deepStrictEqual(chat.verifyClaudeHome({ settings: s, local: { permissions: { allow: ['mcp__pa-chat__session_start'] } }, command: cmd }), [], 'a routine action may be allowed (D33)');
    assert.match(chat.verifyClaudeHome({ settings: s, local: { permissions: { allow: ['mcp__pa-chat__profile_delete'] } }, command: cmd }).join(), /must ask/);
    assert.match(chat.verifyClaudeHome({ settings: s, local: { permissions: { allow: ['mcp__pa-chat__*'] } }, command: cmd }).join(), /must ask/);
    assert.match(chat.verifyClaudeHome({ settings: s, local: { permissions: { allow: ['mcp__pa-chat'] } }, command: cmd }).join(), /must ask/);

    const agent = require('../src/chat/agent.ts');
    const rules = agent.opencodeRules();
    for (const t of T.CHAT_READ_TOOL_NAMES) assert.strictEqual(rules[`personal-assistant_${t}`], 'allow');
    for (const t of T.CHAT_AUTO_TOOL_NAMES) assert.strictEqual(rules[`personal-assistant_${t}`], 'allow', `${t} runs unasked (D33)`);
    for (const t of T.CHAT_ASK_TOOL_NAMES) assert.strictEqual(rules[`personal-assistant_${t}`], undefined, `${t} falls to "*": ask`);
    assert.strictEqual(rules['*'], 'ask');

    const md = chat.claudeMd();
    assert.match(md, /`board`/);
    assert.match(md, /Build agent/);
    assert.ok(!/factory_start|factory_jobs/.test(md), 'the chat is not told about the removed factory tools');
    assert.match(md, /run at once, without a prompt/, 'the chat is told its routine actions need no yes (D33)');
    assert.match(md, /only `profile_delete` and `profile_reset` ask/);
    assert.match(md, /Reading needs no yes/);
  }

  // --- what Talk shows while a prompt waits -------------------------------------------
  {
    const { describeTool } = require('../src/chat/transcript.ts');
    const { waitingText } = require('../src/chat/feed.ts');
    assert.strictEqual(describeTool('mcp__pa-chat__session_start', { repo: 'acme/widget', prompt: 'fix review' }), 'starting a session on acme/widget: fix review…');
    assert.strictEqual(describeTool('mcp__pa-chat__board', {}), 'reading your board…');
    assert.strictEqual(waitingText('stopping run 4…'), 'waiting for your yes in termhub: stopping run 4');
    assert.match(waitingText(null), /termhub/, 'the voice page keys its waiting state on "termhub"');
  }

  console.log('chatTools: ok');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
