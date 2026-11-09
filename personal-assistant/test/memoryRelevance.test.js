'use strict';

// What may become memory (src/memory/relevance.ts): only items ME is part
// of. The reported case — a teammate's PR that reached ME through a team
// review request turned into "<repo> adds upload flows on detail pages" —
// and its neighbours. Invented names only.

const assert = require('assert');
const { meFrom, direct, partition, threadKey } = require('../src/memory/relevance.ts');

const me = meFrom([
  { kind: 'github_username', value: 'alex-dev' },
  { kind: 'smtp', value: 'Alex@Example.test' },
  { kind: 'aad_oid', value: 'AB-12' },
]);
assert.strictEqual(me.login, 'alex-dev');
assert.ok(me.authors.has('github:alex-dev') && me.authors.has('alex@example.test') && me.authors.has('aad:ab-12') && me.authors.has('me'));

const PR = 'https://github.example/org/library-ui/pull/198';
const teamNotification = {
  id: 1,
  source: 'github_notification',
  thread_external_id: PR,
  author_identity: 'github:sam-dev',
  subject: 'team_review_requested: library: Upload workbooks from the library pages',
  body_text: 'Description:\n## What\n- **Upload on the detail pages.**',
  raw: { project: 'org/library-ui', action: 'team_review_requested', author: 'sam-dev', requestedMe: false },
};
const ok = (item, m = me) => direct(item, m).ok;

// The reported case: not ME's, whoever reads it.
assert.ok(!ok(teamNotification));
assert.match(direct(teamNotification, me).why, /team_review_requested/);
// Without a login yet, the reason alone still says it is a team's queue.
assert.ok(!ok(teamNotification, meFrom([{ kind: 'smtp', value: 'alex@example.test' }])));
// A legacy search row of the same teammate's PR: nobody named ME.
const teamPr = { id: 2, source: 'github_pr', thread_external_id: PR, author_identity: 'github:sam-dev', subject: 'PR org/library-ui#198', body_text: 'Requested review from @org/cadcam.', raw: { assignees: [] } };
assert.ok(!ok(teamPr));

// Every way GitHub names ME personally.
assert.ok(ok({ ...teamNotification, raw: { ...teamNotification.raw, action: 'review_requested', requestedMe: true } }), 'review requested by name');
assert.ok(!ok({ ...teamNotification, raw: { ...teamNotification.raw, action: 'review_requested', requestedMe: false } }), 'by a team');
assert.ok(ok({ ...teamNotification, raw: { ...teamNotification.raw, action: 'mention' } }));
assert.ok(ok({ ...teamNotification, raw: { ...teamNotification.raw, action: 'author', author: 'alex-dev' } }), 'ME wrote the PR');
assert.ok(ok({ ...teamNotification, author_identity: 'github:alex-dev' }), 'ME wrote the latest comment');
assert.ok(ok({ ...teamPr, author_identity: 'github:alex-dev' }));
assert.ok(ok({ ...teamPr, raw: { assignees: ['Alex-Dev'] } }), 'assigned (login case folded)');
assert.ok(ok({ ...teamPr, raw: { assignees: [], reviewRequested: true } }), 'from the user-review-requested search');
assert.ok(ok({ ...teamPr, body_text: 'cc @alex-dev for the API side' }), '@mentioned');
assert.ok(!ok({ ...teamPr, body_text: 'cc @alex-dev2 and @org/team' }), 'not a longer login, not a team');

// Teams: a chat ME is in is ME's; a channel post only when it names ME or ME wrote it.
const chat = { id: 3, source: 'graph_chat', author_identity: 'sam@example.test', thread_external_id: 'chat-1', body_text: 'The mouldings plan has a smoke path.', raw: { chatType: 'group' } };
assert.ok(ok(chat));
const post = { ...chat, id: 4, thread_external_id: 'chan-root-9', raw: { chatType: 'channel', mentionsMe: false } };
assert.ok(!ok(post));
assert.ok(ok({ ...post, raw: { chatType: 'channel', mentionsMe: true } }));
assert.ok(ok({ ...post, author_identity: 'ALEX@example.test' }), 'ME posted it');
// ME's own sessions, meetings, mail: always.
for (const source of ['claude_session', 'audio', 'graph_mail', 'graph_event', 'jira_issue', 'pa_request']) assert.ok(ok({ id: 5, source, author_identity: 'someone@example.test', raw: {} }), source);

// A thread ME took part in makes all of it ME's: ME commented on the PR, so
// the team-request notification on the same PR is kept.
{
  const myComment = { id: 6, source: 'github_notification', thread_external_id: PR, author_identity: 'github:alex-dev', raw: { action: 'comment' } };
  const r = partition([teamNotification, teamPr], me, [myComment]);
  assert.deepStrictEqual(r.keep.map((i) => i.id), [1, 2]);
  assert.strictEqual(r.skip.length, 0);
  const alone = partition([teamNotification, teamPr, chat], me);
  assert.deepStrictEqual(alone.keep.map((i) => i.id), [3]);
  assert.deepStrictEqual(alone.skip.map((s) => s.item.id), [1, 2]);
  // A channel thread ME replied in.
  const reply = { ...post, id: 7, author_identity: 'alex@example.test' };
  assert.deepStrictEqual(partition([post], me, [reply]).keep.map((i) => i.id), [4]);
  // A Teams thread id never vouches for a GitHub item, and a repository URL
  // (a notification with no PR) is not a thread.
  assert.strictEqual(threadKey({ source: 'github_notification', thread_external_id: 'https://github.example/org/library-ui' }), null);
  assert.strictEqual(threadKey({ source: 'github_pr', thread_external_id: PR }), threadKey({ source: 'github_notification', thread_external_id: PR }));
  assert.notStrictEqual(threadKey({ source: 'graph_chat', thread_external_id: PR }), threadKey({ source: 'github_pr', thread_external_id: PR }));
  const repoWide = { ...teamNotification, id: 8, thread_external_id: 'https://github.example/org/library-ui' };
  const mine = { ...myComment, thread_external_id: 'https://github.example/org/library-ui' };
  assert.deepStrictEqual(partition([repoWide], me, [mine]).skip.map((s) => s.item.id), [8]);
}

console.log('memoryRelevance ok');
