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

// ------------------------------------------------------------------ REST --
// /rest/api/3/search/jql returns Atlassian Document Format and nested
// objects; restIssue flattens them to the relay's shape so issueItem sees one
// shape from either route. Invented data throughout.

const { restIssue, parseRest, adfText, normaliseSite, searchRest } = require('../src/ingest/jira');

const adf = (...paras) => ({
  type: 'doc',
  version: 1,
  content: paras.map((p) => ({ type: 'paragraph', content: [].concat(p) })),
});

{
  assert.strictEqual(normaliseSite('acme'), 'https://acme.atlassian.net');
  assert.strictEqual(normaliseSite('https://acme.atlassian.net/'), 'https://acme.atlassian.net');
  assert.strictEqual(normaliseSite('acme.atlassian.net'), 'https://acme.atlassian.net');
  assert.strictEqual(normaliseSite('http://acme.atlassian.net'), null, 'Basic auth never goes over http');
  assert.strictEqual(normaliseSite(null), null);

  assert.strictEqual(
    adfText(adf([{ type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { text: '@Wren Okafor' } }, { type: 'text', text: ', see' }], { type: 'inlineCard', attrs: { url: 'https://example.invalid/x' } })).trim(),
    'Hi @Wren Okafor, see\nhttps://example.invalid/x'
  );

  const json = {
    issues: [
      {
        id: '10001',
        key: 'ORB-12',
        fields: {
          summary: 'Ledger export drops the last row',
          status: { name: 'In Review', statusCategory: { name: 'In Progress' } },
          assignee: { displayName: 'Tamsin Vale' },
          reporter: { displayName: 'Wren Okafor' },
          priority: { name: 'High' },
          updated: '2026-10-10T10:00:00.000+0000',
          duedate: '2026-10-20',
          description: adf([{ type: 'text', text: 'Steps: export, count rows.' }]),
          comment: {
            comments: [
              { author: { displayName: 'Wren Okafor' }, created: '2026-10-09T08:00:00.000+0000', body: adf([{ type: 'text', text: 'older' }]) },
              { author: { displayName: 'Tamsin Vale' }, created: '2026-10-10T09:30:00.000+0200', body: adf([{ type: 'text', text: 'can you check?' }]) },
            ],
          },
        },
      },
      { key: 'nope', fields: { summary: 'bad key' } },
      { key: 'ORB-13', fields: { summary: '' } },
      { key: 'ORB-14', fields: { summary: 'Closed one', status: { name: 'Done', statusCategory: { name: 'Done' } }, updated: '2026-10-11T00:00:00.000-0500' } },
    ],
    nextPageToken: 'abc',
    isLast: false,
  };
  const page = parseRest(json);
  assert.deepStrictEqual(page.issues.map((i) => i.key), ['ORB-12', 'ORB-14']);
  assert.strictEqual(page.nextPageToken, 'abc');
  assert.strictEqual(page.isLast, false);
  assert.strictEqual(parseRest({ issues: [] }).isLast, true);

  const i = page.issues[0];
  assert.deepStrictEqual(i, {
    key: 'ORB-12',
    summary: 'Ledger export drops the last row',
    status: 'In Review',
    statusCategory: 'In Progress',
    assignee: 'Tamsin Vale',
    reporter: 'Wren Okafor',
    priority: 'High',
    updated: '2026-10-10T10:00:00.000Z',
    due: '2026-10-20',
    description: 'Steps: export, count rows.',
    lastComment: { author: 'Tamsin Vale', created: '2026-10-10T07:30:00.000Z', body: 'can you check?' },
  });
  assert.strictEqual(page.issues[1].updated, '2026-10-11T05:00:00.000Z');

  // Same item shape as the relay produces.
  const it = issueItem(i, 'https://acme.atlassian.net');
  assert.strictEqual(it.externalId, 'ORB-12');
  assert.strictEqual(it.threadExternalId, 'https://acme.atlassian.net/browse/ORB-12');
  assert.strictEqual(it.authorIdentity, 'Tamsin Vale');
  assert.strictEqual(it.subject, 'ORB-12 [In Review]: Ledger export drops the last row');
  assert.ok(it.bodyText.startsWith('Latest comment by Tamsin Vale:\ncan you check?'));
  assert.deepStrictEqual(it.raw, {
    project: 'ORB', state: 'opened', status: 'In Review', assignee: 'Tamsin Vale', reporter: 'Wren Okafor',
    priority: 'High', dueDate: '2026-10-20', webUrl: 'https://acme.atlassian.net/browse/ORB-12',
  });
  assert.strictEqual(issueItem(page.issues[1], null).raw.state, 'closed');
}

(async () => {
  // Pagination, Basic auth, and an error that names the fix without echoing
  // anything Jira sent back.
  process.env.PA_JIRA_API_TOKEN = 'invented-token';
  const calls = [];
  const pages = [
    { issues: [{ key: 'ORB-1', fields: { summary: 'one' } }], nextPageToken: 'p2', isLast: false },
    { issues: [{ key: 'ORB-2', fields: { summary: 'two' } }], isLast: true },
  ];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => pages[calls.length - 1] };
  };
  const got = await searchRest({ site: 'https://acme.atlassian.net', email: 'quill@example.invalid' }, 'project = ORB', { fetchImpl: fakeFetch });
  assert.deepStrictEqual(got.map((x) => x.key), ['ORB-1', 'ORB-2']);
  assert.strictEqual(calls[0].url, 'https://acme.atlassian.net/rest/api/3/search/jql');
  assert.strictEqual(calls[0].init.headers.Authorization, `Basic ${Buffer.from('quill@example.invalid:invented-token').toString('base64')}`);
  assert.strictEqual(JSON.parse(calls[1].init.body).nextPageToken, 'p2');
  assert.strictEqual(JSON.parse(calls[0].init.body).jql, 'project = ORB');

  await assert.rejects(
    searchRest({ site: 'https://acme.atlassian.net', email: 'q@example.invalid' }, 'x', {
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    }),
    (err) => /rejected the API token/.test(err.message) && !err.message.includes('invented-token')
  );
  delete process.env.PA_JIRA_API_TOKEN;
  console.log('jira ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
