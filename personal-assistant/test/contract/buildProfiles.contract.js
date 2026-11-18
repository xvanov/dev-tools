'use strict';

// Contract: src/repo/buildProfiles.ts (see test/repoContract.test.js). The same on Postgres and SQLite:
// this is also what proves sql/047 and sql-sqlite/019 create the table and build_run's profile columns.

const row = (o = {}) => ({ description: 'd', model: 'opus', effort: 'medium', permission_mode: null, prompt: 'p', tools: '{"mcp":[]}', subagents: '[]', subagent_model: null, cost_cap_usd: 8, wall_cap_min: 180, idle_after_s: null, repo_path: null, ...o });

module.exports = {
  'upsert: creates a profile, then replaces it (a missing field becomes null)': async ({ repos, assert }) => {
    const a = await repos.buildProfiles.upsert('contract-a', row());
    assert.deepStrictEqual([a.name, a.model, a.effort, Number(a.cost_cap_usd), Number(a.wall_cap_min), a.idle_after_s], ['contract-a', 'opus', 'medium', 8, 180, null]);
    const b = await repos.buildProfiles.upsert('contract-a', { description: 'again', model: 'haiku' });
    assert.deepStrictEqual([b.description, b.model, b.effort, b.cost_cap_usd, b.created_at], ['again', 'haiku', null, null, a.created_at]);
    assert.ok(b.updated_at >= a.updated_at);
  },

  'byName: the row, or null': async ({ repos, assert }) => {
    await repos.buildProfiles.upsert('contract-b', row({ prompt: 'text' }));
    assert.strictEqual((await repos.buildProfiles.byName('contract-b')).prompt, 'text');
    assert.strictEqual(await repos.buildProfiles.byName('contract-none'), null);
  },

  'list: every profile, by name': async ({ repos, assert }) => {
    await repos.buildProfiles.upsert('contract-z', row());
    await repos.buildProfiles.upsert('contract-y', row());
    const names = (await repos.buildProfiles.list()).map((p) => p.name).filter((n) => /^contract-[yz]$/.test(n));
    assert.deepStrictEqual(names, ['contract-y', 'contract-z']);
  },

  'insertIfAbsent: writes once and never over an edit': async ({ repos, assert }) => {
    assert.strictEqual(await repos.buildProfiles.insertIfAbsent('contract-seed', row({ model: 'sonnet' })), 1);
    await repos.buildProfiles.upsert('contract-seed', row({ model: 'haiku' }));
    assert.strictEqual(await repos.buildProfiles.insertIfAbsent('contract-seed', row({ model: 'sonnet' })), 0);
    assert.strictEqual((await repos.buildProfiles.byName('contract-seed')).model, 'haiku');
  },

  'remove: 1 when it existed, else 0': async ({ repos, assert }) => {
    await repos.buildProfiles.upsert('contract-del', row());
    assert.strictEqual(await repos.buildProfiles.remove('contract-del'), 1);
    assert.strictEqual(await repos.buildProfiles.remove('contract-del'), 0);
    assert.strictEqual(await repos.buildProfiles.byName('contract-del'), null);
  },

  'build_run: a run records its profile, effort and permission mode': async ({ repos, assert }) => {
    const r = await repos.buildRuns.insert({ task: 't', model: 'opus', costCapUsd: 5, wallCapMin: 120, profile: 'feature', effort: 'high', permissionMode: 'plan' });
    assert.deepStrictEqual([r.profile, r.effort, r.permission_mode], ['feature', 'high', 'plan']);
    const plain = await repos.buildRuns.insert({ task: 't', model: 'sonnet', costCapUsd: 5, wallCapMin: 120 });
    assert.deepStrictEqual([plain.profile, plain.effort, plain.permission_mode], [null, null, null]);
    await repos.buildRuns.update(plain.id, { profile: 'quick' });
    assert.strictEqual((await repos.buildRuns.byId(plain.id)).profile, 'quick');
  },
};
