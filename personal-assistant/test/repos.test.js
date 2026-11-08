'use strict';

// The repo registry's pure rules (src/repos/merge.js) and the resolver's use
// of the registry's vocabulary (src/projects/resolve.js).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const m = require('../src/repos/merge.ts');
const resolve = require('../src/projects/resolve.ts');

// --- forges
assert.strictEqual(m.forgeOf('git@github.com:innergy-dev/erp.git'), 'github');
assert.strictEqual(m.forgeOf('https://github.com/xvanov/dev-tools'), 'github');
assert.strictEqual(m.forgeOf('git@git.innergy.dev:innergy/tools.git'), 'gitlab');
assert.strictEqual(m.forgeOf('C:\\somewhere'), null);
assert.strictEqual(m.forgeUrl('github', 'innergy-dev/erp'), 'https://github.com/innergy-dev/erp');
assert.strictEqual(m.forgeUrl(null, 'x/y'), null);

// --- which repo folder a session ran in
assert.deepStrictEqual(m.sessionDir('C:\\repos\\erp\\src\\Modules', ['C:\\repos']), { dir: 'erp', path: 'C:\\repos\\erp' });
assert.deepStrictEqual(m.sessionDir('c:\\source\\mv-assistant', ['C:\\source']), { dir: 'mv-assistant', path: 'C:\\source\\mv-assistant' }, "the root's spelling");
assert.deepStrictEqual(m.sessionDir('/home/k/rental-management/.claude/worktrees/x', ['/home/k']), { dir: 'rental-management', path: '/home/k/rental-management' });
assert.strictEqual(m.sessionDir('C:\\repos', ['C:\\repos']), null, 'the root itself is no repo');
assert.strictEqual(m.sessionDir('C:\\source\\.pa-worktrees\\run-2', ['C:\\source']), null, 'dot-folders are scratch');
assert.strictEqual(m.sessionDir('/tmp/zephyrine-sandbox-x', ['/home/k']), null, 'outside every root');
assert.strictEqual(m.sessionDir('C:\\repos-old\\x', ['C:\\repos']), null, 'a sibling with the same prefix is not inside');

// --- folder name → registry row
const rows = [
  { id: 1, name: 'dev-tools', gitlab_path: 'xvanov/dev-tools', aliases: [] },
  { id: 2, name: 'dev-toolkit', gitlab_path: 'drewmiller-innergy/dev-toolkit', aliases: [] },
  { id: 3, name: 'mv-pipeline', gitlab_path: 'innergy-dev/mv-pipeline', aliases: ['guidance-mv'] },
  { id: 4, name: 'tk', gitlab_path: 'innergy-dev/quillwork', aliases: [] },
  { id: 5, name: 'mv-CNC-toolkit', gitlab_path: 'innergy-dev/mv-CNC-toolkit', aliases: [], paths: ['C:\\source\\cnc'] },
];
assert.strictEqual(m.matchDir('dev-tools', rows).id, 1);
assert.strictEqual(m.matchDir('DEV-TOOLKIT', rows).id, 2, 'case-insensitive, whole name');
assert.strictEqual(m.matchDir('guidance-mv', rows).id, 3, 'by alias');
assert.strictEqual(m.matchDir('quillwork', rows).id, 4, 'by the forge repo name');
assert.strictEqual(m.matchDir('mv-cnc-toolkit', rows).id, 5);
assert.strictEqual(m.matchDir('cnc', rows).id, 5, 'by a known folder');
assert.strictEqual(m.matchDir('dev', rows), null);
// A row's own name beats another row's alias of the same spelling.
assert.strictEqual(m.matchDir('tk', [{ id: 9, name: 'other', aliases: ['tk'] }, rows[3]]).id, 4);

// --- where a forge repo goes
const reg = [
  { id: 1, name: 'erp', gitlab_path: 'innergy-dev/erp', active: true },
  { id: 2, name: 'argocdstate', gitlab_path: 'innergy/argocdstate', active: false },
  { id: 3, name: 'tools', gitlab_path: 'innergy/tools', active: true },
  { id: 4, name: 'design', gitlab_path: 'innergy-dev/design', active: true, remote_paths: ['abyss-team/design'] },
  { id: 5, name: 'docs-only', gitlab_path: null, active: true },
];
assert.deepStrictEqual(m.placeForgeRepo('innergy-dev/ERP', reg), { action: 'use', id: 1, name: 'erp' });
assert.deepStrictEqual(m.placeForgeRepo('abyss-team/design', reg), { action: 'use', id: 4, name: 'design' }, 'an older remote of the same repo');
assert.deepStrictEqual(m.placeForgeRepo('innergy-dev/argocdstate', reg), { action: 'takeover', id: 2, name: 'argocdstate' }, 'the retired GitLab original');
assert.deepStrictEqual(m.placeForgeRepo('someone/docs-only', reg), { action: 'takeover', id: 5, name: 'docs-only' }, 'a row with no forge path');
assert.deepStrictEqual(m.placeForgeRepo('innergy-dev/tools', reg), { action: 'insert', name: 'tools (innergy-dev)' }, 'a live repo of the same name is another repo');
assert.deepStrictEqual(m.placeForgeRepo('innergy-dev/raven', reg), { action: 'insert', name: 'raven' });

