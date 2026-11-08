'use strict';

// Read-only Cursor agent transcripts for personal-assistant (remote ingest).
//   GET /api/cursor/transcripts?since=&limit=
//   GET /api/cursor/transcript?id=<project>/<uuid>.jsonl
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const fs = require('fs');
const os = require('os');
const path = require('path');

const { MAX_TRANSCRIPT_BYTES, MAX_LIMIT } = require('./transcripts.ts');

const DEFAULT_LIMIT = 100;
const PROJECT_RE = /^[A-Za-z0-9._-]+$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.jsonl$/;
const UUID_RE = /^[0-9a-f-]{36}\.jsonl$/i;

function projectsRoot() {
  return path.join(os.homedir(), '.cursor', 'projects');
}

function realOrNull(p: any) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function inside(root: any, p: any) {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function listTranscripts({ root = projectsRoot(), since = 0, limit = DEFAULT_LIMIT }: { root?: any; since?: number | undefined; limit?: any } = {}) {
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
    if (!p.isDirectory() || !PROJECT_RE.test(p.name)) continue;
    const agentDir = path.join(root, p.name, 'agent-transcripts');
    let sessions;
    try {
      sessions = fs.readdirSync(agentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const file = `${s.name}.jsonl`;
      if (!UUID_RE.test(file)) continue;
      const full = path.join(agentDir, s.name, file);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs <= after) continue;
      out.push({
        id: `${p.name}/${file}`,
        project: p.name,
        file,
        sessionId: s.name,
        mtimeMs: Math.floor(st.mtimeMs),
        size: st.size,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, cap);
}

function resolveTranscript(id: any, { root = projectsRoot() }: { root?: any } = {}) {
  const parts = String(id || '').split('/');
  if (parts.length !== 2) return { status: 400, error: 'id must be <project>/<file>.jsonl' };
  const [project = '', file = ''] = parts;
  if (!PROJECT_RE.test(project) || !FILE_RE.test(file) || !UUID_RE.test(file)) {
    return { status: 400, error: 'not a transcript id' };
  }
  const sessionId = file.replace(/\.jsonl$/i, '');
  const realRoot = realOrNull(root);
  const real = realOrNull(path.join(root, project, 'agent-transcripts', sessionId, file));
  if (!realRoot || !real) return { status: 404, error: 'no such transcript' };
  if (!inside(realRoot, real)) return { status: 403, error: 'outside the projects directory' };
  let st;
  try { st = fs.statSync(real); } catch { return { status: 404, error: 'no such transcript' }; }
  if (!st.isFile()) return { status: 404, error: 'no such transcript' };
  if (st.size > MAX_TRANSCRIPT_BYTES) {
    return { status: 413, error: `transcript is ${st.size} bytes, over the ${MAX_TRANSCRIPT_BYTES} limit` };
  }
  return { path: real, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

function handle(req: any, res: any, url: any, { sendJson, machine = process.env.TERMHUB_MACHINE || os.hostname(), root }: { sendJson?: any; machine?: any; root?: any } = {}) {
  if (req.method !== 'GET') return false;
  const opts = root ? { root } : {};
  if (url.pathname === '/api/cursor/transcripts') {
    sendJson(res, 200, {
      machine,
      transcripts: listTranscripts({ ...opts, since: url.searchParams.get('since'), limit: url.searchParams.get('limit') }),
    });
    return true;
  }
  if (url.pathname !== '/api/cursor/transcript') return false;
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

module.exports = { handle, listTranscripts, resolveTranscript, projectsRoot };
