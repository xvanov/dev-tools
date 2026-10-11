'use strict';

// GitHub item shapes: the ids that make re-fetches idempotent, and the board
// filter that keeps other people's cards out of your list.

const assert = require('assert');
const { notificationItem, searchItem, projectItems, htmlUrl } = require('../src/ingest/github');

assert.strictEqual(
  htmlUrl('https://api.github.com/repos/innergy-dev/platform/pulls/100'),
  'https://github.com/innergy-dev/platform/pull/100'
);
assert.strictEqual(
  htmlUrl('https://api.github.com/repos/o/r/issues/7'),
  'https://github.com/o/r/issues/7'
);

{
  const n = {
    id: '42',
    reason: 'mention',
    updated_at: '2026-10-10T10:00:00Z',
    unread: true,
    repository: { full_name: 'o/r' },
    subject: { title: 'Fix it', type: 'Issue', url: 'https://api.github.com/repos/o/r/issues/7' },
  };
  const it = notificationItem(n, { body: 'desc', comment: '@me can you look?', commentAuthor: 'sam' });
  // A new comment bumps updated_at and must arrive as a new item to distill.
  assert.strictEqual(it.externalId, 'notification/42/2026-10-10T10:00:00Z');
  assert.strictEqual(it.authorIdentity, 'github:sam');
  assert.strictEqual(it.raw.project, 'o/r');
  assert.ok(it.bodyText.includes('can you look'));
  assert.strictEqual(notificationItem(n, null).authorIdentity, null);
}

{
  const it = searchItem('pr', {
    number: 5,
    title: 'T',
    state: 'open',
    html_url: 'https://github.com/o/r/pull/5',
    repository_url: 'https://api.github.com/repos/o/r',
    updated_at: '2026-10-10T10:00:00Z',
    user: { login: 'me' },
  });
  assert.strictEqual(it.externalId, 'pr/o/r#5');
  assert.strictEqual(it.raw.state, 'opened');
}

{
  const project = {
    title: 'Board',
    url: 'https://github.com/orgs/o/projects/1',
    items: {
      nodes: [
        { id: 'A', updatedAt: 'x', isArchived: false, status: { name: 'Todo' },
          content: { __typename: 'Issue', title: 'mine', state: 'OPEN', url: 'u', assignees: { nodes: [{ login: 'me' }] } } },
        { id: 'B', updatedAt: 'x', isArchived: false, status: null,
          content: { __typename: 'Issue', title: 'theirs', state: 'OPEN', assignees: { nodes: [{ login: 'sam' }] } } },
        { id: 'C', updatedAt: 'x', isArchived: false, status: null,
          content: { __typename: 'Issue', title: 'closed', state: 'CLOSED', assignees: { nodes: [{ login: 'me' }] } } },
        { id: 'D', updatedAt: 'x', isArchived: true, status: null,
          content: { __typename: 'DraftIssue', title: 'archived', assignees: { nodes: [{ login: 'me' }] } } },
        { id: 'E', updatedAt: 'x', isArchived: false, status: null,
          content: { __typename: 'DraftIssue', title: 'draft', assignees: { nodes: [{ login: 'me' }] } } },
      ],
    },
  };
  const items = projectItems(project, 'me');
  assert.deepStrictEqual(items.map((i) => i.externalId), ['project-item/A', 'project-item/E']);
  assert.strictEqual(items[0].subject, '[Board · Todo] mine');
  assert.strictEqual(items[1].threadExternalId, project.url);
}

console.log('github ok');
