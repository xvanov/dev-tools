'use strict';

// Shared transcript parsing for agent sessions (Claude Code and Cursor agent CLI).
// Keep in sync with termhub/lib/claudeTranscript.js and cursorTranscript.js for
// "which message is last" semantics.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

function textOf(content: any) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function isHumanPrompt(entry: any) {
  if (entry.type !== 'user') return false;
  if (typeof entry.message?.content === 'string') return true;
  return Boolean(entry.promptSource);
}

/** Claude Code JSONL (`type` field). */
function parseClaudeTranscript(text: any) {
  const turns: any[] = [];
  let sessionId: any = null;
  let title: any = null;
  let cwd: any = null;
  let gitBranch: any = null;
  let firstAt: any = null;
  let lastAt: any = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.sessionId) sessionId = entry.sessionId;
    if (entry.type === 'ai-title' && entry.aiTitle) title = entry.aiTitle;
    if (entry.cwd) cwd = entry.cwd;
    if (entry.gitBranch) gitBranch = entry.gitBranch;
    if (entry.timestamp) {
      firstAt = firstAt || entry.timestamp;
      lastAt = entry.timestamp;
    }

    if (isHumanPrompt(entry)) {
      const body = textOf(entry.message.content).trim();
      if (body) turns.push({ role: 'me', at: entry.timestamp, text: body });
    } else if (entry.type === 'assistant') {
      const body = textOf(entry.message?.content).trim();
      if (body) turns.push({ role: 'assistant', at: entry.timestamp, text: body });
    }
  }

  return { sessionId, title, cwd, gitBranch, firstAt, lastAt, turns, provider: 'claude' };
}

/** Cursor agent CLI JSONL (`role` field). */
function parseCursorTranscript(text: any) {
  const turns: any[] = [];
  let sessionId: any = null;
  let cwd: any = null;
  let firstAt: any = null;
  let lastAt: any = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.sessionId) sessionId = entry.sessionId;
    if (entry.cwd) cwd = entry.cwd;
    if (entry.timestamp) {
      firstAt = firstAt || entry.timestamp;
      lastAt = entry.timestamp;
    }
    if (entry.role === 'user') {
      const body = textOf(entry.message?.content).trim();
      if (body && !body.startsWith('<user_query>')) {
        turns.push({ role: 'me', at: entry.timestamp, text: body });
      } else if (body) {
        const query = body.replace(/^<user_query>\s*/i, '').replace(/\s*<\/user_query>\s*$/i, '').trim();
        if (query) turns.push({ role: 'me', at: entry.timestamp, text: query });
      }
    } else if (entry.role === 'assistant') {
      const body = textOf(entry.message?.content).trim();
      if (body) turns.push({ role: 'assistant', at: entry.timestamp, text: body });
    }
  }

  const title = cwd ? `Cursor session in ${require('path').basename(cwd)}` : 'Cursor agent session';
  return { sessionId, title, cwd, gitBranch: null as any, firstAt, lastAt, turns, provider: 'cursor' };
}

function toItem(parsed: any, file: any, { machine = null, source = 'claude_session' }: { machine?: any | null; source?: string } = {}) {
  const { headTail } = require('../util/text.ts');
  const MAX_BODY = 60_000;
  const body = parsed.turns
    .map((t: any) => `${t.role === 'me' ? '>>' : '<<'} ${t.text}`)
    .join('\n\n');

  const sessionId = parsed.sessionId || require('path').basename(String(file), '.jsonl');
  const provider = parsed.provider || (source === 'cursor_session' ? 'cursor' : 'claude');
  const subject = parsed.title || `${provider} session`;
  const raw: Record<string, any> = {
    provider,
    cwd: parsed.cwd,
    gitBranch: parsed.gitBranch,
    turns: parsed.turns.length,
    startedAt: parsed.firstAt,
    transcript: file,
  };
  if (machine) raw.machine = machine;

  return {
    externalId: machine ? `${machine}:${sessionId}` : sessionId,
    threadExternalId: parsed.cwd ? (machine ? `${machine}:${parsed.cwd}` : parsed.cwd) : null,
    occurredAt: parsed.lastAt || new Date().toISOString(),
    authorIdentity: 'me',
    subject: machine ? `${subject} (on ${machine})` : subject,
    bodyText: headTail(body, MAX_BODY),
    raw,
  };
}

module.exports = { parseClaudeTranscript, parseCursorTranscript, toItem, textOf };
