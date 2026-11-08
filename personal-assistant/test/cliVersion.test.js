'use strict';

// `pa version` (src/cli/version.ts): the dashboard's served commit when it
// answers, else this checkout's short hash, labelled with which it was.

const test = require('node:test');
const assert = require('node:assert');

const { choose, format } = require('../src/cli/version.ts');
const cli = require('../src/cli/index.ts');

test('the dashboard wins when it answers with a commit', () => {
  const c = choose({ commit: '5e2228fabc' }, { commit: 'a9b8832' });
  assert.deepStrictEqual(c, { source: 'dashboard', commit: '5e2228fabc' });
  assert.strictEqual(format(c), 'Dashboard: 5e2228fabc');
});

test('git is the fallback when the dashboard request fails', () => {
  const c = choose({ error: 'ECONNREFUSED' }, { commit: 'a9b8832\n' });
  assert.deepStrictEqual(c, { source: 'git', commit: 'a9b8832' });
  assert.strictEqual(format(c), 'Git: a9b8832');
});

test("git is the fallback when the dashboard has no commit (its started-<ms> stand-in)", () => {
  assert.strictEqual(choose({ commit: 'started-1762560000000' }, { commit: 'a9b8832' }).source, 'git');
  assert.strictEqual(choose({}, { commit: 'a9b8832' }).source, 'git');
});

test('neither answering says why, with no source', () => {
  const c = choose({ error: 'timeout' }, { error: 'not a git repository' });
  assert.strictEqual(c.source, null);
  assert.match(c.error, /dashboard: timeout/);
  assert.match(c.error, /git: not a git repository/);
});

test('version is a pa verb and in the HELP text', () => {
  assert.strictEqual(typeof cli.commands.version, 'function');
  assert.match(cli.HELP, /pa version\b/);
});
