'use strict';

// `pa version`: the commit the running worker serves (GET /api/version), else
// the checkout's `git rev-parse --short HEAD`, saying which (src/cli/version.ts).

const test = require('node:test');
const assert = require('node:assert');

const version = require('../src/cli/version.ts');
const cli = require('../src/cli/index.ts');

test('a 2xx /api/version answer wins, and says it came from the dashboard', () => {
  const r = version.chooseVersion({ dashboard: { status: 200, body: '{"commit":"5961dbd0123456789abcdef0123456789abcdef0"}' }, git: () => 'abc1234\n' });
  assert.deepStrictEqual(r, { version: '5961dbd0123456789abcdef0123456789abcdef0', source: 'dashboard' });
  assert.strictEqual(version.formatVersion(r), '5961dbd0123456789abcdef0123456789abcdef0 (dashboard)');
});

test('the git fallback is not consulted when the dashboard answers', () => {
  let called = false;
  version.chooseVersion({ dashboard: { status: 200, body: '{"commit":"deadbee"}' }, git: () => { called = true; return 'x'; } });
  assert.strictEqual(called, false);
});

test('an unreachable dashboard falls back to the git short hash', () => {
  const r = version.chooseVersion({ dashboard: { error: new Error('connect ECONNREFUSED 127.0.0.1:7300') }, git: () => 'abc1234\n' });
  assert.deepStrictEqual(r, { version: 'abc1234', source: 'git' });
  assert.strictEqual(version.formatVersion(r), 'abc1234 (git fallback)');
});

test('a non-2xx answer falls back to git', () => {
  for (const status of [301, 404, 500, 503]) {
    const r = version.chooseVersion({ dashboard: { status, body: '{"commit":"deadbee"}' }, git: () => 'abc1234' });
    assert.deepStrictEqual(r, { version: 'abc1234', source: 'git' }, `status ${status}`);
  }
});

test('a 2xx answer without a commit (or not JSON) falls back to git', () => {
  for (const body of ['not json', '{}', '{"commit":""}', '{"commit":42}', '']) {
    const r = version.chooseVersion({ dashboard: { status: 200, body }, git: () => 'abc1234' });
    assert.strictEqual(r.source, 'git', `body ${JSON.stringify(body)}`);
  }
});

test('neither source: no version, and the reason', () => {
  const r = version.chooseVersion({ dashboard: { error: new Error('timeout') }, git: () => { throw new Error('not a git repository'); } });
  assert.strictEqual(r.version, null);
  assert.strictEqual(r.source, null);
  assert.match(r.error, /not a git repository/);
});

test('pa help lists the version verb, and the verb is registered', () => {
  assert.match(cli.HELP, /^\s+pa version\s/m);
  assert.strictEqual(typeof cli.commands.version, 'function');
});
