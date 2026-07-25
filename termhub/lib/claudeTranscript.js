'use strict';

// Turn-level reading of a Claude Code conversation transcript — "what did the
// assistant last say, and is it now waiting on the human?".
//
// lib/claudeModel.js already knows where these JSONL files live and how to walk
// their tail cheaply; this module adds the one question the voice layer needs
// that a model badge doesn't. Deliberately read-only and synchronous: it runs
// once a second per armed session off a 64 KB tail read, and never spawns
// anything.

const { scanTail } = require('./claudeModel');

// Entry types that carry a conversational turn. Everything else in the file is
// Claude Code's own bookkeeping (`system`, `mode`, `permission-mode`,
// `file-history-snapshot`, `ai-title`, `last-prompt`, `attachment`, …) and must
// not be mistaken for the end of a turn — a transcript routinely ends with
// several of them after the final assistant message.
const TURN_TYPES = new Set(['assistant', 'user']);

// Tool calls that stop and ask the human something even though the turn's
// stop_reason is `tool_use`. Claude is genuinely waiting on input here, so from
// the voice layer's point of view these end a turn like `end_turn` does.
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

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

function toolNamesIn(content) {
  if (!Array.isArray(content)) return [];
  const names = [];
  for (const block of content) {
    if (block && block.type === 'tool_use' && block.name) names.push(block.name);
  }
  return names;
}

// Shape a raw transcript entry into a turn, or null if it isn't one we care
// about. Subagent turns (`isSidechain`) are skipped wholesale — a single user
// request can spawn a dozen of them and each one "finishes", which would make
// the voice layer announce constantly. `isMeta` entries are injected context,
// not something anyone said.
function toTurn(entry) {
  if (!entry || !TURN_TYPES.has(entry.type)) return null;
  if (entry.isSidechain || entry.isMeta) return null;
  const message = entry.message;
  if (!message) return null;
  const content = message.content;
  return {
    uuid: entry.uuid || null,
    role: entry.type,
    text: blocksToText(content),
    stopReason: message.stop_reason === undefined ? null : message.stop_reason,
    toolNames: toolNamesIn(content),
    ts: entry.timestamp ? Date.parse(entry.timestamp) || null : null,
  };
}

// The most recent real turn in the transcript, or null if the file is missing,
// unreadable, or holds nothing but bookkeeping. Never throws.
function readLastTurn(file) {
  if (!file) return null;
  return scanTail(file, (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const turn = toTurn(entry);
      if (turn) return turn;
    }
    return null;
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

module.exports = { readLastTurn, isWaitingForInput };
