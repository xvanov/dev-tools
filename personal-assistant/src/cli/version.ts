'use strict';

// `pa version`: the commit the running worker serves. Asks the dashboard
// (GET /api/version, public, src/dashboard/server.ts); when it does not answer,
// falls back to `git rev-parse --short HEAD` of this checkout, and says which.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const HELP = `pa version    the commit the running worker serves
  Dashboard: <commit>   GET /api/version on the dashboard answered
  Git: <commit>         it did not; this checkout's \`git rev-parse --short HEAD\``;

type Source = 'dashboard' | 'git';
type Attempt = { commit?: unknown; error?: unknown } | null | undefined;
type Choice = { source: Source; commit: string } | { source: null; error: string };

const LABELS: Record<Source, string> = { dashboard: 'Dashboard', git: 'Git' };

// A commit hash, not the dashboard's `started-<ms>` stand-in for "git failed".
function commitOf(attempt: Attempt): string | null {
  if (!attempt || attempt.error) return null;
  const c = typeof attempt.commit === 'string' ? attempt.commit.trim() : '';
  return /^[0-9a-f]{7,40}$/i.test(c) ? c : null;
}

/** Pure. The dashboard's answer when it gave a commit, else git's, else why neither. */
function choose(dashboard: Attempt, git: Attempt): Choice {
  const d = commitOf(dashboard);
  if (d) return { source: 'dashboard', commit: d };
  const g = commitOf(git);
  if (g) return { source: 'git', commit: g };
  const why = (a: Attempt, name: string) => `${name}: ${a?.error ? String(a.error) : a ? 'no commit' : 'not asked'}`;
  return { source: null, error: `${why(dashboard, 'dashboard')}; ${why(git, 'git')}` };
}

/** Pure. "Dashboard: <commit>" or "Git: <commit>". */
function format(choice: { source: Source; commit: string }): string {
  return `${LABELS[choice.source]}: ${choice.commit}`;
}

function dashboardBase(): string {
  const { config } = require('../config.ts');
  // As src/e2e/goldenPath.ts: a server bound to every interface answers on loopback.
  const host = config.dispatch.host === '0.0.0.0' ? '127.0.0.1' : config.dispatch.host;
  return `http://${host}:${config.dispatch.port}`;
}

async function askDashboard(timeoutMs = 2000): Promise<Attempt> {
  try {
    const res = await fetch(`${dashboardBase()}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body: any = await res.json();
    return { commit: body?.commit };
  } catch (err: any) {
    return { error: err?.cause?.code || err?.message || String(err) };
  }
}

function askGit(): Attempt {
  try {
    const commit = require('child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { commit: String(commit).trim() };
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}

function make(out: any, fail: any) {
  return {
    async version() {
      const dashboard = await askDashboard();
      const choice = choose(dashboard, commitOf(dashboard) ? null : askGit());
      if (choice.source === null) return fail(`no version: ${choice.error}`);
      out(format(choice));
    },
  };
}

module.exports = { make, HELP, choose, format };
