'use strict';

// The PA chat on the Agent SDK (src/chat/sdkFeed.js, plan 4.2), over a mocked
// SDK: no Claude Code process is started and no model is called. Covers
// streaming into the chat feed, an approval round trip, deny, timeout, the
// policy hook, resume, and the engine flag.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/chat/sdkFeed.ts');
const T = require('../src/chat/transcript.ts');
const { engine } = require('../src/chat/feed.ts');

const tick = () => new Promise((r) => setImmediate(r));
// A wait is re-checked when something it waits on happens: a feed event, or a
// call on one of the fakes below (each calls changed()). No clock: a loaded
// machine outran a fixed 2 s. A wait nothing can satisfy any more leaves the
// event loop empty, and beforeExit names it.
const waiting = new Map();
function changed() {
  for (const check of [...waiting.keys()]) check();
}
function until(fn, what) {
  return new Promise((resolve) => {
    const check = () => {
      if (!fn()) return;
      waiting.delete(check);
      resolve();
    };
    waiting.set(check, what);
    check();
  });
}
process.on('beforeExit', () => {
  if (!waiting.size) return;
  console.error(`never happened: ${[...waiting.values()].join(', ')}`);
  process.exit(1);
});

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
      changed();
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
    evaluate(req) {
      return rules[req.tool] || { decision: 'ask', rule: 'default', reason: 'no rule matches', tags: [] };
    },
    async authorize(req, opts = {}) {
      calls.authorize.push({ req, opts });
      changed();
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

// A stand-in for termhub: the Run view's session is created here, never in a real termhub.
function fakeHub() {
  const sessions = [];
  const created = [];
  return {
    created,
    sessions,
    async listSessions() {
      return sessions;
    },
    async createSession(o) {
      const s = { id: `view-${created.length + 1}`, cwd: o.cwd, alive: true };
      created.push(o);
      sessions.push(s);
      changed();
      return { id: s.id };
    },
    async sessionUrl(id) {
      return `http://127.0.0.1:7000/#session=${id}`;
    },
  };
}

function makeFeed({ dir, sdk, policy, timeoutMs = 60_000, root = path.join(dir, 'projects'), hub = fakeHub() }) {
  const home = path.join(dir, 'pa-home');
  fs.mkdirSync(home, { recursive: true });
  const feed = S.createSdkFeed({
    loadSdk: async () => ({ query: sdk.query }),
    prepare: () => ({ home, mcpServers: { 'pa-chat': { type: 'stdio', command: 'node', args: ['server.js'], env: { PA_MCP_CHAT_TOOLS: '1' } } } }),
    policy: () => policy,
    root: () => root,
    stateDir: () => home,
    model: () => null,
    approvalTimeoutMs: () => timeoutMs,
    env: () => S.subscriptionEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 't' }),
    hub: () => hub,
    viewCommand: (file) => `node sdkView.js --follow "${file}"`,
  });
  // After the test's own subscriber has seen the event too.
  feed.subscribe(() => queueMicrotask(changed));
  return feed;
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
  assert.strictEqual(env.CLAUDE_CODE_ARTIFACT, '1', 'the Artifact tool is on: shared Claude pages are found by voice, no link pasted');

  assert.deepStrictEqual(S.splitTool('mcp__pa-chat__factory_start'), { server: 'pa-chat', tool: 'factory_start' });
  assert.deepStrictEqual(S.splitTool('mcp__personal-assistant__recall'), { server: 'personal-assistant', tool: 'recall' });
  assert.deepStrictEqual(S.splitTool('Read'), { server: null, tool: 'Read' });

  // The hook: deny wins; the chat's actions always ask; an explicit rule stands; no rule defers.
  assert.strictEqual(S.hookDecision('mcp__pa-chat__factory_start', { decision: 'deny', rule: 'voice-no-merge' }).decision, 'deny');
  assert.strictEqual(S.hookDecision('mcp__pa-chat__factory_start', { decision: 'allow', rule: 'oops' }).decision, 'ask', 'no rule makes an action run unasked');
  assert.strictEqual(S.hookDecision('mcp__pa-chat__factory_start', null).decision, 'ask', 'without a policy an action still asks');
  // Shared Claude pages: listing and reading run unasked; publishing, deleting, pinning still ask.
  assert.strictEqual(S.artifactRead('Artifact', { action: 'list', scope: 'shared' }), true);
  assert.strictEqual(S.artifactRead('Artifact', { action: 'read', url: 'https://claude.ai/artifact/x' }), true);
  assert.strictEqual(S.artifactRead('Artifact', { file_path: 'page.html' }), false, 'publish (no action) asks');
  assert.strictEqual(S.artifactRead('Artifact', { action: 'delete', url: 'u' }), false);
  assert.strictEqual(S.artifactRead('Artifact', { action: 'read', file_path: 'x' }), false, 'a read that carries a file is not a plain read');
  assert.strictEqual(S.artifactRead('Read', { action: 'read' }), false);
  assert.strictEqual(S.hookDecision('mcp__pa-chat__board', { decision: 'allow', rule: 'chat-reads' }).decision, 'allow');
  assert.strictEqual(S.hookDecision('Read', { decision: 'ask', rule: 'default' }), null, 'no matching rule: Claude Code\'s settings decide');
  assert.strictEqual(S.hookDecision('Bash', null), null);

  // Reads are allowed by policy only inside pa-home.
  const H = path.resolve('/pa/home');
  assert.ok(S.insideHome(H, { file_path: path.join(H, 'INBOX.md') }));
  assert.ok(S.insideHome(H, { file_path: 'INBOX.md' }), 'relative to the chat\'s cwd');
  assert.ok(S.insideHome(H, {}), 'no path: the cwd');
  assert.ok(!S.insideHome(H, { file_path: path.resolve('/pa/home-other/x') }), 'a sibling with the same prefix is outside');
  assert.ok(!S.insideHome(H, { path: '..' }));
  // Generic prompts: the detail is the exact input, cut only with a count; voice only when it can be heard whole.
  assert.strictEqual(S.genericDetail('Bash', { command: 'ls' }), 'ls');
  assert.match(S.genericDetail('Bash', { command: 'x'.repeat(2100) }), /… \(100 more characters\)$/);
  assert.strictEqual(S.genericDetail('mcp__personal-assistant__remember', { text: 'a' }), '{\n "text": "a"\n}');
  assert.strictEqual(S.genericAsk('mcp__personal-assistant__request_secret', {}), 'Claude wants to use request secret (personal-assistant). Allow once?');
  assert.strictEqual(S.genericVoiceOk('Bash', { command: 'pa propose --task x' }), true);
  assert.strictEqual(S.genericVoiceOk('Bash', { command: 'x'.repeat(200) }), false);
  assert.strictEqual(S.genericVoiceOk('Write', { file_path: 'a', content: 'b' }), false);
  assert.strictEqual(S.genericVoiceOk('mcp__personal-assistant__remember', { text: 'the renewal is in May' }), true, 'a short MCP input is heard whole (one line)');
  assert.strictEqual(S.genericVoiceOk('Bash', { command: 'a\nb' }), false, 'a multi-line command is not');

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
      assert.deepStrictEqual(feed.doorbell(1, { minIdleMs: 0 }), { ok: false, reason: 'no PA chat session' }, 'the doorbell never starts a session');

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
      assert.strictEqual((await feed.session()).conversationId, 'sess-1');

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

      // The INBOX doorbell: the fixed line, as a user turn, only when idle long enough and nothing waits.
      assert.deepStrictEqual(feed.doorbell(42, { minIdleMs: 60_000 }), { ok: false, reason: 'idle too briefly' });
      assert.strictEqual(feed.doorbell('x; rm', { minIdleMs: 0 }).reason, 'bad notification id');
      assert.deepStrictEqual(feed.doorbell(42, { minIdleMs: 0 }), { ok: true, reason: 'idle, nothing waiting' });
      assert.deepStrictEqual((await run.next()).message, { role: 'user', content: 'PA inbox: notification 42 is waiting. Read INBOX.md.' });
      assert.ok(got.some((e) => e.type === 'user' && /notification 42/.test(e.text) && !e.source), 'shown like the terminal doorbell: no source');
      assert.deepStrictEqual(feed.doorbell(43, { minIdleMs: 0 }), { ok: false, reason: 'state thinking' }, 'never during a turn');
      run.emit(sdkMsg.result());
      await until(() => got.filter((e) => e.type === 'status' && e.text === 'idle').length === 3, 'idle after the doorbell');
      const rung = [];
      const r = await require('../src/notify/chat.ts').ringSdk(7, 120_000, async (url, body) => {
        rung.push([url, body]);
        return { ok: true, reason: 'idle, nothing waiting' };
      });
      assert.deepStrictEqual(r, { nudged: true, reason: 'idle, nothing waiting' });
      assert.match(rung[0][0], /^http:\/\/[^/]+\/api\/chat\/doorbell$/);
      assert.deepStrictEqual(rung[0][1], { id: 7, minIdleMs: 120_000 }, 'only the id travels, never content');

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
      const policy = fakePolicy({ board: { decision: 'allow', rule: 'chat-reads' }, Read: { decision: 'allow', rule: 'chat-builtin-reads-allow' } });
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
      assert.strictEqual(rd.hookSpecificOutput.permissionDecision, 'allow', 'a read in pa-home: the policy\'s allow');
      assert.strictEqual(policy.calls.authorize.at(-1).opts.audit, true, 'a built-in tool call is audited here');
      const ro = await hook({ tool_name: 'Read', tool_input: { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') }, tool_use_id: 'tuR2' });
      assert.deepStrictEqual(ro, { continue: true }, 'a read outside pa-home is not the policy\'s allow: Claude Code asks');
      const bh = await hook({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tuB' });
      assert.deepStrictEqual(bh, { continue: true }, 'no rule: Claude Code\'s own settings decide');

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
      assert.strictEqual(s.url, `http://127.0.0.1:7000/#session=${s.sessionId}`, 'the session links to its Run view');

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

      // Passkeys on (PA_PASSKEYS=on): a merge approval without a tap is a 403 that says so, the prompt
      // keeps waiting; after the tap, enforce passes and the one-use grant is spent before the release.
      {
        const prev = process.env.PA_PASSKEYS;
        process.env.PA_PASSKEYS = 'on';
        let tapped = false;
        const consumed = [];
        const enforceBefore = policy.enforce;
        policy.enforce = async (req) => {
          policy.calls.enforce.push(req);
          if (req.action === 'approve' && req.args?.delivery === 'auto_merge' && !tapped) {
            throw Object.assign(new Error('needs a passkey: merges automatically'), { code: 'STEPUP_REQUIRED', status: 403, needsStepUp: true, approvalId: req.subject });
          }
          return { decision: 'allow', rule: 'test', tags: req.args?.delivery === 'auto_merge' ? ['merge'] : [] };
        };
        policy.consumeStepUp = async (req, verdict) => {
          consumed.push([req.subject, verdict.tags]);
          return true;
        };
        const ps = run.options.canUseTool('mcp__pa-chat__factory_start', { card: '9', delivery: 'auto_merge' }, { signal: ac.signal, toolUseID: 'tuS' });
        await tick();
        await assert.rejects(feed.answerPermission({ answer: 'yes', toolUseId: 'tuS', via: 'dashboard' }), (e) => e.status === 403 && e.needsStepUp === true && e.approvalId === 'tuS' && /passkey/.test(e.message));
        assert.strictEqual((await feed.session()).permission.toolUseId, 'tuS', 'still waiting for the tap');
        assert.deepStrictEqual(consumed, [], 'nothing spent on a refusal');
        tapped = true;
        await feed.answerPermission({ answer: 'yes', toolUseId: 'tuS', via: 'dashboard' });
        assert.strictEqual((await ps).behavior, 'allow');
        assert.deepStrictEqual(consumed, [['tuS', ['merge']]], 'the grant is spent on this one approval');
        delete policy.consumeStepUp;
        policy.enforce = enforceBefore;
        if (prev === undefined) delete process.env.PA_PASSKEYS;
        else process.env.PA_PASSKEYS = prev;
      }

      // Two prompts at once (parallel calls): one card at a time, the next offered when the first is answered.
      const p4 = run.options.canUseTool('mcp__pa-chat__factory_resume', { job: 'a:1' }, { signal: ac.signal, toolUseID: 'tu4' });
      const p5 = run.options.canUseTool('mcp__pa-chat__factory_resume', { job: 'a:2' }, { signal: ac.signal, toolUseID: 'tu5' });
      await tick();
      assert.strictEqual((await feed.session()).permission.toolUseId, 'tu4');
      await feed.answerPermission({ answer: 'no', toolUseId: 'tu4' });
      assert.ok(got.some((e) => e.type === 'permission' && e.toolUseId === 'tu5' && !e.cleared), 'the second is offered next');
      await feed.answerPermission({ answer: 'yes', toolUseId: 'tu5' });
      assert.deepStrictEqual([(await p4).behavior, (await p5).behavior], ['deny', 'allow']);

      // Any other prompt gets the generic card: the whole input shown, allow once, through the policy.
      const bashInput = { command: 'node pa.js remember "the renewal is in May"', description: 'remember it' };
      const bashP = run.options.canUseTool('Bash', bashInput, { signal: ac.signal, toolUseID: 'tu6' });
      await tick();
      const gen = (await feed.session()).permission;
      assert.deepStrictEqual([gen.toolUseId, gen.generic, gen.approvable, gen.voice], ['tu6', true, true, true]);
      assert.strictEqual(gen.detail, bashInput.command, 'the card shows the exact command, not the model\'s description');
      assert.strictEqual(gen.ask, `Claude wants to run a command: remember it — ${bashInput.command}. Allow once?`);
      await feed.answerPermission({ answer: 'yes', toolUseId: 'tu6', via: 'voice' });
      assert.deepStrictEqual(await bashP, { behavior: 'allow', updatedInput: bashInput }, 'once: no updatedPermissions');
      assert.deepStrictEqual([policy.calls.enforce.at(-1).tool, policy.calls.enforce.at(-1).action, policy.calls.enforce.at(-1).channel], ['Bash', 'approve', 'voice']);

      // An edit is never answered by voice: 403 there, the dashboard answers it.
      const editInput = { file_path: path.join(dir, 'x.md'), old_string: 'a', new_string: 'b' };
      const editP = run.options.canUseTool('Edit', editInput, { signal: ac.signal, toolUseID: 'tu6e', title: 'Claude wants to edit x.md' });
      await tick();
      const ed = (await feed.session()).permission;
      assert.strictEqual(ed.voice, false);
      assert.strictEqual(ed.ask, 'Claude wants to edit x.md. Allow once?');
      assert.match(ed.detail, /- a\n\+ b$/);
      assert.ok(got.some((e) => e.type === 'permission' && e.toolUseId === 'tu6e' && e.generic), 'offered on the stream too');
      await assert.rejects(feed.answerPermission({ answer: 'yes', toolUseId: 'tu6e', via: 'voice' }), (e) => e.status === 403);
      await feed.answerPermission({ answer: 'no', toolUseId: 'tu6e', via: 'dashboard' });
      assert.strictEqual((await editP).behavior, 'deny');
      // Another MCP tool that asks (remember): generic, its bare name to the policy.
      const remP = run.options.canUseTool('mcp__personal-assistant__remember', { text: 'x' }, { signal: ac.signal, toolUseID: 'tu6r' });
      await tick();
      await feed.answerPermission({ answer: 'yes', toolUseId: 'tu6r' });
      assert.strictEqual((await remP).behavior, 'allow');
      assert.strictEqual(policy.calls.enforce.at(-1).tool, 'remember');
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
      assert.deepStrictEqual([opened.engine, opened.conversationId, opened.created, opened.sessionId, opened.url], ['sdk', 'sess-old', true, 'view-1', 'http://127.0.0.1:7000/#session=view-1']);
      assert.strictEqual(sdk.runs[0].options.resume, 'sess-old');
      assert.strictEqual((await feed.open()).created, false, 'one session');
      feed.stop();
      await until(() => sdk.runs[0].closed, 'closed');
    }

    // ------------------------------------------------- the Run view (gap 3) --
    {
      const d = fs.mkdtempSync(path.join(dir, 'v-'));
      const hub = fakeHub();
      const sdk = fakeSdk();
      const feed = makeFeed({ dir: d, sdk, policy: fakePolicy(), hub });
      await feed.send({ text: 'hello', source: 'typed' });
      const run = sdk.runs[0];
      await run.next();
      run.emit(sdkMsg.init('sess-v'));
      run.emit(sdkMsg.stream({ type: 'message_start', message: { id: 'mv' } }));
      run.emit(sdkMsg.stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      run.emit(sdkMsg.stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi\x1b[2J there.' } }));
      run.emit(sdkMsg.assistant('mv', [{ type: 'text', text: 'Hi\x1b[2J there.' }], 'end_turn'));
      run.emit(sdkMsg.result());
      await until(() => hub.created.length === 1, 'view created');
      const viewDir = path.join(d, 'pa-home', 'sdk-view');
      assert.strictEqual(path.resolve(hub.created[0].cwd), path.resolve(viewDir), 'its own folder, never pa-home (the terminal engine finds its chat by cwd)');
      assert.match(hub.created[0].command, /--follow ".*chat\.jsonl"$/);
      const s = await feed.session();
      assert.deepStrictEqual([s.sessionId, s.url], ['view-1', 'http://127.0.0.1:7000/#session=view-1']);
      await until(() => /"idle"/.test(fs.readFileSync(path.join(viewDir, 'chat.jsonl'), 'utf8')), 'idle logged');
      const logged = fs.readFileSync(path.join(viewDir, 'chat.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepStrictEqual(logged.map((e) => e.type), ['user', 'assistant', 'status'], 'kept events and idle; never the partials');
      const V = require('../src/chat/sdkView.ts');
      const shown = V.renderChunk('', fs.readFileSync(path.join(viewDir, 'chat.jsonl'), 'utf8'), { color: false }).out.join('\n');
      assert.match(shown, /you\nhello/);
      assert.match(shown, /Jarvis\nHi\[2J there\./, 'escape sequences from the model never reach the terminal');
      assert.ok(!shown.includes('\x1b'));
      assert.match(shown, /─ idle/);
      // A worker restart finds the live view instead of opening a second one.
      feed.stop();
      const again = makeFeed({ dir: d, sdk: fakeSdk(), policy: fakePolicy(), hub });
      const o = await again.open();
      assert.strictEqual(o.sessionId, 'view-1');
      assert.strictEqual(hub.created.length, 1);
      again.stop();
      // termhub down: no url, and the chat still works.
      const down = { listSessions: async () => { throw new Error('ECONNREFUSED'); } };
      const sdk2 = fakeSdk();
      const f2 = makeFeed({ dir: fs.mkdtempSync(path.join(dir, 'v2-')), sdk: sdk2, policy: fakePolicy(), hub: down });
      await f2.send({ text: 'hi' });
      assert.ok(sdk2.runs[0]);
      assert.strictEqual((await f2.session()).url, null);
      f2.stop();
      // The renderer: permission lines with the detail, answers, and partials skipped.
      const r = (e) => V.renderEvent({ at: '2026-11-08T10:00:00Z', ...e }, { color: false });
      assert.match(r({ type: 'permission', ask: 'Claude wants to run a command. Allow once?', detail: 'ls -la' }), /\? waiting for your yes: Claude wants to run a command\. Allow once\?\n {5}ls -la$/);
      assert.match(r({ type: 'permission', cleared: true, answered: 'yes' }), /✓ approved/);
      assert.strictEqual(r({ type: 'assistant', text: 'x', partial: true }), null);
      assert.match(r({ type: 'user', text: 'PA inbox: notification 3 is waiting. Read INBOX.md.' }), /you \(doorbell\)/);
      assert.strictEqual(V.renderChunk('', '{"type":"user","text":"a"}\n{"type":"us', { color: false }).rest, '{"type":"us', 'a line still being written waits');
    }

    // ------------------------------------------------- a Z1 roll (drain) --
    {
      const d = fs.mkdtempSync(path.join(dir, 'z-'));
      const sdkA = fakeSdk();
      const genA = makeFeed({ dir: d, sdk: sdkA, policy: fakePolicy() });
      const gotA = [];
      genA.subscribe((e) => gotA.push(e));
      await genA.send({ text: 'start job for card 5' });
      const runA = sdkA.runs[0];
      await runA.next();
      runA.emit(sdkMsg.init('sess-A'));
      const pending = runA.options.canUseTool('mcp__pa-chat__factory_start', { card: '5' }, { signal: new AbortController().signal, toolUseID: 'tuZ' });
      await tick();
      // Routing moves to generation B; A drains while its turn is still running.
      const drained = genA.drain({ waitMs: 1000 });
      const res = await pending;
      assert.strictEqual(res.behavior, 'deny', 'a prompt nobody can answer here any more is not left hanging');
      assert.match(res.message, /restarting/);
      assert.ok(gotA.some((e) => e.type === 'activity' && /^not done, the PA is restarting/.test(e.text)));
      assert.ok(!runA.closed, 'the turn in flight gets its time to finish');
      runA.emit(sdkMsg.assistant('msg_z', [{ type: 'text', text: 'Not started; ask me again.' }], 'end_turn'));
      runA.emit(sdkMsg.result());
      assert.deepStrictEqual(await drained, { sessionId: 'sess-A', closed: true });
      assert.ok(runA.closed, 'then the query is closed');
      await assert.rejects(genA.send({ text: 'late' }), (e) => e.status === 503, 'a draining generation starts nothing');
      assert.strictEqual(genA.doorbell(1, { minIdleMs: 0 }).ok, false);

      // Generation B resumes the same conversation by its id.
      const sdkB = fakeSdk();
      const genB = makeFeed({ dir: d, sdk: sdkB, policy: fakePolicy() });
      await genB.send({ text: 'start job for card 5' });
      assert.strictEqual(sdkB.runs[0].options.resume, 'sess-A');
      genB.stop();

      // A rollback (undrain): A takes messages again and resumes too.
      genA.undrain();
      await genA.send({ text: 'back on A' });
      assert.strictEqual(sdkA.runs[1].options.resume, 'sess-A');
      genA.stop();

      // A drain with a turn that never ends still closes, after waitMs.
      const sdkC = fakeSdk();
      const genC = makeFeed({ dir: fs.mkdtempSync(path.join(dir, 'zc-')), sdk: sdkC, policy: fakePolicy() });
      await genC.send({ text: 'long one' });
      const t0 = Date.now();
      assert.strictEqual((await genC.drain({ waitMs: 50 })).closed, true);
      assert.ok(Date.now() - t0 < 2000);
      assert.ok(sdkC.runs[0].closed);
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
        executable: () => 'C:\\pa\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe',
        hub: () => null,
      });
      await assert.rejects(feed.send({ text: 'hi' }), (e) => e.status === 503 && /module not installed/.test(e.message));
      fail = false;
      await feed.send({ text: 'hi' });
      assert.strictEqual(sdk.runs[0].options.model, 'claude-opus-5', 'PA_CHAT_MODEL is passed through');
      assert.strictEqual(sdk.runs[0].options.pathToClaudeCodeExecutable, 'C:\\pa\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe', 'the binary found on disk is passed: the compiled jarvisd cannot resolve it');
      feed.stop();
    }

    // claudeExecutable: the SDK's platform package on disk first (the compiled
    // jarvisd's own module URL is virtual), then the installed claude, else null.
    {
      const pkg = path.join('/pa', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
      const have = (set) => (p) => set.includes(p);
      assert.strictEqual(S.claudeExecutable({ platform: 'win32', arch: 'x64', dirs: ['', '/nowhere', '/pa'], installed: () => 'claude', exists: have([pkg]) }), pkg);
      const home = path.resolve('/home/k/.local/bin/claude');
      assert.strictEqual(S.claudeExecutable({ platform: 'linux', arch: 'x64', dirs: ['/pa'], installed: () => home, exists: have([home]) }), home, 'falls back to the installed claude');
      assert.strictEqual(S.claudeExecutable({ platform: 'linux', arch: 'x64', dirs: ['/pa'], installed: () => 'claude', exists: () => false }), null, 'nothing found: the SDK resolves its own');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('chatSdk ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