// --- PR summaries from bodies, no model
assert.strictEqual(m.prSummary(''), null);
assert.strictEqual(m.prSummary('## Summary\n\nCloses #12\n\n- [x] tests\n\nThe export now streams rows instead of loading them all.'), 'The export now streams rows instead of loading them all.');
assert.strictEqual(m.prSummary('<!-- template -->\n**Why:** the [build](http://x) broke on `main`.'), 'Why: the build broke on main.');
assert.strictEqual(m.prSummary('## Summary\n- Adds a retry to the uploader when the blob store throttles'), 'Adds a retry to the uploader when the blob store throttles');
assert.strictEqual(m.prSummary('x'.repeat(10) + ' ' + 'word '.repeat(80), 60).length, 60);
assert.strictEqual(m.prSummary('```\ncode only\n```'), null);
assert.strictEqual(
  m.prSummary('Jira returned a 200 with an error page\nrather than a 401, so search could not tell.\n\nMore.'),
  'Jira returned a 200 with an error page rather than a 401, so search could not tell.',
  'a hard-wrapped paragraph is joined'
);
assert.strictEqual(m.prSummary('Fixes #4\nFixes the export when a row is empty.'), 'Fixes the export when a row is empty.', '"Fixes" prose is kept, "Fixes #4" is not');
assert.strictEqual(m.prState({ state: 'MERGED', mergedAt: '2026-01-01' }), 'merged');
assert.strictEqual(m.prState({ state: 'OPEN' }), 'open');
assert.strictEqual(m.prState({ state: 'CLOSED' }), 'closed');

// --- raven's repo map
const raven = m.parseRavenRepos(
  [
    '| Repo | What it is |',
    '|---|---|',
    '| `innergy-dev/erp` | **INNERGY ERP** ("Aspen") — see [erp/](erp/README.md). Default branch `develop`. |',
    '| `innergy-dev/ui-core` (`@innergy/ui`) and `innergy-dev/frontend-core` | Shared frontend packages. |',
    'not a row',
  ].join('\n')
);
assert.strictEqual(raven.get('innergy-dev/erp'), 'INNERGY ERP ("Aspen") — see erp/. Default branch develop.');
assert.strictEqual(raven.get('innergy-dev/ui-core'), 'Shared frontend packages.');
assert.strictEqual(raven.size, 2);

// --- manual edits always win
const synced = { id: 1, name: 'erp', description: 'from raven', profile_source: 'raven', profile: { owner: null, stack: ['C#'], kind: 'product' }, manual: {} };
assert.strictEqual(m.effective(synced).description, 'from raven');
assert.strictEqual(m.effective(synced).descriptionSource, 'raven');
const edited = { ...synced, manual: m.applyManual({}, { description: 'mine', stack: 'C#, React', owner: 'Pod Xi' }) };
assert.strictEqual(m.effective(edited).description, 'mine');
assert.strictEqual(m.effective(edited).descriptionSource, 'manual');
assert.deepStrictEqual(m.effective(edited).stack, ['C#', 'React']);
assert.strictEqual(m.effective(edited).owner, 'Pod Xi');
assert.strictEqual(m.effective(edited).kind, 'product', 'unset manual fields fall through');
assert.deepStrictEqual(m.applyManual(edited.manual, { description: '' }), { stack: ['C#', 'React'], owner: 'Pod Xi' }, 'empty clears');
assert.throws(() => m.applyManual({}, { name: 'x' }), /cannot set/);

// --- on the Repos tab or not
assert.ok(m.contributed({ pr_count: 2 }));
assert.ok(m.contributed({ session_count: 1 }));
assert.ok(m.contributed({ last_commit_at: '2026-01-01' }));
assert.ok(m.contributed({ manual: { pinned: true } }));
assert.ok(!m.contributed({ pr_count: 0 }));
assert.ok(!m.contributed({ pr_count: 5, hidden: true }), 'hidden beats activity');
assert.strictEqual(m.effective({ last_pr_at: '2026-01-02', last_commit_at: '2026-03-01', last_session_at: null }).lastActivity, '2026-03-01T00:00:00.000Z');

// --- branches from several sources
const merged = m.mergeBranches(
  [
    [
      { name: 'main', at: '2026-11-05', source: 'local' },
      { name: 'feat/a', at: '2026-11-01', mine: true, current: true, machine: 'lap', source: 'local' },
    ],
    [{ name: 'feat/a', at: '2026-11-04', mine: true, machine: 'lap', source: 'session' }],
    [{ name: 'feat/b', at: '2026-11-03', mine: true, pr: 12, machine: null, source: 'pr' }],
  ],
  { defaultBranch: 'main' }
);
assert.deepStrictEqual(merged.map((b) => b.name), ['feat/a', 'feat/b'], 'default branch out, newest first, one per name+machine');
assert.strictEqual(merged[0].at, '2026-11-04T00:00:00.000Z');
assert.ok(merged[0].current);
assert.strictEqual(merged[0].source, 'local+session');
assert.strictEqual(merged[1].pr, 12);

