'use strict';

// Remote dispatch: a run on another machine's termhub (PA_MACHINES), Windows,
// Linux or macOS.
//
// Some work belongs on a particular machine — the VM that runs the service,
// holds the OneDrive sync, has the credentials — and you watch it from the
// same termhub hub as everything else. The dispatcher cannot touch that
// machine's disk, so it asks that machine's termhub to do there what it does
// here, then checks the result through termhub's own API before Claude starts:
//
//   1. `git fetch` and `git worktree add -b pa/<run>-<slug>` under
//      `<reposRoot>/.pa-worktrees/run-<id>` — the main checkout on that machine
//      is never the agent's working tree, exactly as here.
//   2. For a mode that may not push, every remote's pushurl is pointed at the
//      dead address — in the WORKTREE's own config (extensions.worktreeConfig),
//      so the main checkout and other runs can still push — and then read back:
//      the worktree must report the dead address and the main checkout must
//      not. If either check fails the run fails. Same enforcement as a local
//      run, applied on that machine, and verified rather than assumed.
//   3. BRIEF.md written into the worktree from stdin (never a command line),
//      and its size read back.
//   4. The worktree must exist (`/api/dirs`) before the session is opened in
//      it and `claude` is typed.
//
// All of that goes through termhub's `POST /api/exec` (src/dispatch/exec.ts):
// argv arrays, no shell, each step's exit code checked. An older termhub
// without that route gets the old way — the same steps TYPED into a fresh
// shell (PowerShell on Windows, POSIX sh on Linux/macOS) — but only for a mode
// that may push: a push block that was typed cannot be read back, and an
// unverified block is not enforcement, so a no-push run on such a machine is
// refused with "update termhub there".
//
// What does not cross the wire: `pa review/diff/land` run git on this
// machine's disk, so for a remote run they say so and point at the session.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type ErrorWithCode = import('../types.ts').ErrorWithCode;
/** 'windows' | 'linux' | 'macos' (config.ts MACHINE_OS). */
type Os = string;
type Family = 'windows' | 'posix';
/** A PA_MACHINES entry (config.ts). */
type Machine = { name: string; url: string; reposRoot: string; os?: Os | null };
/** exec.ts's runCommand result, the fields used here. */
type RunResult = { code: number; stdout: string; stderr: string; error?: string };
type RunOptions = { timeoutMs?: number; stdin?: string; env?: Record<string, string> };
type Run = (argv: string[], opts?: RunOptions) => Promise<RunResult>;
/** A termhub client (termhub.ts client(), or a test's stand-in). */
type Hub = Json;
type Mode = { name: string; mayPush: boolean };
type NoPush = { env: Record<string, string>; unsetEnv: string[] };
type SetupSpec = { repo: string; worktree: string; branch: string; mayPush: boolean; brief: string; blockedPushUrl: string };

const { config, MACHINE_OS } = require('../config.ts');
const { runCommand } = require('./exec.ts');

const CHUNK = 1800;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

