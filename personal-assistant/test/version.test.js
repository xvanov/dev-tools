'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { selectVersion, formatVersion } = require('../src/cli/version.ts');

test('selectVersion returns dashboard source when response has a commit', () => {
  const result = selectVersion({ commit: 'abc1234' }, 'deadbee');
  assert.strictEqual(result.source, 'dashboard');
  assert.strictEqual(result.commit, 'abc1234');
});

test('selectVersion returns git source when response is null', () => {
  const result = selectVersion(null, 'deadbee');
  assert.strictEqual(result.source, 'git');
  assert.strictEqual(result.commit, 'deadbee');
});

test('selectVersion returns git source when response has no commit field', () => {
  const result = selectVersion({ error: 'something' }, 'deadbee');
  assert.strictEqual(result.source, 'git');
  assert.strictEqual(result.commit, 'deadbee');
});

test('selectVersion returns git source when commit is empty string', () => {
  const result = selectVersion({ commit: '' }, 'deadbee');
  assert.strictEqual(result.source, 'git');
  assert.strictEqual(result.commit, 'deadbee');
});

test('selectVersion returns git source when commit is whitespace only', () => {
  const result = selectVersion({ commit: '   ' }, 'deadbee');
  assert.strictEqual(result.source, 'git');
  assert.strictEqual(result.commit, 'deadbee');
});

test('formatVersion labels dashboard source correctly', () => {
  const result = formatVersion({ source: 'dashboard', commit: 'abc1234' });
  assert.strictEqual(result, 'Dashboard: abc1234');
});

test('formatVersion labels git source correctly', () => {
  const result = formatVersion({ source: 'git', commit: 'deadbee' });
  assert.strictEqual(result, 'Git: deadbee');
});

test('selectVersion + formatVersion integrated: dashboard path', () => {
  // Simulate the full pipeline: fetch OK → select → format
  const body = { commit: 'abc1234' };
  const chosen = selectVersion(body, 'deadbee');
  assert.strictEqual(chosen.source, 'dashboard');
  assert.strictEqual(chosen.commit, 'abc1234');
  const output = formatVersion(chosen);
  assert.strictEqual(output, 'Dashboard: abc1234');
});

test('selectVersion + formatVersion integrated: git fallback path', () => {
  // Simulate fetch failed (null body) → select → format
  const chosen = selectVersion(null, 'deadbee');
  assert.strictEqual(chosen.source, 'git');
  assert.strictEqual(chosen.commit, 'deadbee');
  const output = formatVersion(chosen);
  assert.strictEqual(output, 'Git: deadbee');
});