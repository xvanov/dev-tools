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

const TAIL_BYTES = 8192; // plenty for the last couple of turns without reading a whole long transcript

// Claude Code's own project-folder naming: every non-alphanumeric character
// (path separators, drive-letter colon, dots, …) becomes a hyphen. Verified
// against this machine's real ~/.claude/projects entries, e.g.
// `C:\source\dev-tools\termhub` -> `C--source-dev-tools-termhub`.
function projectDirFor(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function transcriptPath(cwd, claudeSessionId) {
  return path.join(os.homedir(), '.claude', 'projects', projectDirFor(cwd), `${claudeSessionId}.jsonl`);
}

// Scan the tail of the transcript for the most recent assistant turn's model.
// Reads only the last TAIL_BYTES (these files grow large over a long session)
// rather than the whole thing every time this is polled.
function readLastModel(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null; // not written yet, or session never got a tracked id
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // a truncated first line from the tail cut, e.g. — skip it
      if (entry.type === 'assistant' && entry.message && entry.message.model) return entry.message.model;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
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

module.exports = { transcriptPath, readLastModel, formatModelName };
