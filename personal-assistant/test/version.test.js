'use strict';

// `pa version`: the pure part only. The dashboard fetch and the git fallback are
// I/O and are not exercised here; this file must not make network calls or run git.

const test = require('node:test');
const assert = require('node:assert');

const { formatVersionOutput } = require('../src/cli/version.ts');
const { HELP } = require('../src/cli/index.ts');

test('formatVersionOutput prints the commit and the source it came from', () => {
  assert.strictEqual(formatVersionOutput('0d3d401', 'dashboard/worker'), '0d3d401 (source: dashboard/worker)');
  assert.strictEqual(formatVersionOutput('84f4c47', 'git checkout'), '84f4c47 (source: git checkout)');
});

test('the main HELP text lists pa version with a one-line description', () => {
  const line = HELP.split('\n').find((l) => l.trimStart().startsWith('pa version'));
  assert.ok(line, 'no "pa version" line in HELP');
  assert.match(line, /pa version\s+\S/, 'pa version has no description');
});
