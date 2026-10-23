'use strict';

// Which open commitments GitHub has already settled, and which review
// requests were never addressed to the reader.

const assert = require('assert');
const { verdict, prRef, refFor, duplicatePlan } = require('../src/ingest/githubReconcile');
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

// The merge or close date goes in the reason when GitHub gives one.
assert.strictEqual(verdict(review, { ...open, merged: true, mergedAt: '2031-04-02T10:00:00Z' }, [], me).reason, 'PR merged 2031-04-02');

// Which PR a commitment is about.
{
  // The GitHub item's own URL first.
  const own = refFor({ summary: 'Answer Brannoc', url: 'https://github.com/acme/widgets/pull/42' });
  assert.deepStrictEqual([own.ref.key, own.fromText], ['acme/widgets#42', false]);
  // A PR URL in the text of a review/merge ask from chat.
  const linked = refFor({ summary: 'Review the importer fix', detail: 'see https://github.com/Acme/Widgets/pull/7', url: '' });
  assert.deepStrictEqual([linked.ref.key, linked.fromText], ['acme/widgets#7', true]);
  // "PR #N" plus the commitment's project.
  const numbered = refFor({ summary: 'Review and merge PR #63 for the resize script', url: '', projectPath: 'acme/gizmo' });
  assert.strictEqual(numbered.ref.key, 'acme/gizmo#63');
  // Not an ask about the PR itself: "after #41 merges, update the docs" is not settled by the merge.
  assert.strictEqual(refFor({ summary: 'After PR #41 merges, update the contract doc', url: '', projectPath: 'acme/gizmo' }), null);
  // Two PRs named, or none, or no repo to look in: no guess.
  assert.strictEqual(refFor({ summary: 'Merge PR 8 before PR 9', url: '', projectPath: 'acme/gizmo' }), null);
  assert.strictEqual(refFor({ summary: 'Review PRs 12 and 14', url: '', projectPath: 'acme/gizmo' }), null);
  assert.strictEqual(refFor({ summary: 'Review PR #63', url: '', projectPath: null }), null);
}

// An ask found in text settles only on merged/closed, never on review requests.
{
  const fromChat = { summary: 'Review PR #12 on the importer', action: null, fromText: true };
  assert.strictEqual(verdict(fromChat, open, [], me), null);
  assert.strictEqual(verdict(fromChat, { ...open, state: 'closed' }, [], me).status, 'dropped');
}

// Repeated review asks for one PR fold into the newest; other asks are left.
{
  const plan = duplicatePlan([
    { id: 5, key: 'acme/widgets#42', summary: 'Review the importer PR', status: 'open', supersededBy: null },
    { id: 9, key: 'acme/widgets#42', summary: 'Review PR adding the importer', status: 'open', supersededBy: null },
    { id: 12, key: 'acme/widgets#42', summary: 'Review the importer PR again', status: 'open', supersededBy: null },
    { id: 13, key: 'acme/widgets#42', summary: 'Deploy the importer after merge', status: 'open', supersededBy: null },
    { id: 20, key: 'acme/widgets#43', summary: 'Review the exporter PR', status: 'open', supersededBy: null },
  ]);
  assert.deepStrictEqual(plan, [
    { id: 5, supersededBy: 12 },
    { id: 9, supersededBy: 12 },
  ]);
  // A dispatched one is kept, and never superseded.
  const kept = duplicatePlan([
    { id: 5, key: 'k', summary: 'Review it', status: 'dispatched', supersededBy: null },
    { id: 9, key: 'k', summary: 'Review it', status: 'open', supersededBy: null },
  ]);
  assert.deepStrictEqual(kept, [{ id: 9, supersededBy: 5 }]);
  // An ask of mine and one owed to me on the same PR are different work.
  const sides = duplicatePlan([
    { id: 5, key: 'k', direction: 'owed_by_me', summary: 'Review it', status: 'open', supersededBy: null },
    { id: 9, key: 'k', direction: 'owed_to_me', summary: 'Review it', status: 'open', supersededBy: null },
  ]);
  assert.deepStrictEqual(sides, []);
}

// Notification reasons: a team-only review request is renamed; one naming me,
// or one whose detail could not be read, keeps its reason.
assert.strictEqual(reviewAction('review_requested', { requestedMe: false }), 'team_review_requested');
assert.strictEqual(reviewAction('review_requested', { requestedMe: true }), 'review_requested');
assert.strictEqual(reviewAction('review_requested', null), 'review_requested');
assert.strictEqual(reviewAction('mention', { requestedMe: false }), 'mention');

console.log('githubReconcile.test.js ok');