// PowerShell single-quoted literal: '' is the only escape.
// PowerShell single-quoted literal. PowerShell also reads the curly quotes
// ‘ ’ ‚ ‛ as single quotes, so each is doubled too, or one in a path or a
// title ends the string early.
function psq(text: unknown): string {
  return `'${String(text).replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

// POSIX sh single-quoted literal: close, escaped quote, reopen.
function shq(text: unknown): string {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// ---- which OS, and its paths ----------------------------------------------

const isWindowsPath = (p: unknown): boolean => /^[A-Za-z]:([\\/]|$)|^\\\\/.test(String(p));
const isPosixPath = (p: unknown): boolean => String(p).startsWith('/');

/** 'windows' | 'posix' — how paths are written there. */
function family(os: Os | null | undefined): Family {
  return os === 'windows' ? 'windows' : 'posix';
}

/**
 * Pure: the OS a machine is known to run without asking it — PA_MACHINES' own
 * field, else read off the repos root (`C:\…` vs `/…`). null when neither says.
 */
function declaredOs(machine: Pick<Machine, 'os' | 'reposRoot'>): Os | null {
  if (machine.os) return machine.os;
  if (isWindowsPath(machine.reposRoot)) return 'windows';
  if (isPosixPath(machine.reposRoot)) return 'linux';
  return null;
}

/** termhub's `process.platform` → our name for it. */
function platformOs(platform: unknown): Os | null {
  return MACHINE_OS[String(platform || '').toLowerCase()] || null;
}

/**
 * The machine's OS: PA_MACHINES' field, else what its termhub reports, else
 * the repos root's shape — and refuses a configuration that contradicts
 * itself (a Windows box with a `/home/...` repos root cannot work). `hub` is
 * that machine's termhub client.
 */
async function resolveOs(machine: Machine, hub: Hub): Promise<Os> {
  let reported: Os | null = null;
  try {
    reported = platformOs((await hub.api('/api/info', { timeoutMs: 5000 }))?.platform);
  } catch {
    /* unreachable now; the steps after this will say so */
  }
  const os = machine.os || reported || declaredOs(machine);
  if (!os) throw new Error(`cannot tell what OS ${machine.name} runs — add |windows, |linux or |macos to its PA_MACHINES entry`);
  if (machine.os && reported && machine.os !== reported) {
    throw new Error(`${machine.name} is configured as ${machine.os} but its termhub reports ${reported} — fix PA_MACHINES`);
  }
  const shapeOk = family(os) === 'windows' ? isWindowsPath(machine.reposRoot) : isPosixPath(machine.reposRoot);
  if (!shapeOk) {
    throw new Error(`${machine.name} runs ${os}, but its repos root ${machine.reposRoot} is not a ${os} path — fix PA_MACHINES`);
  }
  return os;
}

function joinFor(fam: Family, root: string, ...parts: string[]): string {
  const sep = fam === 'windows' ? '\\' : '/';
  const base = String(root).replace(/[\\/]+$/, '');
  return [fam === 'posix' && base === '' ? '' : base, ...parts].join(sep) || sep;
}

function machineFamily(machine: Pick<Machine, 'os' | 'reposRoot'>): Family {
  return family(declaredOs(machine) || 'windows');
}

/** Where a repo lives on that machine: same folder name, under its repos root. */
function remoteRepoPath(machine: Pick<Machine, 'os' | 'reposRoot'>, localRepoPath: string): string {
  const name = String(localRepoPath).replace(/[\\/]+$/, '').split(/[\\/]/).pop() as string;
  return joinFor(machineFamily(machine), machine.reposRoot, name);
}

function remoteWorktreePath(machine: Pick<Machine, 'os' | 'reposRoot'>, runId: number | string): string {
  return joinFor(machineFamily(machine), machine.reposRoot, '.pa-worktrees', `run-${runId}`);
}

// Directory listings from termhub are compared the way that OS compares names.
function samePath(fam: Family, a: string, b: string): boolean {
  const norm = (p: string): string => String(p).replace(/[\\/]+$/, '');
  return fam === 'windows' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// ---- the typed fallback (a termhub without /api/exec) ----------------------

/**
 * Pure: the shell lines that set a remote run up, in order, typed one per line
 * into a session on that machine. PowerShell for `os: 'windows'` (the
 * default), POSIX sh otherwise. Only used against a termhub too old for
 * /api/exec, and only for modes that may push (see the header).
 */
function setupLines({ repo, worktree, branch, mayPush, brief, blockedPushUrl, os = 'windows' }: SetupSpec & { os?: Os }): string[] {
  if (family(os) === 'posix') return posixSetupLines({ repo, worktree, branch, mayPush, brief, blockedPushUrl });
  const lines = [
    `git -C ${psq(repo)} fetch origin --prune`,
    `$paBase = git -C ${psq(repo)} symbolic-ref --short refs/remotes/origin/HEAD 2>$null; if (-not $paBase) { $paBase = 'origin/main' }`,
    `git -C ${psq(repo)} worktree add -b ${psq(branch)} ${psq(worktree)} $paBase`,
  ];
  if (!mayPush) {
    lines.push(
      `git -C ${psq(repo)} config extensions.worktreeConfig true`,
      `git -C ${psq(worktree)} config --worktree remote.origin.pushurl ${psq(blockedPushUrl)}`
    );
  }
  const b64 = Buffer.from(brief, 'utf8').toString('base64');
  lines.push(`$paBrief = ''`);
  for (let i = 0; i < b64.length; i += CHUNK) lines.push(`$paBrief += '${b64.slice(i, i + CHUNK)}'`);
  lines.push(
    `[IO.File]::WriteAllText((Join-Path ${psq(worktree)} 'BRIEF.md'), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($paBrief)))`,
    `Set-Location ${psq(worktree)}`
  );
  return lines;
}

function posixSetupLines({ repo, worktree, branch, mayPush, brief, blockedPushUrl }: SetupSpec): string[] {
  const lines = [
    `git -C ${shq(repo)} fetch origin --prune`,
    `paBase=$(git -C ${shq(repo)} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)`,
    `git -C ${shq(repo)} worktree add -b ${shq(branch)} ${shq(worktree)} "$paBase"`,
  ];
  if (!mayPush) {
    lines.push(
      `git -C ${shq(repo)} config extensions.worktreeConfig true`,
      `git -C ${shq(worktree)} config --worktree remote.origin.pushurl ${shq(blockedPushUrl)}`
    );
  }
  const b64 = Buffer.from(brief, 'utf8').toString('base64');
  lines.push(`paBrief=''`);
  for (let i = 0; i < b64.length; i += CHUNK) lines.push(`paBrief="\${paBrief}${b64.slice(i, i + CHUNK)}"`);
  const file = shq(`${worktree}/BRIEF.md`);
  // GNU and current macOS take -d; older macOS only -D.
  lines.push(
    `{ printf '%s' "$paBrief" | base64 -d 2>/dev/null || printf '%s' "$paBrief" | base64 -D; } > ${file}`,
    `cd ${shq(worktree)}`
  );
  return lines;
}

// ---- the exec path ----------------------------------------------------------

function failure(machine: Pick<Machine, 'name'>, what: string, r: RunResult): Error {
  const why = (r.error || r.stderr || r.stdout || `exit ${r.code}`).trim().split(/\r?\n/).slice(-4).join(' | ');
  return new Error(`${what} failed on ${machine.name}: ${why.slice(0, 400)}`);
}

/**
 * Points every remote's pushurl in `worktree` at `blockedPushUrl`, in that
 * worktree's own config, then proves it: each remote of the worktree must
 * report the dead URL and the main checkout's must not. Throws otherwise.
 * `run(argv)` runs on the machine. Exported for tests.
 */
async function blockPush({ machine, repo, worktree, blockedPushUrl, run }: { machine: Pick<Machine, 'name'>; repo: string; worktree: string; blockedPushUrl: string; run: Run }): Promise<void> {
  const must = async (argv: string[], what: string): Promise<string> => {
    const r = await run(argv);
    if (r.code !== 0) throw failure(machine, what, r);
    return r.stdout;
  };
  const remotes = (await must(['git', '-C', worktree, 'remote'], 'listing remotes')).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!remotes.length) return; // nowhere to push to
  // Without this, `git config` in a worktree writes the repo's SHARED config:
  // the block would land on the main checkout and every other run, and
  // lifting it for one run would lift it for all.
  await must(['git', '-C', repo, 'config', 'extensions.worktreeConfig', 'true'], 'enabling per-worktree config');
  for (const name of remotes) {
    await must(['git', '-C', worktree, 'config', '--worktree', `remote.${name}.pushurl`, blockedPushUrl], `blocking push to ${name}`);
  }
  for (const name of remotes) {
    const got = (await must(['git', '-C', worktree, 'remote', 'get-url', '--push', name], `checking the push block on ${name}`)).trim();
    if (got !== blockedPushUrl) throw new Error(`the push block on ${machine.name} did not take: ${name} still pushes to ${got}`);
    const main = await run(['git', '-C', repo, 'remote', 'get-url', '--push', name]);
    if (main.code === 0 && main.stdout.trim() === blockedPushUrl) {
      throw new Error(`the push block on ${machine.name} leaked into the main checkout ${repo} — refusing to continue`);
    }
  }
}

/**
 * Undoes the push block older code wrote to the SHARED config: before the
 * block moved into the worktree's own config, `git config` run in a worktree
 * put the dead pushurl on the repo itself, blocking the main checkout — and
 * blockPush's leak check then refuses every new no-push run there. Removes
 * only a pushurl that IS the dead address, from the shared (`--local`) config,
 * for every remote; leaves any other pushurl alone. Idempotent; returns the
 * remotes it cleared. `run(argv)` runs on the machine. Exported for tests.
 */
async function clearLegacyBlock({ machine, repo, blockedPushUrl, run }: { machine: Pick<Machine, 'name'>; repo: string; blockedPushUrl: string; run: Run }): Promise<string[]> {
  const r = await run(['git', '-C', repo, 'config', '--local', '--get-regexp', '^remote\\..*\\.pushurl$']);
  if (r.code !== 0) return []; // exit 1: no pushurl at all
  const exact = `^${String(blockedPushUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  const cleared: string[] = [];
  for (const line of String(r.stdout).split(/\r?\n/)) {
    const m = /^(remote\..+\.pushurl)\s+(.*)$/i.exec(line.trim());
    if (!m) continue;
    const [, key = '', url = ''] = m;
    if (url.trim() !== blockedPushUrl) continue;
    const u = await run(['git', '-C', repo, 'config', '--local', '--unset-all', key, exact]);
    if (u.code !== 0) throw failure(machine, `removing the old shared push block on ${key}`, u);
    cleared.push(key.slice('remote.'.length, -'.pushurl'.length));
  }
  return cleared;
}

// ---- what a no-push run's agent may NOT have ---------------------------------
//
// The pushurl block stops `git push` to a configured remote; it is not
// credential isolation — `git push <url>`, `git -c remote.origin.pushurl=…`
// and `git remote add` all walk round it. So a no-push run's session also
// starts without the credentials those would need: no GitHub token in the
// environment, no SSH agent, no askpass helper, git's credential helpers
// reset to none (GIT_CONFIG_* outranks every config file), and ssh started
// with no user config, no agent and no default key.
//
// RESIDUAL RISK (AGENT.md): this strips what the environment hands the agent,
// not what the disk holds. An agent that reads ~/.ssh/id_* or gh's hosts.yml
// itself and passes it explicitly can still push. The real boundary for a run
// that must not push is a machine (or user) without those credentials.
/** A token that authenticates nothing (see noPushEnv). */
const NO_PUSH_SENTINEL = 'pa-no-push-sentinel';
const NO_PUSH_UNSET = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GITHUB_PAT', 'GH_PAT',
  'HUB_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN', 'GLAB_TOKEN', 'CI_JOB_TOKEN',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_CONFIG_PARAMETERS',
];

/**
 * Where `gh` looks for its login in a no-push session: an empty private
 * directory made for that run alone (mkdtemp, 0700, under the data dir), so
 * the `hosts.yml` in ~/.config/gh is never read and no two runs share one.
 * Removed when the run ends (removeNoGhDirs). On another machine it is a path
 * under the worktrees root that does not exist, which gh reads as "not
 * logged in".
 */
function noGhBase(): string {
  const fs = require('fs');
  const path = require('path');
  const base = path.join(config.dataDir, 'no-gh');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  return base;
}

function noGhDir(runId: number | string | null = null): string {
  const fs = require('fs');
  const path = require('path');
  const dir: string = fs.mkdtempSync(path.join(noGhBase(), runId != null ? `run-${Number(runId)}-` : 'tmp-'));
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** The run's private gh config dirs, gone. Best effort; returns how many. */
function removeNoGhDirs(runId: number | string): number {
  const fs = require('fs');
  const path = require('path');
  let n = 0;
  try {
    const base = path.join(config.dataDir, 'no-gh');
    for (const f of fs.readdirSync(base)) {
      if (f.startsWith(`run-${Number(runId)}-`)) {
        fs.rmSync(path.join(base, f), { recursive: true, force: true });
        n++;
      }
    }
  } catch {
    /* nothing made */
  }
  return n;
}

/** Pure. { env, unsetEnv } for a no-push run's termhub session. */
function noPushEnv({ ghConfigDir = null, runId = null }: { ghConfigDir?: string | null; runId?: number | string | null } = {}): NoPush {
  return {
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_SSH_COMMAND: 'ssh -F none -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes',
      GH_CONFIG_DIR: ghConfigDir || noGhDir(runId),
      GH_PROMPT_DISABLED: '1',
      // gh falls back to the OS credential store (Windows Credential Manager, keychain, Secret Service) when its
      // config dir is empty, and `gh auth token [--hostname H]` prints what it finds there. A token in the environment
      // wins over the store for every host, so give it one that is worthless: `gh auth token` prints the sentinel,
      // `gh api` gets a 401. Unsetting alone (NO_PUSH_UNSET) is not enough.
      GH_TOKEN: NO_PUSH_SENTINEL,
      GH_ENTERPRISE_TOKEN: NO_PUSH_SENTINEL,
    },
    unsetEnv: [...NO_PUSH_UNSET],
  };
}

