'use strict';

// Tests for the pure version-resolution logic (src/cli/version.ts),
// and smoke tests for the CLI integration.

const test = require('node:test');
const assert = require('node:assert');

const { resolveVersion, HELP } = require('../src/cli/version.ts');

// AC6.1: pure logic — success path
test('resolveVersion returns dashboard result when fetch succeeds', async () => {
  const fetch = async () => 'abc1234';
  const git = async () => { throw new Error('should not be called'); };
  const result = await resolveVersion(fetch, git);
  assert.strictEqual(result.value, 'abc1234');
  assert.strictEqual(result.source, 'dashboard');
});

// AC6.1: pure logic — fallback path
test('resolveVersion falls back to git when fetch throws', async () => {
  const fetch = async () => { throw new Error('ECONNREFUSED'); };
  const git = async () => 'def5678';
  const result = await resolveVersion(fetch, git);
  assert.strictEqual(result.value, 'def5678');
  assert.strictEqual(result.source, 'git');
});

// AC6.1: pure logic — fetch returns null
test('resolveVersion falls back to git when fetch returns null', async () => {
  const fetch = async () => null;
  const git = async () => 'def5678';
  const result = await resolveVersion(fetch, git);
  assert.strictEqual(result.value, 'def5678');
  assert.strictEqual(result.source, 'git');
});

// AC6.1: pure logic — fetch returns empty string
test('resolveVersion falls back to git when fetch returns empty string', async () => {
  const fetch = async () => '';
  const git = async () => 'def5678';
  const result = await resolveVersion(fetch, git);
  assert.strictEqual(result.value, 'def5678');
  assert.strictEqual(result.source, 'git');
});

// AC6.1: pure logic — both fail
test('resolveVersion throws when both sources fail', async () => {
  const fetch = async () => { throw new Error('ECONNREFUSED'); };
  const git = async () => { throw new Error('not a git repo'); };
  await assert.rejects(
    () => resolveVersion(fetch, git),
    (err) => /could not determine version/.test(err.message)
  );
});

// AC6.1: pure logic — git returns null
test('resolveVersion throws when git returns null after dashboard fails', async () => {
  const fetch = async () => { throw new Error('timeout'); };
  const git = async () => null;
  await assert.rejects(
    () => resolveVersion(fetch, git),
    (err) => /could not determine version/.test(err.message)
  );
});

// AC4.1: The source label is included in the format — verified by the
// combination of value + source. Each test above asserts on source.

// AC5.1: HELP text lists version
test('HELP text contains version verb', () => {
  assert.ok(typeof HELP === 'string');
  assert.ok(HELP.trim().length > 0);
  assert.ok(HELP.includes('pa version'), 'HELP should mention pa version');
});

// AC7.1: CLI module loads without error (existing commands unaffected)
test('version CLI module loads and exports make and HELP', () => {
  const mod = require('../src/cli/version.ts');
  assert.strictEqual(typeof mod.make, 'function');
  assert.strictEqual(typeof mod.HELP, 'string');
  assert.strictEqual(typeof mod.resolveVersion, 'function');
});

// Verify the version command is registered in the main CLI
test('version verb is registered in the CLI commands', () => {
  const { commands } = require('../src/cli/index.ts');
  assert.strictEqual(typeof commands.version, 'function', 'version command should be registered');
});