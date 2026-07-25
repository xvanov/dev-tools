'use strict';

// Turn-level reading of a Claude Code conversation transcript — "what did the
// assistant last say, and is it now waiting on the human?".
//
// lib/claudeModel.js already knows where these JSONL files live and how to walk
// their tail cheaply; this module adds the one question the voice layer needs
// that a model badge doesn't. Deliberately read-only and synchronous: it runs
// once a second per armed session off a 64 KB tail read, and never spawns
// anything.
//
// The load-bearing subtlety: **one assistant response is written as SEVERAL
// transcript entries** — thinking, then text, then each tool_use — all sharing
// one `requestId` and one `stop_reason`. Reading only the last entry gets the
// turn wrong in exactly the case that matters most (see readLastTurn).

const { scanTail } = require('./claudeModel');

// Entry types that carry a conversational turn. Everything else in the file is
// Claude Code's own bookkeeping (`system`, `mode`, `permission-mode`,
// `file-history-snapshot`, `ai-title`, `last-prompt`, `attachment`,
// `queue-operation`, …) and must not be mistaken for the end of a turn — a
// transcript routinely ends with several of them after the final message.
const TURN_TYPES = new Set(['assistant', 'user']);

// Tool calls that stop and ask the human something even though the turn's
// stop_reason is `tool_use`. Claude is genuinely waiting on input here, so from
// the voice layer's point of view these end a turn like `end_turn` does.
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// How many entries back to walk when reassembling one response. A response is
// a handful of entries; this only bounds a pathological file.
const MAX_RESPONSE_ENTRIES = 40;

// Spoken option lists get tedious fast — name a few and stop. Real
// AskUserQuestion calls go up to four questions with four options each, which
// reads out as ~70 seconds of monotone; the browser shows the full thing, the
// announcement just has to get the user's attention and convey the first ask.
const MAX_SPOKEN_OPTIONS = 4;
const MAX_SPOKEN_QUESTIONS = 2;
const MAX_PROMPT_CHARS = 400;

// Assistant text is the concatenation of `text` blocks only. `thinking` blocks
// are explicitly excluded: they're the model's scratchpad, often much longer
// than the answer, and reading them aloud would be both wrong and interminable.
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out.push(block.text);
  }
  return out.join('\n').trim();
}

function toolUsesIn(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool_use' && b.name);
}

// Is this an entry the voice layer should ever look at? Subagent turns
// (`isSidechain`) are rejected because a single user request can spawn a dozen
// and each one "finishes". NOTE: on this Claude Code version that flag is never
// actually set — subagent conversations are filed in a separate
// `<session-uuid>/subagents/` directory, and what really keeps them out is that
// findActiveTranscript (lib/claudeModel.js) lists one directory
// non-recursively. Those files are full of `stop_reason: null` entries that
// would read as "waiting", so **do not make that readdir recursive**, and keep
// this flag check as the belt to that braces. `isMeta` entries are injected
// context, not something anyone said.
function isSpeakableEntry(entry) {
  return !!entry && TURN_TYPES.has(entry.type) && !entry.isSidechain && !entry.isMeta && !!entry.message;
}

// Turn an asking tool's input into the sentence the user needs to hear. This is
// the whole point of announcing these: the question IS the message.
function promptFromTool(tool) {
  const input = (tool && tool.input) || {};
  if (tool.name === 'ExitPlanMode') {
    return 'Do you want me to go ahead with this plan?';
  }
  // AskUserQuestion: {questions: [{question, header, options: [{label, …}]}]}
  const questions = (Array.isArray(input.questions) ? input.questions : [])
    .filter((q) => q && typeof q.question === 'string');
  const parts = [];
  for (const q of questions.slice(0, MAX_SPOKEN_QUESTIONS)) {
    let line = q.question.trim();
    const labels = (Array.isArray(q.options) ? q.options : [])
      .map((o) => (o && typeof o.label === 'string' ? o.label.trim() : ''))
      .filter(Boolean)
      .slice(0, MAX_SPOKEN_OPTIONS);
    if (labels.length) line += ` Options are: ${labels.join(', ')}.`;
    parts.push(line);
  }
  const dropped = questions.length - parts.length;
  if (dropped > 0) parts.push(`And ${dropped} more question${dropped > 1 ? 's' : ''}.`);
  let out = parts.join(' ').trim();
  if (out.length > MAX_PROMPT_CHARS) out = `${out.slice(0, MAX_PROMPT_CHARS).replace(/\s+\S*$/, '')}…`;
  return out || null;
}

