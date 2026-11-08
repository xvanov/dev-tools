'use strict';

// The PA chat on the Agent SDK (src/chat/sdkFeed.js, plan 4.2), over a mocked
// SDK: no Claude Code process is started and no model is called. Covers
// streaming into the chat feed, an approval round trip, deny, timeout, the
// policy hook, resume, and the engine flag.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/chat/sdkFeed');
const T = require('../src/chat/transcript');
const { engine } = require('../src/chat/feed');

const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

// A stand-in for @anthropic-ai/claude-agent-sdk's query(): the test reads what
// the feed streams in and emits what the SDK would stream out.
function fakeSdk() {
  const runs = [];
  function query({ prompt, options }) {
    const out = [];
    let wake = null;
    let done = false;
    const it = prompt[Symbol.asyncIterator]();
    const run = {
      options,
      closed: false,
      next: async () => (await it.next()).value,
      emit(m) {
        out.push(m);
        if (wake) wake();
      },
      end() {
        done = true;
        if (wake) wake();
      },
    };
    runs.push(run);
    const gen = (async function* () {
      for (;;) {
        while (out.length) yield out.shift();
        if (done) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    })();
    gen.close = () => {
      run.closed = true;
      run.end();
    };
    return gen;
  }
  return { query, runs };
}

// A stand-in for src/policy: records every call; denies a voice yes to a merge.
function fakePolicy(rules = {}) {
  const calls = { authorize: [], enforce: [] };
  return {
    calls,
    async authorize(req, opts = {}) {
      calls.authorize.push({ req, opts });
      const r = rules[req.tool];
      return r || { decision: 'ask', rule: 'default', reason: 'no rule matches', tags: [] };
    },
    async enforce(req) {
      calls.enforce.push(req);
      if (req.channel === 'voice' && req.action === 'approve' && req.args?.delivery === 'auto_merge') {
        throw Object.assign(new Error('denied by policy (voice-no-merge): voice never approves a merge'), { code: 'POLICY_DENIED' });
      }
      return { decision: 'allow', rule: 'test' };
    },
  };
}

function makeFeed({ dir, sdk, policy, timeoutMs = 60_000, root = path.join(dir, 'projects') }) {
  const home = path.join(dir, 'pa-home');
  fs.mkdirSync(home, { recursive: true });
  return S.createSdkFeed({
    loadSdk: async () => ({ query: sdk.query }),
    prepare: () => ({ home, mcpServers: { 'pa-chat': { type: 'stdio', command: 'node', args: ['server.js'], env: { PA_MCP_CHAT_TOOLS: '1' } } } }),
    policy: () => policy,
    root: () => root,
    stateDir: () => home,
    model: () => null,
    approvalTimeoutMs: () => timeoutMs,
    env: () => S.subscriptionEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 't' }),
  });
}

const sdkMsg = {
  init: (sid) => ({ type: 'system', subtype: 'init', session_id: sid, apiKeySource: 'none', model: 'claude-opus-5', permissionMode: 'default', parent_tool_use_id: null }),
  stream: (event) => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: `s-${Math.random()}`, session_id: 's' }),
  assistant: (id, content, stop = null, uuid = `a-${id}`) => ({ type: 'assistant', uuid, parent_tool_use_id: null, message: { id, role: 'assistant', content, stop_reason: stop } }),
  result: (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5, total_cost_usd: 0.01, uuid: `r-${Math.random()}`, parent_tool_use_id: null, ...extra }),
};

