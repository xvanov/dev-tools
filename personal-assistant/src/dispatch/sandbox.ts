'use strict';

// PA_SANDBOX=on (default off, native plan 5.2/5.3): a dispatched Claude
// session starts inside the factory's OS sandbox (software-factory
// factory/sandbox: bubblewrap on Linux, a restricted low-integrity token on
// Windows) with no GitHub token, no SSH key and no gh login, egress through
// the allowlist proxy, and a credential broker that pushes / opens a draft PR
// for it, capped at the ceiling its mode maps to (`sbx push`, `sbx pr`).
//
// One process per run outside the sandbox holds the proxy and the broker:
// `python -m factory.sandbox.host`, started from the factory checkout
// (PA_FACTORY_PATH), alive for the session (--ttl), and its argv prefix is put
// in front of the agent's command.
//
// Scope today: `plan` sessions only. A sandboxed session reads the worktree's
// git data but cannot write it (the repo's shared .git holds hooks and config
// the operator's own git runs), so it cannot commit, and the end of a code run
// delivers commits. Until the broker can commit a session's tree, a code mode
// with PA_SANDBOX=on is refused rather than run unsandboxed.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type ErrorWithCode = import('../types.ts').ErrorWithCode;
/** What `python -m factory.sandbox.host --spec` reads (software-factory factory/sandbox). */
type HostSpec = { run_id: string; workdir: string; state_dir: string; ceiling: string; extra_readable: string[]; pass_env: string[]; trusted_repo?: string; source?: string; branch_prefix?: string };

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CEILING_BY_MODE: Record<string, string> = { plan: 'none', local: 'none', branch: 'push_branch', mr: 'draft_pr', full: 'draft_pr' };
const SANDBOXABLE_MODES = ['plan'];

function enabled(env: Record<string, string | undefined> = process.env) {
  return /^(on|1|true|yes)$/i.test(String(env.PA_SANDBOX || '').trim());
}

/** The broker ceiling for a session mode; unknown → none (fail safe). */
function ceilingFor(mode: string | null | undefined): string {
  return CEILING_BY_MODE[String(mode || '').toLowerCase()] || 'none';
}

/** Throws (code `sandbox_mode`) when PA_SANDBOX=on cannot cover this mode. */
function requireSandboxable(mode: string | null | undefined) {
  if (SANDBOXABLE_MODES.includes(String(mode || '').toLowerCase())) return;
  const err: ErrorWithCode = new Error(
    `PA_SANDBOX=on: a ${mode} session would run sandboxed and could not commit (only plan sessions are sandboxed so far) — ` +
      'run it as plan, or turn PA_SANDBOX off for this run'
  );
  err.code = 'sandbox_mode';
  throw err;
}

/** The factory venv's interpreter under PA_FACTORY_PATH. */
function factoryPython(factoryPath: string, platformId: string = process.platform === 'win32' ? 'windows' : 'posix') {
  return platformId === 'windows'
    ? path.join(factoryPath, '.venv', 'Scripts', 'python.exe')
    : path.join(factoryPath, '.venv', 'bin', 'python');
}

/** The host's spec: what the sandbox may touch and what the broker may do. */
function hostSpec({ runId, workdir, stateDir, mode, repoPath = null, branch = null, claudeBin = null, passEnv = null }: { runId: number | string; workdir: string; stateDir: string; mode: string; repoPath?: string | null; branch?: string | null; claudeBin?: string | null; passEnv?: string | null }): HostSpec {
  const spec: HostSpec = {
    run_id: `pa-${runId}`,
    workdir,
    state_dir: stateDir,
    ceiling: ceilingFor(mode),
    extra_readable: claudeBin ? [claudeBin] : [],
    pass_env: (passEnv || 'CLAUDE_CODE_OAUTH_TOKEN').split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (repoPath) {
    spec.trusted_repo = repoPath; // the push URL is read here, before the sandbox exists
    spec.source = workdir;
    if (branch) spec.branch_prefix = branch;
  }
  return spec;
}

function quote(arg: unknown, fam: string) {
  const s = String(arg);
  if (fam === 'windows') return /^[\w.:\\/=-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
  return /^[\w.:/=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The agent's command line, started inside the sandbox (termhub's shell). */
function wrapCommand(wrapArgv: string[], command: string, fam = 'posix') {
  if (!Array.isArray(wrapArgv) || !wrapArgv.length) throw new Error('sandbox: empty wrap');
  const prefix = wrapArgv.map((a) => quote(a, fam)).join(' ');
  return `${fam === 'windows' ? '& ' : ''}${prefix} ${String(command).trim()}`;
}

/** What the agent is told when it runs sandboxed. */
const BRIEF_NOTE = [
  '## Sandbox',
  '',
  'This session runs in a sandbox: no GitHub token, no SSH key, no gh login, and only allowlisted',
  'hosts are reachable. Pushes and pull requests go through the run\'s broker, never git/gh directly:',
  '`sbx push <branch>` and `sbx pr --head <branch> --title "..."` (a draft, if this run may open one).',
  '`sbx info` says what this run may do.',
  '',
].join('\n');

/**
 * Start the run's sandbox host and wait until it is ready.
 * @returns {Promise<{wrap: string[], policy: string, pid: number}>}
 */
async function start({ factoryPath, spec, stateDir, ttlSeconds = 12 * 3600, readyTimeoutMs = 60_000, spawnFn = spawn, platformId }: { factoryPath: string; spec: HostSpec; stateDir: string; ttlSeconds?: number; readyTimeoutMs?: number; spawnFn?: (cmd: string, args: string[], opts: object) => any; platformId?: string }): Promise<{ wrap: string[]; policy: string; pid: number }> {
  if (!factoryPath) throw new Error('PA_SANDBOX=on needs PA_FACTORY_PATH (the sandbox lives in the factory)');
  fs.mkdirSync(stateDir, { recursive: true });
  const specPath = path.join(stateDir, 'host-spec.json');
  const readyPath = path.join(stateDir, 'host-ready.json');
  try { fs.rmSync(readyPath, { force: true }); } catch { /* fresh */ }
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  const child = spawnFn(
    factoryPython(factoryPath, platformId),
    ['-I', '-m', 'factory.sandbox.host', '--spec', specPath, '--out', readyPath, '--ttl', String(ttlSeconds)],
    { cwd: factoryPath, detached: true, stdio: 'ignore', windowsHide: true }
  );
  if (child && typeof child.unref === 'function') child.unref();
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyPath)) {
      const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      return { wrap: ready.wrap, policy: ready.policy, pid: ready.pid };
    }
    if (child && child.exitCode != null) throw new Error(`sandbox host exited (${child.exitCode}) before it was ready`);
    await new Promise((r) => setTimeout(r, 200));
  }
  try { if (child && child.pid) process.kill(child.pid); } catch { /* gone */ }
  throw new Error('sandbox host was not ready in time');
}

module.exports = { CEILING_BY_MODE, SANDBOXABLE_MODES, enabled, ceilingFor, requireSandboxable, factoryPython, hostSpec, wrapCommand, BRIEF_NOTE, start };
