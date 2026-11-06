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

// Typed text Claude Code wraps in tags is the CLI talking to itself: slash
// commands and their output, interrupted-request notices, reminders.
const CLI_NOISE = /^\s*(<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)>|\[Request interrupted by user)/;

// Claude Code's own project-folder naming (termhub/lib/claudeModel.js
// projectDirFor): every non-alphanumeric character becomes '-', after a
// trailing separator is dropped.
function projectDirFor(cwd) {
  return String(cwd).replace(/(?<=.)[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

function shorten(s, n = 80) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function base(p) {
  return String(p || '').split(/[\\/]/).pop();
}

/**
 * A short, present-tense line for a tool call, for a UI that wants to show the
 * assistant is working ("searching your history: renewal…"). Never the tool's
 * full input: it can be long, and it can quote other people's messages.
 */
function describeTool(name, input = {}) {
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
      default: return `using ${tool.replace(/_/g, ' ')}…`;
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

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
}

/**
 * The events one transcript entry produces: [{id, type, text, at}]. Ids are
 * the entry's uuid (suffixed per block), so re-reading a file yields the same
 * ids and a client can dedupe history against the stream.
 */
function entryEvents(entry) {
  if (!entry || typeof entry !== 'object' || entry.isSidechain) return [];
  const at = entry.timestamp || new Date().toISOString();
  const uuid = String(entry.uuid || '');
  const out = [];
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
    blocks.forEach((b, k) => {
      if (!b) return;
      const id = k ? `${uuid}:${k}` : uuid;
      if (b.type === 'text' && String(b.text || '').trim()) {
        const e = { id, type: 'assistant', text: String(b.text).trim(), at };
        if (final !== undefined) e.final = final;
        out.push(e);
      } else if (b.type === 'tool_use') out.push({ id, type: 'activity', text: describeTool(b.name, b.input), at });
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
function parseLines(rest, chunk) {
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
function sessionStatus(session) {
  if (!session || session.alive === false) return { status: 'offline', waitingOn: null };
  const reason = session.idleReason;
  if (session.idleState === 'working') return { status: 'thinking', waitingOn: null };
  if (session.idleState === 'waiting' && (reason === 'blocked' || reason === 'question')) return { status: 'thinking', waitingOn: 'termhub' };
  if (session.idleState === 'waiting' || session.idleState === 'limited') return { status: 'idle', waitingOn: null };
  // An older termhub without idleState: its PTY dot is all there is.
  return { status: session.busy ? 'thinking' : 'idle', waitingOn: null };
}

module.exports = { projectDirFor, describeTool, entryEvents, parseLines, sessionStatus, textOf };
