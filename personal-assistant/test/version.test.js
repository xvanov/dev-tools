'use strict';

// `pa version`: pure formatVersion logic and CLI command path.

const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const http = require('http');

const { formatVersion, make } = require('../src/cli/version.ts');

// ---- pure formatVersion ----

{
  const local = 'abc1234';
  const dashboard = 'def5678';

  // AC 6.1: dashboard version present → dashboard-prefixed string.
  assert.strictEqual(formatVersion(dashboard, local), `dashboard: ${dashboard}`);

  // AC 6.2: dashboard version null → local-prefixed string.
  assert.strictEqual(formatVersion(null, local), `local: ${local}`);

  // Empty string treated as absent (same as null).
  assert.strictEqual(formatVersion('', local), `local: ${local}`);
}

// ---- CLI path: wired make() ----

async function testCliPath() {
  const gitHash = cp.execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  assert.ok(gitHash.length >= 4, 'git rev-parse returned a short hash');

  // With dashboardVersion null: formatVersion uses local.
  assert.strictEqual(formatVersion(null, gitHash), `local: ${gitHash}`);

  let outCalled = null;
  let failCalled = null;
  const out = (text) => { outCalled = text; };
  const fail = (msg) => { failCalled = msg; };

  const instance = make(out, fail);

  // Call version(). This will try the real dashboard, but even if it
  // succeeds, we just check that out or fail was called with a non-empty
  // string (AC 1.1, AC 4.1). We cannot control network here; we assert
  // that one of out/fail fires and the output distinguishes the source.
  await instance.version();

  if (failCalled !== null) {
    // git failure path — only happens if git is broken.
    assert.match(failCalled, /cannot read local git hash/);
  } else {
    assert.ok(outCalled !== null, 'out or fail must have been called');
    if (outCalled !== null) {
      // AC 4.1: output clearly indicates the source.
      assert.ok(
        outCalled.startsWith('dashboard: ') || outCalled.startsWith('local: '),
        `output must indicate source: ${outCalled}`
      );
      // AC 1.1: command exits with status 0 (no fail call implies success).
    }
  }
}

async function main() {
  await testCliPath();
  console.log('version.test.js ok');
}

main();