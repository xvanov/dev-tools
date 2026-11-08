'use strict';

// `pa version`: the pure part (source choice, output line) and the response parser.
// No dashboard and no git are touched here; the thin wrappers are not exercised.

const test = require('node:test');
const assert = require('node:assert');

const V = require('../src/cli/version.ts');

const FULL = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

test('parseDashboardCommit reads the commit field of a /api/version body and shortens it to 7', () => {
  assert.strictEqual(V.parseDashboardCommit(JSON.stringify({ commit: FULL })), 'a1b2c3d');
});

test('parseDashboardCommit rejects bodies that are not a commit (bad JSON, missing field, placeholder)', () => {
  assert.strictEqual(V.parseDashboardCommit('<html>not json</html>'), null);
  assert.strictEqual(V.parseDashboardCommit(JSON.stringify({ ready: true })), null);
  // servedCommit() falls back to 'started-<ms>' when git is missing in the worker: not a commit.
  assert.strictEqual(V.parseDashboardCommit(JSON.stringify({ commit: 'started-1731000000000' })), null);
});

test('chooseSource: dashboard answers -> dashboard wins even when git also knows a commit', () => {
  const r = V.chooseSource('a1b2c3d', 'ffeedd0');
  assert.deepStrictEqual(r, { commit: 'a1b2c3d', source: 'dashboard', error: null });
});

test('chooseSource: dashboard does not answer -> git checkout is used', () => {
  const r = V.chooseSource(null, 'ffeedd0');
  assert.deepStrictEqual(r, { commit: 'ffeedd0', source: 'git', error: null });
});

test('chooseSource: both fail -> no commit, no source, and an error saying why', () => {
  const r = V.chooseSource(null, null);
  assert.strictEqual(r.commit, null);
  assert.strictEqual(r.source, null);
  assert.match(r.error, /dashboard/);
  assert.match(r.error, /git/);
});

test('formatVersion always names the source in the output line', () => {
  assert.strictEqual(
    V.formatVersion({ commit: 'a1b2c3d', source: 'dashboard', error: null }),
    'a1b2c3d (from the dashboard/worker)'
  );
  assert.strictEqual(
    V.formatVersion({ commit: 'ffeedd0', source: 'git', error: null }),
    'ffeedd0 (from the git checkout)'
  );
});

test('the verb prints the formatted line and exits 0 when a source answered', async () => {
  const lines = [];
  const failures = [];
  const { version } = V.make((t) => lines.push(String(t)), (m) => failures.push(String(m)), {
    dashboard: async () => 'a1b2c3d',
    git: () => null,
  });
  await version();
  assert.deepStrictEqual(lines, ['a1b2c3d (from the dashboard/worker)']);
  assert.deepStrictEqual(failures, []);
});

test('the verb reports a clear error (not a stack trace) when neither source answers', async () => {
  const lines = [];
  const failures = [];
  const { version } = V.make((t) => lines.push(String(t)), (m) => failures.push(String(m)), {
    dashboard: async () => null,
    git: () => null,
  });
  await version();
  assert.deepStrictEqual(lines, []);
  assert.strictEqual(failures.length, 1);
  assert.match(failures[0], /dashboard/);
  assert.doesNotMatch(failures[0], /\n\s+at /);
});
