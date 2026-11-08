'use strict';

// `pa version`: which commit is live. The running worker's dashboard answers GET /api/version
// (src/dashboard/server.ts, `{ commit }`); when it does not answer, the checkout this CLI was
// started from is asked with `git rev-parse --short HEAD`. The output always says which one it was.
//
// The decision and the output line are pure (chooseSource, formatVersion, parseDashboardCommit).
// The two sources are thin wrappers that do the network and subprocess work and return null on any failure.

const { execFileSync } = require('child_process');
const { config } = require('../config.ts');

/** The dashboard's /api/version is asked with this much patience before the git checkout is used. */
const DASHBOARD_TIMEOUT_MS = 2000;

const HEX_COMMIT = /^[0-9a-f]{4,40}$/i;

/** Pure. The commit in a /api/version body, shortened to 7 characters, or null when the body is not one. */
function parseDashboardCommit(body: string): string | null {
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const commit = parsed?.commit;
  if (typeof commit !== 'string' || !HEX_COMMIT.test(commit)) return null;
  return commit.slice(0, 7).toLowerCase();
}

type Source = 'dashboard' | 'git';
type Chosen = { commit: string | null; source: Source | null; error: string | null };

/**
 * Pure. The dashboard's commit wins when it answered; otherwise the git checkout's; otherwise an error.
 * Git is only consulted by the caller when the dashboard did not answer, so `gitCommit` may be null
 * for that reason as well.
 */
function chooseSource(dashboardCommit: string | null, gitCommit: string | null): Chosen {
  if (dashboardCommit) return { commit: dashboardCommit, source: 'dashboard', error: null };
  if (gitCommit) return { commit: gitCommit, source: 'git', error: null };
  return {
    commit: null,
    source: null,
    error: 'no commit: the dashboard did not answer GET /api/version, and `git rev-parse --short HEAD` gave none',
  };
}

/** Pure. The one output line, always naming the source. */
function formatVersion(chosen: Chosen): string {
  const from = chosen.source === 'dashboard' ? 'the dashboard/worker' : 'the git checkout';
  return `${chosen.commit} (from ${from})`;
}

/** Thin wrapper. GET /api/version on the dashboard; null on connection error, timeout, non-2xx or a bad body. */
async function dashboardCommit(): Promise<string | null> {
  const url = `http://${config.dispatch.host}:${config.dispatch.port}/api/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS) });
    if (!res.ok) return null;
    return parseDashboardCommit(await res.text());
  } catch {
    return null;
  }
}

/** Thin wrapper. `git rev-parse --short HEAD` in the checkout this code runs from; null when git cannot say. */
function gitCheckoutCommit(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return HEX_COMMIT.test(out) ? out : null;
  } catch {
    return null;
  }
}

type Sources = { dashboard: () => Promise<string | null>; git: () => string | null };

function make(out: any, fail: any, sources: Sources = { dashboard: dashboardCommit, git: gitCheckoutCommit }) {
  return {
    async version() {
      const fromDashboard = await sources.dashboard();
      // The git checkout is only asked when the dashboard did not answer.
      const chosen = chooseSource(fromDashboard, fromDashboard ? null : sources.git());
      if (!chosen.commit) return fail(chosen.error);
      out(formatVersion(chosen));
    },
  };
}

module.exports = { parseDashboardCommit, chooseSource, formatVersion, make, dashboardCommit, gitCheckoutCommit };
