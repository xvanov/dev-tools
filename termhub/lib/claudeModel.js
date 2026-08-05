'use strict';

// Reads which model a `claude` session is currently using, straight from
// Claude Code's own on-disk conversation transcript — the only place that
// information exists once you're a step removed (a terminal supervisor, not
// the CLI itself). Claude Code writes one JSONL file per conversation at
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl, one line per turn,
// each assistant line carrying the model that produced it.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Progressively larger tail windows. A single Claude turn — thinking, tool
// calls, tool results, or an inline image attachment — can be tens of KB to
// megabytes, so a small fixed window often lands entirely inside one line and
// sees no complete assistant entry at all (measured: an 8 KB window missed the
// model on ~22% of real transcripts). Start small for the common case and grow
// only when the model isn't yet in view, up to reading the whole file. Cheap in
// practice: readLastModel runs only when the transcript's mtime changes.
const TAIL_STEPS_BYTES = [65536, 524288, 4194304];

// Claude Code's own project-folder naming: every non-alphanumeric character
// (path separators, drive-letter colon, dots, …) becomes a hyphen. Verified
// against this machine's real ~/.claude/projects entries, e.g.
// `C:\source\dev-tools\termhub` -> `C--source-dev-tools-termhub`.
//
// A TRAILING SEPARATOR MUST GO FIRST. Claude Code encodes its own resolved cwd,
// which never carries one; termhub encodes whatever the user typed into the
// new-terminal dialog, and the directory autocomplete hands back paths ending
// in `/`. Encoding that produces `-home-k-project-` where Claude wrote
// `-home-k-project`, so the transcript is never found: no model badge, and no
// spoken announcements, for every session started from the picker. Cost a real
// debugging session — measured against a live one whose cwd was
// `/home/k/software-factory/`.
function projectDirFor(cwd) {
  // Keep the last separator when it's all there is (`/`, or `C:\`), since
  // that path really is the directory rather than a stray suffix.
  const trimmed = String(cwd).replace(/(?<=.)[\\/]+$/, '');
  return trimmed.replace(/[^a-zA-Z0-9]/g, '-');
}

function transcriptPath(cwd, claudeSessionId) {
  return path.join(os.homedir(), '.claude', 'projects', projectDirFor(cwd), `${claudeSessionId}.jsonl`);
}

// Fallback for when termhub didn't launch claude itself — a plain shell session
// where the user ran `claude` by hand, or a claude command that pinned its own
// --resume/-c/-r id we can't predict. There's no session id to map to a
// transcript, so attribute the cwd instead: Claude Code files every
// conversation under ~/.claude/projects/<encoded cwd>/, so the most-recently-
// written *.jsonl there is almost certainly the claude running in this
// directory now. `minMtimeMs` (the session's start time) rejects transcripts
// that predate this terminal — those belong to some earlier/other session, not
// this one — which is what keeps a bare shell from wearing a stale badge.
// Returns { file, mtimeMs } or null.
function findActiveTranscript(cwd, minMtimeMs) {
  const dir = path.join(os.homedir(), '.claude', 'projects', projectDirFor(cwd));
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    let mtimeMs;
    try { mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs; } catch { continue; }
    if (!best || mtimeMs > best.mtimeMs) best = { file: path.join(dir, name), mtimeMs };
  }
  if (!best) return null;
  if (minMtimeMs && best.mtimeMs < minMtimeMs) return null;
  return best;
}

