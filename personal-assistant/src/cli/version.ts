'use strict';

// `pa version`: print the commit served by the running worker.
//
// Calls GET /api/version on the dashboard; falls back to `git rev-parse --short
// HEAD` from the current checkout when the dashboard cannot be reached or does
// not answer. The output indicates which source supplied the value.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const http = require('http');
const { execFileSync } = require('child_process');

const HELP = `pa version — the commit the running worker serves

  pa version                      print the served commit; falls back to git when
                                  the dashboard is unreachable`;

/**
 * Pure selection/formatting logic, exported for testing.
 *
 * Accepts a dashboard commit result (string if the dashboard responded, null if
 * it could not be reached) and a git commit result (string if git ran, null if
 * the call failed). Returns the formatted output string: the commit value
 * prefixed with its source.
 */
function formatVersion(
  dashboardCommit: string | null,
  gitCommit: string | null,
): string {
  if (dashboardCommit) return `dashboard: ${dashboardCommit}`;
  if (gitCommit) return `git: ${gitCommit}`;
  return 'version unknown (dashboard unreachable, git unavailable)';
}

function make(out: any, fail: any) {
  return {
    async version(_args: any, _flags: any) {
      const config = require('../config.ts').config;

      // 1. Try the dashboard.
      let dashboardCommit: string | null = null;
      try {
        dashboardCommit = await dashboardVersion(config);
      } catch {
        // Dashboard unreachable or not answering — fall through to git.
      }

      // 2. Git fallback.
      let gitCommit: string | null = null;
      if (!dashboardCommit) {
        try {
          gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            timeout: 5000,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch {
          // git unavailable — handled by formatVersion.
        }
      }

      out(formatVersion(dashboardCommit, gitCommit || null));
    },
  };
}

/** Call GET /api/version on the dashboard. Returns the commit string or throws. */
function dashboardVersion(config: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: config.dispatch.host,
        port: config.dispatch.port,
        path: '/api/version',
        timeout: 5000,
      },
      (res: any) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed.commit === 'string' && parsed.commit) {
              resolve(parsed.commit);
            } else {
              reject(new Error('missing commit in response'));
            }
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timed out'));
    });
    req.on('error', reject);
  });
}

module.exports = { make, formatVersion, HELP };