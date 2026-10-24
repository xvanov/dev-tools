'use strict';

// Notes from my own work: grouped one per PR (whether the PR is named by URL
// or by number and project), else per session; newest group first.

const assert = require('assert');
const { groupKey, group } = require('../src/commitments/selfNotes');

const pr = 'https://github.com/acme/widgets/pull/162';
assert.deepStrictEqual(groupKey({ thread_external_id: pr, summary: 'Rebase the banner PR' }), { key: 'widgets#162', label: 'widgets PR #162' });
assert.deepStrictEqual(groupKey({ thread_external_id: 's-1', summary: 'Get PR #162 merged', project: 'widgets' }).key, 'widgets#162');
assert.strictEqual(groupKey({ id: 7, source: 'claude_session', thread_external_id: 'session-abc', summary: 'Run the e2e suite' }).key, 'session-abc');
assert.strictEqual(groupKey({ id: 7, source: 'claude_session', summary: 'x', project: 'widgets' }).label, 'session in widgets');

const g = group([
  { id: 1, thread_external_id: pr, summary: 'Verify the banner in a browser', occurred_at: '2026-03-01T10:00:00Z' },
  { id: 2, thread_external_id: 's-9', summary: 'Get PR #162 merged', project: 'widgets', occurred_at: '2026-03-02T10:00:00Z' },
  { id: 3, source: 'claude_session', thread_external_id: 's-5', summary: 'Tidy the fixtures', occurred_at: '2026-02-01T10:00:00Z' },
]);
assert.strictEqual(g.length, 2, 'two notes about one PR are one group');
assert.deepStrictEqual(g[0].items.map((c) => c.id), [2, 1], 'newest note first');
assert.strictEqual(g[1].key, 's-5');

console.log('selfNotes.test.js ok');
