'use strict';

// The pure parts of retrieval: the context header every chunk is indexed
// under, who a query names, and the filter fragment each leg shares.

const assert = require('assert');
const { chunkContext } = require('../src/search/context');
const { mentionedPeople } = require('../src/search/entities');
const { filterSql, embeddingInput } = require('../src/search');

{
  const line = chunkContext({
    source: 'graph_chat',
    subject: null,
    occurred_at: '2026-03-04T10:00:00Z',
    author_identity: 'aad:1234',
    raw: { chatTopic: 'Estimating import', fromName: 'Brannoc Hale' },
  });
  assert.strictEqual(line, 'Teams chat · "Estimating import" · 2026-03-04 · from Brannoc Hale');
}

{
  // The repo and subject carry; an opaque author id is still better than nothing.
  const line = chunkContext({
    source: 'github_pr',
    subject: 'Fix rounding in quote totals',
    occurred_at: new Date('2026-05-01T00:00:00Z'),
    author_identity: 'github:quill',
    raw: { project: 'acme/widgets' },
  });
  assert.strictEqual(line, 'GitHub PR · acme/widgets · 2026-05-01 · from github:quill — Fix rounding in quote totals');
}

{
  // My own messages are not "from me" noise.
  const line = chunkContext({ source: 'graph_mail', occurred_at: '2026-01-01', author_identity: 'me', raw: {} });
  assert.strictEqual(line, 'Email · 2026-01-01');
}

{
  const people = [
    { id: 1, display_name: 'Brannoc Hale' },
    { id: 2, display_name: 'Quill Moravec' },
    { id: 3, display_name: 'Quill Ashdown' },
    { id: 4, display_name: 'Me Myself', is_me: true },
    { id: 5, display_name: 'Ed' },
  ];
  // Unique first name matches; full name matches.
  assert.deepStrictEqual(mentionedPeople('what did brannoc ask about exports?', people), [1]);
  assert.deepStrictEqual(mentionedPeople('Quill Ashdown review', people), [3]);
  // An ambiguous first name pulls nobody rather than the wrong person.
  assert.deepStrictEqual(mentionedPeople('ask quill', people), []);
  // Never me; never a name shorter than three letters on its own.
  assert.deepStrictEqual(mentionedPeople('me myself and ed', people), []);
  // Whole words only.
  assert.deepStrictEqual(mentionedPeople('brannockfield', people), []);
}

{
  const params = ['q', 10];
  const sql = filterSql({ sources: ['graph_mail'], since: '2026-01-01', until: null }, params);
  assert.strictEqual(sql, 'and si.source = any($3) and si.occurred_at >= $4');
  assert.deepStrictEqual(params.slice(2, 3), [['graph_mail']]);
  assert.ok(params[3] instanceof Date);
  assert.strictEqual(filterSql({}, []), '');
}

{
  assert.strictEqual(embeddingInput({ context: 'Email · 2026-01-01', content: 'hi' }), 'Email · 2026-01-01\n\nhi');
  assert.strictEqual(embeddingInput({ context: '', content: 'hi' }), 'hi');
}

console.log('search.test.js ok');
