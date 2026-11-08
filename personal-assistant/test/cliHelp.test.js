'use strict';

// `pa help <topic>` requires each topic's module by a computed path, which
// requiresResolve.test.js cannot see: after the .ts move every topic threw
// MODULE_NOT_FOUND, so `pa help e2e` (and every other topic) crashed.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { HELP_TOPICS } = require('../src/cli/index.ts');

test('every pa help topic loads its module and has a HELP text', () => {
  const dir = path.join(__dirname, '..', 'src', 'cli');
  assert.ok(Object.keys(HELP_TOPICS).length >= 10);
  for (const [topic, rel] of Object.entries(HELP_TOPICS)) {
    const mod = require(path.join(dir, rel));
    assert.strictEqual(typeof mod.HELP, 'string', `pa help ${topic}: ${rel} exports no HELP`);
    assert.ok(mod.HELP.trim().length > 0, `pa help ${topic}: empty HELP`);
  }
});