(async () => {
  // ------------------------------------------------------------- pure parts --
  const env = S.subscriptionEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 'tok', OTHER: '1' });
  assert.ok(!('ANTHROPIC_API_KEY' in env) && !('ANTHROPIC_AUTH_TOKEN' in env), 'the SDK never sees API credentials: it runs on the Claude login');
  assert.strictEqual(env.OTHER, '1');
  assert.strictEqual(env.PA_CHAT_SESSION, '1');

  assert.deepStrictEqual(S.splitTool('mcp__pa-chat__factory_start'), { server: 'pa-chat', tool: 'factory_start' });
  assert.deepStrictEqual(S.splitTool('mcp__personal-assistant__recall'), { server: 'personal-assistant', tool: 'recall' });
  assert.deepStrictEqual(S.splitTool('Read'), { server: null, tool: 'Read' });

  // The hook: deny wins; the chat's actions always ask; an explicit rule stands; no rule defers.
  assert.strictEqual(S.hookDecision('mcp__pa-chat__factory_start', { decision: 'deny', rule: 'voice-no-merge' }).decision, 'deny');
  assert.strictEqual(S.hookDecision('mcp__pa-chat__factory_start', { decision: 'allow', rule: 'oops' }).decision, 'ask', 'no rule makes an action run unasked');
  assert.strictEqual(S.hookDecision('mcp__pa-chat__factory_start', null).decision, 'ask', 'without a policy an action still asks');
  assert.strictEqual(S.hookDecision('mcp__pa-chat__board', { decision: 'allow', rule: 'chat-reads' }).decision, 'allow');
  assert.strictEqual(S.hookDecision('Read', { decision: 'ask', rule: 'default' }), null, 'no matching rule: Claude Code\'s settings decide');
  assert.strictEqual(S.hookDecision('Bash', null), null);

  // The engine flag: terminal by default, sdk when asked, anything else terminal.
  assert.strictEqual(engine('sdk'), 'sdk');
  assert.strictEqual(engine(' SDK '), 'sdk');
  assert.strictEqual(engine('terminal'), 'terminal');
  assert.strictEqual(engine(null), 'terminal');
  assert.strictEqual(engine('pty'), 'terminal');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-chat-sdk-'));
  try {
    // ------------------------------------------------- streaming into the feed --
    {
      const sdk = fakeSdk();
      const policy = fakePolicy();
      const feed = makeFeed({ dir, sdk, policy });
      const got = [];
      const unsub = feed.subscribe((e) => got.push(e));
      assert.strictEqual(got[0].type, 'status');
      assert.strictEqual(got[0].text, 'offline', 'no session until the first message');

      const sent = await feed.send({ text: 'what is on today?\r\n', source: 'voice' });
      const run = sdk.runs[0];
      assert.ok(run, 'the first message starts the SDK session');
      assert.strictEqual(run.options.permissionMode, 'default');
      assert.ok(typeof run.options.canUseTool === 'function');
      assert.ok(run.options.hooks.PreToolUse[0].hooks[0], 'every tool call meets the policy hook');
      assert.strictEqual(run.options.includePartialMessages, true);
      assert.ok(run.options.mcpServers['pa-chat'], 'the same pa-chat MCP server as the terminal chat');
      assert.ok(!('ANTHROPIC_API_KEY' in run.options.env), 'subscription, not the API');
      assert.ok(!run.options.resume, 'nothing to resume yet');
      const msg = await run.next();
      assert.deepStrictEqual(msg.message, { role: 'user', content: 'what is on today?' });
      assert.strictEqual(msg.parent_tool_use_id, null);
      assert.deepStrictEqual(got.filter((e) => e.type === 'user').map((e) => [e.id, e.text, e.source]), [[sent.id, 'what is on today?', 'voice']]);
      assert.ok(got.some((e) => e.type === 'status' && e.text === 'thinking'));

      run.emit(sdkMsg.init('sess-1'));
      run.emit(sdkMsg.stream({ type: 'message_start', message: { id: 'msg_1' } }));
      run.emit(sdkMsg.stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
      run.emit(sdkMsg.stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
      run.emit(sdkMsg.stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Two ' } }));
      run.emit(sdkMsg.stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'meetings.' } }));
      run.emit(sdkMsg.assistant('msg_1', [{ type: 'text', text: 'Two meetings.' }]));
      run.emit(sdkMsg.stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
      run.emit(sdkMsg.stream({ type: 'message_stop' }));
      run.emit(sdkMsg.result());
      await until(() => got.some((e) => e.type === 'status' && e.text === 'idle'), 'idle');

      const partials = got.filter((e) => e.type === 'assistant' && e.partial);
      assert.deepStrictEqual(partials.map((e) => e.text), ['Two ', 'Two meetings.'], 'partials carry the text so far');
      const finals = got.filter((e) => e.type === 'assistant' && !e.partial);
      assert.strictEqual(finals.length, 1);
      assert.strictEqual(finals[0].text, 'Two meetings.');
      assert.strictEqual(finals[0].final, true);
      assert.ok(partials.every((p) => p.id === finals[0].id), 'partials and the final share one id (Ask speaks them as one utterance)');
      assert.deepStrictEqual(feed.history().map((e) => [e.type, e.text]), [['user', 'what is on today?'], ['assistant', 'Two meetings.']], 'history keeps finals only');
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pa-home', S.SESSION_FILE), 'utf8')).sessionId, 'sess-1', 'the session id is kept for a resume');
      assert.strictEqual((await feed.session()).sessionId, 'sess-1');

      // Text before a tool call is a step (final false); the tool call is activity.
      await feed.send({ text: 'check my mail' });
      await run.next();
      run.emit(sdkMsg.assistant('msg_2', [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu_r', name: 'mcp__personal-assistant__recall', input: { query: 'mail' } }], 'tool_use'));
      run.emit(sdkMsg.assistant('msg_3', [{ type: 'text', text: 'Nothing new.' }], 'end_turn'));
      run.emit(sdkMsg.result());
      await until(() => got.filter((e) => e.type === 'status' && e.text === 'idle').length === 2, 'second idle');
      const step = got.find((e) => e.text === 'Let me look.');
      assert.strictEqual(step.final, false);
      assert.strictEqual(got.find((e) => e.text === 'Nothing new.').final, true);
      const act = got.find((e) => e.type === 'activity' && e.toolUseId === 'tu_r');
      assert.strictEqual(act.text, 'searching your history: mail…');
      // A subagent's traffic is not the chat speaking.
      run.emit({ ...sdkMsg.assistant('msg_sub', [{ type: 'text', text: 'subagent says' }], 'end_turn'), parent_tool_use_id: 'tu_x' });
      await tick();
      assert.ok(!got.some((e) => e.text === 'subagent says'));

      // An error result is shown, and the turn still ends.
      await feed.send({ text: 'again' });
      await run.next();
      run.emit(sdkMsg.result({ subtype: 'error_max_turns', is_error: true }));
      await until(() => got.some((e) => e.type === 'activity' && /the chat stopped: error_max_turns/.test(e.text)), 'error activity');

      // The session ending: offline, and the next message starts (resumes) another.
      run.end();
      await until(() => got.some((e) => e.type === 'status' && e.text === 'offline' && got.indexOf(e) > 0), 'offline');
      await feed.send({ text: 'still there?' });
      assert.strictEqual(sdk.runs.length, 2);
      assert.strictEqual(sdk.runs[1].options.resume, 'sess-1', 'a new query resumes the same conversation');
      feed.stop();
      unsub();
    }

    // ---------------------------------------- approval round trip (dashboard) --
    {
      const sdk = fakeSdk();
      const policy = fakePolicy({ board: { decision: 'allow', rule: 'chat-reads' } });
      const feed = makeFeed({ dir: fs.mkdtempSync(path.join(dir, 'a-')), sdk, policy });
      const got = [];
      feed.subscribe((e) => got.push(e));
      await feed.send({ text: 'start a job for card 412' });
      const run = sdk.runs[0];
      await run.next();
      const hook = run.options.hooks.PreToolUse[0].hooks[0];

      // The hook: an action asks (audited by the MCP server, not twice here); a read is allowed.
      const input = { card: '412', delivery: 'pr' };
      const h = await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__pa-chat__factory_start', tool_input: input, tool_use_id: 'tu1' }, 'tu1', { signal: new AbortController().signal });
      assert.deepStrictEqual([h.hookSpecificOutput.hookEventName, h.hookSpecificOutput.permissionDecision], ['PreToolUse', 'ask']);
      const last = policy.calls.authorize.at(-1);
      assert.deepStrictEqual([last.req.tool, last.req.channel, last.req.action, last.opts.audit], ['factory_start', 'chat', 'call', false]);
      const r = await hook({ tool_name: 'mcp__pa-chat__board', tool_input: {}, tool_use_id: 'tu0' });
      assert.strictEqual(r.hookSpecificOutput.permissionDecision, 'allow');
      const rd = await hook({ tool_name: 'Read', tool_input: { file_path: 'INBOX.md' }, tool_use_id: 'tuR' });
      assert.deepStrictEqual(rd, { continue: true }, 'no rule: Claude Code\'s own settings decide');
      assert.strictEqual(policy.calls.authorize.at(-1).opts.audit, true, 'a built-in tool call is audited here');

      run.emit(sdkMsg.assistant('msg_a', [{ type: 'tool_use', id: 'tu1', name: 'mcp__pa-chat__factory_start', input }], 'tool_use'));
      await until(() => got.some((e) => e.type === 'activity' && e.toolUseId === 'tu1'), 'tool activity');
      const ac = new AbortController();
      const decided = run.options.canUseTool('mcp__pa-chat__factory_start', input, { signal: ac.signal, toolUseID: 'tu1' });
      await tick();
      const offer = got.find((e) => e.type === 'permission' && e.toolUseId === 'tu1');
      assert.ok(offer, 'the card and Talk are offered the prompt');
      assert.strictEqual(offer.approvable, true);
      assert.strictEqual(offer.ask, 'Start a factory job for card 412 on your subscription, opening a PR for review. Shall I?');
      assert.ok(got.some((e) => e.type === 'activity' && /^waiting for your yes: starting a factory job/.test(e.text)));
      const s = await feed.session();
      assert.strictEqual(s.waitingOn, 'dashboard');
      assert.strictEqual(s.permission.toolUseId, 'tu1');
      assert.strictEqual(s.url, null);

      await assert.rejects(feed.send({ text: 'hello?' }), (e) => e.status === 409, 'typing while a yes is pending is refused, as before');
      await assert.rejects(feed.answerPermission({ answer: 'yes', toolUseId: 'stale' }), (e) => e.status === 409);
      await assert.rejects(feed.answerPermission({ answer: 'maybe', toolUseId: 'tu1' }), (e) => e.status === 409);

      const ok = await feed.answerPermission({ answer: 'yes', toolUseId: 'tu1', via: 'dashboard' });
      assert.deepStrictEqual(ok, { ok: true, answer: 'yes', tool: 'factory_start' });
      assert.deepStrictEqual(await decided, { behavior: 'allow', updatedInput: input }, 'that one call is allowed, nothing broader');
      const enf = policy.calls.enforce.at(-1);
      assert.deepStrictEqual([enf.tool, enf.action, enf.channel, enf.subject], ['factory_start', 'approve', 'dashboard', 'tu1'], 'the answer goes through the policy engine');
      assert.ok(got.some((e) => e.type === 'permission' && e.cleared && e.answered === 'yes'));
      assert.strictEqual((await feed.session()).permission, null);
      await assert.rejects(feed.answerPermission({ answer: 'yes', toolUseId: 'tu1' }), (e) => e.status === 409, 'answered once only');

      // ------------------------------------------------------------- deny --
      const d2 = run.options.canUseTool('mcp__pa-chat__factory_cancel', { job: 'dev-tools:9' }, { signal: ac.signal, toolUseID: 'tu2' });
      await tick();
      await feed.answerPermission({ answer: 'no', toolUseId: 'tu2', via: 'voice' });
      const denied = await d2;
      assert.strictEqual(denied.behavior, 'deny');
      assert.match(denied.message, /said no/);
      assert.deepStrictEqual([policy.calls.enforce.at(-1).action, policy.calls.enforce.at(-1).channel], ['deny', 'voice']);

      // The policy bars voice from approving a merge: 403, and the prompt still waits for the click path.
      const d3 = run.options.canUseTool('mcp__pa-chat__factory_start', { card: '7', delivery: 'auto_merge' }, { signal: ac.signal, toolUseID: 'tu3' });
      await tick();
      await assert.rejects(feed.answerPermission({ answer: 'yes', toolUseId: 'tu3', via: 'voice' }), (e) => e.status === 403);
      assert.strictEqual((await feed.session()).permission.toolUseId, 'tu3');
      await feed.answerPermission({ answer: 'yes', toolUseId: 'tu3', via: 'dashboard' });
      assert.strictEqual((await d3).behavior, 'allow');

      // Two prompts at once (parallel calls): one card at a time, the next offered when the first is answered.
      const p4 = run.options.canUseTool('mcp__pa-chat__factory_resume', { job: 'a:1' }, { signal: ac.signal, toolUseID: 'tu4' });
      const p5 = run.options.canUseTool('mcp__pa-chat__factory_resume', { job: 'a:2' }, { signal: ac.signal, toolUseID: 'tu5' });
      await tick();
      assert.strictEqual((await feed.session()).permission.toolUseId, 'tu4');
      await feed.answerPermission({ answer: 'no', toolUseId: 'tu4' });
      assert.ok(got.some((e) => e.type === 'permission' && e.toolUseId === 'tu5' && !e.cleared), 'the second is offered next');
      await feed.answerPermission({ answer: 'yes', toolUseId: 'tu5' });
      assert.deepStrictEqual([(await p4).behavior, (await p5).behavior], ['deny', 'allow']);

      // Anything that is not one of the chat's actions cannot be approved here: refused at once.
      const bash = await run.options.canUseTool('Bash', { command: 'node pa.js do --task x' }, { signal: ac.signal, toolUseID: 'tu6' });
      assert.strictEqual(bash.behavior, 'deny');
      assert.match(bash.message, /no terminal/);
      assert.strictEqual((await feed.session()).permission, null, 'nothing left waiting');

      // The SDK cancelling the call (an interrupt) settles it as a deny.
      const ac2 = new AbortController();
      const p7 = run.options.canUseTool('mcp__pa-chat__session_start', { prompt: 'x' }, { signal: ac2.signal, toolUseID: 'tu7' });
      await tick();
      ac2.abort();
      assert.strictEqual((await p7).behavior, 'deny');
      assert.strictEqual((await feed.session()).permission, null);
      feed.stop();
    }

    // ------------------------------------------------------------- timeout --
    {
      const sdk = fakeSdk();
      const policy = fakePolicy();
      const feed = makeFeed({ dir: fs.mkdtempSync(path.join(dir, 't-')), sdk, policy, timeoutMs: 40 });
      const got = [];
      feed.subscribe((e) => got.push(e));
      await feed.send({ text: 'cancel job 9' });
      const run = sdk.runs[0];
      await run.next();
      const res = await run.options.canUseTool('mcp__pa-chat__factory_cancel', { job: 'dev-tools:9' }, { signal: new AbortController().signal, toolUseID: 'tuT' });
      assert.strictEqual(res.behavior, 'deny', 'no answer is a no');
      assert.match(res.message, /did not answer/);
      await until(() => policy.calls.authorize.some((c) => c.req.channel === 'timeout'), 'timeout audit');
      const a = policy.calls.authorize.find((c) => c.req.channel === 'timeout').req;
      assert.deepStrictEqual([a.tool, a.action, a.subject], ['factory_cancel', 'deny', 'tuT']);
      assert.ok(got.some((e) => e.type === 'permission' && e.cleared), 'the card is cleared');
      assert.ok(got.some((e) => e.type === 'activity' && /^no answer in/.test(e.text)));
      await assert.rejects(feed.answerPermission({ answer: 'yes', toolUseId: 'tuT' }), (e) => e.status === 409, 'a late yes approves nothing');
      feed.stop();
    }

    // ----------------------------------------------- resume and its history --
    {
      const d = fs.mkdtempSync(path.join(dir, 'r-'));
      const home = path.join(d, 'pa-home');
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, S.SESSION_FILE), JSON.stringify({ sessionId: 'sess-old' }));
      const proj = path.join(d, 'projects', T.projectDirFor(home));
      fs.mkdirSync(proj, { recursive: true });
      const at = '2026-11-07T10:00:00.000Z';
      fs.writeFileSync(path.join(proj, 'sess-old.jsonl'), [
        { type: 'user', uuid: 'u1', timestamp: at, message: { role: 'user', content: 'earlier question' } },
        { type: 'assistant', uuid: 'a1', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], stop_reason: 'end_turn' } },
      ].map((x) => JSON.stringify(x)).join('\n') + '\n');
      const sdk = fakeSdk();
      const feed = makeFeed({ dir: d, sdk, policy: fakePolicy() });
      assert.deepStrictEqual(feed.history().map((e) => e.text), ['earlier question', 'earlier answer'], 'a worker restart keeps the conversation on screen');
      const opened = await feed.open();
      assert.deepStrictEqual([opened.engine, opened.sessionId, opened.created, opened.url], ['sdk', 'sess-old', true, null]);
      assert.strictEqual(sdk.runs[0].options.resume, 'sess-old');
      assert.strictEqual((await feed.open()).created, false, 'one session');
      feed.stop();
      await until(() => sdk.runs[0].closed, 'closed');
    }

    // A failure to start is a 503 with the reason, and the next message tries again.
    {
      let fail = true;
      const sdk = fakeSdk();
      const feed = S.createSdkFeed({
        loadSdk: async () => {
          if (fail) throw new Error('module not installed');
          return { query: sdk.query };
        },
        prepare: () => ({ home: dir, mcpServers: {} }),
        policy: () => fakePolicy(),
        root: () => path.join(dir, 'none'),
        stateDir: () => fs.mkdtempSync(path.join(dir, 'f-')),
        model: () => 'claude-opus-5',
        approvalTimeoutMs: () => 1000,
        env: () => ({}),
      });
      await assert.rejects(feed.send({ text: 'hi' }), (e) => e.status === 503 && /module not installed/.test(e.message));
      fail = false;
      await feed.send({ text: 'hi' });
      assert.strictEqual(sdk.runs[0].options.model, 'claude-opus-5', 'PA_CHAT_MODEL is passed through');
      feed.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('chatSdk ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
