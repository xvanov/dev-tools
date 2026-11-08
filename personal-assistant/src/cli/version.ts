'use strict';

// `pa version`: print the commit the PA worker serves (GET /api/version on the
// dashboard; when the dashboard does not answer, git rev-parse --short HEAD).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../types.ts').Json;

const { execFileSync } = require('child_process');

const HELP = `
  Version
    pa version                        the commit the PA worker serves, or the local checkout
`;

/**
 * Pure. Given a dashboard response body and a git hash, return the commit to
 * display and its source. When the dashboard response is falsy (failed request,
 * non-200, or no commit field), fall back to the git hash.
 */
function selectVersion(dashboardResponse: any, gitHash: string): { source: 'dashboard' | 'git'; commit: string } {
  if (dashboardResponse && typeof dashboardResponse.commit === 'string' && dashboardResponse.commit.trim()) {
    return { source: 'dashboard', commit: dashboardResponse.commit.trim() };
  }
  return { source: 'git', commit: typeof gitHash === 'string' ? gitHash.trim() : '' };
}

/**
 * Format the result of selectVersion for CLI output, with a source label.
 */
function formatVersion(result: { source: 'dashboard' | 'git'; commit: string }): string {
  if (result.source === 'dashboard') return `Dashboard: ${result.commit}`;
  return `Git: ${result.commit}`;
}

function make(out: any, fail: any) {
  return {
    async version() {
      let commit: string;
      let source: 'dashboard' | 'git';

      try {
        const res = await fetch('http://127.0.0.1:7300/api/version', { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const body = await res.json();
          const result = selectVersion(body, '');
          if (result.source === 'dashboard') {
            out(formatVersion(result));
            return;
          }
        }
      } catch {
        // dashboard unreachable or timed out: fall through to git fallback
      }

      // Git fallback
      try {
        commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        commit = '';
      }
      out(formatVersion(selectVersion(null, commit)));
    },
  };
}

module.exports = { make, HELP, selectVersion, formatVersion };