'use strict';

// Contract: src/repo/repos.js (see test/repoContract.test.js).

const PR = (repo, number, o = {}) => ({
  repo, number, title: `PR ${number}`, state: 'open', draft: false, headRef: `b-${number}`, baseRef: 'main', url: `https://github.com/${repo}/pull/${number}`,
  author: 'me', createdAt: new Date(Date.now() - 86400_000), updatedAt: new Date(), mergedAt: null, closedAt: null, summary: 's', body: 'b', ...o,
});

module.exports = {
  'insert: an active project; the same name again is the same id': async ({ repos, assert, uniq }) => {
    const name = uniq('repo');
    const id = await repos.repos.insert({ name, gitlabPath: `o/${name}`, forge: 'github', origin: 'manual' });
    assert.strictEqual(String(await repos.repos.insert({ name, gitlabPath: null, forge: null, origin: 'x' })), String(id));
    const row = await repos.repos.rowById(id);
    assert.deepStrictEqual([row.name, row.gitlab_path, row.forge, row.origin, row.active], [name, `o/${name}`, 'github', 'manual', true]);
  },

  'allRows: every project, by id': async ({ repos, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('r'), gitlabPath: null, forge: null, origin: 'manual' });
    const all = await repos.repos.allRows();
    assert.ok(all.some((r) => String(r.id) === String(id)));
    assert.deepStrictEqual(all.map((r) => Number(r.id)), all.map((r) => Number(r.id)).sort((a, b) => a - b));
  },

  'activeRows: active only, by name': async ({ repos, db, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('gone'), gitlabPath: null, forge: null, origin: 'manual' });
    await db.query('update project set active = false where id = $1', [id]);
    const rows = await repos.repos.activeRows();
    assert.ok(!rows.some((r) => String(r.id) === String(id)) && rows.every((r) => r.active));
  },

  'rowById: null when missing': async ({ repos, assert }) => {
    assert.strictEqual(await repos.repos.rowById(-1), null);
  },

  'allAliases: every alias': async ({ repos, seed, db, assert, uniq }) => {
    const p = await seed.project({ name: uniq('p') });
    await db.query(`insert into project_alias (project_id, alias) values ($1, $2)`, [p, uniq('alias')]);
    assert.ok((await repos.repos.allAliases()).some((a) => Number(a.project_id) === p));
  },

  'aliasesOf: a project\'s aliases with their origin': async ({ repos, seed, db, assert, uniq }) => {
    const p = await seed.project({ name: uniq('p') });
    const a = uniq('alias');
    await db.query(`insert into project_alias (project_id, alias) values ($1, $2)`, [p, a]);
    const got = await repos.repos.aliasesOf(p);
    assert.ok(got.some((x) => x.alias === a && 'origin' in x));
  },

  'takeOver: new path and forge, active again, folder set': async ({ repos, db, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('moved'), gitlabPath: 'old/x', forge: 'gitlab', origin: 'manual' });
    await db.query(`update project set active = false, retired_at = now() where id = $1`, [id]);
    await repos.repos.takeOver(id, 'new/x', 'github', null);
    const r = await repos.repos.rowById(id);
    assert.deepStrictEqual([r.gitlab_path, r.forge, r.active, r.retired_at, r.repo_path], ['new/x', 'github', true, null, null]);
  },

  'saveSynced: the pass\'s facts; absent dates and counts keep what is there': async ({ repos, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('s'), gitlabPath: null, forge: null, origin: 'manual' });
    const at = new Date('2026-11-01T00:00:00Z');
    const base = { forge: 'github', remoteUrls: ['git@github.com:o/s.git'], localPaths: JSON.stringify({ box: ['/w/s'] }), defaultBranch: 'main', branches: JSON.stringify([{ name: 'b' }]) };
    await repos.repos.saveSynced(id, { ...base, lastCommitAt: at, lastSessionAt: at, sessionCount: 3, profileAdd: JSON.stringify({ ravenDoc: 'doc' }) });
    await repos.repos.saveSynced(id, { ...base, lastCommitAt: null, lastSessionAt: null, sessionCount: 0, profileAdd: '{}' });
    const r = await repos.repos.rowById(id);
    assert.deepStrictEqual([r.forge, r.remote_urls, r.local_paths, r.default_branch, r.branches, r.session_count, r.profile.ravenDoc], ['github', ['git@github.com:o/s.git'], { box: ['/w/s'] }, 'main', [{ name: 'b' }], 3, 'doc']);
    assert.strictEqual(r.last_commit_at.toISOString(), at.toISOString());
    assert.ok(r.synced_at instanceof Date);
  },

  'markLocalOrigins: a folder and no origin is local': async ({ repos, db, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('l'), gitlabPath: null, forge: null, origin: null });
    await repos.repos.setRepoPath(id, '/w/l');
    await repos.repos.markLocalOrigins();
    assert.strictEqual((await repos.repos.rowById(id)).origin, 'local');
    assert.ok(db);
  },

  'upsertPr: insert then refresh by (forge, repo, number)': async ({ repos, db, assert, uniq }) => {
    const repo = `o/${uniq('pr')}`;
    const id = await repos.repos.insert({ name: uniq('pp'), gitlabPath: repo, forge: 'github', origin: 'manual' });
    await repos.repos.upsertPr(id, PR(repo, 1));
    await repos.repos.upsertPr(id, PR(repo, 1, { state: 'merged', mergedAt: new Date() }));
    const rows = await db.rows(`select state, merged_at from repo_pr where repo = $1`, [repo]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].state, 'merged');
  },

  'refreshPrStats: pr_count and last_pr_at from repo_pr': async ({ repos, assert, uniq }) => {
    const repo = `o/${uniq('st')}`;
    const id = await repos.repos.insert({ name: uniq('st'), gitlabPath: repo, forge: 'github', origin: 'manual' });
    await repos.repos.upsertPr(id, PR(repo, 1));
    await repos.repos.upsertPr(id, PR(repo, 2));
    await repos.repos.refreshPrStats();
    const r = await repos.repos.rowById(id);
    assert.strictEqual(Number(r.pr_count), 2);
    assert.ok(r.last_pr_at instanceof Date);
  },

  'saveProfile: description, profile, source, hash': async ({ repos, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('pf'), gitlabPath: null, forge: null, origin: 'manual' });
    await repos.repos.saveProfile(id, 'A tool', JSON.stringify({ kind: 'service' }), 'model', 'h1');
    const r = await repos.repos.rowById(id);
    assert.deepStrictEqual([r.description, r.profile, r.profile_source, r.profile_hash], ['A tool', { kind: 'service' }, 'model', 'h1']);
    assert.ok(r.profiled_at instanceof Date);
  },

  'syncCounts: active, worked and PRs': async ({ repos, assert, uniq }) => {
    const before = await repos.repos.syncCounts();
    await repos.repos.insert({ name: uniq('c'), gitlabPath: null, forge: null, origin: 'manual' });
    const after = await repos.repos.syncCounts();
    assert.strictEqual(Number(after.active), Number(before.active) + 1);
    assert.ok(Number(after.worked) >= 0 && Number(after.prs) >= 0);
  },

  'findId: by name, path, alias or folder, any case; null when unknown': async ({ repos, db, assert, uniq }) => {
    const name = uniq('Find');
    const id = await repos.repos.insert({ name, gitlabPath: `o/${name}`, forge: 'github', origin: 'manual' });
    await repos.repos.setRepoPath(id, `/w/${name}`);
    const alias = uniq('al');
    await db.query(`insert into project_alias (project_id, alias) values ($1, $2)`, [id, alias]);
    for (const ref of [name.toUpperCase(), `O/${name}`, alias, `/w/${name}`]) assert.strictEqual(String(await repos.repos.findId(ref)), String(id), ref);
    assert.strictEqual(await repos.repos.findId(uniq('none')), null);
  },

  'nameOf: {name}, or null': async ({ repos, assert, uniq }) => {
    const name = uniq('n');
    const id = await repos.repos.insert({ name, gitlabPath: null, forge: null, origin: 'manual' });
    assert.strictEqual((await repos.repos.nameOf(id)).name, name);
    assert.strictEqual(await repos.repos.nameOf(-1), null);
  },

  'setRepoPath: the folder': async ({ repos, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('rp'), gitlabPath: null, forge: null, origin: 'manual' });
    await repos.repos.setRepoPath(id, '/w/rp');
    assert.strictEqual((await repos.repos.rowById(id)).repo_path, '/w/rp');
  },

  'revive: active, shown, not retired': async ({ repos, db, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('rv'), gitlabPath: null, forge: null, origin: 'manual' });
    await db.query(`update project set active = false, hidden = true, retired_at = now(), retired_reason = 'x' where id = $1`, [id]);
    await repos.repos.revive(id);
    const r = await repos.repos.rowById(id);
    assert.deepStrictEqual([r.active, r.hidden, r.retired_at, r.retired_reason], [true, false, null, null]);
  },

  'manualOf: the manual corrections': async ({ repos, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('m'), gitlabPath: null, forge: null, origin: 'manual' });
    assert.ok('manual' in (await repos.repos.manualOf(id)));
  },

  'setManual: replaces them': async ({ repos, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('m'), gitlabPath: null, forge: null, origin: 'manual' });
    await repos.repos.setManual(id, JSON.stringify({ pinned: true }));
    assert.deepStrictEqual((await repos.repos.manualOf(id)).manual, { pinned: true });
  },

  'setHidden: hidden and back': async ({ repos, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('h'), gitlabPath: null, forge: null, origin: 'manual' });
    await repos.repos.setHidden(id, true);
    assert.strictEqual((await repos.repos.rowById(id)).hidden, true);
    await repos.repos.setHidden(id, false);
    assert.strictEqual((await repos.repos.rowById(id)).hidden, false);
  },

  'openCommitments: open, unfolded, newest first': async ({ repos, seed, db, assert, uniq }) => {
    const id = await repos.repos.insert({ name: uniq('oc'), gitlabPath: null, forge: null, origin: 'manual' });
    const a = await seed.commitment();
    const b = await seed.commitment({ status: 'done' });
    await db.query('update commitment set project_id = $2 where id = any($1::bigint[])', [[a, b], id]);
    assert.deepStrictEqual((await repos.repos.openCommitments(id)).map((c) => Number(c.id)), [a]);
  },

  'lastPrUpdate: the newest PR update ({at})': async ({ repos, assert, uniq }) => {
    const repo = `o/${uniq('lu')}`;
    const id = await repos.repos.insert({ name: uniq('lu'), gitlabPath: repo, forge: 'github', origin: 'manual' });
    const at = new Date(Date.now() + 86400_000);
    await repos.repos.upsertPr(id, PR(repo, 1, { updatedAt: at }));
    assert.strictEqual((await repos.repos.lastPrUpdate()).at.toISOString(), at.toISOString());
  },

  'openPrBranches: open PRs with a head branch': async ({ repos, assert, uniq }) => {
    const repo = `o/${uniq('ob')}`;
    const id = await repos.repos.insert({ name: uniq('ob'), gitlabPath: repo, forge: 'github', origin: 'manual' });
    await repos.repos.upsertPr(id, PR(repo, 1));
    await repos.repos.upsertPr(id, PR(repo, 2, { state: 'closed' }));
    await repos.repos.upsertPr(id, PR(repo, 3, { headRef: null }));
    assert.deepStrictEqual((await repos.repos.openPrBranches(id)).map((p) => [p.number, p.head_ref]), [[1, 'b-1']]);
  },

  'recentPrs: at most n per project, newest first': async ({ repos, assert, uniq }) => {
    const repo = `o/${uniq('rc')}`;
    const id = await repos.repos.insert({ name: uniq('rc'), gitlabPath: repo, forge: 'github', origin: 'manual' });
    for (let i = 1; i <= 3; i++) await repos.repos.upsertPr(id, PR(repo, i, { updatedAt: new Date(Date.now() - (5 - i) * 60_000) }));
    assert.deepStrictEqual((await repos.repos.recentPrs([id], 2)).map((p) => p.number), [3, 2]);
  },

  'prsOf: every PR of a project, newest first': async ({ repos, assert, uniq }) => {
    const repo = `o/${uniq('po')}`;
    const id = await repos.repos.insert({ name: uniq('po'), gitlabPath: repo, forge: 'github', origin: 'manual' });
    await repos.repos.upsertPr(id, PR(repo, 1, { updatedAt: new Date(Date.now() - 60_000) }));
    await repos.repos.upsertPr(id, PR(repo, 2));
    assert.deepStrictEqual((await repos.repos.prsOf(id)).map((p) => p.number), [2, 1]);
  },
  // --- for dispatch/delivery.ts (chunk E)

  'setDelivery: sets a repo\'s default; a repeat changes it': async ({ repos, assert, uniq }) => {
    const slug = `own/${uniq('repo')}`;
    await repos.repos.setDelivery(slug, 'branch');
    assert.strictEqual((await repos.repos.deliveryOf(slug)).delivery, 'branch');
    await repos.repos.setDelivery(slug, 'pr');
    assert.strictEqual((await repos.repos.deliveryOf(slug)).delivery, 'pr');
  },

  'deliveryOf: a repo\'s default, or null': async ({ repos, assert, uniq }) => {
    assert.strictEqual(await repos.repos.deliveryOf(`own/${uniq('none')}`), null);
  },

  'clearDelivery: whether the repo had a default': async ({ repos, assert, uniq }) => {
    const slug = `own/${uniq('repo')}`;
    await repos.repos.setDelivery(slug, 'branch');
    assert.strictEqual(await repos.repos.clearDelivery(slug), true);
    assert.strictEqual(await repos.repos.clearDelivery(slug), false);
  },

  'deliveries: every repo\'s default by repo': async ({ repos, assert, uniq }) => {
    const a = `own/${uniq('a')}`;
    const b = `own/${uniq('b')}`;
    await repos.repos.setDelivery(b, 'pr');
    await repos.repos.setDelivery(a, 'branch');
    const got = (await repos.repos.deliveries()).filter((r) => [a, b].includes(r.repo));
    assert.deepStrictEqual(got.map((r) => [r.repo, r.delivery]), [[a, 'branch'], [b, 'pr']].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
    assert.ok(got[0].updated_at instanceof Date);
  },
};
