'use strict';

// `pa version`: the commit the running worker serves. It asks the dashboard
// first (GET /api/version, the same answer the dashboard shell uses to notice an
// update, src/dashboard/server.ts) and falls back to this checkout's HEAD when the
// dashboard does not answer. The line says which of the two it used.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const { execFileSync } = require('child_process');
const { config } = require('../config.ts');

const DASHBOARD_SOURCE = 'dashboard/worker';
const GIT_SOURCE = 'git checkout';
// Short on purpose: when the dashboard is down the fallback should answer at once.
const DASHBOARD_TIMEOUT_MS = 2000;

/** The one output line: `<commit> (source: <label>)`. Pure: no I/O. */
function formatVersionOutput(commit: string, source: string): string {
  return `${commit} (source: ${source})`;
}

function why(err: any): string {
  const code = err?.cause?.code;
  return code ? `${err.message} (${code})` : String(err?.message || err);
}

async function fromDashboard(): Promise<string> {
  const { host, port } = config.dispatch;
  const res = await fetch(`http://${host}:${port}/api/version`, { signal: AbortSignal.timeout(DASHBOARD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`dashboard answered HTTP ${res.status}`);
  const body: any = await res.json();
  if (!body || typeof body.commit !== 'string' || !body.commit) throw new Error('dashboard answer has no commit');
  return body.commit;
}

function fromGit(): string {
  // cwd is this file's directory, inside the checkout: git finds the repo from there.
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: __dirname, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!commit) throw new Error('git printed no commit');
  return commit;
}

function make(out: any, fail: any) {
  return {
    async version() {
      let dashboardProblem: string;
      try {
        const commit = await fromDashboard();
        out(formatVersionOutput(commit, DASHBOARD_SOURCE));
        return;
      } catch (err: any) {
        dashboardProblem = why(err);
      }
      let gitCommit: string;
      try {
        gitCommit = fromGit();
      } catch (err: any) {
        fail(`cannot tell which commit is served: the dashboard did not answer (${dashboardProblem}) and git rev-parse failed (${why(err)})`);
        return;
      }
      out(formatVersionOutput(gitCommit, GIT_SOURCE));
    },
  };
}

module.exports = { make, formatVersionOutput };
