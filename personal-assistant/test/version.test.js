'use strict';

// Unit tests for the pure version-selection/formatting logic (src/cli/version.ts).

const test = require('node:test');
const assert = require('node:assert');
const { formatVersion } = require('../src/cli/version.ts');

test('formatVersion: dashboard success path', () => {
  // Dashboard commit available — prefer it, output with source indicator.
  const result = formatVersion('abc1234', 'def5678');
  assert.strictEqual(result, 'dashboard: abc1234');
});

test('formatVersion: dashboard success with git null', () => {
  const result = formatVersion('abc1234', null);
  assert.strictEqual(result, 'dashboard: abc1234');
});

test('formatVersion: git fallback when dashboard is null', () => {
  const result = formatVersion(null, 'def5678');
  assert.strictEqual(result, 'git: def5678');
});

test('formatVersion: git fallback when dashboard is empty string', () => {
  const result = formatVersion('', 'def5678');
  assert.strictEqual(result, 'git: def5678');
});

test('formatVersion: unknown when both are null', () => {
  const result = formatVersion(null, null);
  assert.strictEqual(result, 'version unknown (dashboard unreachable, git unavailable)');
});

test('formatVersion: unknown when both are empty strings', () => {
  const result = formatVersion('', '');
  assert.strictEqual(result, 'version unknown (dashboard unreachable, git unavailable)');
});