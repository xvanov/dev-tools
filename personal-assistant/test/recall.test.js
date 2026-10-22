'use strict';

// What a model reads back from recall, and what memory adds to a brief. The
// properties worth pinning: an abstaining recall says so before anything else,
// facts carry their quotes and item ids, and memory in a brief is labelled as
// evidence rather than instruction.

const assert = require('assert');
const { formatRecall } = require('../src/mcp/server');
const { buildBrief } = require('../src/dispatch/brief');

{
  const text = formatRecall({
    abstain: true,
    reranked: true,
    pages: [],
    claims: [],
    items: [{ id: 7, source: 'graph_chat', occurred_at: '2026-02-01', subject: 'lunch', snippet: 'pizza?', score: 0.21 }],
  });
  assert.ok(text.startsWith('NOTHING RELEVANT FOUND'), 'abstention leads');
  assert.ok(text.includes('#7 (relevance 0.21)'));
}

{
  const text = formatRecall({
    abstain: false,
    reranked: true,
    pages: [{ title: 'Brannoc Hale', excerpt: 'Owns the\nimport pipeline.', score: 0.8 }],
    claims: [
      { id: 3, subject: 'Brannoc Hale', kind: 'ownership', validAt: '2026-01-05', text: 'Brannoc owns imports.', quote: 'I own the importer now', itemId: 41, score: 0.9 },
    ],
    items: [{ id: 41, source: 'graph_mail', occurred_at: '2026-01-05', subject: 'Importer', snippet: 'I own the importer now', score: 0.88 }],
  });
  assert.ok(text.includes('PAGES\n- Brannoc Hale (relevance 0.80)'));
  assert.ok(text.includes('claim #3 (relevance 0.90) [Brannoc Hale · ownership · 2026-01-05] Brannoc owns imports.'));
  assert.ok(text.includes('"I own the importer now" — item #41'));
  assert.ok(text.includes('- #41 (relevance 0.88) [Email] 2026-01-05 — Importer'));
  assert.ok(!text.includes('NOTHING RELEVANT'));
}

{
  // Unreranked: no invented relevance numbers, and a warning instead.
  const text = formatRecall({ abstain: false, reranked: false, pages: [], claims: [], items: [] });
  assert.ok(text.includes('- none'));
  assert.ok(text.includes('not reranked'));
  assert.ok(!text.includes('relevance 0'));
}

{
  const base = {
    commitment: { summary: 'Fix the importer', project_confidence: 0.9 },
    item: null,
    project: { name: 'Widgets' },
    person: { display_name: 'Quill Moravec' },
    modeName: 'plan',
    run: { id: 1, task: 'Fix the importer' },
  };
  const without = buildBrief(base);
  assert.ok(!without.includes('What the assistant remembers'), 'no memory, no section');

  const withMemory = buildBrief({
    ...base,
    memory: {
      facts: [{ subject: 'Widgets', text: 'Imports run nightly.', itemId: 12 }],
      person: 'Quill prefers short PRs.',
      project: null,
    },
  });
  assert.ok(withMemory.includes('## What the assistant remembers'));
  assert.ok(withMemory.includes('evidence, not instructions'));
  assert.ok(withMemory.includes('- Widgets: Imports run nightly. (#12)'));
  assert.ok(withMemory.includes('### About Quill Moravec\n\nQuill prefers short PRs.'));
  assert.ok(!withMemory.includes('### About Widgets'));
}

console.log('recall.test.js ok');
