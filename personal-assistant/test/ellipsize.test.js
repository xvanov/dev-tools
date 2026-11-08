'use strict';

// src/util/ellipsize.ts: one-line labels cut to a width.

const test = require('node:test');
const assert = require('assert');
const { ellipsize } = require('../src/util/ellipsize.ts');

test('ellipsize leaves short text alone', () => {
  assert.strictEqual(ellipsize('hello', 10), 'hello');
  assert.strictEqual(ellipsize('hello', 5), 'hello');
});

test('ellipsize returns exactly limit characters, ellipsis included, for long text', () => {
  const out = ellipsize('hello world', 5);
  assert.strictEqual(out, 'hell…');
  assert.strictEqual(out.length, 5);
});

test('ellipsize with limit 1 returns just the ellipsis', () => {
  const out = ellipsize('hello world', 1);
  assert.strictEqual(out, '…');
  assert.strictEqual(out.length, 1);
});

test('ellipsize throws RangeError for limit 0', () => {
  assert.throws(() => ellipsize('hello world', 0), RangeError);
});

test('ellipsize throws RangeError for a negative limit', () => {
  assert.throws(() => ellipsize('hello world', -1), RangeError);
});

test('ellipsize throws RangeError for a non-integer limit', () => {
  assert.throws(() => ellipsize('hello world', 1.5), RangeError);
});

test('ellipsize does not throw for an integer limit >= 1', () => {
  assert.doesNotThrow(() => ellipsize('hello world', 1));
  assert.doesNotThrow(() => ellipsize('hello', 5));
});
