'use strict';

// Happy path only. The review comments cover long text and the limit guard.
// DO NOT MERGE. Dummy for the review-fix acceptance run.

const assert = require('assert');
const { clipLabel } = require('../src/util/e2eClip.ts');

assert.strictEqual(clipLabel('ok', 10), 'ok');
assert.strictEqual(clipLabel('hello', 5), 'hello');
