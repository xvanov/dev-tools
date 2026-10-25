'use strict';

// Read-only access to this machine's Claude Code transcripts, for the personal
// assistant on another machine.
//
// The assistant ingests your own Claude sessions as evidence of work done
// (personal-assistant/src/ingest/claudeSessions.js). It can read its own disk,
// but a run dispatched to another machine — the fix branch it made, what it
// said it did — leaves its transcript on *that* machine's disk, and termhub is
// the one thing already reachable there. So termhub lists and serves the files
// under `~/.claude/projects/`, and nothing else:
//
//   GET /api/claude/transcripts?since=<ms>&limit=<n>   newest first, metadata only
//   GET /api/claude/transcript?id=<project>/<file>.jsonl   the file, verbatim
//
// No write route, and the id is two plain path segments checked by a strict
// pattern *and* by resolving the real path and confirming it is still inside
// the projects directory — a symlinked project folder pointing elsewhere is
// refused, not followed. Only the top level of each project folder is listed:
// subagent conversations live in `<session>/subagents/` and are not sessions
// anyone typed into (the same reason lib/claudeTranscript.js never recurses).
//
// Served by the front (front.js), not sessiond: `windows/update.ps1` swaps
// only the front and never restarts sessiond (its PTYs must survive), so a
// route in sessiond reaches a machine only when someone kills every terminal
// there. In the front it ships with the next update.
//
// This adds no capability to termhub's trust model (anyone who can reach it can
// already open a shell and `cat` these files); it only makes the read
// structured, bounded and safe to automate.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
// A transcript past this is refused rather than shipped: the reader keeps only
// a head and tail of the conversation anyway, and an unbounded read is how a
// stuck session's log takes a phone's uplink or the front's memory with it.
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

// Claude Code encodes a project's cwd by replacing every non-alphanumeric
// character with '-', and names a transcript by its session uuid. Both patterns
// are deliberately narrower than "any filename".
const PROJECT_RE = /^[A-Za-z0-9._-]+$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.jsonl$/;

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function inside(root, p) {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Newest transcripts first: [{id, project, file, mtimeMs, size}].
 * `since` (epoch ms) drops anything not modified after it.
 */
function listTranscripts({ root = projectsRoot(), since = 0, limit = DEFAULT_LIMIT } = {}) {
  const cap = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const after = Number(since) || 0;
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const p of projects) {
    if (!p.isDirectory() || !PROJECT_RE.test(p.name) || p.name === '.' || p.name === '..') continue;
    let files;
    try {
      files = fs.readdirSync(path.join(root, p.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !FILE_RE.test(f.name)) continue;
      let st;
      try {
        st = fs.statSync(path.join(root, p.name, f.name));
      } catch {
        continue; // vanished mid-scan
      }
      if (st.mtimeMs <= after) continue;
      out.push({ id: `${p.name}/${f.name}`, project: p.name, file: f.name, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, cap);
}

/**
 * The absolute path for a transcript id, or {error, status} when the id is not
 * one this route serves. Never throws.
 */
function resolveTranscript(id, { root = projectsRoot() } = {}) {
  const parts = String(id || '').split('/');
  if (parts.length !== 2) return { status: 400, error: 'id must be <project>/<file>.jsonl' };
  const [project, file] = parts;
  if (!PROJECT_RE.test(project) || project === '.' || project === '..' || !FILE_RE.test(file)) {
    return { status: 400, error: 'not a transcript id' };
  }
  const realRoot = realOrNull(root);
  const real = realOrNull(path.join(root, project, file));
  if (!realRoot || !real) return { status: 404, error: 'no such transcript' };
  if (!inside(realRoot, real)) return { status: 403, error: 'outside the projects directory' };
  let st;
  try {
    st = fs.statSync(real);
  } catch {
    return { status: 404, error: 'no such transcript' };
  }
  if (!st.isFile()) return { status: 404, error: 'no such transcript' };
  if (st.size > MAX_TRANSCRIPT_BYTES) return { status: 413, error: `transcript is ${st.size} bytes, over the ${MAX_TRANSCRIPT_BYTES} limit` };
  return { path: real, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

/**
 * The two GET routes, for the front. Returns true when it answered.
 * `sendJson(res, status, body)` is the caller's, so errors look like every
 * other route's.
 */
function handle(req, res, url, { sendJson, machine = process.env.TERMHUB_MACHINE || os.hostname(), root } = {}) {
  if (req.method !== 'GET') return false;
  const opts = root ? { root } : {};
  if (url.pathname === '/api/claude/transcripts') {
    sendJson(res, 200, {
      machine,
      transcripts: listTranscripts({ ...opts, since: url.searchParams.get('since'), limit: url.searchParams.get('limit') }),
    });
    return true;
  }
  if (url.pathname !== '/api/claude/transcript') return false;
  const found = resolveTranscript(url.searchParams.get('id'), opts);
  if (found.error) {
    sendJson(res, found.status, { error: found.error });
    return true;
  }
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Content-Length': found.size,
    'X-Transcript-Mtime': String(found.mtimeMs),
    'Cache-Control': 'no-store',
  });
  // A live session may append while this streams; the reader tolerates a
  // short or half-written last line, so no lock and no snapshot.
  if (!found.size) {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(found.path, { start: 0, end: found.size - 1 });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
  return true;
}

module.exports = { handle, listTranscripts, resolveTranscript, projectsRoot, MAX_TRANSCRIPT_BYTES, MAX_LIMIT };
