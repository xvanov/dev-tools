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
//     the real path behind a link or junction is judged too; Grep never takes
//     a glob that could pick a credential (rg's globs override its hidden and
//     ignore rules) and runs with credential exclusions added (updatedInput:
//     it searches dot files);
//   - a read-only Bash command (policy rule chat-readonly-bash-allow) holds
//     only from a shell outside secret dirs, with every tree its `rg` searches
//     inside the read roots and off the data dir's top;
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

type Gate = { decision: 'allow' | 'deny' | 'ask'; reason: string; updatedInput?: Record<string, unknown> };
interface PolicyRes { decision?: string; rule?: string; reason?: string; tags?: string[] }
interface ReadCtx {
  roots: string[];
  cwd: string;
  dataDir?: string | null | undefined;
  // The real path behind a link or junction (null: none, or it does not exist); defaults to the file system.
  realpath?: ((p: string) => string | null) | undefined;
  homedir?: string | undefined;
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const SENSITIVE = ['merge', 'push_main', 'secret_reveal'];
const READONLY_BASH_RULE = 'chat-readonly-bash-allow';

/**
 * Pure. The hook's answer from the policy's (see the header). null: no opinion,
 * Claude Code's own settings decide.
 */
function hookDecision(toolName: unknown, res: PolicyRes | null | undefined): Gate | null {
  if (res && res.decision === 'deny') return { decision: 'deny', reason: `denied by policy (${res.rule})${res.reason ? `: ${res.reason}` : ''}` };
  const sensitive = !!res && (res.tags || []).some((t) => SENSITIVE.includes(t));
  const action: string | null = PERM.chatAction(String(toolName || ''));
  if (action) {
    const explicitAllow = !!res && res.decision === 'allow' && !!res.rule && res.rule !== 'default';
    if (explicitAllow && !CHAT_ASK_TOOL_NAMES.includes(action) && !sensitive) return { decision: 'allow', reason: `policy rule ${res.rule}` };
    return { decision: 'ask', reason: CHAT_ASK_TOOL_NAMES.includes(action) ? 'this action cannot be undone: it asks the user' : 'this action asks the user' };
  }
  // A merge, a push to main or a secret reveal asks whatever tool makes it, even when an override rule allows the tool.
  if (sensitive && res && res.decision === 'allow') return { decision: 'ask', reason: `a ${(res.tags || []).filter((t) => SENSITIVE.includes(t)).join('/')} call asks the user` };
  if (res && res.rule && res.rule !== 'default' && (res.decision === 'allow' || res.decision === 'ask')) return { decision: res.decision, reason: `policy rule ${res.rule}` };
  return null;
}

function fsRealpath(p: string): string | null {
  try {
    return gfs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Whether an absolute path, and the real path behind it (a link or junction), stays inside the roots and off secrets. */
function placeAllowed(abs: string, { roots, realpath = fsRealpath }: ReadCtx): boolean {
  if (!RO.insideRoots(roots, abs, abs)) return false;
  const real = realpath(abs);
  if (!real) return !RO.isSecretPath(abs);
  // The real path names what is opened (a short name like GIT-CR~1 comes back long); a root may itself be a junction.
  const realRoots = [...roots, ...roots.map((r) => realpath(r)).filter((r): r is string => !!r)];
  return RO.insideRoots(realRoots, real, real) && !RO.isSecretPath(real);
}

// What a Grep over a directory leaves out (Claude Code's Grep searches dot files; only .gitignore keeps
// .env out, and only in a git repo). Credential-shaped names only: a broad `*token*` would hide code silently.
const GREP_EXCLUDE = ['.env*', '*.env', 'env.before-*', '.envrc', '*.pem', '*.key', '*.pfx', '*.p12', '*.ppk', '*.jks', '*.keystore', '*.kdbx', '*.tfstate',
  '*.sqlite*', '*.dump', '*.pabak', '*.sealed', '*_history', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.npmrc', '.netrc', '_netrc', '.pgpass', '.pypirc',
  '.git-credentials', '.claude.json', '*credential*', '*client_secret*', 'secrets.*', '*.secret*', '.ssh', '.aws', '.azure', '.gnupg', '.docker', '.kube'];
// rg globs are case-sensitive; Windows names are not.
const ci = (g: string): string => g.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const GREP_EXCLUDE_GLOB = GREP_EXCLUDE.map((g) => `!**/${ci(g)}`).join(' ');

/** Pure. Grep's input with the credential exclusions appended to its glob (an exclusion given last wins in rg). */
function grepExcluding(input: Record<string, unknown>): Record<string, unknown> {
  const g = String(input.glob || '').trim();
  return { ...input, glob: g ? `${g} ${GREP_EXCLUDE_GLOB}` : GREP_EXCLUDE_GLOB };
}

/**
 * Whether a read-only Bash command (readOnly.ts) may run unasked from this
 * shell: the shell is not in a secret directory, and each tree an `rg`
 * searches stays inside the read roots and never takes in the data dir's top
 * (env backups, the store), as for the Grep tool.
 */
function bashAllowed(input: Record<string, unknown> | null | undefined, ctx: ReadCtx): boolean {
  const v = RO.readOnlyBash(input && input.command);
  if (!v.ok) return false;
  if (RO.isSecretPath(ctx.cwd)) return false;
  const home = ctx.homedir || require('os').homedir();
  return (v.searches || []).every((s: string) => {
    const abs = gpath.resolve(ctx.cwd, s.replace(/^~(?=\/|$)/, home));
    return placeAllowed(abs, ctx) && !(ctx.dataDir && RO.insideRoots([abs], abs, ctx.dataDir));
  });
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
function readAllowed(name: string, input: Record<string, unknown> | null | undefined, ctx: ReadCtx): boolean {
  const { roots, cwd, dataDir = null } = ctx;
  const i = input && typeof input === 'object' ? input : {};
  const target = String(i.file_path || i.path || '');
  if (!RO.insideRoots(roots, cwd, target)) return false;
  const abs = gpath.resolve(cwd, target || '.');
  if (target && RO.isSecretPath(target)) return false;
  // Off secrets, and a link or junction inside a root must not lead out of the roots or onto a secret.
  if (!placeAllowed(abs, ctx)) return false;
  // A glob that picks secret files out: Grep's `glob` overrides rg's hidden/ignore rules, so `*` alone reaches .env.
  if (i.glob && RO.globMaySelectSecret(i.glob)) return false;
  // Glob's pattern only lists names, but stays under its path: no secret directory, no `..`, no absolute pattern.
  if (name === 'Glob' && i.pattern && (RO.isSecretPath(i.pattern) || /(^|[\\/])\.\.([\\/]|$)/.test(String(i.pattern)) || /^([a-z]:)?[\\/]|^~/i.test(String(i.pattern)))) return false;
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
  if (d && d.decision === 'allow' && name === 'Bash' && res && res.rule === READONLY_BASH_RULE && !bashAllowed(input, ctx)) d = null;
  // An allowed Grep runs with the credential exclusions added (it searches dot files).
  if (d && d.decision === 'allow' && name === 'Grep') d = { ...d, updatedInput: grepExcluding(input || {}) };
  return d;
}

module.exports = { hookDecision, artifactRead, readAllowed, bashAllowed, grepExcluding, readRoots, gate, READ_TOOLS, SENSITIVE, GREP_EXCLUDE_GLOB };
