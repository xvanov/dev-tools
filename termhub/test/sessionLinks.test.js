'use strict';

// Session links (lib/sessionLinks.js): the ids that tie a terminal to its card,
// PA run, factory job and step, sent on POST /api/sessions and returned by
// GET /api/sessions.
//
// What earns a test: links are metadata, so a bad or unknown entry is dropped
// rather than refusing the session (an older caller, or a newer one with a key
// this build does not know, must still get its terminal); a value is an id or
// (for `pr`) an http(s) URL, never markup or a path; numbers are accepted as
// ids; and a PATCH adds, replaces and (with null) removes keys.

const assert = require('assert');
const { KEYS, parseLinks, mergeLinks } = require('../lib/sessionLinks');

assert.deepStrictEqual(KEYS, ['card', 'run', 'job', 'step', 'story', 'external', 'pr']);

// Nothing sent, or nothing usable: null, and the session starts anyway.
for (const raw of [undefined, null, 'card=1', 42, [], {}, { unknown: 'x' }, { card: '' }]) {
  assert.strictEqual(parseLinks(raw), null, `nothing kept from ${JSON.stringify(raw)}`);
}

// The full chain, as the PA and the factory send it.
assert.deepStrictEqual(
  parseLinks({ card: 412, run: '77', job: 'dev-tools:031-pa-version', step: 9001, story: 55, external: '3f2a9c1e-77', pr: 12 }),
  { card: '412', run: '77', job: 'dev-tools:031-pa-version', step: '9001', story: '55', external: '3f2a9c1e-77', pr: '12' }
);

// A PR may be its URL; nothing else may be one.
assert.deepStrictEqual(parseLinks({ pr: 'https://github.com/o/r/pull/7' }), { pr: 'https://github.com/o/r/pull/7' });
assert.strictEqual(parseLinks({ job: 'https://example.com/x' }), null, 'a URL is not a job id');
assert.strictEqual(parseLinks({ pr: 'javascript:alert(1)' }), null, 'not an http(s) URL');

// Markup, spaces, paths and over-long values are dropped one by one, not the lot.
assert.deepStrictEqual(
  parseLinks({ card: '<img src=x>', run: '1 2', job: '../etc/passwd', step: 'x'.repeat(129), story: '5', other: 'ignored' }),
  { story: '5' }
);
assert.strictEqual(parseLinks({ card: Infinity }), null, 'a non-finite number is not an id');
assert.strictEqual(parseLinks({ card: { id: 1 } }), null, 'an object is not an id');

// PATCH: add, replace, remove.
assert.deepStrictEqual(mergeLinks({ job: 'a:1', step: '3' }, { pr: 9, step: '4' }), { job: 'a:1', step: '4', pr: '9' });
assert.deepStrictEqual(mergeLinks({ job: 'a:1', pr: '9' }, { pr: null }), { job: 'a:1' });
assert.strictEqual(mergeLinks({ pr: '9' }, { pr: null }), null, 'nothing left is null');
assert.deepStrictEqual(mergeLinks({ job: 'a:1' }, { job: '<b>' }), { job: 'a:1' }, 'a bad value leaves the old one');
assert.deepStrictEqual(mergeLinks(null, { card: 3 }), { card: '3' });
assert.deepStrictEqual(mergeLinks({ card: '3' }, 'junk'), { card: '3' });

console.log('sessionLinks.test.js ok');
