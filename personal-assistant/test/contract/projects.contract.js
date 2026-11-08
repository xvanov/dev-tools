'use strict';

// Contract: src/repo/projects.js (see test/repoContract.test.js).

module.exports = {
  'byGitlabPath: exact forge path': async ({ repos, seed, assert, uniq }) => {
    const path = `grp/${uniq('gp')}`;
    const id = await seed.projectNamed(uniq('p'), { gitlabPath: path });
    assert.strictEqual(Number((await repos.projects.byGitlabPath(path)).id), id);
    assert.strictEqual(await repos.projects.byGitlabPath(path.toUpperCase()), null);
  },

  'byRepoPath: exact clone path': async ({ repos, seed, assert, uniq }) => {
    const path = `/w/${uniq('rp')}`;
    const id = await seed.projectNamed(uniq('p'), { repoPath: path });
    assert.strictEqual(Number((await repos.projects.byRepoPath(path)).id), id);
    assert.strictEqual(await repos.projects.byRepoPath('/nowhere'), null);
  },

  'byNameCaseless: name, case-insensitive': async ({ repos, seed, assert, uniq }) => {
    const name = uniq('Name');
    const id = await seed.projectNamed(name);
    assert.strictEqual(Number((await repos.projects.byNameCaseless(name.toUpperCase())).id), id);
    assert.strictEqual(await repos.projects.byNameCaseless(`${name}-x`), null);
  },

  'insert: a project with its paths, active': async ({ repos, assert, uniq }) => {
    const name = uniq('ins');
    const { id } = await repos.projects.insert(name, 'grp/x', '/w/x');
    const row = await repos.projects.byNameCaseless(name);
    assert.deepStrictEqual([Number(row.id), row.gitlab_path, row.repo_path, row.active], [Number(id), 'grp/x', '/w/x', true]);
  },

  'refresh: renamed when the name is free, paths filled in, reactivated': async ({ repos, seed, assert, uniq }) => {
    const [oldName, taken, fresh] = [uniq('old'), uniq('taken'), uniq('fresh')];
    const id = await seed.projectNamed(oldName, { gitlabPath: 'keep/me', active: false });
    await seed.projectNamed(taken);
    await repos.projects.refresh(id, null, '/w/new', taken);
    let row = await repos.projects.byRepoPath('/w/new');
    assert.deepStrictEqual([row.name, row.gitlab_path, row.active], [oldName, 'keep/me', true], 'a taken name is not used');
    await repos.projects.refresh(id, 'grp/new', null, fresh);
    row = await repos.projects.byGitlabPath('grp/new');
    assert.deepStrictEqual([row.name, row.repo_path], [fresh, '/w/new']);
    assert.strictEqual(row.retired_at, null);
  },

  'upsertAlias: a corrected alias beats a seeded one, never the reverse': async ({ repos, seed, assert, uniq }) => {
    const [a, b] = [await seed.projectNamed(uniq('pa')), await seed.projectNamed(uniq('pb'))];
    const alias = uniq('alias phrase');
    assert.strictEqual(await repos.projects.upsertAlias(a, alias, 'seeded', 1.0, null), true);
    assert.strictEqual(await repos.projects.upsertAlias(b, alias.toUpperCase(), 'corrected', 2.0, 7), true);
    let row = (await repos.projects.allAliases()).find((r) => r.alias.toLowerCase() === alias);
    assert.deepStrictEqual([Number(row.project_id), row.origin, row.weight], [b, 'corrected', 2]);
    await repos.projects.upsertAlias(a, alias, 'seeded', 1.0, null);
    row = (await repos.projects.allAliases()).find((r) => r.alias.toLowerCase() === alias);
    assert.deepStrictEqual([Number(row.project_id), row.origin], [b, 'corrected']);
  },

  'allForRetire: every project, active or not': async ({ repos, seed, assert, uniq }) => {
    const [on, off] = [await seed.projectNamed(uniq('on'), { repoPath: '/w/on' }), await seed.projectNamed(uniq('off'), { active: false })];
    const got = await repos.projects.allForRetire();
    const by = (id) => got.find((r) => Number(r.id) === id);
    assert.deepStrictEqual([by(on).active, by(on).repo_path, by(off).active], [true, '/w/on', false]);
  },

  'retire: deactivates an active project with the reason; a retired one is left': async ({ repos, seed, db, assert, uniq }) => {
    const id = await seed.projectNamed(uniq('ret'));
    await repos.projects.retire(id, 'repo folder gone: /w');
    await repos.projects.retire(id, 'a second reason');
    const row = await db.one('select active, retired_at, retired_reason from project where id = $1', [id]);
    assert.deepStrictEqual([row.active, row.retired_at instanceof Date, row.retired_reason], [false, true, 'repo folder gone: /w']);
  },

  'activeForCandidates: active projects with the resolver columns, by name': async ({ repos, seed, assert, uniq }) => {
    const [a, off] = [await seed.projectNamed(uniq('zz-active')), await seed.projectNamed(uniq('zz-off'), { active: false })];
    const got = await repos.projects.activeForCandidates();
    const row = got.find((r) => Number(r.id) === a);
    assert.deepStrictEqual([row.local_paths, row.remote_urls], [{}, []]);
    assert.ok(!got.some((r) => Number(r.id) === off));
  },

  'allAliases: project_id, alias, origin and weight': async ({ repos, seed, assert, uniq }) => {
    const p = await seed.projectNamed(uniq('al'));
    const alias = uniq('some alias');
    await repos.projects.upsertAlias(p, alias, 'observed', 1.2, null);
    const row = (await repos.projects.allAliases()).find((r) => r.alias === alias);
    assert.deepStrictEqual([Number(row.project_id), row.origin, Math.round(row.weight * 10)], [p, 'observed', 12]);
  },

  'byNameOrAlias: name, forge path or alias of an active project; the name wins': async ({ repos, seed, assert, uniq }) => {
    const name = uniq('Named');
    const p = await seed.projectNamed(name, { gitlabPath: `grp/${name}` });
    const alias = uniq('nick name');
    await repos.projects.upsertAlias(p, alias, 'seeded', 1.0, null);
    for (const q of [name.toUpperCase(), `GRP/${name}`, alias.toUpperCase()]) assert.strictEqual(Number((await repos.projects.byNameOrAlias(q)).id), p, q);
    const other = await seed.projectNamed(uniq('other'));
    await repos.projects.upsertAlias(other, name.toLowerCase() + ' x', 'seeded', 1.0, null);
    assert.strictEqual(await repos.projects.byNameOrAlias('no such project'), null);
    await repos.projects.retire(p, 'gone');
    assert.strictEqual(await repos.projects.byNameOrAlias(name), null, 'a retired project is not an answer');
  },

  'listWithCounts: active projects with their alias and commitment counts': async ({ repos, seed, assert, uniq }) => {
    const p = await seed.projectNamed(uniq('lc'));
    await repos.projects.upsertAlias(p, uniq('alias one'), 'seeded', 1.0, null);
    await repos.projects.upsertAlias(p, uniq('alias two'), 'seeded', 1.0, null);
    const c = await seed.commitment();
    await seed.setCommitment(c, { project_id: p });
    const off = await seed.projectNamed(uniq('lc-off'), { active: false });
    const got = await repos.projects.listWithCounts();
    const row = got.find((r) => Number(r.id) === p);
    assert.deepStrictEqual([Number(row.aliases), Number(row.commitments)], [2, 1]);
    assert.ok(!got.some((r) => Number(r.id) === off));
  },
  // --- for cli (chunk G)

  'activeNamePaths: name and folder of the active projects': async ({ repos, seed, db, assert, uniq }) => {
    const live = uniq('live');
    const dead = uniq('dead');
    const a = await seed.projectNamed(live, {});
    const b = await seed.projectNamed(dead, {});
    await db.query(`update project set repo_path = '/r/live' where id = $1`, [a]);
    await db.query(`update project set active = false where id = $1`, [b]);
    const got = await repos.projects.activeNamePaths();
    assert.deepStrictEqual(got.find((r) => r.name === live), { name: live, repo_path: '/r/live' });
    assert.ok(!got.some((r) => r.name === dead));
  },
  // --- for dispatch, mcp (chunk E)

  'activeByRepo: an active project by folder or forge path': async ({ repos, seed, assert, uniq }) => {
    const folder = `/r/${uniq('f')}`;
    const path = `Grp/${uniq('p')}`;
    const id = await seed.projectNamed(uniq('act'), { repoPath: folder, gitlabPath: path });
    await seed.projectNamed(uniq('off'), { repoPath: `${folder}-off`, active: false });
    assert.strictEqual(Number((await repos.projects.activeByRepo(folder)).id), id);
    assert.strictEqual(Number((await repos.projects.activeByRepo(path.toLowerCase())).id), id);
    assert.strictEqual(await repos.projects.activeByRepo(`${folder}-off`), null);
  },

  'rowById: the whole project row; null when gone': async ({ repos, seed, assert, uniq }) => {
    const name = uniq('rb');
    const id = await seed.projectNamed(name);
    assert.strictEqual((await repos.projects.rowById(id)).name, name);
    assert.strictEqual(await repos.projects.rowById(999999999), null);
  },

  'findLoose: by name or forge path caseless, or by alias': async ({ repos, seed, db, assert, uniq }) => {
    const name = uniq('Loose');
    const path = `grp/${uniq('lp')}`;
    const id = await seed.projectNamed(name, { gitlabPath: path });
    assert.strictEqual(Number((await repos.projects.findLoose(name.toUpperCase())).id), id);
    assert.strictEqual(Number((await repos.projects.findLoose(path.toUpperCase())).id), id);
    const alias = uniq('alias');
    await db.query('insert into project_alias (project_id, alias) values ($1, $2)', [id, alias]);
    assert.strictEqual(Number((await repos.projects.findLoose(alias)).id), id);
    assert.strictEqual(await repos.projects.findLoose(uniq('none')), null);
  },
};