/**
 * Pure. The agent's command line with the no-push environment applied AGAIN,
 * after the shell's rc files ran (a ~/.bashrc that exports GH_TOKEN or starts
 * an ssh-agent would otherwise undo the session env). POSIX shells only;
 * Windows relies on termhub skipping the profile (`noRc`).
 */
function noPushCommand(command: string, { env, unsetEnv }: NoPush, fam: Family = 'posix'): string {
  if (!command || fam === 'windows') return command;
  const q = (v: unknown): string => `'${String(v).replace(/'/g, `'\\''`)}'`;
  return ['env', ...unsetEnv.flatMap((k) => ['-u', k]), ...Object.entries(env).map(([k, v]) => `${k}=${q(v)}`), command].join(' ');
}

/**
 * Opens a no-push run's session with noPushEnv(), shell rc files skipped
 * (termhub `noRc`) and the env re-applied on the command line on POSIX, and
 * refuses — killing the session — when termhub does not say it applied the
 * env (a termhub too old for session env would start the agent with every
 * credential) or, on Windows, did not skip the profile. Enforced, not
 * requested.
 */
async function createNoPushSession(
  hub: Hub,
  spec: Json,
  machineName: string | null | undefined,
  { ghConfigDir = null, fam = 'posix', runId = null }: { ghConfigDir?: string | null; fam?: Family; runId?: number | string | null } = {}
): Promise<Json> {
  const ne = noPushEnv({ ghConfigDir, runId });
  const env = { ...(spec.env || {}), ...ne.env };
  const session = await hub.createSession({ ...spec, command: noPushCommand(spec.command, { ...ne, env }, fam), env, unsetEnv: ne.unsetEnv, noRc: true });
  const refuse = async (why: string): Promise<never> => {
    await hub.killSession(session.id).catch(() => {});
    throw new Error(`termhub${machineName ? ` on ${machineName}` : ''} ${why} — update termhub there, or dispatch as \`branch\`/\`mr\``);
  };
  if (!session.envApplied) await refuse('cannot start a session without push credentials (no session env)');
  if (fam === 'windows' && session.rcSkipped !== true) await refuse('cannot start a shell without its profile (noRc), which could restore credentials');
  return Object.assign(session, { noPush: ne });
}

