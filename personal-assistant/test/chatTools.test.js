'use strict';

// The PA chat's structured tools (src/mcp/chatTools.js): the compact views a
// model reads, the factory_start → dispatch mapping (default runtime, models,
// branch/PR), the "never start an unattended end state from the chat" rule,
// the permission split (reads allowed, actions ask), the factory's
// continue/resume contract, and what Talk shows while a prompt waits.
// The store, dispatch and the factory CLI are stubbed; names are invented.

// These reach src/db only incidentally (board refresh, brief gather): never the real one.
require('./_fakeDb').install();
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PA_FACTORY_PATH = '/srv/factory-checkout';
process.env.PA_FACTORY_MACHINE = '';
process.env.PA_WORKTREES_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-chattools-test-'));

const T = require('../src/mcp/chatTools.ts');
const F = require('../src/dispatch/factoryCore');

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
          asks: [{ id: 9, kind: 'dispatch', title: 'Start: export retry', payload: { delivery: 'pr' } }] },
        { id: 2, group: 'blocked', summary: 'Release notes', blockers: [{ id: 5, who: 'Lee Sample', summary: 'Send the changelog' }], unblocked: [], asks: [] },
        { id: 3, group: 'todo', summary: 'Wire the new endpoint', blockers: [], unblocked: [{ blocker_id: '6', who: 'Lee Sample', summary: 'API spec' }], asks: [] },
        { id: 4, group: 'settled', summary: 'Reply to the vendor', blockers: [], unblocked: [], asks: [], settled: { id: 11, confidence: 0.8 } },
        { id: 'p50', standalone: true, group: 'todo', summary: 'Land run #3', blockers: [], unblocked: [], asks: [{ id: 50, kind: 'land', title: 'Land run #3' }] },
      ],
    };
    const extras = new Map([['1', { slug: 'acme/widget', run: { id: 7, status: 'running', route: 'factory', job: 'widget:0042' } }]]);
    const v = T.boardView(board, { extras, now: NOW });
    assert.deepStrictEqual(v.counts, { todo: 2, blocked: 1, unblocked: 1, looks_done: 1, waiting_on_others: 4 });
    assert.deepStrictEqual(v.todo[0], {
      id: '1', summary: 'Ship the export retry fix', who: 'Dana Example', due: 'today', repo: 'acme/widget',
      run: { id: 7, status: 'running', route: 'factory', job: 'widget:0042' }, offer: { proposal: 9, title: 'Start: export retry', delivery: 'pr' },
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

  // --- factory jobs, compact ---------------------------------------------------------
  {
    const job = {
      job_id: 'widget:0042', app: 'widget', title: 'Export retries', state: 'in_progress', kind: 'code', runtime: 'claude_session',
      delivery: 'pr', pipeline: 'solo', cost_usd: 0, subscription_equiv_usd: 3.456, updated_at: '2026-11-07T09:00:00Z',
      stories: [{ id: 1, state: 'in_review', pr_url: 'https://github.example/acme/widget/pull/12', ci: { state: 'failing', failing: ['lint'] } }],
      runs: [{ id: 3, persona: 'dev', runtime: 'claude_session', model: 'claude_session/default', state: 'running', cost_usd: 0, billing: 'subscription', session: { url: 'http://hub.example/#session=s1' } }],
    };
    const v = F.jobView(job, { id: 7, url: null });
    const row = T.jobRow(v);
    assert.deepStrictEqual(row, {
      job: 'widget:0042', state: 'in_progress', group: 'needs_you', kind: 'code', runtime: 'claude_session', title: 'Export retries', app: 'widget',
      prs: ['https://github.example/acme/widget/pull/12'], ci_failing: true, subscription_equiv_usd: 3.46, pa_run: 7, updated: '2026-11-07T09:00:00Z',
    });
    const st = T.jobRow(v, { ...job, stalled: true, base: { branch: 'feat/retry', pr: 12, into: 'main' } });
    assert.strictEqual(st.stalled, true);
    assert.deepStrictEqual(st.continues, { branch: 'feat/retry', pr: 12 });
    const d = T.jobDetail(v, { followUrl: 'http://hub.example/#session=f1' });
    assert.strictEqual(d.stories[0].ci, 'failing: lint');
    assert.strictEqual(d.runs[0].session, 'http://hub.example/#session=s1');
    assert.strictEqual(d.follow, 'http://hub.example/#session=f1');
    assert.strictEqual(d.can_cancel, true);
  }

  // --- termhub sessions -------------------------------------------------------------
  {
    const runs = new Map([['s1', { run: 7, status: 'running' }]]);
    assert.deepStrictEqual(T.sessionRow({ id: 's1', title: 'pa#7', cwd: '/w', kind: 'claude', idleState: 'waiting', idleReason: 'blocked' }, { runs, base: 'http://hub' }),
      { id: 's1', title: 'pa#7', cwd: '/w', kind: 'claude', state: 'needs_answer', run: { run: 7, status: 'running' }, url: 'http://hub/#session=s1' });
    assert.strictEqual(T.sessionRow({ id: 's2', alive: false }).state, 'ended');
    assert.strictEqual(T.sessionRow({ id: 's3', idleState: 'working' }).state, 'working');
  }

  // --- factory_start → dispatch options ---------------------------------------------
  {
    const o = T.factoryPlan({ ask: 'Add retries to the export', repo: 'acme/widget', delivery: 'pr', done: ['CI green', ' ', 'PR ready to merge'] });
    assert.strictEqual(o.runtime, 'claude_session', 'the user\'s default: Claude Code on the subscription');
    assert.strictEqual(o.via, 'factory');
    assert.strictEqual(o.jobKind, 'code');
    assert.deepStrictEqual(o.done, ['CI green', 'PR ready to merge']);
    assert.strictEqual(o.models, null);
    const c = T.factoryPlan({}, { card: { commitment: 412 } });
    assert.strictEqual(c.commitmentId, 412);
    assert.strictEqual(c.task, null, 'the card is the ask; its context is composed server-side');
    assert.throws(() => T.factoryPlan({}), /card id or the ask/);
    // Models: a Claude model on claude_session, provider/model on the api for the working persona.
    assert.deepStrictEqual(T.modelOverrides({ runtime: 'claude_session', model: 'claude-sonnet-5-5' }), ['claude_session=claude-sonnet-5-5']);
    assert.deepStrictEqual(T.modelOverrides({ runtime: 'claude_session', model: 'anthropic/claude-sonnet-5-5' }), ['claude_session=claude-sonnet-5-5']);
    assert.throws(() => T.modelOverrides({ runtime: 'claude_session', model: 'deepseek/deepseek-coder' }), /runtime "api"/);
    assert.deepStrictEqual(T.modelOverrides({ runtime: 'api', model: 'deepseek/deepseek-coder' }), ['dev=deepseek/deepseek-coder']);
    assert.deepStrictEqual(T.modelOverrides({ runtime: 'api', kind: 'research', model: 'deepseek/deepseek-chat' }), ['researcher=deepseek/deepseek-chat']);
    assert.throws(() => T.modelOverrides({ runtime: 'api', model: 'deepseek' }), /provider\/model/);
    assert.throws(() => T.modelOverrides({ runtime: 'api', model: 'x/y; rm -rf ~' }), /persona=model/);
    const api = T.factoryPlan({ ask: 'x', runtime: 'api', model: 'deepseek/deepseek-coder' });
    assert.strictEqual(api.runtime, 'api');
    assert.deepStrictEqual(api.models, ['dev=deepseek/deepseek-coder']);
    // Continuing: one of branch / PR, a code job, on a named repo.
    assert.strictEqual(T.factoryPlan({ ask: 'fix review', repo: 'acme/widget', branch: 'feat/retry' }).branch, 'feat/retry');
    assert.strictEqual(T.factoryPlan({ ask: 'fix review', repo: 'acme/widget', pr: 12 }).pr, 12);
    assert.throws(() => T.factoryPlan({ ask: 'x', repo: 'acme/widget', branch: 'a', pr: 1 }), /not both/);
    assert.throws(() => T.factoryPlan({ ask: 'x', branch: 'a' }), /repo/);
    assert.throws(() => T.factoryPlan({ ask: 'x', repo: 'acme/widget', branch: '--upload-pack=evil' }), /not a branch name/);
    assert.throws(() => T.factoryPlan({ ask: 'x', repo: 'acme/widget', kind: 'research', pr: 3 }), /code job/);
  }

  // --- the submit argv for branch / PR, and resume -------------------------------------
  {
    const base = { app: 'widget', title: 't', askFile: '/tmp/a.md', delivery: 'pr', externalId: 'i-1' };
    const b = F.submitArgv({ ...base, branch: 'feat/retry' });
    assert.ok(b.includes('--branch=feat/retry'));
    const p = F.submitArgv({ ...base, pr: 12 });
    assert.deepStrictEqual(p.slice(p.indexOf('--pr'), p.indexOf('--pr') + 2), ['--pr', '12']);
    assert.ok(!F.submitArgv(base).some((a) => /^--(branch|pr)/.test(a)), 'a new job sends neither');
    assert.throws(() => F.submitArgv({ ...base, branch: 'a', pr: 1 }), /not both/);
    assert.throws(() => F.submitArgv({ ...base, branch: '-x' }), /branch name/);
    assert.throws(() => F.submitArgv({ ...base, pr: 0 }), /PR number/);
    assert.deepStrictEqual(F.resumeArgv('widget:0042'), ['job', 'resume', 'widget:0042', '--json']);
    // v1.3's pre-creation refusals fail the run outright: no job was made.
    for (const code of ['branch_not_found', 'pr_not_open', 'branch_busy', 'github_unavailable']) {
      assert.ok(F.isRefusal(new F.FactoryError(code, 'x')), code);
    }
    assert.throws(() => F.resumeArgv('widget:0042;rm'), /not a factory job id/);

    const factory = require('../src/dispatch/factory');
    const sent = [];
    // A factory without --branch: refused in its parser. Never resent without the flag.
    factory._setRunner(async (machine, argv) => {
      sent.push(argv);
      return { code: 2, stdout: '', stderr: "Usage: factory job submit\nError: No such option: --branch" };
    });
    await assert.rejects(() => factory.submit(['uv', 'run', 'factory', ...b].slice(3), { kind: 'code', runtime: 'api' }), /cannot continue an existing branch or PR/);
    assert.strictEqual(sent.length, 1, 'not resent without --branch');
    // A factory without `job resume`: said plainly.
    factory._setRunner(async () => ({ code: 2, stdout: '', stderr: "Usage: factory job\nError: No such command 'resume'." }));
    await assert.rejects(() => factory.resume('widget:0042'), /cannot resume jobs yet/);
    // One that has it: its answer, then the stored list is refreshed (stubbed away).
    const calls = [];
    factory._setRunner(async (machine, argv) => {
      calls.push(argv.slice(3).join(' '));
      if (argv.includes('resume')) return { code: 0, stdout: JSON.stringify({ job_id: 'widget:0042', state: 'queued' }), stderr: '' };
      return { code: 1, stdout: JSON.stringify({ error: 'internal', message: 'no list in tests' }), stderr: '' };
    });
    const r = await factory.resume('widget:0042');
    assert.strictEqual(r.state, 'queued');
    assert.strictEqual(calls[0], 'job resume widget:0042 --json');
    factory._setRunner(null);
  }

  // --- actions: start, or a card for an end state with no human step -------------------
  {
    const stub = (rel, exports) => {
      const file = require.resolve(rel);
      require.cache[file] = { id: file, filename: file, loaded: true, exports };
    };
    const started = [];
    const proposed = [];
    let preview = 'pr';
    stub('../src/dispatch', {
      previewDelivery: async () => ({ delivery: preview, source: 'explicit' }),
      start: async (o) => {
        started.push(o);
        return { route: 'factory', id: 21, jobId: 'widget:0050', jobKind: 'code', runtime: o.runtime, app: 'widget', delivery: preview, deliveryRequested: preview, pipeline: 'solo', created: true, warnings: [], url: 'http://hub/#session=f9' };
      },
    });
    stub('../src/dispatch/offer', { propose: async (o) => { proposed.push(o); return { id: 77, title: 'Start: export retries' }; } });
    stub('../src/budget.ts', { allow: async () => true });

    const r = await T.handle('factory_start', { card: '412', delivery: 'pr', done: ['CI green'] });
    assert.deepStrictEqual(r, { started: true, run: 21, job: 'widget:0050', kind: 'code', runtime: 'claude_session', delivery: 'pr', pipeline: 'solo', app: 'widget', follow: 'http://hub/#session=f9' });
    assert.strictEqual(started[0].commitmentId, 412);
    assert.strictEqual(started[0].routeReason, 'the chat started it');

    preview = 'auto_merge';
    const c = await T.handle('factory_start', { card: '412', delivery: 'auto_merge' });
    assert.strictEqual(c.started, false, 'merging with no human step never starts from the chat');
    assert.deepStrictEqual(c.card, { proposal: 77, title: 'Start: export retries' });
    assert.strictEqual(proposed[0].suggestedBy, 'the chat');
    assert.strictEqual(started.length, 1);
    await assert.rejects(() => T.handle('factory_continue', { repo: 'acme/widget', pr: 12, ask: 'merge it', delivery: 'auto_merge' }), /not started from the chat/);
    await assert.rejects(() => T.handle('factory_continue', { repo: 'acme/widget', ask: 'x' }), /branch or the PR/);
    await assert.rejects(() => T.handle('factory_start', { card: 'p5' }), /an offer, not a card/);

    preview = 'draft_pr';
    await T.handle('session_start', { repo: 'acme/widget', prompt: 'Look into the flaky export test', mode: 'plan' });
    const s = started[started.length - 1];
    assert.strictEqual(s.via, 'claude');
    assert.strictEqual(s.mode, 'plan');
    assert.strictEqual(s.delivery, null, 'plan delivers nothing');
    await assert.rejects(() => T.handle('factory_cancel', { job: 'not a job' }), /not a factory job id/);
    for (const rel of ['../src/dispatch', '../src/dispatch/offer', '../src/budget.ts']) delete require.cache[require.resolve(rel)];
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
    for (const t of T.CHAT_ACTION_TOOL_NAMES) assert.ok(!s.permissions.allow.some((r) => r.endsWith(`__${t}`)), `${t} asks`);
    const cmd = 'claude --permission-mode default';
    assert.deepStrictEqual(chat.verifyClaudeHome({ settings: s, command: cmd }), []);
    assert.match(chat.verifyClaudeHome({ settings: s, local: { permissions: { allow: ['mcp__pa-chat__factory_start'] } }, command: cmd }).join(), /action tool/);
    assert.match(chat.verifyClaudeHome({ settings: s, local: { permissions: { allow: ['mcp__pa-chat__*'] } }, command: cmd }).join(), /action tool/);
    assert.match(chat.verifyClaudeHome({ settings: s, local: { permissions: { allow: ['mcp__pa-chat'] } }, command: cmd }).join(), /action tool/);

    const agent = require('../src/chat/agent');
    const rules = agent.opencodeRules();
    for (const t of T.CHAT_READ_TOOL_NAMES) assert.strictEqual(rules[`personal-assistant_${t}`], 'allow');
    for (const t of T.CHAT_ACTION_TOOL_NAMES) assert.strictEqual(rules[`personal-assistant_${t}`], undefined, `${t} falls to "*": ask`);
    assert.strictEqual(rules['*'], 'ask');

    const md = chat.claudeMd();
    assert.match(md, /`board`/);
    assert.match(md, /Runtime: claude_session/);
    assert.match(md, /permission prompt is the yes/);
  }

  // --- what Talk shows while a prompt waits -------------------------------------------
  {
    const { describeTool } = require('../src/chat/transcript');
    const { waitingText } = require('../src/chat/feed');
    assert.strictEqual(describeTool('mcp__pa-chat__factory_start', { card: '412', delivery: 'pr' }), 'starting a factory job: card 412 (claude_session, pr)…');
    assert.strictEqual(describeTool('mcp__pa-chat__factory_continue', { repo: 'acme/widget', pr: 12, ask: 'fix review', runtime: 'api' }), 'starting a factory job on PR #12: fix review (api)…');
    assert.strictEqual(describeTool('mcp__pa-chat__board', {}), 'reading your board…');
    assert.strictEqual(waitingText('cancelling factory job widget:1…'), 'waiting for your yes in termhub: cancelling factory job widget:1');
    assert.match(waitingText(null), /termhub/, 'the voice page keys its waiting state on "termhub"');
  }

  console.log('chatTools: ok');
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
