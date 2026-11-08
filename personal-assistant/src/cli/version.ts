'use strict';

// `pa version`: the commit the running worker serves, or the local checkout's
// short hash as a fallback.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;

const HELP = `pa version — which commit the running worker serves

  pa version                      print the commit from the dashboard, or the local checkout if it
                                  is not answering; the source is shown next to the hash
`;

// Pure logic: given a fetch function and a fallback function, return the
// formatted version string. Split from the CLI so it can be tested without
// touching the network or the filesystem.
async function resolveVersion(
  fetchDashboard: () => Promise<string | null>,
  gitFallback: () => Promise<string | null>,
): Promise<{ value: string; source: 'dashboard' | 'git' }> {
  try {
    const commit = await fetchDashboard();
    if (commit) return { value: commit, source: 'dashboard' };
  } catch {
    // Fall through to git.
  }
  try {
    const hash = await gitFallback();
    if (hash) return { value: hash, source: 'git' };
  } catch {
    // Fall through to the error below.
  }
  throw new Error('could not determine version: dashboard unreachable and git rev-parse failed');
}

function make(out: any, fail: any) {
  const http = require('http');
  const { execFileSync } = require('child_process');
  const { config } = require('../config.ts');

  async function fetchDashboard(): Promise<string | null> {
    const url = `http://${config.dispatch.host}:${config.dispatch.port}/api/version`;
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 5000 }, (res: any) => {
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`dashboard returned ${res.statusCode}`));
          try {
            const data: Json = JSON.parse(body);
            resolve(typeof data.commit === 'string' && data.commit ? data.commit : null);
          } catch {
            reject(new Error('unparseable dashboard response'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('dashboard request timed out')); });
    });
  }

  async function gitFallback(): Promise<string | null> {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  }

  return {
    async version() {
      try {
        const result = await resolveVersion(fetchDashboard, gitFallback);
        out(`${result.value} (${result.source})`);
      } catch (err: any) {
        fail(err.message);
      }
    },
  };
}

module.exports = { make, HELP, resolveVersion };