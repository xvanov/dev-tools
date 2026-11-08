'use strict';

// `pa version`: which commit the running worker serves, and where the answer
// came from. Primary: GET /api/version on the dashboard (src/dashboard/server.ts
// servedCommit). Fallback, only when the dashboard does not answer: the
// checkout's `git rev-parse --short HEAD`.
//
// The decision and the text are pure (chooseVersion, formatVersion,
// dashboardCommit; test/version.test.js). The HTTP call and the git call are
// thin wrappers around them.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

/** Where the running code lives: the personal-assistant folder, in its git checkout. */
const PA_DIR = path.join(__dirname, '..', '..');

type VersionChoice = { commit: string; source: 'dashboard' | 'git' };

/** Pure. The commit in a GET /api/version body, or null when the body does not name one. */
function dashboardCommit(body: unknown): string | null {
  const commit = body && typeof body === 'object' ? (body as { commit?: unknown }).commit : undefined;
  return typeof commit === 'string' && commit.trim() !== '' ? commit.trim() : null;
}

/**
 * Pure. The dashboard's commit when it answered; otherwise the git commit,
 * labelled as the fallback. null when neither source names a commit.
 */
function chooseVersion(dashboard: string | null, git: string | null): VersionChoice | null {
  if (dashboard) return { commit: dashboard, source: 'dashboard' };
  if (git) return { commit: git, source: 'git' };
  return null;
}

/** Pure. The one line `pa version` prints: the commit, then its source in words. */
function formatVersion(choice: VersionChoice): string {
  const label = choice.source === 'dashboard' ? 'from the dashboard (GET /api/version)' : 'git fallback (git rev-parse --short HEAD of the checkout)';
  return `${choice.commit}  ${label}`;
}

/** Thin wrapper: GET /api/version on the dashboard. null on connection failure, timeout or non-200. */
function fetchDashboardCommit({ host, port, timeoutMs = 3000 }: { host: string; port: number; timeoutMs?: number }): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/version', timeout: timeoutMs }, (res: import('http').IncomingMessage) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(dashboardCommit(JSON.parse(text)));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Thin wrapper: `git rev-parse --short HEAD` in the checkout of the running code. null when git fails. */
function gitShortHead(dir: string = PA_DIR): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function make(out: (text: string) => void, fail: (message: string) => void) {
  return {
    async version() {
      const { config } = require('../config.ts');
      // Same loopback rule as src/e2e/goldenPath.js: a 0.0.0.0 bind is reached on 127.0.0.1.
      const host = config.dispatch.host === '0.0.0.0' ? '127.0.0.1' : config.dispatch.host;
      const dashboard = await fetchDashboardCommit({ host, port: config.dispatch.port });
      const choice = chooseVersion(dashboard, dashboard ? null : gitShortHead());
      if (!choice) {
        return fail(`no commit: the dashboard did not answer GET /api/version on ${host}:${config.dispatch.port}, and git rev-parse --short HEAD failed in ${PA_DIR}`);
      }
      out(formatVersion(choice));
    },
  };
}

module.exports = { dashboardCommit, chooseVersion, formatVersion, fetchDashboardCommit, gitShortHead, make };
