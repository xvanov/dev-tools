'use strict';

// `pa version`: which build is live. Asks the dashboard's GET /api/version (the
// commit the worker serves, src/dashboard/server.ts); when that does not answer,
// the checkout's `git rev-parse --short HEAD`. Every line says which one it was.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Source = 'dashboard' | 'checkout';
type Resolved = { commit: string; source: Source };

const FETCH_TIMEOUT_MS = 3000;

/** The commit in a dashboard answer, or null when the answer has none. */
function dashboardCommit(body: any): string | null {
  const c = body && typeof body === 'object' ? body.commit : undefined;
  return typeof c === 'string' && c.trim() ? c.trim() : null;
}

/** The commit in `git rev-parse --short HEAD` output: a short hex hash, or null (never a partial). */
function gitCommit(stdout: string): string | null {
  const c = String(stdout || '').trim();
  return /^[0-9a-f]{4,40}$/i.test(c) ? c : null;
}

/**
 * Dashboard first, checkout second. Both calls are injected so the choice can be
 * tested with no network and no git. A throwing dependency counts as "no answer".
 */
async function resolveVersion(deps: {
  fetchDashboard: () => Promise<any>;
  gitHead: () => Promise<string>;
}): Promise<Resolved | null> {
  const fromDashboard = await deps.fetchDashboard().then(dashboardCommit, () => null);
  if (fromDashboard) return { commit: fromDashboard, source: 'dashboard' };
  const fromGit = await deps.gitHead().then(gitCommit, () => null);
  if (fromGit) return { commit: fromGit, source: 'checkout' };
  return null;
}

function formatVersion(r: Resolved): string {
  const source = r.source === 'dashboard' ? 'dashboard' : 'local checkout';
  return `${r.commit}\nsource: ${source}`;
}

function make(out: any, fail: any) {
  return {
    async version() {
      const { config } = require('../config.ts');
      const { execFile } = require('child_process');
      const url = `http://${config.dispatch.host}:${config.dispatch.port}/api/version`;
      const checkout = config.repoRoot;
      const r = await resolveVersion({
        fetchDashboard: async () => {
          const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        },
        gitHead: () => new Promise((resolve, reject) => {
          execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: checkout, timeout: 5000, windowsHide: true },
            (err: any, stdout: string) => (err ? reject(err) : resolve(stdout)));
        }),
      });
      if (!r) {
        return fail(`no commit: the dashboard at ${url} did not answer, and \`git rev-parse --short HEAD\` in ${checkout} gave none`);
      }
      out(formatVersion(r));
    },
  };
}

module.exports = { make, dashboardCommit, gitCommit, resolveVersion, formatVersion };
