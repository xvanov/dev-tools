'use strict';

// Cursor Agent CLI conversation transcripts — same job as lib/claudeModel.js for
// Claude Code. Files live under:
//   ~/.cursor/projects/<slug>/agent-transcripts/<session-id>/<session-id>.jsonl
//
// The slug encodes the workspace cwd (`C:\repos\dev-tools` → `C-repos-dev-tools`).
// Verified against this machine's ~/.cursor/projects layout (Oct 2026).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TAIL_STEPS_BYTES = [65536, 524288, 4194304];

function projectDirFor(cwd: any) {
  const trimmed = String(cwd).replace(/[\\/]+$/, '');
  return trimmed.replace(/[:\\\/]/g, '-');
}

function transcriptPath(cwd: any, sessionId: any) {
  return path.join(
    os.homedir(),
    '.cursor',
    'projects',
    projectDirFor(cwd),
    'agent-transcripts',
    sessionId,
    `${sessionId}.jsonl`
  );
}

function projectsRoot() {
  return path.join(os.homedir(), '.cursor', 'projects');
}

function findActiveTranscript(cwd: any, minMtimeMs: any) {
  const dir = path.join(projectsRoot(), projectDirFor(cwd), 'agent-transcripts');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const file = path.join(dir, d.name, `${d.name}.jsonl`);
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
  }
  if (!best) return null;
  if (minMtimeMs && best.mtimeMs < minMtimeMs) return null;
  return best;
}

function scanTail(filePath: any, scan: any) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    for (const window of TAIL_STEPS_BYTES) {
      const start = Math.max(0, size - window);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start !== 0) lines.shift();
      const found = scan(lines);
      if (found) return found;
      if (start === 0) break;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function readLastModel(filePath: any) {
  return scanTail(filePath, (lines: any) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.role === 'assistant' && entry.message && typeof entry.message.model === 'string') {
        const m = entry.message.model.trim();
        if (m && !/^<.*>$/.test(m)) return m;
      }
    }
    return null;
  });
}

const realTurnCache = new Map();
function hasRealTurn(filePath: any, mtimeMs: any) {
  const hit = realTurnCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  const value = readLastModel(filePath) !== null || scanTail(filePath, (lines: any) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.role === 'assistant' && e.message) return true;
      } catch { /* skip */ }
    }
    return null;
  }) !== null;
  realTurnCache.set(filePath, { mtimeMs, value });
  return value;
}

function resolveTranscript(cwd: any, agentSessionId: any, minMtimeMs: any) {
  if (agentSessionId) {
    const f = transcriptPath(cwd, agentSessionId);
    let pinnedMtimeMs = null;
    try { pinnedMtimeMs = fs.statSync(f).mtimeMs; } catch { /* fall through */ }
    if (pinnedMtimeMs !== null) {
      if (hasRealTurn(f, pinnedMtimeMs)) return f;
      const active = findActiveTranscript(cwd, minMtimeMs);
      if (!active || active.mtimeMs <= pinnedMtimeMs) return f;
      return active.file;
    }
  }
  const active = findActiveTranscript(cwd, minMtimeMs);
  return active ? active.file : null;
}

function formatModelName(raw: any) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.replace(/^gpt-/i, 'GPT ').replace(/^claude-/i, (m) => m[0]!.toUpperCase() + m.slice(1));
}

function agentBinFromCommand(command: any) {
  const s = String(command || '').trim();
  if (!s) return 'agent';
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    return end === -1 ? s.slice(1) : s.slice(1, end);
  }
  const m = /^\S+/.exec(s);
  return m ? m[0] : 'agent';
}

/** Sync spawn: `agent create-chat` → session uuid (stdout). */
function createChat(command: any) {
  const bin = agentBinFromCommand(command);
  const out = execFileSync(bin, ['create-chat'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  }).trim();
  if (!/^[0-9a-f-]{36}$/i.test(out)) {
    throw new Error(`create-chat returned unexpected id: ${out.slice(0, 80)}`);
  }
  return out;
}

module.exports = {
  projectDirFor,
  transcriptPath,
  projectsRoot,
  findActiveTranscript,
  resolveTranscript,
  scanTail,
  readLastModel,
  formatModelName,
  createChat,
  agentBinFromCommand,
};
