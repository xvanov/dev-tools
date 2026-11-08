'use strict';

// `pa version`: the commit the worker is serving (dashboard GET /api/version),
// or the local checkout short hash when the dashboard cannot be reached.

type Json = import('../types.ts').Json;

const http = require('http');
const cp = require('child_process');
const { config } = require('../config.ts');

const HELP = `pa version — what commit is running

  pa version                     the served commit (dashboard), or the local short hash`;

/** Pure: picks a source and formats it. */
function formatVersion(dashboardVersion: string | null, localHash: string): string {
  if (dashboardVersion) return `dashboard: ${dashboardVersion}`;
  return `local: ${localHash}`;
}

function make(out: any, fail: any) {
  return {
    async version() {
      const dashboardVer = await fetchDashboardVersion();
      let localHash: string;
      try {
        localHash = cp.execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: __dirname, encoding: 'utf8', timeout: 5000, windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch (e: any) {
        return fail(`cannot read local git hash: ${e.message}`);
      }
      out(formatVersion(dashboardVer, localHash));
    },
  };
}

function fetchDashboardVersion(): Promise<string | null> {
  const { host, port } = config.dispatch;
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/api/version`, { timeout: 5000 }, (res: any) => {
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const obj: Json = JSON.parse(body);
          if (obj && typeof obj.commit === 'string' && obj.commit) resolve(obj.commit);
          else resolve(null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

module.exports = { make, HELP, formatVersion };