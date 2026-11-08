'use strict';

// Update check for the front tier.
//
// termhub lives in a subdirectory (`termhub/`) of the `dev-tools` git repo. This
// module fetches the upstream branch and reports whether HEAD is behind it, with
// a flag for whether the termhub tool *itself* changed (so the UI can nudge the
// user to update only when it matters). It does NOT apply anything — applying is
// done by opening a terminal that runs the platform updater (windows/update.ps1),
// so the blue-green swap survives the front being replaced under it.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeCli = require('./claudeCli.ts');

const PROJECT_DIR = path.join(__dirname, '..'); // .../termhub
// The parts of the repo one update deploys.
const STACK_PARTS = ['termhub', 'personal-assistant', 'software-factory'];

// Re-running `git fetch` on every poll is wasteful; serve a recent result unless
// the caller forces a refresh (the "Check again" button).
const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, data: null };

function git(args: any, timeoutMs: number = 10000) {
  return new Promise<any>((resolve) => {
    execFile('git', ['-C', PROJECT_DIR, ...args], { timeout: timeoutMs, windowsHide: true }, (err: any, stdout: any) => {
      resolve({ ok: !err, out: (stdout || '').trim(), err });
    });
  });
}

// Human-facing version string: the nearest git tag (e.g. "v0.3.0"), with a
// "-<n>-g<sha>" suffix when HEAD is past the tag and "-dirty" when the tree has
// uncommitted changes; falls back to the short sha when no tags exist yet.
async function gitDescribe() {
  const r = await git(['describe', '--tags', '--always', '--dirty']);
  return r.ok && r.out ? r.out : null;
}

// The command that performs the actual update, run inside a terminal the user
// watches. Absolute -File path so it works regardless of the shell's cwd.
//
// Both platforms also update the Claude Code CLI, because termhub's Claude
// integration is version-coupled (lib/claudeCli.js) and a machine that only ever
// updates termhub drifts away from the CLI termhub was tested against. The CLI
// step is deliberately non-fatal: `|| true` on Linux, a warning in update.ps1 —
// a rate-limited or offline `claude update` must not abort a termhub update.
// Both platforms delegate to a script IN THE REPO, and that is the important part:
// this string is composed by the RUNNING front, so it always encodes the OLD
// version's idea of how to update. An inline command therefore can never apply a
// change to the update procedure itself — every new step (installing the watchdog,
// say) would need a manual first run on every machine, forever. Pointing at a
// pulled script means the pull brings the new procedure with it.
//
// Linux was an inline one-liner until that bit: `git pull && claude update &&
// systemctl --user restart termhub`. It also had nowhere to put a verify step,
// because the restart kills the PTY the command runs in — see linux/update.sh.
function updateCommand() {
  if (process.platform === 'win32') {
    const script = path.join(PROJECT_DIR, 'windows', 'update.ps1');
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
  }
  const script = path.join(PROJECT_DIR, 'linux', 'update.sh');
  if (fs.existsSync(script)) return `bash "${script}"`;
  // Fallback for a checkout that predates the script (or has lost it): the original
  // inline sequence. Restart last, since it ends the terminal running it.
  return `git pull --ff-only && { ${claudeCli.updateCommand()} || true; } && systemctl --user restart termhub`;
}

async function compute() {
  const head = await git(['rev-parse', 'HEAD']);
  const version = await gitDescribe();
  // Reported on EVERY path, including the error returns below: a machine whose
  // checkout can't be compared (no upstream, not a git tree) is exactly the kind
  // that quietly drifts to an untested CLI, so that's the last place to hide it.
  const claude = await claudeCli.status();
  if (!head.ok) {
    return { available: false, version, claudeCli: claude, error: 'not a git checkout', checkedAt: Date.now() };
  }

  // Best-effort fetch; if it fails (offline, auth), fall back to comparing the
  // refs we already have rather than erroring out.
  const fetched = await git(['fetch', '--quiet']);

  const upstreamRef = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstreamRef.ok || !upstreamRef.out) {
    return {
      available: false,
      version,
      claudeCli: claude,
      current: head.out.slice(0, 7),
      error: 'no upstream branch tracked',
      fetchOk: fetched.ok,
      checkedAt: Date.now(),
    };
  }

  const upstream = await git(['rev-parse', '@{u}']);
  const behindRes = await git(['rev-list', '--count', 'HEAD..@{u}']);
  const behind = Number(behindRes.out) || 0;

  // Which part of the repo changed? The updater redeploys the whole stack (termhub,
  // then personal-assistant/windows|linux/redeploy), so a change to any part of it
  // counts; other tools in the repo do not.
  const prefixRes = await git(['rev-parse', '--show-prefix']);
  const prefix = prefixRes.out; // e.g. "termhub/" ('' if termhub is the repo root)
  let toolChanged = behind > 0 && !prefix; // repo-root install: any change is the tool

  let subjects = [];
  let parts: any[] = [];
  if (behind > 0) {
    const names = await git(['diff', '--name-only', 'HEAD..@{u}']);
    if (names.ok && prefix) {
      const files = names.out.split('\n').filter(Boolean);
      parts = STACK_PARTS.filter((p) => files.some((f: any) => f.startsWith(p + '/')));
      toolChanged = parts.length > 0;
    }
    const log = await git(['log', '--no-merges', '--format=%h\x1f%s', '-n', '20', 'HEAD..@{u}']);
    if (log.ok && log.out) {
      subjects = log.out.split('\n').map((line: any) => {
        const [hash, ...rest] = line.split('\x1f');
        return { hash, subject: rest.join('\x1f') };
      });
    }
  }

  return {
    available: behind > 0,
    version,
    claudeCli: claude,
    behind,
    toolChanged,
    parts,
    current: head.out.slice(0, 7),
    latest: upstream.ok ? upstream.out.slice(0, 7) : null,
    upstream: upstreamRef.out,
    subjects,
    command: updateCommand(),
    cwd: PROJECT_DIR,
    fetchOk: fetched.ok,
    checkedAt: Date.now(),
  };
}

// Every answer carries the command, including the error ones and a compute()
// that throws. The UI enables its button on `command`, and the update script
// copes with a missing upstream, a failed fetch or a dirty tree on its own —
// so a check that could not compare refs must never be what stops an update.
function withCommand(data: any) {
  return { ...data, command: updateCommand(), cwd: PROJECT_DIR };
}

async function checkForUpdate({ force = false }: { force?: boolean | undefined } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  let data;
  try {
    data = withCommand(await compute());
  } catch (e: any) {
    data = withCommand({ available: false, error: String((e && e.message) || e), checkedAt: Date.now() });
  }
  cache = { at: Date.now(), data };
  return data;
}

// updateCommand is exported for test/update.test.js: it decides how every machine
// applies every update, and a wrong string there is a machine that cannot update
// itself — the one bug you cannot fix by shipping a fix.
module.exports = { checkForUpdate, updateCommand, PROJECT_DIR };
