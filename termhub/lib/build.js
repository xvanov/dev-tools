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

function commit() {
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync('git', ['-C', PROJECT_DIR, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cached = out.trim() || null;
  } catch {
    cached = null; // no git, or not a checkout — reported as null, never fatal
  }
  return cached;
}

function shortCommit() {
  const full = commit();
  return full ? full.slice(0, 7) : null;
}

module.exports = { commit, shortCommit, PROJECT_DIR };
