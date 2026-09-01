'use strict';

// The project scorer, pinned on the cases that decide whether a dispatched run
// lands in the right repo.

const assert = require('assert');
const { scoreCandidates, explicitTokens, containsPhrase } = require('../src/projects/resolve');
const { pathFromRemote } = require('../src/projects');

const CANDIDATES = [
  {
    id: 1,
    name: 'estimating-api',
    gitlabPath: 'innergy/estimating-api',
    repoPath: 'C:\\repos\\estimating-api',
    aliases: [
      { alias: 'estimating-api', origin: 'seeded', weight: 1 },
      { alias: 'the estimating rewrite', origin: 'corrected', weight: 2 },
    ],
  },
  {
    id: 2,
    name: 'shopfloor-ui',
    gitlabPath: 'innergy/shopfloor-ui',
    repoPath: 'C:\\repos\\shopfloor-ui',
    aliases: [{ alias: 'shopfloor', origin: 'seeded', weight: 1 }],
  },
  {
    id: 3,
    name: 'dev-tools',
    gitlabPath: 'xvanov/dev-tools',
    repoPath: 'C:\\repos\\dev-tools',
    aliases: [{ alias: 'dev-tools', origin: 'seeded', weight: 1 }],
  },
];

{
  // A corrected alias is the whole point of the correction loop: the phrase a
  // human confirmed once must win over a name that merely looks similar.
  const ranked = scoreCandidates('can you pick up the estimating rewrite this week?', CANDIDATES);
  assert.strictEqual(ranked[0].projectId, 1);
  assert.match(ranked[0].rationale, /you corrected this before/);
}

{
  // An explicit path beats everything.
  const ranked = scoreCandidates('the bug is in innergy/shopfloor-ui/src/grid.ts', CANDIDATES);
  assert.strictEqual(ranked[0].projectId, 2);
  assert.ok(ranked[0].score >= 5);
}

{
  // No evidence must produce no guess, not a low-confidence coin flip. An
  // "unknown" that asks once beats a wrong repo a session then works in.
  const ranked = scoreCandidates('can we move the 1:1 to Thursday?', CANDIDATES);
  assert.deepStrictEqual(ranked, []);
}

{
  // Recency alone is a tie-breaker, never a match.
  const ranked = scoreCandidates('please look at this when you can', CANDIDATES, {
    recentProjectIds: [3],
  });
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].projectId, 3);
  assert.ok(ranked[0].confidence < 0.5, 'a hint-only match must not look confident');
}

{
  // Two equally plausible candidates must report low confidence even though the
  // top score is high — confidence is about separation.
  const ambiguous = scoreCandidates('update estimating-api and shopfloor together', CANDIDATES);
  assert.ok(ambiguous.length >= 2);
  assert.ok(ambiguous[0].confidence < 0.6, `expected low confidence, got ${ambiguous[0].confidence}`);
}

{
  // A confident, unambiguous match should read as confident.
  const clear = scoreCandidates('the estimating rewrite needs a migration', CANDIDATES);
  assert.ok(clear[0].confidence > 0.5, `expected confidence, got ${clear[0].confidence}`);
}

{
  assert.ok(containsPhrase('fix the Estimating-API import', 'estimating api'));
  assert.ok(!containsPhrase('comparison of options', 'pa'), 'substrings must not match');
}

{
  const tokens = explicitTokens('see feature/fix-grid and src/grid.ts in innergy/shopfloor-ui');
  assert.ok(tokens.includes('feature/fix-grid'));
  assert.ok(tokens.includes('grid.ts'));
  assert.ok(tokens.some((t) => t.includes('shopfloor-ui')));
}

{
  assert.strictEqual(pathFromRemote('git@gitlab.com:innergy/estimating-api.git'), 'innergy/estimating-api');
  assert.strictEqual(pathFromRemote('https://gitlab.com/innergy/sub/group.git'), 'innergy/sub/group');
  assert.strictEqual(pathFromRemote('https://github.com/xvanov/dev-tools'), 'xvanov/dev-tools');
  assert.strictEqual(pathFromRemote(null), null);
}

console.log('projects.test.js ok');
