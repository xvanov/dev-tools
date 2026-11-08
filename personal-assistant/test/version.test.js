'use strict';

// `pa version` (src/cli/version.js): the pure part only. Which commit to print, and
// the line that says where it came from. No network, no git: the dashboard's answer
// and the git reader are passed in as values or fakes.

const assert = require('assert');
const V = require('../src/cli/version');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// The git reader must never run when the dashboard answered. A fake that throws
// proves it: if the decision asks for git anyway, the test fails loudly.
const noGit = () => {
  throw new Error('git must not be read when the dashboard answered');
};

test('dashboard answered: its commit, labelled dashboard, git never read', () => {
  assert.strictEqual(V.versionLine('abc1234', noGit), 'abc1234 (dashboard)');
});

test('dashboard did not answer: git sha, labelled git/checkout', () => {
  assert.strictEqual(V.versionLine(null, () => 'def5678'), 'def5678 (git/checkout)');
});

test('dashboard answered with an empty or blank commit counts as not answered', () => {
  assert.strictEqual(V.versionLine('', () => 'def5678'), 'def5678 (git/checkout)');
  assert.strictEqual(V.versionLine('   ', () => 'def5678'), 'def5678 (git/checkout)');
});

test('both sources fail: null, so the caller can print an error', () => {
  assert.strictEqual(V.versionLine(null, () => null), null);
  assert.strictEqual(V.versionLine(null, () => ''), null);
});

test('git reader that throws is a failed git source, not a crash', () => {
  const boom = () => {
    throw new Error('not a git repository');
  };
  assert.strictEqual(V.versionLine(null, boom), null);
});

test('surrounding whitespace is trimmed from both sources', () => {
  assert.strictEqual(V.versionLine('  abc1234\n', noGit), 'abc1234 (dashboard)');
  assert.strictEqual(V.versionLine(null, () => '\tdef5678 \n'), 'def5678 (git/checkout)');
});

test('dashboard body: the commit field of a JSON object', () => {
  assert.strictEqual(V.commitFromDashboard({ commit: 'abc1234' }), 'abc1234');
});

test('dashboard body: unexpected shapes are no answer', () => {
  assert.strictEqual(V.commitFromDashboard(null), null);
  assert.strictEqual(V.commitFromDashboard(undefined), null);
  assert.strictEqual(V.commitFromDashboard('abc1234'), null);
  assert.strictEqual(V.commitFromDashboard(['abc1234']), null);
  assert.strictEqual(V.commitFromDashboard({}), null);
  assert.strictEqual(V.commitFromDashboard({ commit: 42 }), null);
  assert.strictEqual(V.commitFromDashboard({ commit: '' }), null);
  assert.strictEqual(V.commitFromDashboard({ sha: 'abc1234' }), null);
});

test('git output: the sha line, trimmed; empty output is no answer', () => {
  assert.strictEqual(V.shaFromGit('abc1234\n'), 'abc1234');
  assert.strictEqual(V.shaFromGit(''), null);
  assert.strictEqual(V.shaFromGit('\n'), null);
  assert.strictEqual(V.shaFromGit(undefined), null);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok - ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`not ok - ${t.name}\n  ${err.stack}`);
    }
  }
  if (failed) {
    console.log(`${failed} of ${tests.length} failed`);
    process.exit(1);
  }
  console.log(`${tests.length} passed`);
})();
