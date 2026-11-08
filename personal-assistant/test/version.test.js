'use strict';

// `pa version`: unit tests for the pure selection/formatting logic and
// integration tests with a mocked dashboard and real git.

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const { formatVersion } = require('../src/cli/version');

// ----------------------------------------------------------- unit tests ----

{
  // Dashboard commit: preferred and labelled "dashboard".
  const r = formatVersion({ dashboardCommit: 'abc1234', gitCommit: null });
  assert.strictEqual(r, 'commit abc1234 (dashboard)');
}

{
  // Git commit: labelled "checkout" when there's no dashboard.
  const r = formatVersion({ dashboardCommit: null, gitCommit: 'def5678' });
  assert.strictEqual(r, 'commit def5678 (checkout)');
}

{
  // Both provided: dashboard wins.
  const r = formatVersion({ dashboardCommit: 'aaa1111', gitCommit: 'bbb2222' });
  assert.strictEqual(r, 'commit aaa1111 (dashboard)');
}

{
  // Neither: null.
  const r = formatVersion({ dashboardCommit: null, gitCommit: null });
  assert.strictEqual(r, null);
}

{
  // Undefined inputs behave the same as null.
  const r = formatVersion({});
  assert.strictEqual(r, null);
}

{
  // Empty string dashboardCommit is falsy, fall through to git.
  const r = formatVersion({ dashboardCommit: '', gitCommit: 'git456' });
  assert.strictEqual(r, 'commit git456 (checkout)');
}

// ---------------------------------------------------- integration helpers ----

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function makeVersionHandler(out, fail) {
  const { make } = require('../src/cli/version');
  return make(out, fail).version;
}

// Make a temporary git repo for a realistic git rev-parse fallback.
function tmpGitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ver-')));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=a@b', 'commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

// ---------------------------------------------- integration: dashboard ok ---

(async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ commit: 'dash007' }));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  const { port } = srv.address();

  const { config } = require('../src/config.ts');
  const savedHost = config.dispatch.host;
  const savedPort = config.dispatch.port;
  config.dispatch.host = '127.0.0.1';
  config.dispatch.port = port;

  const lines = [];
  const failLines = [];
  try {
    await makeVersionHandler(
      (t) => lines.push(t),
      (m) => failLines.push(m),
    )([], {});
  } finally {
    config.dispatch.host = savedHost;
    config.dispatch.port = savedPort;
  }

  assert.strictEqual(lines.length, 1, `lines: ${JSON.stringify(lines)}`);
  assert.strictEqual(lines[0], 'commit dash007 (dashboard)');
  assert.strictEqual(failLines.length, 0, `failLines: ${JSON.stringify(failLines)}`);

  srv.close();
})()
  .then(() => {
    // ----------------------------------------- integration: dashboard down ----
    return new Promise((resolve) => {
      const repo = tmpGitRepo();
      const shortHash = String(execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo })).trim();

      const srv = http.createServer((_req, res) => {
        res.writeHead(500);
        res.end('error');
      });
      srv.listen(0, '127.0.0.1', async () => {
        const { port } = srv.address();

        const { config } = require('../src/config.ts');
        const savedHost = config.dispatch.host;
        const savedPort = config.dispatch.port;
        const savedRoot = config.repoRoot;
        config.dispatch.host = '127.0.0.1';
        config.dispatch.port = port;
        config.repoRoot = repo;

        const lines = [];
        const failLines = [];
        try {
          await makeVersionHandler(
            (t) => lines.push(t),
            (m) => failLines.push(m),
          )([], {});
        } finally {
          config.dispatch.host = savedHost;
          config.dispatch.port = savedPort;
          config.repoRoot = savedRoot;
        }

        assert.strictEqual(lines.length, 1);
        assert.strictEqual(lines[0], `commit ${shortHash} (checkout)`);
        assert.strictEqual(failLines.length, 0);

        srv.close();
        fs.rmSync(repo, { recursive: true, force: true });
        resolve();
      });
    });
  })
  .then(() => {
    // ------------------------------------ integration: dashboard timeout ----
    return new Promise((resolve) => {
      const repo = tmpGitRepo();
      const shortHash = String(execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo })).trim();

      const srv = http.createServer(() => {}); // never responds
      srv.listen(0, '127.0.0.1', async () => {
        const { port } = srv.address();

        const { config } = require('../src/config.ts');
        const savedHost = config.dispatch.host;
        const savedPort = config.dispatch.port;
        const savedRoot = config.repoRoot;
        config.dispatch.host = '127.0.0.1';
        config.dispatch.port = port;
        config.repoRoot = repo;

        const lines = [];
        const failLines = [];
        try {
          await makeVersionHandler(
            (t) => lines.push(t),
            (m) => failLines.push(m),
          )([], {});
        } finally {
          config.dispatch.host = savedHost;
          config.dispatch.port = savedPort;
          config.repoRoot = savedRoot;
        }

        assert.strictEqual(lines.length, 1);
        assert.strictEqual(lines[0], `commit ${shortHash} (checkout)`);
        assert.strictEqual(failLines.length, 0);

        srv.closeAllConnections?.();
        srv.close();
        fs.rmSync(repo, { recursive: true, force: true });
        resolve();
      });
    });
  })
  .then(() => {
    // ----------------------------------- integration: dashboard 404 + no git --
    return new Promise((resolve) => {
      const repo = tmpGitRepo();
      // Remove .git to break git rev-parse.
      fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });

      const srv = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end('not found');
      });
      srv.listen(0, '127.0.0.1', async () => {
        const { port } = srv.address();

        const { config } = require('../src/config.ts');
        const savedHost = config.dispatch.host;
        const savedPort = config.dispatch.port;
        const savedRoot = config.repoRoot;
        config.dispatch.host = '127.0.0.1';
        config.dispatch.port = port;
        config.repoRoot = repo;

        const lines = [];
        const failLines = [];
        try {
          await makeVersionHandler(
            (t) => lines.push(t),
            (m) => failLines.push(m),
          )([], {});
        } finally {
          config.dispatch.host = savedHost;
          config.dispatch.port = savedPort;
          config.repoRoot = savedRoot;
        }

        assert.strictEqual(lines.length, 0);
        assert.ok(failLines.length > 0);
        assert.match(failLines[0], /version unavailable/);

        srv.close();
        fs.rmSync(repo, { recursive: true, force: true });
        resolve();
      });
    });
  })
  .then(() => {
    console.log('version.test.js ok');
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });