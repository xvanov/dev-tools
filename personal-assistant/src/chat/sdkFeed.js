'use strict';

// The PA chat on the Claude Agent SDK (plan 4.2; PA_CHAT_ENGINE=sdk). The same
// conversation contract as feed.js — send, history, subscribe, session,
// answerPermission — that the dashboard's chat box, Ask (/talk) and the
// "Waiting for your yes" card already speak, without a terminal in between:
//
//   in    a streamed SDKUserMessage into one long-lived query(), started in
//         pa-home with the same CLAUDE.md, settings, SessionStart hook and
//         pa-chat MCP server as the terminal chat (src/chat/index.js), and
//         resumed by its session id after a worker restart.
//   out   the SDK's messages: text streams as `partial` assistant events (the
//         text so far, under the id the final event will carry), tool calls as
//         the same activity lines the transcript gave (transcript.js).
//   ask   a typed callback instead of a screen read. Every tool call passes the
//         policy engine first (PreToolUse hook, src/policy); a call that must
//         ask reaches canUseTool, which waits for Approve/Deny from the card or
//         a spoken yes on Talk (POST /api/chat/permission), or times out to a
//         deny. Only the chat's own action tools (permission.js chatAction) can
//         be approved from a page, as before; any other prompt is refused at
//         once, because nothing here can show what it would approve and there is
//         no terminal to answer it in.
//
// Billing: the SDK runs the bundled Claude Code on the machine's own Claude
// login, like the terminal chat. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are
// removed from its environment so it never silently bills the API instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const T = require('./transcript');
const P = require('./permission');
const { logger } = require('../log.ts');

const log = logger('chat-sdk');

const SDK_MODULE = '@anthropic-ai/claude-agent-sdk';
const MAX_EVENTS = 500;
const MAX_TEXT = 8000;
const SEED_BYTES = 4 * 1024 * 1024;
const SOURCES = ['typed', 'voice'];
const ANSWERS = ['yes', 'no'];
const SESSION_FILE = '.pa-chat-sdk-session.json';
const VIEW_MAX_BYTES = 8 * 1024 * 1024;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Pure. The environment the SDK's Claude Code runs with: the worker's, minus
 * API credentials (so it signs in with the machine's Claude login, i.e. the
 * subscription), marked as the PA chat the way termhub's session is.
 */
function subscriptionEnv(base = process.env) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.PA_CHAT_SESSION = '1';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'personal-assistant/pa-chat';
  return env;
}

/** Pure. `mcp__pa-chat__factory_start` → {server: 'pa-chat', tool: 'factory_start'}; `Read` → {server: null, tool: 'Read'}. */
function splitTool(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  return m ? { server: m[1], tool: m[2] } : { server: null, tool: String(name || '') };
}

/**
 * Pure. The PreToolUse hook's answer from the policy's: a deny refuses; the
 * chat's action tools always ask (no rule or settings file can make one run
 * unasked); an explicit rule's allow/ask stands; no rule (or no policy) leaves
 * it to Claude Code's own permission settings.
 * @returns {{decision: 'allow'|'deny'|'ask', reason: string} | null}  null: no opinion
 */
