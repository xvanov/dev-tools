'use strict';

// Pure. Claude Code's transcript JSONL -> the chat events the dashboard and
// the voice page stream (src/chat/feed.js, README "Talking to it").
//
// The PA chat is a Claude Code TUI in termhub; its screen is not something to
// parse. Its transcript is: one JSON object per line at
// ~/.claude/projects/<encoded cwd>/<session-uuid>.jsonl — the same file
// termhub's model badge and voice announcements read (termhub/lib/claudeModel.js).
//
// What a line can be, as measured on real transcripts:
//   user        content a string (what was typed) or an array — text blocks
//               (also typed), or tool_result blocks (not the user speaking).
//               isMeta lines are hook output and caveats, never the user.
//   assistant   one content block per line (thinking | text | tool_use); every
//               line of one response shares requestId and stop_reason, and is
//               written once the block is complete — so text arrives whole,
//               never as a stream of tokens.
//
// Status (thinking / idle / offline) is NOT read from here: a permission
// prompt or a question writes nothing to the transcript until it is answered
// (termhub/AGENT.md), so termhub's own idleState, which also watches the PTY,
// is the authority — sessionStatus() below.
//   anything else (attachment, api-request, mode, ai-title, …) is bookkeeping.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../types.ts').Json;

// Typed text Claude Code wraps in tags is the CLI talking to itself: slash
// commands and their output, interrupted-request notices, reminders.
const CLI_NOISE = /^\s*(<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)>|\[Request interrupted by user)/;

