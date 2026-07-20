'use strict';

// Reads which model an `opencode` session is currently using. Unlike Claude
// Code, opencode has no local transcript file we can just tail — its sessions
// live in a SQLite DB and there's no flag to pin a fresh session's id up front
// (`-s/--session` only continues an EXISTING one). So termhub has to go
// through opencode's own CLI: discover the session id by asking `opencode
// session list` (scoped to the terminal's directory) shortly after spawn, then
// periodically `opencode export <id>` to read its current model. Both are real
// subprocess spawns of a bun-compiled binary (~1.4s each, measured) — too slow
// to call on every UI poll, so callers must throttle (see lib/session.js).

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { findOnPath } = require('./shell');

const execFileP = promisify(execFile);

// opencode always reports `directory` in native-OS form (backslashes on
// Windows) regardless of how a path was spelled when opencode was launched —
// confirmed live: a cwd passed with forward slashes still came back
// backslash-separated, so a strict string compare silently matched nothing.
// path.normalize() also converts separators on Windows, so this closes both.
function normPath(p) {
  return path.normalize(String(p)).replace(/[\\/]+$/, '');
}

let binPath; // resolved once and cached — null means "not found on PATH"
function resolveBin() {
  if (binPath === undefined) binPath = findOnPath(['opencode']);
  return binPath;
}

// The Windows install is a `.cmd` shim; CreateProcess can't launch that
// directly (confirmed: throws EINVAL without a shell), so route through a
// shell only where that's actually necessary.
function run(args, cwd) {
  const bin = resolveBin();
  if (!bin) return Promise.reject(new Error('opencode not found on PATH'));
  return execFileP(bin, args, { cwd, shell: process.platform === 'win32', timeout: 10000 });
}

async function listSessions(cwd) {
  const { stdout } = await run(['session', 'list', '--format', 'json'], cwd);
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [];
}

// Best-effort correlation: find the newest session opencode recorded for this
// exact directory, created no earlier than shortly before we spawned the PTY.
//
// opencode doesn't create a session record on launch — only once the user
// sends its first message (confirmed live: an idle, freshly-spawned session is
// simply absent from `session list` even after several seconds). So this can't
// give up after a short fixed window the way it might for a slow-starting
// process: a user who reads the welcome screen for a minute before typing
// anything would otherwise never get a model badge. Instead: a quick burst of
// retries to catch the common case fast, then settle into indefinite slow
// polling for as long as the terminal stays open and unattributed. Each check
// is a real ~1.4s subprocess spawn, so the slow interval keeps that cheap over
// a long-lived idle terminal. Only stops early when found or aborted (session
// killed — see lib/session.js's kill()).
const DISCOVERY_BURST_MS = [2000, 3000, 5000, 8000, 12000, 20000];
const DISCOVERY_IDLE_INTERVAL_MS = 30000;
const CREATED_SKEW_MS = 5000; // opencode's own timestamp can lag our spawn call slightly

async function discoverSessionId(cwd, spawnedAtMs, isAborted) {
  const targetDir = normPath(cwd);
  const delays = DISCOVERY_BURST_MS[Symbol.iterator]();
  while (!isAborted()) {
    const next = delays.next();
    await new Promise((r) => setTimeout(r, next.done ? DISCOVERY_IDLE_INTERVAL_MS : next.value));
    if (isAborted()) return null;
    try {
      const sessions = await listSessions(cwd);
      const candidates = sessions.filter((s) => normPath(s.directory) === targetDir && s.created >= spawnedAtMs - CREATED_SKEW_MS);
      if (candidates.length) {
        candidates.sort((a, b) => b.created - a.created);
        return candidates[0].id;
      }
    } catch {
      // opencode not installed, or a transient error — keep trying
    }
  }
  return null;
}

// `export` prints the JSON on stdout; slicing from the first `{` is a cheap
// guard against any incidental preamble text without needing to special-case it.
async function getModel(cwd, sessionId) {
  try {
    const { stdout } = await run(['export', sessionId], cwd);
    const json = JSON.parse(stdout.slice(stdout.indexOf('{')));
    const model = json && json.info && json.info.model;
    return model && model.id ? { id: model.id, providerID: model.providerID || null } : null;
  } catch {
    return null;
  }
}

// "big-pickle" -> "Big Pickle". opencode spans 75+ providers with no shared
// naming convention (unlike Claude's predictable claude-<family>-<version>), so
// this is deliberately generic rather than trying to parse a family/version out
// of it — matches the humanized name opencode's own TUI footer shows.
function formatModelLabel(id) {
  if (!id) return null;
  return id.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

module.exports = { discoverSessionId, getModel, formatModelLabel };