function hookDecision(toolName, res) {
  if (res && res.decision === 'deny') return { decision: 'deny', reason: `denied by policy (${res.rule})${res.reason ? `: ${res.reason}` : ''}` };
  if (P.chatAction(toolName)) return { decision: 'ask', reason: 'the chat\'s actions always ask the user' };
  if (res && res.rule && res.rule !== 'default' && (res.decision === 'allow' || res.decision === 'ask')) return { decision: res.decision, reason: `policy rule ${res.rule}` };
  return null;
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const DETAIL_MAX = 2000;
const VOICE_MAX = 160;

/** Pure. Whether a Read/Grep/Glob call stays inside `home` (no path: its cwd, home). */
function insideHome(home, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const target = i.file_path || i.path || '';
  if (!target) return true;
  const abs = path.resolve(home, String(target)).toLowerCase();
  const root = path.resolve(home).toLowerCase();
  return abs === root || abs.startsWith(root + path.sep);
}

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}… (${t.length - n} more characters)` : t;
};

/**
 * Pure. Everything a generic prompt approves, for the card: the command, the
 * file and its change, or the tool's whole input. Never shortened silently:
 * a cut says how much is left out.
 */
function genericDetail(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Bash':
    case 'PowerShell': return clip(i.command, DETAIL_MAX);
    case 'Edit': return clip(`${i.file_path}\n- ${i.old_string ?? ''}\n+ ${i.new_string ?? ''}`, DETAIL_MAX);
    case 'Write': return clip(`${i.file_path}\n${i.content ?? ''}`, DETAIL_MAX);
    default: return clip(JSON.stringify(i, null, 1), DETAIL_MAX);
  }
}

/** Pure. The card's headline and Talk's question for a generic prompt. */
function genericAsk(name, input = {}, title = null) {
  const i = input && typeof input === 'object' ? input : {};
  const { server, tool } = splitTool(name);
  let what;
  if (title) what = String(title).replace(/[.?!\s]+$/, '');
  else if (name === 'Bash' || name === 'PowerShell') what = `Claude wants to run a command${i.description ? `: ${String(i.description).trim()}` : ''}`;
  else if (name === 'Edit' || name === 'Write') what = `Claude wants to change ${path.basename(String(i.file_path || 'a file'))}`;
  else what = `Claude wants to use ${tool.replace(/_/g, ' ')}${server ? ` (${server})` : ''}`;
  return `${what.replace(/\s+/g, ' ').trim()}. Allow once?`;
}

/**
 * Pure. Whether a generic prompt may be answered by voice: only when what it
 * approves can be heard whole (a short command or input), never an edit.
 */
function genericVoiceOk(name, input = {}) {
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return false;
  const d = genericSpoken(name, input);
  return d.length <= VOICE_MAX && !d.includes('\n');
}

/** Pure. The exact input in one line, for a spoken question: the command, or compact JSON. */
function genericSpoken(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  return name === 'Bash' || name === 'PowerShell' ? String(i.command ?? '') : JSON.stringify(i);
}

/** `p`, or null once `ms` have passed (a slow termhub must not hold a page's request). */
function withTimeout(p, ms) {
  let t;
  return Promise.race([Promise.resolve(p), new Promise((r) => (t = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(t));
}

/** An async iterable the SDK reads user messages from; push() to send, close() to end. */
function createInputQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(m) {
      items.push(m);
      if (wake) wake();
    },
    close() {
      closed = true;
      if (wake) wake();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

// The chat's home as the terminal chat has it, read back the same way.
function defaultPrepare() {
  const chat = require('./index');
  const home = chat.ensureHome();
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(home, '.claude', f), 'utf8')); } catch { return null; } };
  // permissionMode 'default' is passed below; verifyClaudeHome checks the rest.
  const problems = chat.verifyClaudeHome({ settings: read('settings.json'), local: read('settings.local.json'), command: '--permission-mode default' });
  if (problems.length) throw new Error(`Claude chat refused: ${problems.join('; ')}`);
  return { home, mcpServers: chat.mcpJson().mcpServers };
}

/**
 * Everything external is injectable, for tests: `loadSdk()` the SDK module,
 * `prepare()` the home and MCP servers, `policy()` src/policy, `root()` Claude
 * Code's projects directory (where a resumed session's history is read from),
 * `stateDir()` where the session id is kept.
 */
function createSdkFeed({
  loadSdk = () => import(SDK_MODULE),
  prepare = defaultPrepare,
  policy = () => require('../policy'),
  root = () => path.join(os.homedir(), '.claude', 'projects'),
  stateDir = () => require('./index').homeDir(),
  model = () => require('../config.ts').config.chat.model,
  approvalTimeoutMs = () => require('../config.ts').config.chat.approvalTimeoutMs,
  jobLookup = null,
  env = () => subscriptionEnv(),
  hub = () => require('../dispatch/termhub'),
  viewCommand = (file) => {
    const js = path.join(require('../config.ts').config.toolDir, 'src', 'chat', 'sdkView.js').replace(/\\/g, '/');
    return `node "${js}" --follow "${file.replace(/\\/g, '/')}"`;
  },
} = {}) {
  const events = [];
  const seen = new Set();
  const subs = new Set();
  const approvals = new Map(); // toolUseId -> pending approval, oldest first
  let status = 'offline';
  let idleSince = 0;
  let draining = false;
  let q = null;
  let input = null;
  let starting = null;
  let sessionId = readSessionId();
  let seeded = false;
  let seeding = false;
  let home = null;
  // Streaming state: the API message being streamed, and text blocks of the
  // current message whose `final` is not known yet.
  const textCount = new Map(); // message id -> text blocks seen (for ids)
  const streamIds = new Map(); // `${message id}#${block index}` -> event id
  const streamText = new Map(); // event id -> text so far
  let streamMsg = null;
  let held = [];

  function readSessionId() {
    try {
      return JSON.parse(fs.readFileSync(path.join(stateDir(), SESSION_FILE), 'utf8')).sessionId || null;
    } catch {
      return null;
    }
  }

  function saveSessionId(id) {
    try {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(path.join(stateDir(), SESSION_FILE), JSON.stringify({ sessionId: id }), 'utf8');
    } catch (err) {
      log.warn('could not save the chat session id', { message: err.message });
    }
  }

  // ------------------------------------------------------------ the Run view --
  // Every kept event goes to pa-home/sdk-view/chat.jsonl, which a read-only
  // termhub session renders (src/chat/sdkView.js): the SDK engine's answer to
  // the terminal chat's termhub tab, and what session().url points at. The
  // view's cwd is its own folder, never pa-home: the terminal engine finds its
  // chat by cwd and must not mistake the view for it.
  const viewDir = () => path.join(stateDir(), 'sdk-view');
  const viewFile = () => path.join(viewDir(), 'chat.jsonl');
  let view = null; // {id, url}
  let viewChecked = 0;
  let viewing = null;

  function logView(e) {
    try {
      fs.mkdirSync(viewDir(), { recursive: true });
      fs.appendFileSync(viewFile(), `${JSON.stringify(e)}\n`, 'utf8');
    } catch {
      /* the view is a convenience */
    }
  }

  function rotateView() {
    try {
      if (fs.statSync(viewFile()).size > VIEW_MAX_BYTES) fs.renameSync(viewFile(), path.join(viewDir(), 'chat.old.jsonl'));
    } catch {
      /* none yet */
    }
  }

  async function findOrStartView() {
    const h = hub();
    if (!h) return null;
    const dir = viewDir();
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(viewFile())) fs.writeFileSync(viewFile(), '', 'utf8');
    const same = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
    const live = (await h.listSessions()).find((s) => s.alive !== false && same(s.cwd, dir));
    const id = live ? live.id : (await h.createSession({ cwd: dir, command: viewCommand(viewFile()), title: 'PA chat (SDK)' })).id;
    const url = await h.sessionUrl(id).catch(() => null);
    return { id, url };
  }

  // The view, found or started; checked at most every 30 s, never throws.
  async function ensureView({ force = false } = {}) {
    if (!force && Date.now() - viewChecked < 30_000) return view;
    if (!viewing) {
      viewing = findOrStartView()
        .then((v) => (view = v))
        .catch((err) => {
          log.debug('no Run view for the SDK chat', { message: err.message });
          view = null;
          return null;
        })
        .finally(() => {
          viewChecked = Date.now();
          viewing = null;
        });
    }
    return viewing;
  }

  function publish(e, { keep = true } = {}) {
    if (keep && e.type !== 'status') {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      events.push(e);
      while (events.length > MAX_EVENTS) seen.delete(events.shift().id);
      if (!seeding) logView(e);
    } else if (e.type === 'status' && (e.text === 'idle' || e.text === 'offline')) logView(e);
    for (const fn of subs) {
      try {
        fn(e);
      } catch (err) {
        log.debug('subscriber failed', { message: err.message });
      }
    }
  }

  const now = () => new Date().toISOString();

  function setStatus(next) {
    if (next === status) return;
    status = next;
    if (next === 'idle') idleSince = Date.now();
    publish({ id: `status-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, type: 'status', text: next, at: now() });
  }

  // A resumed session's earlier turns, from the transcript Claude Code writes
  // for it (the same file format the terminal chat's feed tails).
  function seedHistory() {
    if (seeded || !sessionId) return;
    seeded = true;
    const dir = home || stateDir();
    const file = path.join(root(), T.projectDirFor(dir), `${sessionId}.jsonl`);
    let text;
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      try {
        const start = Math.max(0, st.size - SEED_BYTES);
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
        if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    // Seeded history is already in the view's file (written when it happened).
    seeding = true;
    try {
      for (const entry of T.parseLines('', `${text}\n`).entries) {
        for (const e of T.entryEvents(entry)) if (e.type === 'user' || e.type === 'assistant') publish(e, { keep: true });
      }
    } finally {
      seeding = false;
    }
  }

  // ------------------------------------------------------------ approvals --

  function pendingView(p) {
    const v = { toolUseId: p.toolUseId, text: p.text, approvable: true, ask: p.ask || null };
    if (p.generic) Object.assign(v, { generic: true, detail: p.detail, voice: p.voice });
    return v;
  }

  function permissionPending() {
    const p = approvals.values().next().value;
    return p ? pendingView(p) : null;
  }

  function offerNext() {
    const p = approvals.values().next().value;
    if (p) publish({ id: `perm-${p.toolUseId}-${Date.now()}`, type: 'permission', ...pendingView(p), at: now() });
    else publish({ id: `perm-clear-${Date.now()}`, type: 'permission', cleared: true, at: now() });
  }

  async function audit(p, action, channel) {
    try {
      await policy().authorize({ tool: splitTool(p.name).tool, action, channel, actor: 'pa-chat', subject: p.toolUseId, args: p.input });
    } catch (err) {
      log.warn('could not audit a chat approval', { message: err.message });
    }
  }

  function settle(p, result, { answered = null } = {}) {
    if (!approvals.has(p.toolUseId)) return;
    approvals.delete(p.toolUseId);
    clearTimeout(p.timer);
    p.resolve(result);
    if (answered) publish({ id: `perm-answered-${Date.now()}`, type: 'permission', cleared: true, answered, at: now() });
    offerNext();
  }

  // canUseTool: Claude Code's permission prompt, as a callback.
  function canUseTool(toolName, toolInput, opts = {}) {
    const toolUseId = String(opts.toolUseID || '');
    if (!toolUseId) return Promise.resolve({ behavior: 'deny', message: 'a permission request without a tool_use id cannot be answered' });
    // The chat's own actions keep their spoken question; anything else (a shell
    // command, an edit, another MCP tool) gets the generic card, which shows
    // the call's whole input so the yes is to exactly what runs.
    const generic = !P.chatAction(toolName);
    let voice = true;
    if (generic) {
      voice = genericVoiceOk(toolName, toolInput);
      try {
        if (voice && policy().evaluate({ tool: splitTool(toolName).tool, action: 'approve', channel: 'voice', args: toolInput || {} }).decision === 'deny') voice = false;
      } catch {
        voice = false;
      }
    }
    return new Promise((resolve) => {
      const p = {
        toolUseId,
        name: toolName,
        input: toolInput || {},
        text: T.describeTool(toolName, toolInput),
        // Heard by voice, the question carries the exact input (a description is the model's words).
        ask: generic ? genericAsk(toolName, toolInput, opts.title).replace(/\. Allow once\?$/, voice ? ` — ${genericSpoken(toolName, toolInput)}. Allow once?` : '. Allow once?') : T.askTool(toolName, toolInput),
        generic,
        detail: generic ? genericDetail(toolName, toolInput) : null,
        voice,
        resolve,
        timer: null,
      };
      const ms = Number(approvalTimeoutMs()) || 300_000;
      p.timer = setTimeout(() => {
        log.info('a chat approval timed out', { tool: toolName, ms });
        audit(p, 'deny', 'timeout');
        publish({ id: `perm-timeout-${toolUseId}`, type: 'activity', text: `no answer in ${Math.round(ms / 60000) || 1} min, not done: ${p.text.replace(/…$/, '')}`, at: now() });
        settle(p, { behavior: 'deny', message: `The user did not answer within ${Math.round(ms / 1000)} s, so this was not done. Do not retry it unasked; say it is waiting for a fresh ask.` });
      }, ms);
      if (opts.signal) {
        if (opts.signal.aborted) return settle(p, { behavior: 'deny', message: 'cancelled' });
        opts.signal.addEventListener('abort', () => settle(p, { behavior: 'deny', message: 'cancelled' }), { once: true });
      }
      const first = approvals.size === 0;
      approvals.set(toolUseId, p);
      if (first) {
        publish({ id: `perm-${toolUseId}-${Date.now()}`, type: 'permission', ...pendingView(p), at: now() });
        publish({ id: `wait-${toolUseId}`, type: 'activity', text: `waiting for your yes: ${p.text.replace(/…$/, '')}`, at: now() });
      }
    });
  }

  // PreToolUse: every call, whatever the settings files allow, meets the policy.
  async function preToolUse(hookInput) {
    const name = hookInput?.tool_name;
    const { server, tool } = splitTool(name);
    let res = null;
    try {
      // An MCP call is audited by the MCP server itself (src/mcp/server.js); a built-in one here.
      res = await policy().authorize({ tool, action: 'call', channel: 'chat', actor: 'pa-chat', args: hookInput?.tool_input || {} }, { audit: !server });
    } catch (err) {
      log.warn('policy unavailable for a chat tool call; Claude Code\'s settings decide', { message: err.message, tool: name });
    }
    let d = hookDecision(name, res);
    // A policy allow for a built-in read holds inside pa-home only (rules cannot match paths).
    if (d && d.decision === 'allow' && READ_TOOLS.includes(name) && !insideHome(home || stateDir(), hookInput?.tool_input)) d = null;
    if (!d) return { continue: true };
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } };
  }

  /**
   * Answers the approval the chat is waiting on: Approve allows that one call
   * (never "don't ask again"), Deny refuses it. Refused (409) when the id is not
   * the one waiting; 403 when the policy bars the channel (voice and a merge…).
   */
  async function answerPermission({ answer, toolUseId, via = 'dashboard' } = {}) {
    if (!ANSWERS.includes(answer)) throw httpError(409, 'answer must be yes or no');
    if (!approvals.size) throw httpError(409, 'the PA chat is not waiting on a permission prompt');
    const p = approvals.get(String(toolUseId || ''));
    if (!p) throw httpError(409, 'that prompt is no longer the one waiting — reload');
    if (via === 'voice' && p.voice === false) throw httpError(403, 'this one cannot be answered by voice — answer it on the dashboard');
    const tool = P.chatAction(p.name) || splitTool(p.name).tool;
    try {
      const pol = policy();
      let req = { tool, action: answer === 'yes' ? 'approve' : 'deny', channel: via, actor: 'pa-chat', subject: p.toolUseId, args: p.input };
      if (typeof pol.withJobDelivery === 'function') req = await pol.withJobDelivery(req, jobLookup);
      const verdict = await pol.enforce(req);
      // A passkey tap (7.1) is spent on this one approval, before it is released.
      if (typeof pol.consumeStepUp === 'function') await pol.consumeStepUp(req, verdict);
    } catch (err) {
      if (err.code === 'POLICY_DENIED' || err.code === 'STEPUP_REQUIRED') throw Object.assign(httpError(403, err.message), err.needsStepUp ? { needsStepUp: true, approvalId: err.approvalId } : {});
      throw err;
    }
    log.info('answered a chat approval', { tool, answer, via });
    settle(
      p,
      answer === 'yes'
        ? { behavior: 'allow', updatedInput: p.input }
        : { behavior: 'deny', message: 'The user said no to this action. Do not retry it; ask what they want instead.' },
      { answered: answer },
    );
    return { ok: true, answer, tool };
  }

  // ------------------------------------------------------------- the stream --

  function textId(msgId) {
    const n = (textCount.get(msgId) || 0) + 1;
    textCount.set(msgId, n);
    if (textCount.size > 200) textCount.delete(textCount.keys().next().value);
    return `${msgId}:t${n}`;
  }

  function flushHeld(final) {
    for (const e of held) publish(final === undefined ? e : { ...e, final });
    held = [];
  }

  function onStreamEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'message_start') {
      streamMsg = { id: ev.message?.id || `m-${crypto.randomUUID()}`, texts: 0 };
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'text' && streamMsg) {
      streamMsg.texts += 1;
      const id = `${streamMsg.id}:t${streamMsg.texts}`;
      streamIds.set(`${streamMsg.id}#${ev.index}`, id);
      streamText.set(id, ev.content_block.text || '');
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && streamMsg) {
      const id = streamIds.get(`${streamMsg.id}#${ev.index}`);
      if (!id) return;
      const text = (streamText.get(id) || '') + (ev.delta.text || '');
      streamText.set(id, text);
      // The text so far, not the delta: Ask's utterance stream and the chat
      // box both take a cumulative partial. Not kept: the final event is.
      if (text.trim()) publish({ id, type: 'assistant', text, partial: true, at: now() }, { keep: false });
    } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
      flushHeld(ev.delta.stop_reason !== 'tool_use');
    } else if (ev.type === 'message_stop' && streamMsg) {
      for (const [k, id] of [...streamIds]) {
        if (!k.startsWith(`${streamMsg.id}#`)) continue;
        streamIds.delete(k);
        streamText.delete(id);
      }
    }
  }

  function onAssistant(m) {
    const msg = m.message || {};
    const msgId = msg.id || m.uuid;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    blocks.forEach((b, k) => {
      if (!b) return;
      if (b.type === 'text') {
        // Counted even when empty: the streamed blocks are numbered the same way.
        const id = textId(msgId);
        if (String(b.text || '').trim()) held.push({ id, type: 'assistant', text: String(b.text).trim(), at: now() });
      } else if (b.type === 'tool_use') {
        flushHeld(false); // text before a tool call is a step, not the answer
        const e = { id: `${m.uuid || msgId}:${k}`, type: 'activity', text: T.describeTool(b.name, b.input), at: now(), tool: String(b.name || ''), toolUseId: String(b.id || '') };
        const ask = T.askTool(b.name, b.input);
        if (ask) e.ask = ask;
        publish(e);
      }
    });
    if (msg.stop_reason) flushHeld(msg.stop_reason !== 'tool_use');
  }

  function onResult(m) {
    flushHeld(true);
    if (m.subtype !== 'success' || m.is_error) {
      const why = [m.subtype, ...(Array.isArray(m.errors) ? m.errors : [])].filter(Boolean).join(': ');
      publish({ id: `err-${m.uuid || Date.now()}`, type: 'activity', text: `the chat stopped: ${why || 'error'}`, at: now() });
    }
    log.info('chat turn done', { subtype: m.subtype, turns: m.num_turns, ms: m.duration_ms, costEquivalentUsd: m.total_cost_usd });
    setStatus('idle');
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    // A subagent's own traffic is not the chat speaking.
    if (m.parent_tool_use_id) return;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          if (m.session_id && m.session_id !== sessionId) {
            sessionId = m.session_id;
            saveSessionId(sessionId);
          }
          if (m.apiKeySource && !['none', 'oauth', '/login managed key'].includes(m.apiKeySource)) log.warn('the SDK chat is not on the Claude login', { apiKeySource: m.apiKeySource });
          log.info('SDK chat session ready', { session: m.session_id, model: m.model, apiKeySource: m.apiKeySource, permissionMode: m.permissionMode });
        }
        return;
      case 'stream_event': return onStreamEvent(m.event);
      case 'assistant': return onAssistant(m);
      case 'result': return onResult(m);
      default: // user (tool results, replays) and bookkeeping
    }
  }

  async function start() {
    const prepared = prepare();
    home = prepared.home;
    const sdk = await loadSdk();
    const queryFn = sdk.query || sdk.default?.query;
    if (typeof queryFn !== 'function') throw new Error(`${SDK_MODULE} has no query()`);
    const resume = sessionId;
    seedHistory();
    rotateView();
    ensureView({ force: true }); // not awaited: termhub being down never blocks the chat
    input = createInputQueue();
    const m = model();
    const options = {
      cwd: home,
      // Manual approvals through canUseTool, whatever a settings file says.
      permissionMode: 'default',
      settingSources: ['user', 'project', 'local'],
      mcpServers: prepared.mcpServers || {},
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      includePartialMessages: true,
      env: env(),
      ...(m ? { model: m } : {}),
      ...(resume ? { resume } : {}),
    };
    q = queryFn({ prompt: input, options });
    const mine = q;
    (async () => {
      try {
        for await (const msg of mine) onMessage(msg);
      } catch (err) {
        log.warn('the SDK chat ended with an error', { message: err.message });
        publish({ id: `err-${Date.now()}`, type: 'activity', text: `the chat stopped: ${err.message}`, at: now() });
      } finally {
        if (q === mine) {
          q = null;
          input = null;
          for (const p of [...approvals.values()]) settle(p, { behavior: 'deny', message: 'the chat session ended' });
          flushHeld(true);
          setStatus('offline');
        }
      }
    })();
    return { created: true };
  }

  async function ensureStarted() {
    if (draining) throw httpError(503, 'the PA is restarting — send it again in a moment');
    if (q) return { created: false };
    if (!starting) {
      starting = start().finally(() => {
        starting = null;
      });
    }
    try {
      return await starting;
    } catch (err) {
      throw httpError(503, `the PA chat could not start: ${err.message}`);
    }
  }

  async function send({ text, source = 'typed' } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'text must be a non-empty string');
    if (text.length > MAX_TEXT) throw httpError(400, `text is over ${MAX_TEXT} characters`);
    if (!SOURCES.includes(source)) throw httpError(400, `source must be ${SOURCES.join(' or ')}`);
    if (approvals.size) throw httpError(409, 'the PA is waiting for your yes on an action — answer it first');
    if (draining) throw httpError(503, 'the PA is restarting — send it again in a moment');
    const clean = text.replace(/\r\n?/g, '\n').trim();
    await ensureStarted();
    const event = { id: `u-${crypto.randomUUID()}`, type: 'user', text: clean, at: now(), source };
    publish(event);
    setStatus('thinking');
    input.push({ type: 'user', message: { role: 'user', content: clean }, parent_tool_use_id: null, ...(sessionId ? { session_id: sessionId } : {}) });
    return { id: event.id };
  }

  /** Calls fn(event) for every new event; returns the unsubscribe. */
  function subscribe(fn) {
    subs.add(fn);
    seedHistory();
    fn({ id: `status-now-${Date.now()}`, type: 'status', text: status, at: now() });
    return () => subs.delete(fn);
  }

  function history(limit = 50) {
    seedHistory();
    const n = Math.min(Math.max(1, Number(limit) || 50), MAX_EVENTS);
    return events.filter((e) => e.type === 'user' || e.type === 'assistant').slice(-n);
  }

  /**
   * sessionId and url are the Run view's termhub session (what the pages
   * link to, as with the terminal engine); conversationId is the SDK's.
   */
  async function session() {
    const v = q ? await withTimeout(ensureView(), 3000) : view;
    return { engine: 'sdk', sessionId: v?.id || null, conversationId: sessionId, status, waitingOn: approvals.size ? 'dashboard' : null, url: v?.url || null, permission: permissionPending() };
  }

  /**
   * The worker's INBOX doorbell (src/notify/chat.js), on this engine: the
   * fixed, content-free line for notification `id` as a user turn — only into
   * a running session, idle for at least `minIdleMs` since its last turn, with
   * nothing waiting on a yes. Never starts a session (INBOX.md still has it).
   */
  function doorbell(id, { minIdleMs = 2 * 60_000 } = {}) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, reason: 'bad notification id' };
    if (!q || !input) return { ok: false, reason: 'no PA chat session' };
    if (approvals.size) return { ok: false, reason: 'waiting on an approval' };
    if (status !== 'idle') return { ok: false, reason: `state ${status}` };
    if (!(Date.now() - idleSince >= minIdleMs)) return { ok: false, reason: 'idle too briefly' };
    const text = require('../notify/chat.ts').nudgeText(n);
    publish({ id: `u-${crypto.randomUUID()}`, type: 'user', text, at: now() });
    setStatus('thinking');
    input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...(sessionId ? { session_id: sessionId } : {}) });
    return { ok: true, reason: 'idle, nothing waiting' };
  }

  /** POST /api/chat/open: start (or resume) the session without a message. */
  async function open() {
    const { created } = await ensureStarted();
    const v = await withTimeout(ensureView({ force: !view }), 5000);
    return { engine: 'sdk', sessionId: v?.id || null, conversationId: sessionId, created, url: v?.url || null };
  }

  /**
   * A Z1 roll moved routing to the next generation: hand the conversation
   * over. Prompts waiting here can no longer be answered (the page now talks
   * to the new generation), so they are denied with a reason the model can
   * repeat; the turn in flight gets up to `waitMs` to finish; then the query
   * is closed, and the new generation resumes the session by its id on its
   * first message. undrain() (a rollback) just lets the next message restart it.
   */
  async function drain({ waitMs = 20_000 } = {}) {
    draining = true;
    for (const p of [...approvals.values()]) {
      publish({ id: `perm-drain-${p.toolUseId}`, type: 'activity', text: `not done, the PA is restarting: ${p.text.replace(/…$/, '')}`, at: now() });
      settle(p, { behavior: 'deny', message: 'The PA is restarting, so this was not done. Tell the user to ask again in a moment.' });
    }
    const end = Date.now() + waitMs;
    while (q && status === 'thinking' && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    if (q) log.info('closing the SDK chat for the next generation', { session: sessionId, finished: status !== 'thinking' });
    stop();
    // The loop's finally marks it offline; wait for it, bounded.
    const gone = Date.now() + 2000;
    while (q && Date.now() < gone) await new Promise((r) => setTimeout(r, 20));
    return { sessionId, closed: !q };
  }

  function undrain() {
    draining = false;
  }

  function stop() {
    for (const p of [...approvals.values()]) settle(p, { behavior: 'deny', message: 'the chat is stopping' });
    if (input) input.close();
    try {
      q?.close?.();
    } catch {
      /* already gone */
    }
  }

  return { send, history, subscribe, session, open, doorbell, answerPermission, drain, undrain, stop, canUseTool, preToolUse, onMessage };
}

module.exports = { createSdkFeed, subscriptionEnv, splitTool, hookDecision, insideHome, genericDetail, genericAsk, genericVoiceOk, createInputQueue, SDK_MODULE, SESSION_FILE };