// Scan the tail of a transcript for the most recent entry of interest, reading
// progressively larger windows rather than the whole file up front (these grow
// large over a long session). Each window is read from the file's end; the
// first (partial) line of a window that doesn't start at byte 0 is discarded as
// it may be a fragment cut by the window boundary. `scan(lines)` gets the
// window's complete lines in file order and returns its find, or null to ask
// for a bigger window — it should parse lazily from the end, since a window can
// hold megabytes of JSON and the answer is almost always in the last few lines.
// Shared with lib/claudeTranscript.js, which needs the same "find the newest
// entry of some shape" walk over the same files.
function scanTail(filePath, scan) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null; // not written yet, or session never got a tracked id
  }
  try {
    const size = fs.fstatSync(fd).size;
    for (const window of TAIL_STEPS_BYTES) {
      const start = Math.max(0, size - window);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start !== 0) lines.shift(); // drop a boundary-truncated first line
      const found = scan(lines);
      if (found) return found;
      if (start === 0) break; // already read the whole file; no larger window would help
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Claude Code writes its own system notices — "You've hit your individual spend
// limit", "[Request interrupted by user]" — as ordinary `assistant` entries
// carrying the placeholder model `<synthetic>` instead of a real model id. Those
// notices are by definition the *newest* assistant entry right after an
// interrupt or a limit, so taking the last model verbatim pinned the badge to a
// literal `<synthetic>` (formatModelName doesn't match it, so it passed
// straight through) until the next real turn overwrote it. Anything in angle
// brackets is a placeholder, never a model name.
function isRealModel(model) {
  return typeof model === 'string' && model !== '' && !/^<.*>$/.test(model);
}

function readLastModel(filePath) {
  return scanTail(filePath, (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      // Keep walking back past synthetic notices to the last real turn — the
      // model hasn't changed just because Claude Code interjected.
      if (entry.type === 'assistant' && entry.message && isRealModel(entry.message.model)) {
        return entry.message.model;
      }
    }
    return null;
  });
}

// Does this transcript hold a real assistant turn — i.e. is it a conversation
// rather than an empty shell? Cached on mtime because resolveTranscript runs on
// every sidebar poll and an abandoned stub's mtime never changes again, so the
// answer is computed once and then free.
const realTurnCache = new Map();
function hasRealTurn(filePath, mtimeMs) {
  const hit = realTurnCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  const value = readLastModel(filePath) !== null;
  realTurnCache.set(filePath, { mtimeMs, value });
  return value;
}

// Which transcript file backs a live session, by the same two-step rule the
// model badge uses: the conversation termhub pinned with `--session-id` at
// launch if it exists on disk, else the most recently written transcript in
// this cwd (a hand-launched or --resume'd claude). Returns a path or null.
// Shared so the model badge and the voice watcher never disagree about which
// conversation a session is.
function resolveTranscript(cwd, agentSessionId, minMtimeMs) {
  if (agentSessionId) {
    const f = transcriptPath(cwd, agentSessionId);
    let pinnedMtimeMs = null;
    try { pinnedMtimeMs = fs.statSync(f).mtimeMs; } catch { /* not written yet — fall through */ }
    if (pinnedMtimeMs !== null) {
      // The pinned file merely *existing* used to end the search, which strands a
      // session whose conversation forked: Claude Code creates the transcript for
      // the `--session-id` we passed, then a /clear or an internal resume moves the
      // real conversation to a fresh uuid and never writes to ours again. The stub
      // is left holding user/attachment entries and no assistant turn, so the badge
      // showed no model and voiceHub tailed a file that would never change again.
      if (hasRealTurn(f, pinnedMtimeMs)) return f;
      // No assistant turn yet is ambiguous: a session that just launched hasn't had
      // one either. Only a transcript *newer* than ours proves the conversation
      // moved on — while ours is the newest in the cwd it's simply young, and
      // stealing another conversation's file would be worse than waiting.
      const active = findActiveTranscript(cwd, minMtimeMs);
      if (!active || active.mtimeMs <= pinnedMtimeMs) return f;
      return active.file;
    }
  }
  const active = findActiveTranscript(cwd, minMtimeMs);
  return active ? active.file : null;
}

// "claude-sonnet-5" -> "Sonnet 5"; "claude-opus-4-8" -> "Opus 4.8";
// "claude-haiku-4-5-20251001" -> "Haiku 4.5" (drops the snapshot-date segment).
function formatModelName(raw) {
  if (!raw) return null;
  const m = /^claude-([a-z]+)-([\d.-]+)/i.exec(raw);
  if (!m) return raw;
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  const parts = m[2].split('-').filter((p) => p && !/^\d{8}$/.test(p));
  return parts.length ? `${family} ${parts.join('.')}` : family;
}

module.exports = {
  transcriptPath, findActiveTranscript, resolveTranscript, scanTail, readLastModel, formatModelName,
};
