'use strict';

// `pa version`: the commit the running worker serves. It asks the dashboard's
// GET /api/version first (src/dashboard/server.js); when that does not answer, it
// reads `git rev-parse --short HEAD` of this checkout. The decisions are pure
// (versionLine, commitFromDashboard, shaFromGit); the network and git reads are
// thin wrappers around them.

const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

// This checkout: the personal-assistant directory, wherever `pa` is invoked from.
const CHECKOUT = path.resolve(__dirname, '..', '..');

const HELP = `pa version — the commit the running worker serves (dashboard /api/version), or this checkout's HEAD if the dashboard does not answer`;

// A non-empty string commit out of the dashboard's JSON body, or null.
function commitFromDashboard(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const commit = typeof body.commit === 'string' ? body.commit.trim() : '';
  return commit || null;
}

// The sha out of `git rev-parse --short HEAD` stdout, or null.
function shaFromGit(stdout) {
  const sha = typeof stdout === 'string' ? stdout.trim() : '';
  return sha || null;
}

// The one line to print, or null when neither source has a commit. The git reader
// is a thunk so it runs only when the dashboard did not answer.
function versionLine(dashboardCommit, readGit) {
  const fromDashboard = typeof dashboardCommit === 'string' ? dashboardCommit.trim() : '';
  if (fromDashboard) return `${fromDashboard} (dashboard)`;
  let fromGit = null;
  try {
    fromGit = shaFromGit(readGit());
  } catch {
    fromGit = null;
  }
  return fromGit ? `${fromGit} (git/checkout)` : null;
}

// Wrapper: GET /api/version on the dashboard. Resolves to the commit string, or null
// on connection failure, timeout, a non-200 answer or an unparseable body.
function fetchDashboardCommit({ host, port, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = http.get({ host, port, path: '/api/version', timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return done(null);
        try {
          done(commitFromDashboard(JSON.parse(raw)));
        } catch {
          done(null);
        }
      });
      res.on('error', () => done(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(null));
  });
}

// Wrapper: `git rev-parse --short HEAD` in the checkout. Returns the raw stdout;
// throws when git is missing or this is not a repository (versionLine catches it).
function readGitHead(cwd = CHECKOUT) {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function make(out, fail) {
  return {
    async version() {
      const { config } = require('../config');
      const dashboard = await fetchDashboardCommit({ host: config.dispatch.host, port: config.dispatch.port });
      const line = versionLine(dashboard, () => readGitHead());
      if (!line) {
        return fail(`no commit: the dashboard did not answer GET /api/version (is the worker running? \`pa dashboard\`), and ${CHECKOUT} is not a git checkout with a HEAD`);
      }
      out(line);
    },
  };
}

module.exports = { make, HELP, versionLine, commitFromDashboard, shaFromGit, fetchDashboardCommit, readGitHead, CHECKOUT };