// --- the resolver resolves against the registry's vocabulary
const cands = [
  { id: 15, name: 'mv-assistant', gitlabPath: 'innergy-dev/mv-assistant', repoPath: 'C:\\repos\\mv-assistant', paths: ['C:\\repos\\mv-assistant', 'C:\\source\\mv-assistant'], remotePaths: [], aliases: [] },
  { id: 8, name: 'erp', gitlabPath: 'innergy-dev/erp', repoPath: 'C:\\repos\\erp', paths: [], remotePaths: ['innergy/innergy'], aliases: [] },
  { id: 60, name: 'rental-management', gitlabPath: null, repoPath: null, paths: ['/home/k/rental-management'], remotePaths: [], aliases: [] },
  { id: 61, name: 'argocdstate', gitlabPath: 'innergy-dev/argocdstate', repoPath: null, paths: [], remotePaths: [], aliases: [] },
];
assert.strictEqual(resolve.workdirProject('C:\\source\\mv-assistant\\src', cands), 15, "a session on another machine's folder");
assert.strictEqual(resolve.workdirProject('/home/k/rental-management/api', cands), 60, 'a Linux path');
assert.strictEqual(resolve.workdirProject('C:\\repos\\erp', cands), 8);
assert.strictEqual(resolve.workdirProject('C:\\source', cands), null);
assert.strictEqual(resolve.directMatch({ source: 'github_pr', raw: { project: 'innergy-dev/argocdstate' } }, cands).projectId, 61, 'a registry repo with no clone still matches');
assert.strictEqual(resolve.directMatch({ source: 'github_pr', raw: { project: 'innergy-dev/argocdstate' } }, cands).repoPath, null);
assert.strictEqual(resolve.directMatch({ source: 'github_pr', raw: { project: 'innergy/innergy' } }, cands).projectId, 8, 'an older forge path');
assert.strictEqual(resolve.directMatch({ source: 'github_pr', raw: { project: 'someone/else' } }, cands).projectId, null);
assert.ok(resolve.tokenNamesRepo('innergy/innergy', cands[1]), 'an older forge path, whole');
assert.ok(resolve.tokenNamesRepo('home/k/rental-management', cands[2]), 'a folder name from another machine');
const ranked = resolve.scoreCandidates('the bug in rental-management/api/server.ts', cands);
assert.strictEqual(ranked[0].projectId, 60);
// The evidence rule still holds: hints alone rank nothing.
assert.deepStrictEqual(resolve.scoreCandidates('lunch on friday', cands, { recentProjectIds: [15], threadProjectId: 15 }), []);

// --- the Repos tab's client: parses, and no HTML sinks
const client = fs.readFileSync(path.join(__dirname, '../src/dashboard/repos.client.js'), 'utf8');
new vm.Script(client, { filename: 'repos.client.js' });
assert.ok(!/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/.test(client), 'no HTML sinks in the Repos tab');

// --- the Repos view's open items (Plan's former "Code & boards"): still open
// or asking something, newest first, at most 15, and only http(s) links.
(async () => {
  const briefPath = require.resolve('../src/brief');
  require.cache[briefPath] = { id: briefPath, filename: briefPath, loaded: true, exports: { recentReviews: async () => [
    { subject: 'Review: fix the importer', source: 'github_pr', raw: { state: 'opened', project: 'acme/app', webUrl: 'https://github.com/acme/app/pull/1' }, occurred_at: '2026-11-06T10:00:00Z' },
    { subject: 'Review: fix the importer', source: 'github_notification', raw: { action: 'review_requested', project: 'acme/app' }, occurred_at: '2026-11-06T09:00:00Z' },
    { subject: 'merged one', source: 'github_pr', raw: { state: 'merged', project: 'acme/app' }, occurred_at: '2026-11-05T10:00:00Z' },
    { subject: 'You were mentioned', source: 'github_notification', raw: { action: 'mention', webUrl: 'javascript:alert(1)' }, occurred_at: '2026-11-04T10:00:00Z' },
  ] } };
  const open = await require('../src/dashboard/repos.ts').openItems();
  assert.deepStrictEqual(open.map((o) => o.subject), ['Review: fix the importer', 'You were mentioned'], 'one line per item, newest kept');
  assert.strictEqual(open[0].url, 'https://github.com/acme/app/pull/1');
  assert.strictEqual(open[0].project, 'acme/app');
  assert.strictEqual(open[1].url, null, 'a non-http link is dropped');
  console.log('repos ok');
})().catch((err) => { console.error(err); process.exit(1); });
