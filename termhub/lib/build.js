'use strict';

// The commit this PROCESS is running, which is not the same question as the
// commit checked out on disk.
//
// `sessiond` outlives updates by design: the updater pulls, swaps the front, and
// deliberately leaves the supervisor alone so PTYs survive. So after any update
// that touched sessiond-side code, the running supervisor is legitimately behind
// the working tree. That drift is normal and must never fail an update — but it
// has to be VISIBLE, because it's the difference between "the fix is deployed"
// and "the fix is deployed to the tier that doesn't do the work".
//
// Computed once, synchronously, at startup: it's one git call per process and
// `/api/ping` is polled, so it must never pay for it.

const { execFileSync } = require('child_process');
const path = require('path');

const PROJECT_DIR = path.join(__dirname, '..');

let cached; // undefined = not computed yet, null = unavailable (not a git tree)
let cachedDirty; // was the tree modified when this process started?

function git(args) {
  try {
    return execFileSync('git', ['-C', PROJECT_DIR, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // no git, or not a checkout — reported as null, never fatal
  }
}

function commit() {
  if (cached !== undefined) return cached;
  cached = git(['rev-parse', 'HEAD']) || null;
  return cached;
}

// A process started from a modified tree is running code that no commit
// describes, so `commit` alone would overstate what it is. Reported alongside it
// rather than folded in, so the updater's exact commit comparison still works
// (the HEAD is genuinely that commit) while a reader can see the claim is
// approximate. Sampled once at startup — later edits don't retroactively change
// what this process loaded.
function dirty() {
  if (cachedDirty !== undefined) return cachedDirty;
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  cachedDirty = status === null ? null : status.length > 0;
  return cachedDirty;
}

function shortCommit() {
  const full = commit();
  if (!full) return null;
  return full.slice(0, 7) + (dirty() ? '-dirty' : '');
}

module.exports = { commit, dirty, shortCommit, PROJECT_DIR };