// Claude Code's own project-folder naming (termhub/lib/claudeModel.js
// projectDirFor): every non-alphanumeric character becomes '-', after a
// trailing separator is dropped.
function projectDirFor(cwd: any) {
  return String(cwd).replace(/(?<=.)[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

function shorten(s: any, n: number = 80) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function base(p: Json) {
  return String(p || '').split(/[\\/]/).pop();
}

/**
 * A short, present-tense line for a tool call, for a UI that wants to show the
 * assistant is working ("searching your history: renewal…"). Never the tool's
 * full input: it can be long, and it can quote other people's messages.
 */
const DELIVERY_SAID: Json = {
  none: 'committing without pushing',
  branch: 'pushing a branch',
  draft_pr: 'opening a draft PR',
  pr: 'opening a PR for review',
  auto_merge: 'merging it once checks pass',
  push_to_main: 'pushing straight to main',
};

/**
 * The question Jarvis asks out loud before one of the chat's actions runs
 * ("Start a factory job for card 412 on your subscription, opening a PR for
 * review. Shall I?"), or null for any other tool. From the tool's structured
 * input only, shortened: the Talk page speaks it and the user's spoken yes or
 * no answers the permission prompt (src/chat/permission.js).
 */
function askTool(name: string, input: Json = {}) {
  const m = /^mcp__pa-chat__([a-z_]+)$/.exec(String(name || ''));
  if (!m) return null;
  const i = input && typeof input === 'object' ? input : {};
  const job = (j: any) => String(j || 'that job').replace(':', ' ');
  const how = () => {
    const parts = [];
    parts.push(i.runtime === 'api' ? `on the API${i.model ? ` with ${shorten(i.model, 40)}` : ''}` : 'on your subscription');
    if (DELIVERY_SAID[i.delivery]) parts.push(DELIVERY_SAID[i.delivery]);
    return parts.join(', ');
  };
  let q;
  switch (m[1]) {
    case 'factory_start': {
      const kind = i.kind && i.kind !== 'code' ? `${i.kind} ` : '';
      const what = i.card ? `card ${shorten(i.card, 12)}` : shorten(i.title || i.ask || 'this', 70);
      q = `Start a factory ${kind}job for ${what} ${how()}`;
      break;
    }
    case 'factory_continue': {
      const on = i.pr ? `PR ${Number(i.pr) || ''}` : `branch ${shorten(i.branch, 40)}`;
      q = `Continue ${on} on ${shorten(i.repo || 'the repo', 40)} in the factory ${how()}`;
      break;
    }
    case 'factory_resume': q = `Resume factory job ${job(i.job)}`; break;
    case 'factory_cancel': q = `Cancel factory job ${job(i.job)}`; break;
    case 'factory_approve': q = `Approve the direction factory job ${job(i.job)} is waiting on`; break;
    case 'session_start': q = `Start a Claude session${i.repo ? ` on ${shorten(i.repo, 40)}` : ''}${i.mode === 'plan' ? ', read only,' : ''} to ${shorten(i.prompt, 70)}`; break;
    case 'card_edit': {
      const bits = [];
      if (i.title !== undefined) bits.push(`title to "${shorten(i.title, 50)}"`);
      if (i.due !== undefined) bits.push(i.due === null ? 'no due date' : `due ${shorten(i.due, 30)}`);
      if (i.details !== undefined) bits.push('the details');
      if (i.project !== undefined) bits.push(i.project === null ? 'no project' : `project ${shorten(i.project, 30)}`);
      if (i.note !== undefined) bits.push(`a note "${shorten(i.note, 50)}"`);
      q = `Change card ${shorten(i.card, 12)}: ${bits.join(', ') || 'edit it'}`;
      break;
    }
    default: return null;
  }
  return `${q.replace(/\s+/g, ' ').trim()}. Shall I?`;
}

function describeTool(name: string, input: Json = {}) {
  const n = String(name || '');
  const i = input && typeof input === 'object' ? input : {};
  const mcp = /^mcp__.+?__(.+)$/.exec(n);
  const tool = mcp ? mcp[1] : n;
  if (mcp) {
    switch (tool) {
      case 'pa': return `running pa ${shorten([i.command, ...(Array.isArray(i.args) ? i.args : [])].filter(Boolean).join(' '), 60)}…`;
      case 'recall':
      case 'search_context': return `searching your history${i.query ? `: ${shorten(i.query, 50)}` : ''}…`;
      case 'memory_page': return `reading memory${i.subject || i.name ? `: ${shorten(i.subject || i.name, 40)}` : ''}…`;
      case 'brief_me': return 'reading the brief…';
      case 'open_commitments': return 'checking open asks…';
      case 'who_is': return `looking up ${shorten(i.name || i.query || 'a person', 40)}…`;
      case 'get_thread': return 'reading a thread…';
      case 'board': return 'reading your board…';
      case 'card': return `reading card ${shorten(i.id, 20)}…`;
      case 'factory_jobs': return 'checking factory jobs…';
      case 'factory_job': return `checking factory job ${shorten(i.job, 40)}…`;
      case 'sessions': return 'listing sessions…';
      // The actions: what the permission prompt is for, named (src/chat/feed.js waitingText).
      case 'factory_start':
      case 'factory_continue': {
        const on = i.branch ? ` on branch ${shorten(i.branch, 40)}` : i.pr ? ` on PR #${Number(i.pr) || '?'}` : '';
        const what = i.title || (i.card ? `card ${i.card}` : i.ask) || 'a job';
        return `starting a factory ${i.kind && i.kind !== 'code' ? `${i.kind} ` : ''}job${on}: ${shorten(what, 60)} (${i.runtime || 'claude_session'}${i.delivery ? `, ${i.delivery}` : ''})…`;
      }
      case 'factory_resume': return `resuming factory job ${shorten(i.job, 40)}…`;
      case 'factory_cancel': return `cancelling factory job ${shorten(i.job, 40)}…`;
      case 'factory_approve': return `approving factory job ${shorten(i.job, 40)}…`;
      case 'card_edit': return `editing card ${shorten(i.card, 12)}…`;
      case 'session_start': return `starting a session${i.repo ? ` on ${shorten(i.repo, 40)}` : ''}: ${shorten(i.prompt, 50)}…`;
      default: return `using ${(tool ?? '').replace(/_/g, ' ')}…`;
    }
  }
  switch (tool) {
    case 'Bash':
    case 'PowerShell': return `running a command${i.description ? `: ${shorten(i.description, 60)}` : ''}…`;
    case 'Read': return `reading ${base(i.file_path) || 'a file'}…`;
    case 'Grep':
    case 'Glob': return 'searching files…';
    case 'Edit':
    case 'Write': return `writing ${base(i.file_path) || 'a file'}…`;
    case 'WebSearch':
    case 'WebFetch': return 'searching the web…';
    case 'Task':
    case 'Agent': return 'starting a helper…';
    case 'TodoWrite': return 'planning…';
    default: return `using ${tool}…`;
  }
}

function textOf(content: any) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}

/**
 * The events one transcript entry produces: [{id, type, text, at}]. Ids are
 * the entry's uuid (suffixed per block), so re-reading a file yields the same
 * ids and a client can dedupe history against the stream.
 */
function entryEvents(entry: Json) {
  if (!entry || typeof entry !== 'object' || entry.isSidechain) return [];
  const at = entry.timestamp || new Date().toISOString();
  const uuid = String(entry.uuid || '');
  const out: any[] = [];
  if (entry.type === 'user' && !entry.isMeta && entry.message) {
    const c = entry.message.content;
    const toolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
    if (toolResult) return [];
    const text = textOf(c).trim();
    if (!text || CLI_NOISE.test(text)) return [];
    return [{ id: uuid, type: 'user', text, at }];
  }
  if (entry.type === 'assistant' && entry.message) {
    const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
    // Every line of a response carries its stop_reason: 'tool_use' means the
    // text is a step ("let me check…") and the turn goes on; anything else
    // ends the turn, so the text is the answer. No stop_reason: unknown.
    const stop = entry.message.stop_reason;
    const final = stop ? stop !== 'tool_use' : undefined;
    blocks.forEach((b: any, k: any) => {
      if (!b) return;
      const id = k ? `${uuid}:${k}` : uuid;
      if (b.type === 'text' && String(b.text || '').trim()) {
        const e: Json = { id, type: 'assistant', text: String(b.text).trim(), at };
        if (final !== undefined) e.final = final;
        out.push(e);
      } else if (b.type === 'tool_use') {
        // The tool's name and call id ride along (never its input): a permission
        // prompt is for the last call, and the Talk page answers it by that id
        // (src/chat/permission.js).
        const e: Json = { id, type: 'activity', text: describeTool(b.name, b.input), at, tool: String(b.name || ''), toolUseId: String(b.id || '') };
        const ask = askTool(b.name, b.input);
        if (ask) e.ask = ask;
        // The two fields the policy needs to judge an approval (src/policy): which job, and the delivery asked for.
        if (ask && b.input && typeof b.input === 'object') {
          const pa: Json = {};
          if (typeof b.input.job === 'string') pa.job = b.input.job.slice(0, 80);
          if (typeof b.input.delivery === 'string') pa.delivery = b.input.delivery.slice(0, 20);
          if (Object.keys(pa).length) e.policyArgs = pa;
        }
        out.push(e);
      }
    });
    return out;
  }
  return [];
}

/**
 * Splits appended bytes into complete lines. `rest` is the unterminated tail
 * from the previous read (a line Claude Code is still writing): it is carried,
 * never parsed half-written. Returns { entries, rest }.
 */
function parseLines(rest: any, chunk: any) {
  const lines = (String(rest || '') + String(chunk || '')).split('\n');
  const tail = lines.pop();
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* a torn line: skip it rather than stop reading */
    }
  }
  return { entries, rest: tail };
}

/**
 * Pure. termhub's view of the PA session -> { status, waitingOn }.
 * status is 'offline' (no live session), 'thinking' or 'idle'. waitingOn is
 * 'termhub' when Claude is parked on a permission prompt or a question: the
 * turn is not over, and only the terminal can answer it (typing into it
 * from here could press a picker's option).
 */
function sessionStatus(session: Json) {
  if (!session || session.alive === false) return { status: 'offline', waitingOn: null };
  const reason = session.idleReason;
  if (session.idleState === 'working') return { status: 'thinking', waitingOn: null };
  if (session.idleState === 'waiting' && (reason === 'blocked' || reason === 'question')) return { status: 'thinking', waitingOn: 'termhub' };
  if (session.idleState === 'waiting' || session.idleState === 'limited') return { status: 'idle', waitingOn: null };
  // An older termhub without idleState: its PTY dot is all there is.
  return { status: session.busy ? 'thinking' : 'idle', waitingOn: null };
}

module.exports = { projectDirFor, describeTool, askTool, entryEvents, parseLines, sessionStatus, textOf };
