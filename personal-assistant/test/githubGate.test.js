'use strict';

// The GitHub gate: nothing is owed by you from an item you are not personally
// in, and a PR's own planned work stays with its author. Invented names only.

const assert = require('assert');
const { gate, involvement, mentions } = require('../src/distill/githubGate');
const { notificationItem, searchItem } = require('../src/ingest/github');

const ME = 'alex-dev';
const by = (summary, direction = 'owed_by_me') => ({ direction, summary, detail: null, counterparty: null });
const run = (item, cs) => gate(item, cs, { login: ME });

// mentions: by login only, not a team, not a longer login, not an email.
assert.ok(mentions('cc @alex-dev please', ME));
assert.ok(mentions('@Alex-Dev: thoughts?', ME));
assert.ok(!mentions('cc @org/cadcam', ME));
assert.ok(!mentions('cc @alex-dev2', ME));
assert.ok(!mentions('mail foo@alex-dev.com', ME));

// The reported case: a teammate's PR that reached you only because a team
// review was requested (legacy search row, nothing personal in it).
const teamPr = {
  source: 'github_pr',
  author_identity: 'github:sam-dev',
  subject: 'PR org/optimizer#486: Choose the outline tool',
  body_text: 'Backend only. The frontend lands in a follow-up PR. Requested review from @org/cadcam.',
  raw: { project: 'org/optimizer', assignees: [] },
};
{
  const r = run(teamPr, [by('Deliver frontend PR for outline tool picker'), by('Ship follow-up PR for re-optimize'), by('Sam to finish it', 'owed_to_me')]);
  assert.deepStrictEqual(r.commitments, []);
  assert.strictEqual(r.dropped.length, 3);
  assert.strictEqual(involvement(teamPr, ME).personal, false);
}

// Same PR, but you were requested by name: the review is yours, the frontend
// PR is the author's (owed to you), and other work is nobody's.
{
  const item = { ...teamPr, raw: { ...teamPr.raw, reviewRequested: true } };
  const r = run(item, [by('Review PR #486 before Friday'), by('Deliver frontend PR for outline tool picker'), by('Deploy ERP change before merging')]);
  assert.deepStrictEqual(r.commitments.map((c) => [c.direction, c.summary]), [
    ['owed_by_me', 'Review PR #486 before Friday'],
    ['owed_to_me', 'Deliver frontend PR for outline tool picker'],
  ]);
  assert.strictEqual(r.commitments[1].counterparty, 'github:sam-dev');
  assert.strictEqual(r.dropped.length, 1);
}

// Your own PR: everything passes untouched.
{
  const mine = { ...teamPr, author_identity: `github:${ME}` };
  const cs = [by('Ship follow-up PR for the frontend'), by('Rebase onto main')];
  assert.strictEqual(run(mine, cs).commitments, cs);
}

// Assigned to you (an issue from the assignee search): yours.
{
  const issue = { source: 'github_issue', author_identity: 'github:sam-dev', body_text: 'x', raw: { assignees: [ME] } };
  assert.strictEqual(run(issue, [by('Fix the saw filter')]).commitments.length, 1);
}

// @mentioned by login in the body: a conversation with you; a direct ask
// stays, the PR's own delivery still moves to its author.
{
  const item = { ...teamPr, body_text: '@alex-dev can you confirm the clearance rule? Frontend in a follow-up PR.' };
  const r = run(item, [by('Confirm the clearance rule for Sam'), by('Deliver frontend follow-up PR')]);
  assert.deepStrictEqual(r.commitments.map((c) => c.direction), ['owed_by_me', 'owed_to_me']);
}

// Notifications: the reason decides, and a team review request is not you.
const notif = (reason, detail, extra = {}) => ({
  source: 'github_notification',
  ...(() => {
    const it = notificationItem(
      {
        id: '1',
        reason,
        updated_at: '2026-10-20T10:00:00Z',
        repository: { full_name: 'org/r' },
        subject: { title: 'T', type: 'PullRequest', url: 'https://api.github.com/repos/org/r/pulls/9' },
      },
      detail
    );
    return { author_identity: it.authorIdentity, subject: it.subject, body_text: it.bodyText, raw: it.raw };
  })(),
  ...extra,
});
{
  const team = notif('review_requested', { requestedMe: false, author: 'sam-dev', commentAuthor: 'sam-dev', body: 'desc' });
  assert.strictEqual(team.raw.action, 'team_review_requested');
  assert.strictEqual(team.raw.author, 'sam-dev');
  assert.deepStrictEqual(run(team, [by('Review PR #9')]).commitments, []);

  const personal = notif('review_requested', { requestedMe: true, author: 'sam-dev', commentAuthor: 'sam-dev', body: 'desc' });
  assert.strictEqual(run(personal, [by('Review PR #9')]).commitments.length, 1);

  for (const reason of ['team_mention', 'subscribed', 'manual']) {
    const n = notif(reason, { author: 'sam-dev', commentAuthor: 'sam-dev', body: 'cc @org/cadcam' });
    assert.deepStrictEqual(run(n, [by('Fix the nest editor')]).commitments, [], reason);
  }

  // You replied in the thread (the latest comment is yours): you are in it.
  const replied = notif('subscribed', { author: 'sam-dev', commentAuthor: ME, comment: 'I will check the clearance', body: 'd' });
  assert.strictEqual(run(replied, [by('Check the clearance math')]).commitments.length, 1);

  // You authored the thread.
  const authored = notif('author', { author: ME, commentAuthor: 'sam-dev', comment: 'done?', body: 'd' });
  assert.strictEqual(run(authored, [by('Ship follow-up PR')]).commitments.length, 1);
}

// Board cards: a watched pod board's unassigned card is the pod's, not yours.
{
  const card = { source: 'github_project_item', author_identity: 'github:sam-dev', body_text: 'x', raw: { watched: true, assignees: [] } };
  assert.deepStrictEqual(run(card, [by('Implement the picker')]).commitments, []);
  const mine = { ...card, raw: { watched: true, assignees: [ME] } };
  assert.strictEqual(run(mine, [by('Implement the picker')]).commitments.length, 1);
}

// Non-GitHub items and an unknown login are not judged.
{
  const mail = { source: 'graph_mail', raw: {} };
  const cs = [by('Deliver frontend PR')];
  assert.strictEqual(run(mail, cs).commitments, cs);
  assert.strictEqual(gate(teamPr, cs, { login: null }).commitments, cs);
}

// The ingest records the evidence the gate reads.
{
  const pr = {
    number: 5, title: 'T', state: 'open', html_url: 'https://github.com/o/r/pull/5',
    repository_url: 'https://api.github.com/repos/o/r', updated_at: '2026-10-10T10:00:00Z', user: { login: 'sam-dev' },
  };
  assert.strictEqual(searchItem('pr', pr, { reviewRequested: true }).raw.reviewRequested, true);
  assert.strictEqual(searchItem('pr', pr).raw.reviewRequested, undefined);
}

console.log('githubGate ok');
