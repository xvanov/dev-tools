'use strict';

// The project scorer, pinned on the cases that decide whether a dispatched run
// lands in the right repo.

const assert = require('assert');
const { scoreCandidates, explicitTokens, containsPhrase, tokenNamesRepo, directMatch, workdirProject } = require('../src/projects/resolve');
const { pathFromRemote, groupRepos, staleProjects } = require('../src/projects');

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
  // An ssh-config alias has no user; a drive letter is not a host.
  assert.strictEqual(pathFromRemote('github-work:quill/lantern.git'), 'quill/lantern');
  assert.strictEqual(pathFromRemote('C:\\clones\\lantern'), null);
}

// ---------------------------------------------------- org names and repos ---

const ORG = [
  { id: 10, name: 'acme', gitlabPath: 'acme/acme', repoPath: 'C:\\repos\\acme', aliases: [] },
  { id: 11, name: 'widgets', gitlabPath: 'acme-dev/widgets', repoPath: 'C:\\repos\\widgets', aliases: [] },
];

{
  // The org name inside an owner segment is not the repo called after the org.
  assert.ok(!tokenNamesRepo('acme-dev/widgets', ORG[0]));
  assert.ok(tokenNamesRepo('acme-dev/widgets', ORG[1]));
  assert.ok(tokenNamesRepo('github.com/acme-dev/widgets/pull/7', ORG[1]));
  const ranked = scoreCandidates('please look at github.com/acme-dev/widgets/pull/7', ORG);
  assert.strictEqual(ranked[0].projectId, 11);
  assert.ok(!ranked.some((r) => r.projectId === 10 && /explicit/.test(r.rationale)));
}

{
  // A GitHub item names its repo; a repo with no project resolves to none.
  const hit = directMatch({ source: 'github_notification', raw: { project: 'Acme-Dev/Widgets' } }, ORG);
  assert.strictEqual(hit.projectId, 11);
  const miss = directMatch({ source: 'github_pr', raw: { project: 'acme-dev/gizmo' } }, ORG);
  assert.strictEqual(miss.projectId, null);
  assert.match(miss.rationale, /acme-dev\/gizmo/);
  // A Jira project key is not a repo.
  assert.strictEqual(directMatch({ source: 'jira_issue', raw: { project: 'ACME' } }, ORG), null);
  assert.strictEqual(directMatch({ source: 'graph_chat', raw: {} }, ORG), null);
}

{
  // The folder a session ran in, including a subfolder; the longest repo wins.
  assert.strictEqual(workdirProject('C:\\repos\\widgets\\src', ORG), 11);
  assert.strictEqual(workdirProject('c:/repos/widgets', ORG), 11);
  assert.strictEqual(workdirProject('C:\\repos\\widgets-old', ORG), null);
  assert.strictEqual(workdirProject(null, ORG), null);
  const ranked = scoreCandidates('restart the service', ORG, { workdirProjectId: 11 });
  assert.strictEqual(ranked[0].projectId, 11);
}

{
  // One project per remote: the folder named like the repo beats a worktree or copy.
  const groups = groupRepos([
    { dirName: 'widgets-pr9', repoPath: 'C:\\r\\widgets-pr9', gitlabPath: 'acme-dev/widgets', worktree: true },
    { dirName: 'wdg', repoPath: 'C:\\r\\wdg', gitlabPath: 'acme-dev/widgets', worktree: true },
    { dirName: 'widgets', repoPath: 'C:\\r\\widgets', gitlabPath: 'acme-dev/widgets', worktree: false },
    { dirName: 'notes', repoPath: 'C:\\r\\notes', gitlabPath: null, worktree: false },
  ]);
  assert.strictEqual(groups.length, 2);
  const w = groups.find((g) => g.gitlabPath === 'acme-dev/widgets');
  assert.strictEqual(w.dirName, 'widgets');
  assert.deepStrictEqual(w.others.sort(), ['wdg', 'widgets-pr9']);
  // No folder named like the repo: a real clone beats a worktree.
  const g2 = groupRepos([
    { dirName: 'a-wt', repoPath: 'x', gitlabPath: 'acme-dev/gizmo', worktree: true },
    { dirName: 'gizmo-main', repoPath: 'y', gitlabPath: 'acme-dev/gizmo', worktree: false },
  ]);
  assert.strictEqual(g2[0].dirName, 'gizmo-main');
}

{
  // A project whose folder is gone is retired; inactive or path-less ones are left.
  const stale = staleProjects(
    [
      { id: 1, active: true, repo_path: 'C:\\gone' },
      { id: 2, active: true, repo_path: 'C:\\here' },
      { id: 3, active: false, repo_path: 'C:\\gone' },
      { id: 4, active: true, repo_path: null },
    ],
    (p) => p === 'C:\\here'
  );
  assert.deepStrictEqual(stale.map((p) => p.id), [1]);
}

console.log('projects.test.js ok');
