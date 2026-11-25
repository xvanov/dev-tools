'use strict';

// A drafter may answer NO_REPLY_NEEDED instead of a message when the later
// messages in the thread show nothing is owed (src/draft/draft.ts settledBy).

const assert = require('assert');
const { settledBy } = require('../src/draft/draft.ts');

assert.strictEqual(settledBy('NO_REPLY_NEEDED: "Done."'), '"Done."');
assert.strictEqual(settledBy('  NO_REPLY_NEEDED:\n"the installs went through"  '), '"the installs went through"');
assert.strictEqual(settledBy('NO_REPLY_NEEDED'), 'the thread shows it settled');
assert.strictEqual(settledBy('Hi Jon, where does the transfer stand?'), null);
assert.strictEqual(settledBy('Hi Jon, NO_REPLY_NEEDED is not a reply'), null, 'only as the whole answer');
assert.strictEqual(settledBy(''), null);

console.log('draftSettled ok');