// The most recent complete assistant/user response in the transcript, or null
// if the file is missing, unreadable, or holds nothing but bookkeeping.
//
// Assembles every consecutive entry belonging to the same response (same
// `requestId`) rather than returning just the last line. Without this, an
// `AskUserQuestion` turn looks empty: Claude Code writes the tool call as its
// own entry with ZERO text blocks (98 of 98 such entries on this machine), with
// the prose sitting in an earlier entry of the same response. `uuid` is the
// LAST entry's — it's the newest, and it's what announcement dedupe keys on.
//
// Never throws.
function readLastTurn(file) {
  if (!file) return null;
  return scanTail(file, (lines) => {
    // Parse lazily from the end: a window can hold megabytes and the answer is
    // almost always within the last few lines.
    const parse = (i) => {
      const line = lines[i].trim();
      if (!line) return null;
      try { return JSON.parse(line); } catch { return null; }
    };

    let last = null;
    let lastIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parse(i);
      if (isSpeakableEntry(entry)) { last = entry; lastIdx = i; break; }
    }
    if (!last) return null;

    const message = last.message;
    const content = message.content;
    let text = blocksToText(content);
    const tools = toolUsesIn(content);

    // Walk back over the rest of this response. Bail the moment an entry isn't
    // a same-response assistant entry — a different requestId, a user turn, or
    // any bookkeeping line means we've reached the start of this response.
    if (last.type === 'assistant' && last.requestId) {
      const stop = Math.max(0, lastIdx - MAX_RESPONSE_ENTRIES);
      for (let i = lastIdx - 1; i >= stop; i--) {
        const entry = parse(i);
        if (!entry) continue; // a blank or unparseable line inside the response
        if (entry.type !== 'assistant' || entry.requestId !== last.requestId) break;
        if (!isSpeakableEntry(entry)) break;
        const earlier = blocksToText(entry.message.content);
        if (earlier) text = text ? `${earlier}\n${text}` : earlier;
        tools.unshift(...toolUsesIn(entry.message.content));
      }
    }

    const asking = tools.find((t) => ASKING_TOOLS.has(t.name));
    // An ExitPlanMode with no prose still carries the plan, which IS the content.
    if (!text && asking && asking.name === 'ExitPlanMode' && asking.input && typeof asking.input.plan === 'string') {
      text = asking.input.plan;
    }

    return {
      uuid: last.uuid || null,
      role: last.type,
      text,
      stopReason: message.stop_reason === undefined ? null : message.stop_reason,
      toolNames: tools.map((t) => t.name),
      prompt: asking ? promptFromTool(asking) : null,
      ts: last.timestamp ? Date.parse(last.timestamp) || null : null,
    };
  });
}

// Is the conversation parked on the human? Only an assistant turn can be: if
// the last turn is a `user` one, Claude is either about to answer or is feeding
// itself a tool_result mid-call. A `tool_use` stop is mid-work and must NOT be
// announced — except for the tools whose whole purpose is to ask (see
// ASKING_TOOLS), which is exactly the moment the user most wants to be told.
function isWaitingForInput(turn) {
  if (!turn || turn.role !== 'assistant') return false;
  const reason = turn.stopReason;
  if (reason === null || reason === 'end_turn' || reason === 'stop_sequence') return true;
  if (reason === 'tool_use') return turn.toolNames.some((n) => ASKING_TOOLS.has(n));
  return false;
}

// Does this turn have anything worth speaking? A waiting turn with neither
// prose nor a question is a mid-stream fragment (Claude writes a thinking-only
// entry with `stop_reason: null` before the text lands), and announcing it
// would both say nothing and burn the turn's uuid.
function hasSpeakableContent(turn) {
  return !!turn && (!!turn.text || !!turn.prompt);
}

module.exports = { readLastTurn, isWaitingForInput, hasSpeakableContent, ASKING_TOOLS };
