'use strict';

// Update check for the front tier.
//
// termhub lives in a subdirectory (`termhub/`) of the `dev-tools` git repo. This
// module fetches the upstream branch and reports whether HEAD is behind it, with
// a flag for whether the termhub tool *itself* changed (so the UI can nudge the
// user to update only when it matters). It does NOT apply anything — applying is
// done by opening a terminal that runs the platform updater (windows/update.ps1),
// so the blue-green swap survives the front being replaced under it.

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const claudeCli = require('./claudeCli');

const PROJECT_DIR = path.join(__dirname, '..'); // .../termhub

// Re-running `git fetch` on every poll is wasteful; serve a recent result unless
// the caller forces a refresh (the "Check again" button).
const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, data: null };

function git(args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile('git', ['-C', PROJECT_DIR, ...args], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
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
function updateCommand() {
  if (process.platform === 'win32') {
    const script = path.join(PROJECT_DIR, 'windows', 'update.ps1');
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
  }
  // No dedicated Linux updater script: pull fast-forward, update the CLI, then
  // restart the user service (this restarts sessiond too, so sessions reset —
  // Linux only).
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

  // Which part of the repo changed? termhub sits under this prefix; only changes
  // touching it should prompt "the tool changed".
  const prefixRes = await git(['rev-parse', '--show-prefix']);
  const prefix = prefixRes.out; // e.g. "termhub/" ('' if termhub is the repo root)
  let toolChanged = behind > 0 && !prefix; // repo-root install: any change is the tool

  let subjects = [];
  if (behind > 0) {
    const names = await git(['diff', '--name-only', 'HEAD..@{u}']);
    if (names.ok && prefix) {
      toolChanged = names.out.split('\n').some((f) => f && f.startsWith(prefix));
    }
    const log = await git(['log', '--no-merges', '--format=%h\x1f%s', '-n', '20', 'HEAD..@{u}']);
    if (log.ok && log.out) {
      subjects = log.out.split('\n').map((line) => {
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

async function checkForUpdate({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const data = await compute();
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { checkForUpdate, PROJECT_DIR };
