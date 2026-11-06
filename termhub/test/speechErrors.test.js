'use strict';

// Web Speech error codes -> what the user is told. Plain node, no deps:
//   node test/speechErrors.test.js
//
// The bug this pins: `service-not-allowed` (Dictation/Siri off on iOS) and
// `not-allowed` (site permission) used to share one message, and every other
// code became "keeps failing" with the code thrown away.

const assert = require('assert');
const E = require('../web/speechErrors');

assert.ok(E.isBenign('aborted') && E.isBenign('no-speech'));
assert.ok(!E.isBenign('network'));
assert.ok(E.isTerminal('not-allowed') && E.isTerminal('service-not-allowed'));
assert.ok(!E.isTerminal('audio-capture') && !E.isTerminal('network'));

const notAllowed = E.describe('not-allowed', { ios: true });
const service = E.describe('service-not-allowed', { ios: true });
assert.notStrictEqual(notAllowed, service, 'site permission and Dictation-off must not read the same');
assert.match(service, /Dictation/);
assert.match(E.describe('service-not-allowed', { ios: true, standalone: true }), /home-screen/);
assert.match(E.describe('audio-capture'), /another tab or app/);
assert.match(E.describe('network', { ios: true }), /internet/);

// Every message carries its raw code, so a screenshot is a diagnosis.
for (const code of ['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported', 'bad-grammar', 'something-new']) {
  assert.ok(E.describe(code).includes(`(${code})`), `${code} keeps its code`);
}

console.log('speechErrors.test.js ok');
