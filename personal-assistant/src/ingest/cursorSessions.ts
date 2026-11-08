'use strict';

//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveItems } = require('./store.ts');
const { parseCursorTranscript, toItem } = require('./agentTranscript.ts');
const { logger } = require('../log.ts');

const log = logger('cursor-sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.cursor', 'projects');
const MAX_SESSIONS_PER_PASS = 40;

function transcriptFiles() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out: any[] = [];
  for (const project of fs.readdirSync(PROJECTS_DIR)) {
    const agentRoot = path.join(PROJECTS_DIR, project, 'agent-transcripts');
    let sessions: any;
    try {
      sessions = fs.readdirSync(agentRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const p = path.join(agentRoot, s.name, `${s.name}.jsonl`);
      try {
        out.push({ path: p, mtime: fs.statSync(p).mtimeMs, id: `${project}/${s.name}.jsonl` });
      } catch {
        /* gone */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS_PER_PASS);
}

async function run() {
  const files = transcriptFiles();
  if (!files.length) {
    log.debug('no cursor transcripts found', { dir: PROJECTS_DIR });
    return 0;
  }
  const items: any[] = [];
  for (const f of files) {
    let text: any;
    try {
      text = fs.readFileSync(f.path, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseCursorTranscript(text);
    if (!parsed.turns.length) continue;
    items.push(toItem(parsed, f.id, { source: 'cursor_session' }));
  }
  return saveItems('cursor_session', items, {
    source: 'cursor_session',
    deltaToken: null as any,
    state: { scanned: files.length },
  });
}

module.exports = { run, id: 'cursor_session', parseCursorTranscript, toItem, transcriptFiles };
