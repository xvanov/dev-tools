'use strict';

// Ingest of your own agent sessions, read from Claude Code's transcripts.
//
// You asked for the Claude sessions to be recorded too. The microphone is the
// wrong instrument for that: the exact text is already on disk, in
// `~/.claude/projects/<slug>/<session-id>.jsonl`, one JSON object per line.
// Transcribing audio of yourself reading a prompt aloud would be a lossy copy
// of a perfect record.
//
// What gets captured is **your prompts and the assistant's prose replies**, one
// source_item per session, rebuilt whenever the file grows. Tool calls, file
// diffs and thinking blocks are skipped: they are enormous, they are already in
// git, and the thing worth recalling three weeks later is "what did I ask for
// and what did it say back".
//
// termhub reads these same files to summarise turns for its spoken
// announcements — see `termhub/lib` before changing the parsing here, so the
// two never disagree about which message is the last one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveItems } = require('./store');
const { truncate } = require('../util/text');
const { logger } = require('../log');

const log = logger('claude-sessions');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_SESSIONS_PER_PASS = 40;
const MAX_BODY = 60_000;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// A user entry with an array content is usually a tool result being fed back,
// not something a human typed. `promptSource` marks the real ones.
function isHumanPrompt(entry) {
  if (entry.type !== 'user') return false;
  if (typeof entry.message?.content === 'string') return true;
  return Boolean(entry.promptSource);
}

function parseTranscript(text) {
  const turns = [];
  let sessionId = null;
  let title = null;
  let cwd = null;
  let gitBranch = null;
  let firstAt = null;
  let lastAt = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a half-written last line while a session is live
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
      if (body) turns.push({ role: 'claude', at: entry.timestamp, text: body });
    }
  }

  return { sessionId, title, cwd, gitBranch, firstAt, lastAt, turns };
}

function toItem(parsed, file) {
  const body = parsed.turns
    .map((t) => `${t.role === 'me' ? '>>' : '<<'} ${t.text}`)
    .join('\n\n');

  return {
    externalId: parsed.sessionId || path.basename(file, '.jsonl'),
    threadExternalId: parsed.cwd || null,
    occurredAt: parsed.lastAt || new Date().toISOString(),
    authorIdentity: 'me',
    subject: parsed.title || `Claude session in ${path.basename(parsed.cwd || 'unknown')}`,
    bodyText: truncate(body, MAX_BODY),
    raw: {
      cwd: parsed.cwd,
      gitBranch: parsed.gitBranch,
      turns: parsed.turns.length,
      startedAt: parsed.firstAt,
      transcript: file,
    },
  };
}

function transcriptFiles() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out = [];
  for (const dir of fs.readdirSync(PROJECTS_DIR)) {
    const full = path.join(PROJECTS_DIR, dir);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of fs.readdirSync(full)) {
      if (!file.endsWith('.jsonl')) continue;
      const p = path.join(full, file);
      try {
        out.push({ path: p, mtime: fs.statSync(p).mtimeMs });
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS_PER_PASS);
}

async function run() {
  const files = transcriptFiles();
  if (!files.length) {
    log.debug('no transcripts found', { dir: PROJECTS_DIR });
    return 0;
  }

  const items = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f.path, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseTranscript(text);
    if (!parsed.turns.length) continue;
    items.push(toItem(parsed, f.path));
  }

  return saveItems('claude_session', items, {
    source: 'claude_session',
    deltaToken: null,
    state: { scanned: files.length },
  });
}

module.exports = { run, id: 'claude_session', parseTranscript, toItem, transcriptFiles };
