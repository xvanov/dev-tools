'use strict';

// Claude Code asks "Is this a project you trust?" the first time it opens a
// folder, and every run's worktree is a folder it has never seen. The answer
// lives in ~/.claude.json (`projects[<path>].hasTrustDialogAccepted`), and a
// folder inside a trusted one is trusted too — so the worktrees root is marked
// once, and no run's session stops at the question.
//
// The file is Claude Code's own and is rewritten by every running session, so
// this writes only when the mark is missing, and atomically (temp + rename).
// termhub.briefClaude still answers the question if it shows up anyway.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** ~/.claude.json: Claude Code's own file, kept whole except for the one mark. */
type ClaudeConfig = { projects?: Record<string, { hasTrustDialogAccepted?: boolean; [k: string]: unknown }>; [k: string]: unknown };

const fs = require('fs');
const os = require('os');
const path = require('path');

const key = (dir: string): string => path.resolve(dir).replace(/\\/g, '/');

/** Pure: the config with `dir` trusted, or null when it already is. */
function withTrust(cfg: ClaudeConfig, dir: string): ClaudeConfig | null {
  const k = key(dir);
  const projects = cfg.projects || {};
  const cur = projects[k] || projects[path.resolve(dir)];
  if (cur && cur.hasTrustDialogAccepted) return null;
  return { ...cfg, projects: { ...projects, [k]: { ...(cur || {}), hasTrustDialogAccepted: true } } };
}

function ensureTrusted(dir: string, file: string = path.join(os.homedir(), '.claude.json')): boolean {
  let cfg: ClaudeConfig;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false; // no Claude config yet, or mid-write: the screen check answers instead
  }
  const next = withTrust(cfg, dir);
  if (!next) return false;
  const tmp = `${file}.pa-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  return true;
}

module.exports = { ensureTrusted, withTrust, key };
