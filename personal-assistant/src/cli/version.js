'use strict';

// `pa version`: the commit the running worker serves. The dashboard's
// GET /api/version (src/dashboard/server.js, servedCommit) when it answers —
// a pull without a restart does not change what that says — and otherwise
// `git rev-parse --short HEAD` of this checkout, with the source printed.

const path = require('path');

const TIMEOUT_MS = 2000;

// The commit in a GET /api/version body ({ commit }), or null.
function parseVersionBody(body) {
  const commit = body && typeof body.commit === 'string' ? body.commit.trim() : '';
  return commit || null;
}

// { commit, source: 'dashboard', url } or { commit, source: 'local', reason };
// throws when neither answers.
async function getVersion(deps) {
  const url = `${deps.paBase}/api/version`;
  let reason;
  try {
    const commit = parseVersionBody(await deps.getJson(url));
    if (commit) return { commit, source: 'dashboard', url };
    reason = 'no commit in its answer';
  } catch (err) {
    reason = err.message;
  }
  let short;
  try {
    short = String((await deps.gitShortHead()) || '').trim();
  } catch (err) {
    throw new Error(`no version: the dashboard (${url}) did not answer (${reason}) and git failed (${err.message})`);
  }
  if (!short) throw new Error(`no version: the dashboard (${url}) did not answer (${reason}) and git rev-parse printed nothing`);
  return { commit: short, source: 'local', reason };
}

function formatVersion(v) {
  if (v.source === 'dashboard') return `${v.commit}  (dashboard ${v.url})`;
  return `${v.commit}  (local checkout: the dashboard did not answer — ${v.reason})`;
}

function defaultDeps() {
  const { config } = require('../config');
  const paBase = `http://${config.dispatch.host === '0.0.0.0' ? '127.0.0.1' : config.dispatch.host}:${config.dispatch.port}`;
  return {
    paBase,
    async getJson(url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${res.status} on ${url}`);
      return res.json();
    },
    // The same checkout servedCommit() reads (cwd: this source tree).
    async gitShortHead() {
      return require('child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
  };
}

function make(out, fail) {
  return {
    async version(args, flags) {
      let v;
      try {
        v = await getVersion(defaultDeps());
      } catch (err) {
        return fail(err.message);
      }
      out(flags.json ? JSON.stringify(v) : formatVersion(v));
    },
  };
}

module.exports = { make, getVersion, parseVersionBody, formatVersion };
