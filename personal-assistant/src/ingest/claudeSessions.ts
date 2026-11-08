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
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveItems } = require('./store.ts');
const { headTail } = require('../util/text.ts');
const { logger } = require('../log.ts');
const { config } = require('../config.ts');

const log = logger('claude-sessions');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_SESSIONS_PER_PASS = 40;
const MAX_BODY = 60_000;

function textOf(content: any) {
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
function isHumanPrompt(entry: any) {
  if (entry.type !== 'user') return false;
  if (typeof entry.message?.content === 'string') return true;
  return Boolean(entry.promptSource);
}

// A transcript is append-only JSONL, so the parse is a fold over lines: a
// parser fed the lines appended since the last pass ends in the same state as
// one fed the whole file again.
function createParser() {
  const s = { sessionId: null as any, title: null as any, cwd: null as any, gitBranch: null as any, firstAt: null as any, lastAt: null as any, turns: [] as any[] };
  return {
    /** Folds one line in; false when it is not JSON (a half-written last line while a session is live). */
    line(line: string) {
      if (!line.trim()) return true;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        return false;
      }
      if (entry.sessionId) s.sessionId = entry.sessionId;
      if (entry.type === 'ai-title' && entry.aiTitle) s.title = entry.aiTitle;
      if (entry.cwd) s.cwd = entry.cwd;
      if (entry.gitBranch) s.gitBranch = entry.gitBranch;
      if (entry.timestamp) {
        s.firstAt = s.firstAt || entry.timestamp;
        s.lastAt = entry.timestamp;
      }
      if (isHumanPrompt(entry)) {
        const body = textOf(entry.message.content).trim();
        if (body) s.turns.push({ role: 'me', at: entry.timestamp, text: body });
      } else if (entry.type === 'assistant') {
        const body = textOf(entry.message?.content).trim();
        if (body) s.turns.push({ role: 'claude', at: entry.timestamp, text: body });
      }
      return true;
    },
    result() {
      return { ...s, turns: s.turns.slice() };
    },
  };
}

function parseTranscript(text: any) {
  const p = createParser();
  for (const line of String(text).split('\n')) p.line(line);
  return p.result();
}

// The worker's event loop serves the voice path: a 30 MB transcript parsed in
// one go held it for half a second or more.
const YIELD_MS = 10;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Feeds `text`'s lines to `parser`, letting the event loop run every YIELD_MS. */
async function feedLines(parser: { line(l: string): boolean }, text: string) {
  let start = 0;
  let since = Date.now();
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    parser.line(text.slice(start, end));
    start = end + 1;
    if (Date.now() - since >= YIELD_MS) {
      await nextTurn();
      since = Date.now();
    }
  }
}

/** parseTranscript, yielding the event loop as it goes. */
async function parseTranscriptAsync(text: any) {
  const p = createParser();
  await feedLines(p, String(text));
  return p.result();
}

// `machine` is set for a session read from another machine's termhub
// (src/ingest/remoteSessions.js), and then `file` is termhub's transcript id.
// Its ids are prefixed with the machine name: the same repo path on two
// machines is two different working trees, and a local row must never be
// overwritten by a remote one, or the reverse.
// The last folder of a cwd from any OS: a remote Windows session's
// `C:\\repos\\quill` is read on Linux too, where path.basename would not split it.
function folderName(cwd: any) {
  return String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(cwd);
}

function toItem(parsed: any, file: any, { machine = null }: { machine?: any | null } = {}) {
  const body = parsed.turns
    .map((t: any) => `${t.role === 'me' ? '>>' : '<<'} ${t.text}`)
    .join('\n\n');

  const sessionId = parsed.sessionId || path.basename(file, '.jsonl');
  const subject = parsed.title || `Claude session in ${folderName(parsed.cwd || 'unknown')}`;
  const raw: Record<string, any> = {
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

function transcriptFiles() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out: any[] = [];
  for (const dir of fs.readdirSync(PROJECTS_DIR)) {
    const full = path.join(PROJECTS_DIR, dir);
    let stat: any;
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
        const st = fs.statSync(p);
        out.push({ path: p, mtime: st.mtimeMs, size: st.size });
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS_PER_PASS);
}

// What each transcript held at the last pass: {mtime, size, offset (the bytes
// folded in, up to a line end), parser, item}. Every pass used to read and
// parse the 40 newest whole (100 MB on the work laptop) to find one changed.
type Seen = { mtime: number; size: number; offset: number; parser: ReturnType<typeof createParser>; item: any };
const seen = new Map<string, Seen>();

/** The item for transcript `f` ({path, mtime, size}), reading only what was appended since last time. Null when it has no turns. */
async function readTranscript(f: { path: string; mtime: number; size: number }, cache: Map<string, Seen> = seen) {
  const prior = cache.get(f.path);
  if (prior && prior.mtime === f.mtime && prior.size === f.size) return prior.item;
  // Grown: carry on from the last line end. Anything else (shrunk, rewritten
  // in place) is read again from the start.
  const c: Seen = prior && f.size > prior.size ? prior : { mtime: 0, size: 0, offset: 0, parser: createParser(), item: null };
  // One byte before the offset must still be the line end it was cut at.
  const from = c.offset > 0 ? c.offset - 1 : 0;
  const buf = Buffer.alloc(Math.max(0, f.size - from));
  const fh = await fs.promises.open(f.path, 'r');
  let bytesRead = 0;
  try {
    ({ bytesRead } = await fh.read(buf, 0, buf.length, from));
  } finally {
    await fh.close().catch(() => {});
  }
  if (c.offset > 0 && buf[0] !== 0x0a) {
    cache.delete(f.path);
    return readTranscript(f, cache);
  }
  const head = c.offset > 0 ? 1 : 0;
  const nl = bytesRead > 0 ? buf.lastIndexOf(0x0a, bytesRead - 1) : -1;
  const whole = nl < head ? head : nl + 1;
  await feedLines(c.parser, buf.toString('utf8', head, whole));
  c.offset = from + whole;
  // A last line with no line end yet: kept only once it is whole JSON.
  const tail = buf.toString('utf8', whole, bytesRead);
  if (tail.trim() && c.parser.line(tail)) c.offset = from + bytesRead;
  c.mtime = f.mtime;
  c.size = f.size;
  const parsed = c.parser.result();
  c.item = parsed.turns.length ? toItem(parsed, f.path) : null;
  cache.set(f.path, c);
  return c.item;
}

async function run() {
  if (!config.sessions.enabled) return 0;
  const files = transcriptFiles();
  if (!files.length) {
    log.debug('no transcripts found', { dir: PROJECTS_DIR });
    return 0;
  }

  const items: any[] = [];
  const listed = new Set(files.map((f: any) => f.path));
  for (const p of seen.keys()) if (!listed.has(p)) seen.delete(p);
  for (const f of files) {
    let item: any;
    try {
      item = await readTranscript(f);
    } catch {
      seen.delete(f.path);
      continue;
    }
    if (item) items.push(item);
  }

  return saveItems('claude_session', items, {
    source: 'claude_session',
    deltaToken: null as any,
    state: { scanned: files.length },
  });
}

module.exports = { run, id: 'claude_session', parseTranscript, parseTranscriptAsync, readTranscript, toItem, transcriptFiles };
