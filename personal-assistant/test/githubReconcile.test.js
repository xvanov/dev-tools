'use strict';

// Which open commitments GitHub has already settled, and which review
// requests were never addressed to the reader.

const assert = require('assert');
const { verdict, prRef, refFor, refsFor, settledAll, duplicatePlan } = require('../src/ingest/githubReconcile');
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

// Asks naming several PRs, or naming them without the word "PR".
{
  const erp = { url: '', projectPath: 'innergy-dev/erp', projectName: 'erp' };
  const keys = (summary) => refsFor({ ...erp, summary })?.refs.map((r) => r.number) ?? null;
  assert.deepStrictEqual(keys('Review and approve ERP PRs #2062 (search API rate limit) and #2056 (paced tenant fill job)'), [2062, 2056]);
  assert.deepStrictEqual(keys('Have Brannoc review and approve ERP PRs 2023, 2064, and 2076'), [2023, 2064, 2076]);
  assert.deepStrictEqual(keys('Have Quill Ashby re-review ERP PR #2021'), [2021]);
  assert.deepStrictEqual(keys('Re-review ERP pull requests #2064 and #2056'), [2064, 2056]);
  assert.deepStrictEqual(keys('Finish fixing remaining review comments on ERP #2062 and #2056 within the hour'), [2062, 2056]);
  assert.deepStrictEqual(keys('Address the new review comments on PRs #2064 and #2056'), [2064, 2056]);
  assert.deepStrictEqual(keys('Merge PR 8 before PR 9'), [8, 9]);
  // Not asks about the PRs themselves, or nothing to look up.
  assert.strictEqual(keys('Sync ERP main with gizmo develop when the 134.1.0 release branch is cut'), null);
  assert.strictEqual(keys('Split PR 5 into 5a, 5b and 5c and land the fixes'), null);
  assert.strictEqual(keys('Send PRs to Brannoc one at a time as each is completed'), null);
  assert.strictEqual(keys('After PRs #41 and #42 merge, update the contract doc'), null);
  assert.strictEqual(refsFor({ summary: 'Review PRs 12 and 14', url: '', projectPath: null }), null);
  // The single-PR path is unchanged.
  assert.deepStrictEqual(refsFor({ summary: 'Answer Brannoc', url: 'https://github.com/acme/widgets/pull/42' }).fromText, false);

  const ref = (n) => ({ number: n });
  const merged = (d) => ({ state: 'closed', merged: true, mergedAt: d });
  assert.deepStrictEqual(
    settledAll([{ ref: ref(1), pr: merged('2031-04-01T00:00:00Z') }, { ref: ref(2), pr: merged('2031-04-02T00:00:00Z') }]),
    { status: 'done', reason: 'PRs #1, #2 merged or closed 2031-04-02' }
  );
  // One still open: the ask stands.
  assert.strictEqual(settledAll([{ ref: ref(1), pr: merged(null) }, { ref: ref(2), pr: open }]), null);
  assert.strictEqual(settledAll([{ ref: ref(1), pr: { state: 'closed', merged: false } }]).status, 'dropped');
}

// An ask found in text settles on merged/closed, or on a review I submitted
// after it was asked — never on GitHub's review-request bookkeeping.
{
  const fromChat = { summary: 'Review PR #12 on the importer', action: null, fromText: true, askedAt: '2026-03-02T10:00:00Z' };
  assert.strictEqual(verdict(fromChat, open, [], me), null);
  assert.strictEqual(verdict(fromChat, { ...open, state: 'closed' }, [], me).status, 'dropped');
  const after = [{ state: 'COMMENTED', submittedAt: '2026-03-02T15:30:00Z' }];
  assert.deepStrictEqual(verdict(fromChat, open, after, me), { status: 'done', reason: 'you reviewed it 2026-03-02' });
  // A review from before the ask does not answer it; nor does an unsent draft review.
  assert.strictEqual(verdict(fromChat, open, [{ state: 'APPROVED', submittedAt: '2026-03-01T09:00:00Z' }], me), null);
  assert.strictEqual(verdict(fromChat, open, [{ state: 'PENDING', submittedAt: null }], me), null);
  // Not a review ask: a review does not settle "deploy it after merge".
  assert.strictEqual(verdict({ ...fromChat, summary: 'Deploy PR #12 once merged' }, open, after, me), null);
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
