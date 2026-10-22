'use strict';

// Which open commitments GitHub has already settled, and which review
// requests were never addressed to the reader.

const assert = require('assert');
const { verdict, prRef } = require('../src/ingest/githubReconcile');
const { reviewAction } = require('../src/ingest/github');

const me = 'quill';
const review = { summary: 'Review PR #12 on the importer', action: 'review_requested' };
const open = { state: 'open', merged: false, requestedLogins: [], authorLogin: 'brannoc' };

assert.deepStrictEqual(verdict(review, { ...open, merged: true }, [], me), { status: 'done', reason: 'PR merged' });
assert.strictEqual(verdict(review, { ...open, state: 'closed' }, [], me).status, 'dropped');
// Still requested from me: leave it open.
assert.strictEqual(verdict(review, { ...open, requestedLogins: ['quill'] }, [], me), null);
// Reviewed, no longer requested: done.
assert.deepStrictEqual(verdict(review, open, ['APPROVED'], me), { status: 'done', reason: 'you reviewed it' });
// Never requested from me (team only), never reviewed: not mine.
assert.match(verdict(review, open, [], me).reason, /team/);
// Not a review ask, PR still open: untouched.
assert.strictEqual(verdict({ summary: 'Answer Brannoc about the release', action: 'mention' }, open, [], me), null);
// My own PR: a "review" commitment there is about my PR, not a request to me.
assert.strictEqual(verdict(review, { ...open, authorLogin: 'quill' }, [], me), null);
assert.strictEqual(verdict(review, null, [], me), null);

assert.deepStrictEqual(prRef('https://github.com/acme/widgets/pull/42'), {
  owner: 'acme',
  repo: 'widgets',
  number: 42,
  key: 'acme/widgets#42',
});
assert.strictEqual(prRef('https://github.com/acme/widgets/issues/42'), null);

// Notification reasons: a team-only review request is renamed; one naming me,
// or one whose detail could not be read, keeps its reason.
assert.strictEqual(reviewAction('review_requested', { requestedMe: false }), 'team_review_requested');
assert.strictEqual(reviewAction('review_requested', { requestedMe: true }), 'review_requested');
assert.strictEqual(reviewAction('review_requested', null), 'review_requested');
assert.strictEqual(reviewAction('mention', { requestedMe: false }), 'mention');

console.log('githubReconcile.test.js ok');
