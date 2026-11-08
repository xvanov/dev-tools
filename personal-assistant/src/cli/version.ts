'use strict';

// `pa version`: the commit the running worker serves. Asks the dashboard
// (GET /api/version, src/dashboard/server.ts — public even behind passkeys);
// when it does not answer with a 2xx and a commit, `git rev-parse --short HEAD`
// of this checkout. Always says which source it was.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** What the dashboard request came back with: a status and body, or the error that stopped it. */
type DashboardAnswer = { status?: number | undefined; body?: string | undefined; error?: Error | undefined };
type Choice = { version: string | null; source: 'dashboard' | 'git' | null; error?: string | undefined };

const TIMEOUT_MS = 2000;

/** Pure: the commit in a 2xx /api/version answer, or null. */
function dashboardCommit(answer: DashboardAnswer | null | undefined): string | null {
  if (!answer || answer.error || typeof answer.status !== 'number' || answer.status < 200 || answer.status > 299) return null;
  try {
    const commit = JSON.parse(answer.body || '').commit;
    return typeof commit === 'string' && commit.trim() ? commit.trim() : null;
  } catch {
    return null;
  }
}

/** Pure but for `git`, which is called only when the dashboard gave no commit. */
function chooseVersion({ dashboard, git }: { dashboard: DashboardAnswer | null | undefined; git: () => string }): Choice {
  const served = dashboardCommit(dashboard);
  if (served) return { version: served, source: 'dashboard' };
  try {
    const head = String(git()).trim();
    if (head) return { version: head, source: 'git' };
    return { version: null, source: null, error: 'git rev-parse printed nothing' };
  } catch (err: any) {
    return { version: null, source: null, error: err.message };
  }
}

function formatVersion(r: Choice): string {
  return `${r.version} (${r.source === 'dashboard' ? 'dashboard' : 'git fallback'})`;
}

function fetchDashboard(host: string, port: number): Promise<DashboardAnswer> {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/version', timeout: TIMEOUT_MS }, (res: any) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', (error: Error) => resolve({ error }));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer in ${TIMEOUT_MS} ms`)));
    req.on('error', (error: Error) => resolve({ error }));
  });
}

// The checkout this CLI runs from, as servedCommit() in src/dashboard/server.ts reads it.
function gitShortHead(): string {
  return require('child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: __dirname, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function make(out: any, fail: any) {
  return {
    async version() {
      const { config } = require('../config.ts');
      const dashboard = await fetchDashboard(config.dispatch.host, config.dispatch.port);
      const r = chooseVersion({ dashboard, git: gitShortHead });
      if (!r.version) return fail(`no version: the dashboard did not answer and git failed (${r.error})`);
      out(formatVersion(r));
    },
  };
}

module.exports = { make, chooseVersion, dashboardCommit, formatVersion, fetchDashboard };
