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

// The command that performs the actual update, run inside a terminal the user
// watches. Absolute -File path so it works regardless of the shell's cwd.
function updateCommand() {
  if (process.platform === 'win32') {
    const script = path.join(PROJECT_DIR, 'windows', 'update.ps1');
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
  }
  // No dedicated Linux updater script: pull fast-forward, then restart the user
  // service (this restarts sessiond too, so sessions reset — Linux only).
  return 'git pull --ff-only && systemctl --user restart termhub';
}

async function compute() {
  const head = await git(['rev-parse', 'HEAD']);
  if (!head.ok) {
    return { available: false, error: 'not a git checkout', checkedAt: Date.now() };
  }

  // Best-effort fetch; if it fails (offline, auth), fall back to comparing the
  // refs we already have rather than erroring out.
  const fetched = await git(['fetch', '--quiet']);

  const upstreamRef = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstreamRef.ok || !upstreamRef.out) {
    return {
      available: false,
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
