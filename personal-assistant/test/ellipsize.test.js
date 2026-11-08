'use strict';

// src/util/ellipsize.ts: one-line labels cut to a width.

const test = require('node:test');
const assert = require('assert');
const { ellipsize } = require('../src/util/ellipsize.ts');

test('ellipsize leaves short text alone', () => {
  assert.strictEqual(ellipsize('hello', 10), 'hello');
  assert.strictEqual(ellipsize('hello', 5), 'hello');
});
