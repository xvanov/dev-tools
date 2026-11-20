'use strict';

// The PA chat's PreToolUse decision, after the policy has answered (D33): one
// function both engines use — the SDK engine in-process (sdkFeed.preToolUse),
// the terminal engine through the command hook its settings.json names
// (src/chat/toolHook.js). The policy (src/policy) decides by tool, action,
// channel and tags; what a rule cannot see — paths — is decided here:
//
//   - a deny refuses;
//   - the chat's actions run unasked only on an explicit policy allow, never
//     profile_delete / profile_reset, never a call tagged merge, push_main or
//     secret_reveal; otherwise they ask (no policy: ask);
//   - a policy allow for Read/Grep/Glob holds only inside the read roots
//     (pa-home, the PA's data dir — worktrees, build runs and reports, logs —
//     and the repos roots) and never on a secret-looking path (readOnly.ts);
//     Grep never searches the data dir's top (env backups, the store);
//   - the Artifact tool's list/read run unasked; its writes ask;
//   - anything else: an explicit rule's allow/ask stands, no rule defers to
//     Claude Code's own settings (null).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const gfs: typeof import('node:fs') = require('fs');
const gpath: typeof import('node:path') = require('path');
const RO = require('../policy/readOnly.ts');
const PERM = require('./permission.ts');
const { CHAT_ASK_TOOL_NAMES } = require('../mcp/chatTools.ts');

type Gate = { decision: 'allow' | 'deny' | 'ask'; reason: string };
interface PolicyRes { decision?: string; rule?: string; reason?: string; tags?: string[] }
interface ReadCtx { roots: string[]; cwd: string; dataDir?: string | null | undefined }

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const SENSITIVE = ['merge', 'push_main', 'secret_reveal'];

/**
 * Pure. The hook's answer from the policy's (see the header). null: no opinion,
 * Claude Code's own settings decide.
 */
function hookDecision(toolName: unknown, res: PolicyRes | null | undefined): Gate | null {
  if (res && res.decision === 'deny') return { decision: 'deny', reason: `denied by policy (${res.rule})${res.reason ? `: ${res.reason}` : ''}` };
  const action: string | null = PERM.chatAction(String(toolName || ''));
  if (action) {
    const explicitAllow = !!res && res.decision === 'allow' && !!res.rule && res.rule !== 'default';
    if (explicitAllow && !CHAT_ASK_TOOL_NAMES.includes(action) && !(res.tags || []).some((t) => SENSITIVE.includes(t))) return { decision: 'allow', reason: `policy rule ${res.rule}` };
    return { decision: 'ask', reason: CHAT_ASK_TOOL_NAMES.includes(action) ? 'this action cannot be undone: it asks the user' : 'this action asks the user' };
  }
  if (res && res.rule && res.rule !== 'default' && (res.decision === 'allow' || res.decision === 'ask')) return { decision: res.decision, reason: `policy rule ${res.rule}` };
  return null;
}

/**
 * Pure. The Artifact tool's look-ups (list what was shared, read a page) change
 * nothing; its publish/delete/pin share one tool name, so a settings rule cannot
 * split them: the hook allows list and read and leaves the rest to ask.
 */
function artifactRead(toolName: unknown, input: Record<string, unknown> | null | undefined): boolean {
  if (toolName !== 'Artifact') return false;
  const a = String((input && input.action) || 'publish');
  return (a === 'list' || a === 'read') && !(input && (input.file_path || input.file_paths || input.edits || input.files));
}

/** Pure. Whether a Read/Grep/Glob call may run on the policy's allow: inside a read root, off secret paths. */
function readAllowed(name: string, input: Record<string, unknown> | null | undefined, { roots, cwd, dataDir = null }: ReadCtx): boolean {
  const i = input && typeof input === 'object' ? input : {};
  const target = String(i.file_path || i.path || '');
  if (!RO.insideRoots(roots, cwd, target)) return false;
  const abs = gpath.resolve(cwd, target || '.');
  if (RO.isSecretPath(abs) || (target && RO.isSecretPath(target))) return false;
  // A glob that picks secret files out (Grep's `glob`, Glob's `pattern`).
  if ((i.glob && RO.isSecretPath(i.glob)) || (name === 'Glob' && i.pattern && RO.isSecretPath(i.pattern))) return false;
  // Grep reads contents: never across the data dir's top, which holds env backups and the store.
  if (name === 'Grep' && dataDir && RO.insideRoots([abs], abs, dataDir)) return false;
  return true;
}

/**
 * The read roots: pa-home, the PA's data dir (worktrees, build-runs,
 * build-reports, logs …), the worktrees root, the repos root (PA_REPOS_ROOT)
 * and each PA_MACHINES repos root that exists on this machine.
 */
function readRoots(home: string, cfg: any = require('../config.ts').config): string[] {
  const machines = Object.values((cfg.termhub && cfg.termhub.machines) || {}) as { reposRoot?: string }[];
  const local = machines.map((m) => String(m.reposRoot || '')).filter((p) => p && gpath.isAbsolute(p) && (() => { try { return gfs.statSync(p).isDirectory(); } catch { return false; } })());
  return [...new Set([home, cfg.dataDir, cfg.worktreesRoot, cfg.reposRoot, ...local].filter(Boolean).map((p) => gpath.resolve(String(p))))];
}

/** Pure. The whole post-policy decision for one call. */
function gate(name: string, input: Record<string, unknown> | null | undefined, res: PolicyRes | null | undefined, ctx: ReadCtx): Gate | null {
  let d = hookDecision(name, res);
  if (!d && artifactRead(name, input)) d = { decision: 'allow', reason: 'reading or listing shared artifacts changes nothing' };
  if (d && d.decision === 'allow' && READ_TOOLS.includes(name) && !readAllowed(name, input, ctx)) d = null;
  return d;
}

module.exports = { hookDecision, artifactRead, readAllowed, readRoots, gate, READ_TOOLS, SENSITIVE };
