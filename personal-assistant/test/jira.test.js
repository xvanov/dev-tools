'use strict';

// The Jira relay is a model in the loop, so its reply is validated, not
// trusted: malformed keys are dropped, and the item shape is pinned.

const assert = require('assert');
const { buildJql, buildPrompt, parseReply, issueItem } = require('../src/ingest/jira');

{
  const jql = buildJql('2026-10-01T08:30:59.000Z');
  assert.ok(jql.includes('updated >= "2026-10-01 08:30"'));
  assert.ok(jql.includes('assignee = currentUser()'));
  assert.ok(buildPrompt({ cloudId: null, jql, max: 50 }).includes('getAccessibleAtlassianResources'));
  assert.ok(buildPrompt({ cloudId: 'abc', jql, max: 50 }).includes('cloudId is abc'));
}

{
  const reply = 'Here you go:\n' + JSON.stringify({
    cloudId: 'c1',
    site: 'https://innergy.atlassian.net/',
    issues: [
      { key: 'MVL-3594', summary: 'Paths', status: 'Pending Approval', statusCategory: 'In Progress',
        updated: '2026-10-10T10:00:00Z', description: 'd', lastComment: { author: 'Sam', body: 'can you check?' } },
      { key: 'not a key', summary: 'x' },
      { key: 'ASPEN-1', summary: '' },
    ],
  });
  const parsed = parseReply(reply);
  assert.strictEqual(parsed.site, 'https://innergy.atlassian.net');
  assert.deepStrictEqual(parsed.issues.map((i) => i.key), ['MVL-3594']);

  const it = issueItem(parsed.issues[0], parsed.site);
  assert.strictEqual(it.externalId, 'MVL-3594');
  assert.strictEqual(it.threadExternalId, 'https://innergy.atlassian.net/browse/MVL-3594');
  assert.strictEqual(it.authorIdentity, 'Sam');
  assert.strictEqual(it.raw.project, 'MVL');
  assert.strictEqual(it.raw.state, 'opened');
  assert.ok(it.bodyText.startsWith('Latest comment by Sam'));
  assert.strictEqual(issueItem({ ...parsed.issues[0], statusCategory: 'Done' }, null).raw.state, 'closed');
}

assert.throws(() => parseReply('{"nope":1}'), /no issues array/);

console.log('jira ok');
