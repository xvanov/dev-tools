'use strict';

// The planner's pure half (src/agent/plannerCore.js): what an answer may mean
// and when research may start on its own. Names are invented.

const assert = require('assert');
const P = require('../src/agent/plannerCore');

const repos = ['ledger-portal', 'export-svc', 'docs-site'];
const todos = [
  { id: 1, summary: 'Find out why the export job times out', project: 'export-svc' },
  { id: 2, summary: 'Add retry to the ledger sync', project: 'ledger-portal' },
  { id: 3, summary: 'Fix the broken search box', project: null },
  { id: 4, summary: 'Tell Ysolde the release date', project: null },
  { id: 5, summary: 'Investigate the flaky build', project: null },
];
const { prompt, refs } = P.buildPrompt(todos, repos);

{
  assert.match(prompt, /T1: Find out why the export job times out \[repository: export-svc\]/);
  assert.match(prompt, /T3: .*\[repository: unknown\]/);
}

{
  const plans = P.parsePlans(
    {
      plans: [
        { todo: 'T1', kind: 'investigate', action: 'research', brief: 'Trace the export job timeout.' },
        { todo: 'T2', kind: 'coding', action: 'offer_run', brief: 'Add retries with backoff.' },
        { todo: 'T3', kind: 'coding', action: 'ask_repo', repos: ['docs-site', 'not-a-repo', 'LEDGER-PORTAL'] },
        { todo: 'T4', kind: 'reply', action: 'research', brief: 'x' }, // research only fits investigate
        { todo: 'T5', kind: 'investigate', action: 'research', brief: 'y' }, // no repo: cannot research
        { todo: 'T1', kind: 'other', action: 'none' }, // a second plan for one to-do is ignored
        { todo: 'T9', kind: 'coding', action: 'offer_run', brief: 'z' },
      ],
    },
    refs,
    repos
  );
  assert.deepStrictEqual(plans.map((p) => [p.todo.id, p.kind, p.action]), [
    [1, 'investigate', 'research'],
    [2, 'coding', 'offer_run'],
    [3, 'coding', 'ask_repo'],
    [4, 'reply', 'none'],
    [5, 'investigate', 'none'],
  ]);
  // Repo picks are listed repositories only, in their own spelling.
  assert.deepStrictEqual(plans[2].repos, ['docs-site', 'ledger-portal']);
}

{
  // A repo question with no valid pick, or for a reply, is nothing.
  const plans = P.parsePlans(
    { plans: [{ todo: 'T3', kind: 'coding', action: 'ask_repo', repos: ['nope'] }, { todo: 'T4', kind: 'reply', action: 'ask_repo', repos: ['docs-site'] }] },
    refs,
    repos
  );
  assert.deepStrictEqual(plans.map((p) => p.action), ['none', 'none']);
  assert.strictEqual(P.parsePlans({ plans: [{ todo: 'T2', kind: 'weird', action: 'launch' }] }, refs, repos)[0].kind, 'other');
}

{
  assert.strictEqual(P.mayResearch({ startedToday: 1, perDay: 2, budgetOk: true }), true);
  assert.strictEqual(P.mayResearch({ startedToday: 2, perDay: 2, budgetOk: true }), false);
  assert.strictEqual(P.mayResearch({ startedToday: 0, perDay: 2, budgetOk: false }), false);
  assert.strictEqual(P.mayResearch({ startedToday: 0, perDay: 0, budgetOk: true }), false);
}

console.log('planner: ok');