function writeBriefArgv(fam: Family, briefPath: string): string[] {
  if (fam === 'windows') {
    // Base64 over stdin: the console's code page cannot mangle ASCII.
    return ['powershell', '-NoProfile', '-NonInteractive', '-Command',
      `$t = [Console]::In.ReadToEnd(); [IO.File]::WriteAllBytes(${psq(briefPath)}, [Convert]::FromBase64String($t.Trim()))`];
  }
  return ['sh', '-c', 'cat > "$1"', 'sh', briefPath];
}

function sizeArgv(fam: Family, file: string): string[] {
  if (fam === 'windows') {
    return ['powershell', '-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath ${psq(file)}).Length`];
  }
  return ['sh', '-c', 'wc -c < "$1"', 'sh', file];
}

/**
 * The worktree, its push block and BRIEF.md, made on `machine` through
 * /api/exec. Every step's exit code is checked; throws on the first that fails.
 * `run` defaults to runCommand on that machine (tests pass their own).
 */
async function setupViaExec({
  machine,
  os,
  repo,
  worktree,
  branch,
  mayPush,
  brief,
  blockedPushUrl,
  run,
}: SetupSpec & { machine: Pick<Machine, 'name'>; os: Os; run?: Run | null | undefined }): Promise<{ briefPath: string }> {
  const fam = family(os);
  const exec: Run = run || ((argv, opts = {}) => runCommand(machine.name, argv, { timeoutMs: 120_000, env: GIT_ENV, ...opts }));
  const must = async (argv: string[], what: string, opts?: RunOptions): Promise<string> => {
    const r = await exec(argv, opts);
    if (r.code !== 0) throw failure(machine, what, r);
    return r.stdout;
  };

  // A failed fetch (offline, a credential prompt) still leaves a usable base.
  await exec(['git', '-C', repo, 'fetch', 'origin', '--prune'], { timeoutMs: 300_000 });
  const head = await exec(['git', '-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const base = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : 'origin/main';
  await clearLegacyBlock({ machine, repo, blockedPushUrl, run: exec });
  await must(['git', '-C', repo, 'worktree', 'add', '-b', branch, worktree, base], 'git worktree add');

  const briefPath = joinFor(fam, worktree, 'BRIEF.md');
  try {
    if (!mayPush) await blockPush({ machine, repo, worktree, blockedPushUrl, run: exec });
    const bytes = Buffer.from(brief, 'utf8');
    await must(writeBriefArgv(fam, briefPath), 'writing BRIEF.md', { stdin: fam === 'windows' ? bytes.toString('base64') : brief });
    const size = Number((await must(sizeArgv(fam, briefPath), 'checking BRIEF.md')).trim());
    if (size !== bytes.length) throw new Error(`BRIEF.md on ${machine.name} is ${size} bytes, expected ${bytes.length}`);
  } catch (err) {
    // Nothing has started in it yet: take the half-made worktree back down
    // rather than leave an unblocked one lying there. Best effort.
    await exec(['git', '-C', repo, 'worktree', 'remove', '--force', worktree]).catch(() => {});
    await exec(['git', '-C', repo, 'branch', '-D', branch]).catch(() => {});
    throw err;
  }
  return { briefPath };
}

// ---- the machine ------------------------------------------------------------

function machineNamed(name: string): Machine {
  const machine: Machine | undefined = config.termhub.machines[name];
  if (!machine) {
    const known = Object.keys(config.termhub.machines);
    throw new Error(
      `unknown machine "${name}" — ${known.length ? `one of: ${known.join(', ')}` : 'none configured; set PA_MACHINES in .env'}`
    );
  }
  return machine;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean>, { timeoutMs, everyMs = 2000 }: { timeoutMs: number; everyMs?: number }): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return true;
    if (Date.now() > until) return false;
    await sleep(everyMs);
  }
}

async function listed(hub: Hub, fam: Family, parent: string, target: string): Promise<boolean> {
  return ((await hub.dirs(joinFor(fam, parent, ''))) as string[]).some((d) => samePath(fam, d, target));
}

/**
 * Sets up a run's worktree and session on `machine` and starts Claude in it.
 * Returns {sessionId, worktreePath, briefPath, url, os, via}; throws with the
 * session id attached (err.sessionId) when setup failed after a session was
 * opened, so the caller can record it.
 */
async function startOnMachine({
  machine,
  hub,
  run,
  repo,
  branch,
  mode,
  brief,
  title,
  blockedPushUrl,
  exec,
}: {
  machine: Machine;
  hub: Hub;
  run: Json;
  repo: string;
  branch: string;
  mode: Mode;
  brief: string;
  title: string;
  blockedPushUrl: string;
  exec?: Run | null;
}): Promise<{ sessionId: string; worktreePath: string; briefPath: string; url: string; os: Os; via: 'exec' | 'typed' }> {
  const os = await resolveOs(machine, hub);
  const fam = family(os);
  const name = repo.split(/[\\/]/).pop();
  if (!(await listed(hub, fam, machine.reposRoot, repo))) {
    throw new Error(`${name} is not cloned on ${machine.name} (looked for ${repo})`);
  }

  const worktree = joinFor(fam, machine.reposRoot, '.pa-worktrees', `run-${run.id}`);
  const parent = joinFor(fam, machine.reposRoot, '.pa-worktrees');
  const spec = { machine, os, repo, worktree, branch, mayPush: mode.mayPush, brief, blockedPushUrl };

  let via: 'exec' | 'typed' = 'exec';
  let session: Json | undefined;
  try {
    await setupViaExec({ ...spec, run: exec });
  } catch (err) {
    if ((err as ErrorWithCode).code !== 'EXEC_UNSUPPORTED') throw err;
    if (!mode.mayPush) {
      throw new Error(
        `termhub on ${machine.name} is too old to run commands (no /api/exec), so a \`${mode.name}\` run's push block ` +
          'could not be verified there — update termhub on that machine, or dispatch as `branch`/`mr`'
      );
    }
    via = 'typed';
    const shell: Json = await hub.createSession({ cwd: machine.reposRoot, command: '', title });
    session = shell;
    await sleep(2500); // the shell draws its first prompt before it reads input
    for (const line of setupLines({ ...spec, os })) await hub.say(shell.id, line);
  }

  const fail = (message: string): Error => Object.assign(new Error(message), { sessionId: session?.id || null });
  const made = await waitFor(() => listed(hub, fam, parent, worktree), { timeoutMs: via === 'typed' ? 120_000 : 15_000 });
  if (!made) throw fail(`the worktree never appeared on ${machine.name}${session ? ' — open the session to see why' : ''}`);

  if (!session) {
    let opened: Json;
    try {
      opened = mode.mayPush
        ? await hub.createSession({ cwd: worktree, command: '', title, env: { PA_DISPATCHED_RUN: String(run.id) }, links: { card: run.commitment_id, run: run.id } })
        : await createNoPushSession(hub, { cwd: worktree, command: '', title, env: { PA_DISPATCHED_RUN: String(run.id) }, links: { card: run.commitment_id, run: run.id } }, machine.name, { ghConfigDir: `${worktree}.no-gh`, fam });
    } catch (err) {
      // Nothing runs in it: take the worktree back down, as a failed setup does.
      const undo: Run = exec || ((argv) => runCommand(machine.name, argv, { timeoutMs: 120_000, env: GIT_ENV }));
      await undo(['git', '-C', repo, 'worktree', 'remove', '--force', worktree]).catch(() => {});
      await undo(['git', '-C', repo, 'branch', '-D', branch]).catch(() => {});
      throw err;
    }
    session = opened;
    await sleep(2500);
  }
  // The caller waits for Claude's prompt and types the brief (briefClaude).
  // A no-push run's command re-applies the no-push env after the shell's rc.
  await hub.say(session.id, session.noPush ? noPushCommand(config.termhub.claudeCommand, session.noPush, fam) : config.termhub.claudeCommand);

  return {
    sessionId: session.id,
    worktreePath: worktree,
    briefPath: joinFor(fam, worktree, 'BRIEF.md'),
    url: await hub.sessionUrl(session.id),
    os,
    via,
  };
}

/**
 * `pa drop --force` for a remote run: removes its worktree and branch on that
 * machine, then checks through termhub's API that the worktree is gone.
 */
async function removeOnMachine({
  machine,
  hub,
  repo,
  worktree,
  branch,
  exec,
}: {
  machine: Machine;
  hub: Hub;
  repo: string;
  worktree: string;
  branch?: string | null;
  exec?: Run | null;
}): Promise<boolean> {
  const os = await resolveOs(machine, hub);
  const fam = family(os);
  const parent = joinFor(fam, machine.reposRoot, '.pa-worktrees');
  const run: Run = exec || ((argv) => runCommand(machine.name, argv, { timeoutMs: 120_000, env: GIT_ENV }));
  try {
    await run(['git', '-C', repo, 'worktree', 'remove', '--force', worktree]);
    if (branch) await run(['git', '-C', repo, 'branch', '-D', branch]);
  } catch (err) {
    if ((err as ErrorWithCode).code !== 'EXEC_UNSUPPORTED') throw err;
    const session = await hub.createSession({ cwd: machine.reposRoot, command: '', title: `pa cleanup ${worktree.split(/[\\/]/).pop()}` });
    try {
      const q = fam === 'windows' ? psq : shq;
      await sleep(2500);
      await hub.say(session.id, `git -C ${q(repo)} worktree remove --force ${q(worktree)}`);
      if (branch) await hub.say(session.id, `git -C ${q(repo)} branch -D ${q(branch)}`);
      return await waitFor(async () => !(await listed(hub, fam, parent, worktree)), { timeoutMs: 60_000 });
    } finally {
      await hub.killSession(session.id).catch(() => {});
    }
  }
  return waitFor(async () => !(await listed(hub, fam, parent, worktree)), { timeoutMs: 15_000 });
}

/**
 * `pa doctor`'s view of one machine: is its termhub up, what OS does it run
 * (and does that agree with PA_MACHINES), and can it run commands — the
 * last is what a `local`/`plan` run there needs. Never throws.
 * Returns {ok, os, exec, detail}.
 */
async function probeMachine(
  machine: Machine,
  { hub, exec }: { hub: Hub; exec?: Run | null }
): Promise<{ ok: boolean; os: Os | null; exec: boolean; detail: string }> {
  const r = await hub.reachable();
  if (!r.ok) return { ok: false, os: null, exec: false, detail: `${machine.url} — ${r.error}` };
  let os: Os;
  try {
    os = await resolveOs(machine, hub);
  } catch (err) {
    return { ok: false, os: null, exec: false, detail: `${machine.url} — ${(err as Error).message}` };
  }
  const run: Run = exec || ((argv) => runCommand(machine.name, argv, { timeoutMs: 15_000 }));
  let execOk = false;
  let execNote: string;
  try {
    const v = await run(['git', '--version']);
    execOk = v.code === 0;
    execNote = execOk ? v.stdout.trim().replace(/^git version /, 'git ') : 'commands run, but git is not on its PATH';
  } catch (err) {
    const e = err as ErrorWithCode;
    execNote = e.code === 'EXEC_UNSUPPORTED' ? 'termhub too old to run commands (no /api/exec) — update it there; only branch/mr runs can go there' : e.message;
  }
  return { ok: execOk, os, exec: execOk, detail: `${machine.url} · ${os} · repos ${machine.reposRoot} · ${execNote}` };
}

module.exports = {
  probeMachine,
  setupLines,
  setupViaExec,
  blockPush,
  clearLegacyBlock,
  noPushEnv,
  noPushCommand,
  noGhDir,
  removeNoGhDirs,
  createNoPushSession,
  remoteRepoPath,
  remoteWorktreePath,
  machineNamed,
  startOnMachine,
  removeOnMachine,
  resolveOs,
  declaredOs,
  platformOs,
  joinFor,
  psq,
  shq,
};
