'use strict';

// Happy path only. The review comments cover long text and the limit guard.
// DO NOT MERGE. Dummy for the review-fix acceptance run.

const assert = require('assert');
const { clipLabel } = require('../src/util/e2eClip.ts');

assert.strictEqual(clipLabel('ok', 10), 'ok');
assert.strictEqual(clipLabel('hello', 5), 'hello');

// Clipped output is exactly `limit` long: limit - 1 chars plus one U+2026.
const clipped = clipLabel('hello world', 5);
assert.strictEqual(clipped, 'hell…');
assert.strictEqual(clipped.length, 5);
assert.strictEqual(clipLabel('hello world', 1), '…');
assert.strictEqual(clipLabel('hello world', 1).length, 1);

// limit must be an integer >= 1.
for (const bad of [0, -1, 1.5]) {
  assert.throws(() => clipLabel('hello world', bad), RangeError);
}
