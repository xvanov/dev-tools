'use strict';

// `pa version`: print the commit the running worker serves (dashboard
// GET /api/version), falling back to the local checkout's short hash when the
// dashboard is unreachable, and saying which source the answer came from.

const HELP = `pa version — the commit the running worker serves
  
  pa version                     dashboard version when available, else the local checkout`;

function formatVersion({ dashboardCommit, gitCommit }) {
  if (dashboardCommit) return `commit ${dashboardCommit} (dashboard)`;
  if (gitCommit) return `commit ${gitCommit} (checkout)`;
  return null;
}

function make(out, fail) {
  return {
    async version(_args, _flags) {
      const { config } = require('../config.ts');
      const http = require('http');
      const { execFile } = require('child_process');

      // 1. Try the dashboard.
      let dashboardCommit = null;
      try {
        dashboardCommit = await new Promise((resolve, reject) => {
          const u = new URL(`http://${config.dispatch.host}:${config.dispatch.port}`);
          const req = http.get({ host: u.hostname, port: u.port, path: '/api/version', timeout: 5000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                const v = JSON.parse(body);
                if (v && v.commit) resolve(String(v.commit));
                else reject(new Error('no commit in response'));
              } catch (e) { reject(e); }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
      } catch (_e) {
        // Dashboard unreachable — fall through to git.
      }

      // 2. Fall back to git when the dashboard gave nothing.
      let gitCommit = null;
      if (!dashboardCommit) {
        try {
          gitCommit = await new Promise((resolve, reject) => {
            execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: config.repoRoot, timeout: 5000 }, (err, stdout) => {
              if (err) return reject(err);
              resolve(String(stdout).trim());
            });
          });
        } catch (_e) {
          // git unavailable too.
        }
      }

      const result = formatVersion({ dashboardCommit, gitCommit });
      if (result) out(result);
      else fail('version unavailable: the dashboard is unreachable and git rev-parse failed');
    },
  };
}

module.exports = { make, formatVersion, HELP };