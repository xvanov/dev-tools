'use strict';

// Turn-level reading of Cursor Agent CLI JSONL transcripts — parallel to
// lib/claudeTranscript.js. Cursor lines use `role` (user|assistant) rather than
// `type`, and usually omit stop_reason; waiting is inferred from the last
// assistant entry plus the same PTY heuristics in lib/idleState.js.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const path = require('path');
const { scanTail } = require('./cursorModel.ts');
const {
  isWaitingForInput: claudeWaiting,
  hasSpeakableContent,
  isLimitNotice,
  ASKING_TOOLS,
} = require('./claudeTranscript.ts');

function blocksToText(content: any) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out.push(block.text);
  }
  return out.join('\n').trim();
}

function toolUsesIn(content: any) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool_use' && b.name);
}

function isSpeakableEntry(entry: any) {
  return !!entry && (entry.role === 'user' || entry.role === 'assistant') && !!entry.message;
}

function readLastTurn(file: any) {
  if (!file) return null;
  return scanTail(file, (lines: any) => {
    const parse = (i: any) => {
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

    const content = last.message.content;
    let text = blocksToText(content);
    const tools = toolUsesIn(content);

    return {
      uuid: `${path.basename(file, '.jsonl')}:${lastIdx}`,
      role: last.role,
      text,
      model: typeof last.message.model === 'string' ? last.message.model : null,
      stopReason: last.message.stop_reason === undefined ? null : last.message.stop_reason,
      toolNames: tools.map((t) => t.name),
      prompt: null,
      ts: last.timestamp ? Date.parse(last.timestamp) || null : null,
    };
  });
}

function isWaitingForInput(turn: any) {
  if (!turn || turn.role !== 'assistant') return false;
  if (turn.stopReason === 'tool_use') {
    return turn.toolNames.some((n: any) => ASKING_TOOLS.has(n));
  }
  // Cursor often omits stop_reason; an assistant line with prose means the turn ended.
  if (turn.stopReason == null) {
    if (turn.toolNames.length && !turn.text) return false;
    return hasSpeakableContent(turn);
  }
  return claudeWaiting(turn);
}

module.exports = {
  readLastTurn,
  isWaitingForInput,
  hasSpeakableContent,
  isLimitNotice,
  ASKING_TOOLS,
};
