'use strict';

// `pa version`: print the commit the running worker serves, falling back to
// git in the local checkout when the dashboard is unreachable.
//
// The pure formatting is exported so a unit test can cover every AC scenario
// without network or git calls.

type Json = import('../types.ts').Json;
const HELP = `pa version — which commit the running worker serves

  pa version                      ask the dashboard first; fall back to git in the checkout
`;

// AC2: dashboard commit, AC3: git fallback, AC4: neither source yields a commit.
function formatVersionOutput(source: 'dashboard' | 'git' | 'error', commit?: string): string {
  if (source === 'error' || !commit) {
    return 'error: could not determine the running version — dashboard unreachable and git rev-parse failed';
  }
  if (source === 'dashboard') {
    return `commit ${commit} (from dashboard / running worker)`;
  }
  return `commit ${commit} (from local checkout)`;
}

function make(out: any, fail: any) {
  const { config } = require('../config.ts');
  const http = require('http');
  const { execFileSync } = require('child_process');
  const path = require('path');

  function fetchDashboardVersion(baseUrl: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const url = new URL('/api/version', baseUrl);
      const req = http.get(
        { host: url.hostname, port: url.port, path: url.pathname, timeout: 2000 },
        (res: any) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => {
            try {
              const data = JSON.parse(body) as Json;
              resolve(String(data.commit || ''));
            } catch {
              reject(new Error('invalid JSON'));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  function getLocalGitCommit(): string {
    // The checkout root is the directory that contains package.json (the
    // personal-assistant root), matching the dashboard's own servedCommit
    // which uses __dirname relative to src/dashboard/server.ts.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  }

  return {
    async version(_args: any, _flags: any) {
      // Try the dashboard first (short timeout so fallback is quick).
      const dashboardUrl = `http://${config.dispatch.host}:${config.dispatch.port}`;
      let dashboardCommit: string | null = null;

      try {
        dashboardCommit = await fetchDashboardVersion(dashboardUrl);
      } catch {
        // Fall through to git.
      }

      if (dashboardCommit) {
        return out(formatVersionOutput('dashboard', dashboardCommit));
      }

      // Git fallback: use the repo root (where package.json lives).
      let gitCommit: string | null = null;
      try {
        gitCommit = getLocalGitCommit();
      } catch {
        // Both sources failed.
      }

      if (gitCommit) {
        return out(formatVersionOutput('git', gitCommit));
      }

      fail(formatVersionOutput('error'));
      return;
    },
  };
}

module.exports = { make, HELP, formatVersionOutput };