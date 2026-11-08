'use strict';

// `pa version`: the pure part only (src/cli/version.ts). No network, no
// running dashboard, no git call: the I/O wrappers are thin and not tested here.

const test = require('node:test');
const assert = require('node:assert');

const { dashboardCommit, chooseVersion, formatVersion } = require('../src/cli/version.ts');

const DASH = 'a1b2c3d4e5f6071829304a5b6c7d8e9f00112233';
const GIT = 'ffee001';

test('dashboard body: returns the commit string from GET /api/version', () => {
  assert.strictEqual(dashboardCommit({ commit: DASH }), DASH);
});

test('dashboard body: anything without a non-empty string commit is no answer', () => {
  assert.strictEqual(dashboardCommit(null), null);
  assert.strictEqual(dashboardCommit({}), null);
  assert.strictEqual(dashboardCommit({ commit: '' }), null);
  assert.strictEqual(dashboardCommit({ commit: 42 }), null);
  assert.strictEqual(dashboardCommit('a1b2c3d'), null);
});

test('dashboard answers: its commit is chosen and labelled as the dashboard', () => {
  const choice = chooseVersion(DASH, GIT);
  assert.deepStrictEqual(choice, { commit: DASH, source: 'dashboard' });
  assert.match(formatVersion(choice), /^a1b2c3d4e5f6071829304a5b6c7d8e9f00112233 .*dashboard/);
});

test('dashboard does not answer, git does: git commit labelled as the git fallback', () => {
  const choice = chooseVersion(null, GIT);
  assert.deepStrictEqual(choice, { commit: GIT, source: 'git' });
  const line = formatVersion(choice);
  assert.match(line, /^ffee001 /);
  assert.match(line, /git fallback/);
  assert.doesNotMatch(line, /dashboard/);
});

test('neither answers: no choice, and a clear error that says so', () => {
  assert.strictEqual(chooseVersion(null, null), null);
  assert.strictEqual(chooseVersion('', ''), null);
});

test('the two sources produce different labels for the same commit', () => {
  const fromDash = formatVersion(chooseVersion(GIT, null));
  const fromGit = formatVersion(chooseVersion(null, GIT));
  assert.notStrictEqual(fromDash, fromGit);
  assert.match(fromDash, /dashboard/);
  assert.match(fromGit, /git fallback/);
});
