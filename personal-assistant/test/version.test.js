'use strict';

// Unit tests for the pure formatting logic of `pa version` (AC6):
// formatVersionOutput(source, commit) — no network, no git, no I/O.

const test = require('node:test');
const assert = require('node:assert');

const { formatVersionOutput } = require('../src/cli/version.ts');

// AC2.1 + AC2.2: dashboard source prints the commit and says it came from the dashboard
test('formatVersionOutput dashboard source', () => {
  const out = formatVersionOutput('dashboard', 'abc1234');
  assert.ok(out.includes('commit abc1234'), 'should include the commit');
  assert.ok(out.includes('dashboard'), 'should mention dashboard/running worker');
});

// AC3.1 + AC3.2: git fallback prints the short hash and says it came from the local checkout
test('formatVersionOutput git source', () => {
  const out = formatVersionOutput('git', 'def5678');
  assert.ok(out.includes('commit def5678'), 'should include the commit');
  assert.ok(out.includes('local checkout'), 'should mention local checkout');
});

// AC4.1 + AC4.2: neither source yields a commit -> error message, no empty/whitespace output
test('formatVersionOutput error source', () => {
  const out = formatVersionOutput('error');
  assert.ok(out.startsWith('error:'), 'should start with error:');
  assert.ok(!/^\s*$/.test(out), 'should not be empty or whitespace-only');
  assert.ok(out.length > 10, 'should be a real error message');
});

// Edge: empty commit with a valid source -> treated same as error
test('formatVersionOutput empty commit treated as error', () => {
  const out = formatVersionOutput('dashboard', '');
  assert.ok(out.startsWith('error:'), 'empty commit should yield error');
});

// Edge: null/undefined commit
test('formatVersionOutput undefined commit treated as error', () => {
  const out = formatVersionOutput('dashboard', undefined);
  assert.ok(out.startsWith('error:'), 'undefined commit should yield error');
});

// Sanity: dashboard and git outputs differ
test('formatVersionOutput dashboard and git produce distinct messages', () => {
  const dash = formatVersionOutput('dashboard', 'abc1234');
  const git = formatVersionOutput('git', 'abc1234');
  assert.notStrictEqual(dash, git, 'dashboard and git messages should differ');
});