'use strict';

// Settings per agent (docs/native/BUILD-ENRICHMENT.md, B): the store overrides behind src/models.ts, the profile
// edits, and the three front doors over src/agentSettings.ts: the dashboard route, the chat tools and `pa`.
// A throwaway SQLite store; env stays the default.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-agent-settings-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_agent_settings.sqlite');
process.env.PA_SQLITE_KEY = 'agent-settings-test-key';
process.env.PA_DATA_DIR = dir;
process.env.PA_TESTING = '1';
for (const k of ['PA_MODEL', 'PA_PLANNER_MODEL', 'PA_BRIEF_MODEL', 'PA_CHAT_MODEL', 'PA_CHAT_AGENT', 'PA_CHAT_COMMAND']) delete process.env[k];

const { available } = require('../src/db/sqlite.ts');
if (!available()) {
  console.log('agentSettings skipped: no SQLite driver here');
  process.exit(0);
}

const { config } = require('../src/config.ts');
const models = require('../src/models.ts');
const P = require('../src/build/profiles.ts');
const A = require('../src/agentSettings.ts');
const chatTools = require('../src/mcp/chatTools.ts');
const agentsRoute = require('../src/dashboard/agents.ts');
const cliAgents = require('../src/cli/agents.ts');
const { passes } = require('../src/util/exclusive.ts');

const bad = async (p, re) => assert.rejects(p, (e) => re.test(e.message) && (e.status === 400 || e.status === 404), `${re}`);

(async () => {
  await require('../src/db/migrate.ts').migrate();
  // ---------------------------------------------------- pass models: store over env over default ----
  const plannerDefault = config.planner.model;
  const chatDefault = config.chat.model;
  {
    let v = models.effective();
    const row = (k) => v.passes.find((p) => p.key === k);
    assert.strictEqual(row('planner').source, 'default');
    assert.strictEqual(row('planner').model, plannerDefault);
    assert.strictEqual(v.chat.source, 'default');

    // Checked: unknown pass, unknown provider, a model that cannot make connector calls, an unsafe chat model.
    await bad(models.save({ passModels: { nope: 'sonnet' } }), /unknown pass/);
    await bad(models.save({ passModels: { planner: 'azur/gpt' } }), /unknown provider/);
    await bad(models.save({ passModels: { connector: 'azure/gpt-5.4' } }), /connector tool calls/);
    await bad(models.save({ chatModel: 'azure/gpt-5.4' }), /Claude models only/);
    await bad(models.save({ chatModel: 'a b; rm' }), /characters/);

    await models.save({ passModels: { planner: 'azure/pa', brief: 'cli/claude-opus-5' }, chatModel: 'fable' });
    assert.strictEqual(config.planner.model, 'azure/pa', 'the field the pass reads now holds the override');
    assert.strictEqual(config.meetings.model, 'cli/claude-opus-5');
    assert.strictEqual(config.chat.model, 'claude-fable-5-2', 'fable is spelled with its full id');
    assert.strictEqual(models.modelFor('planner'), 'azure/pa');
    v = models.effective();
    assert.deepStrictEqual([row('planner').source, row('planner').default], ['store', plannerDefault]);
    assert.strictEqual(v.chat.source, 'store');
    assert.strictEqual(row('distill').source, 'default', 'a pass without an override is untouched');

    // The store really holds it: a cold read in this process gets the same.
    models.resetOverrides();
    await models.refresh({ force: true });
    assert.strictEqual(models.overrides().passModels.planner, 'azure/pa');
    assert.strictEqual(config.planner.model, 'azure/pa');

    // Clearing one puts its env/default back, leaving the other.
    await models.save({ passModels: { planner: null } });
    assert.strictEqual(config.planner.model, plannerDefault);
    assert.strictEqual(config.meetings.model, 'cli/claude-opus-5');
    await models.save({ passModels: { brief: '' }, chatModel: null });
    assert.deepStrictEqual(models.overrides(), {});
    assert.strictEqual(config.chat.model, chatDefault);

    // An env variable is the default and says so.
    process.env.PA_PLANNER_MODEL = 'claude-opus-5-5';
    assert.strictEqual(models.effective().passes.find((p) => p.key === 'planner').source, 'env');
    delete process.env.PA_PLANNER_MODEL;
  }

  // The TTL: refresh without `force` does not read again inside the window; a broken store keeps what it had.
  {
    await models.save({ passModels: { planner: 'azure/pa' } });
    const repo = require('../src/repo');
    const real = repo.system.setting;
    let reads = 0;
    repo.system.setting = async () => { reads++; throw new Error('store down'); };
    await models.refresh();
    assert.strictEqual(reads, 0, 'inside the TTL nothing is read');
    await models.refresh({ force: true });
    assert.strictEqual(reads, 1);
    assert.strictEqual(config.planner.model, 'azure/pa', 'an unreadable store keeps the overrides in force');
    repo.system.setting = real;
    await models.save({ passModels: { planner: null } });
  }

  // The worker's `before` hook runs ahead of each pass, and its failure does not stop the pass.
  {
    const ran = [];
    const p = passes({ before: () => { ran.push('before'); throw new Error('boom'); } });
    await p.run('x', () => ran.push('pass'));
    assert.deepStrictEqual(ran, ['before', 'pass']);
  }

  // ------------------------------------------------------------------------------ profiles ----
  {
    const before = await P.view();
    assert.deepStrictEqual(before.profiles.map((p) => [p.name, p.seed, p.modified]).sort(), [['chore', true, false], ['feature', true, false], ['quick', true, false], ['research', true, false]]);
    assert.deepStrictEqual(before.missingSeeds, []);

    // "set chore to fable medium": only those fields change.
    const chore = await A.setProfile('chore', { model: 'fable', effort: 'medium' });
    assert.deepStrictEqual([chore.model, chore.effort, chore.costCapUsd, chore.wallCapMin, chore.modified, chore.seed], ['fable', 'medium', 2, 45, true, true]);
    assert.strictEqual(chore.default.model, 'sonnet', 'a built-in shows what it ships as');
    // snake_case from the chat and the CLI, null clears, tools merge by list.
    const s = await A.setProfile('chore', { cost_cap_usd: 3, wall_cap_min: null, permission_mode: 'acceptEdits', tools: { allow: ['Bash(git status)'] } });
    assert.deepStrictEqual([s.costCapUsd, s.wallCapMin, s.permissionMode, s.tools.allow, s.model], [3, null, 'acceptEdits', ['Bash(git status)'], 'fable']);
    const t = await A.setProfile('chore', { tools: { deny: ['Bash(git push:*)'] } });
    assert.deepStrictEqual([t.tools.allow, t.tools.deny], [['Bash(git status)'], ['Bash(git push:*)']], 'a patch naming one tool list leaves the others');
    await bad(A.setProfile('chore', { effort: 'extreme' }), /effort must be/);
    await bad(A.setProfile('chore', { cost_cap_usd: 0 }), /cost cap/);
    await bad(A.setProfile('chore', { permission_mode: 'yolo' }), /permission mode/);
    await bad(A.setProfile('Bad Name', {}), /profile name/);

    // A new profile, then it is deletable and has no default to reset to.
    const mine = await A.setProfile('triage', { description: 'sort the inbox', model: 'haiku', subagents: [{ name: 'scout', description: 'looks', model: 'haiku', prompt: 'look', tools: ['Read'] }], repo: 'C:\\repos\\x' });
    assert.deepStrictEqual([mine.seed, mine.modified, mine.default, mine.repoPath, mine.subagents.length], [false, false, null, 'C:\\repos\\x', 1]);
    await bad(A.resetProfile('triage'), /not a built-in/);
    assert.deepStrictEqual(await A.deleteProfile('triage'), { deleted: 'triage', note: null });
    await bad(A.deleteProfile('triage'), /no profile/);
    await bad(A.getProfile('triage'), /no profile/);

    // Reset: the edits go; a deleted built-in comes back.
    const r = await A.resetProfile('chore');
    assert.deepStrictEqual([r.model, r.effort, r.permissionMode, r.costCapUsd, r.wallCapMin, r.modified], ['sonnet', 'low', null, 2, 45, false]);
    assert.match((await A.deleteProfile('quick')).note, /reset/);
    assert.deepStrictEqual((await P.view()).missingSeeds, ['quick']);
    assert.strictEqual((await A.resetProfile('quick')).model, 'haiku');
  }

  // ------------------------------------------------------------------------- the dashboard route ----
  {
    const get = await agentsRoute.route('GET', new URL('http://x/api/agents'), {});
    assert.deepStrictEqual(get.profiles.map((p) => p.name).sort(), ['chore', 'feature', 'quick', 'research']);
    assert.ok(get.passes.some((p) => p.key === 'distill') && get.chat.env === 'PA_CHAT_MODEL');
    assert.deepStrictEqual([get.options.efforts, get.options.permissionModes.includes('dontAsk'), get.options.buildDefaults.costCapUsd > 0, get.options.basePrompt.length > 100], [['low', 'medium', 'high', 'xhigh', 'max'], true, true, true]);
    const post = (p, body) => agentsRoute.route('POST', new URL(`http://x${p}`), body);
    assert.strictEqual((await post('/api/agents/profiles/feature', { model: 'fable' })).model, 'fable');
    assert.strictEqual((await post('/api/agents/profiles/feature/reset', {})).model, 'opus');
    assert.strictEqual((await post('/api/agents/profiles/mine-x', { description: 'x' })).name, 'mine-x');
    assert.strictEqual((await post('/api/agents/profiles/mine-x/delete', {})).deleted, 'mine-x');
    const s = await post('/api/agents/settings', { passModels: { routine: 'local/qwen3:32b' } });
    assert.strictEqual(s.passes.find((p) => p.key === 'routine').model, 'local/qwen3:32b');
    await post('/api/agents/settings', { passModels: { routine: null } });
    await bad(post('/api/agents/settings', {}), /nothing to set/);
    await bad(post('/api/agents/settings', { chatmodel: 'x' }), /not a setting/);
    assert.strictEqual(await agentsRoute.route('GET', new URL('http://x/api/agents/nope'), {}), undefined);
    assert.strictEqual(await agentsRoute.route('DELETE', new URL('http://x/api/agents/profiles/chore'), {}), undefined);
  }

  // Over HTTP, through the real router: the page, its script, the API, and the X-PA guard on a write.
  {
    const server = await require('../src/dashboard/server.ts').start({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const page = await fetch(`${base}/agents`);
      assert.strictEqual(page.status, 200);
      const html = await page.text();
      assert.match(html, /<title>Jarvis · Agents<\/title>/);
      assert.match(html, /<script src="agents\.client\.js">/);
      assert.match(html, /<link rel="stylesheet" href="theme\.css">/);
      const js = await fetch(`${base}/agents.client.js`);
      assert.strictEqual(js.status, 200);
      const src = await js.text();
      for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) assert.ok(!src.includes(sink), `agents.client.js uses ${sink}`);
      assert.ok(!/fetch\('\//.test(src) && !/api\('\//.test(src), 'relative URLs only (the page works under termhub\'s /pa/)');
      const api = await (await fetch(`${base}/api/agents`)).json();
      assert.ok(api.profiles.length >= 4 && api.passes.length >= 18 && api.chat.env === 'PA_CHAT_MODEL');
      const noHeader = await fetch(`${base}/api/agents/profiles/chore`, { method: 'POST', body: '{"model":"opus"}' });
      assert.strictEqual(noHeader.status, 403, 'a write needs X-PA');
      const ok = await fetch(`${base}/api/agents/profiles/chore`, { method: 'POST', headers: { 'X-PA': '1', 'Content-Type': 'application/json' }, body: '{"model":"opus"}' });
      assert.strictEqual((await ok.json()).model, 'opus');
      const refused = await fetch(`${base}/api/agents/profiles/chore`, { method: 'POST', headers: { 'X-PA': '1' }, body: '{"effort":"extreme"}' });
      assert.strictEqual(refused.status, 400);
      assert.match((await refused.json()).error, /effort must be/);
      await fetch(`${base}/api/agents/profiles/chore/reset`, { method: 'POST', headers: { 'X-PA': '1' }, body: '{}' });
      assert.strictEqual((await P.get('chore')).model, 'sonnet');
    } finally {
      server.close();
    }
  }

  // -------------------------------------------------------------------------------- chat tools ----
  {
    const names = (xs) => xs.map((t) => t.name);
    for (const n of ['profile_list', 'profile_get', 'agent_settings_get']) assert.ok(chatTools.CHAT_READ_TOOL_NAMES.includes(n) && names(chatTools.READ_TOOLS).includes(n), n);
    for (const n of ['profile_set', 'profile_delete', 'profile_reset', 'agent_settings_set']) assert.ok(chatTools.CHAT_ACTION_TOOL_NAMES.includes(n) && names(chatTools.ACTION_TOOLS).includes(n), n);
    const list = await chatTools.handle('profile_list', {});
    assert.deepStrictEqual(list.profiles.map((p) => p.name), ['chore', 'feature', 'quick', 'research']);
    assert.deepStrictEqual(Object.keys(list.profiles[0]).sort(), ['cost_cap_usd', 'description', 'effort', 'idle_after_s', 'mcp', 'model', 'modified', 'name', 'permission_mode', 'repo', 'seed', 'subagents', 'wall_cap_min']);
    const set = await chatTools.handle('profile_set', { name: 'chore', model: 'fable', effort: 'medium' });
    assert.deepStrictEqual([set.model, set.effort, set.modified], ['fable', 'medium', true]);
    assert.strictEqual((await chatTools.handle('profile_get', { name: 'chore' })).default.model, 'sonnet');
    assert.strictEqual((await chatTools.handle('profile_reset', { name: 'chore' })).model, 'sonnet');
    await chatTools.handle('profile_set', { name: 'tmp-tool' });
    assert.strictEqual((await chatTools.handle('profile_delete', { name: 'tmp-tool' })).deleted, 'tmp-tool');
    const set2 = await chatTools.handle('agent_settings_set', { pass_models: { draft: 'azure/pa' }, chat_model: 'opus' });
    assert.strictEqual(set2.passes.find((p) => p.key === 'draft').source, 'store');
    assert.strictEqual(set2.chat.model, 'opus');
    const got = await chatTools.handle('agent_settings_get', {});
    assert.strictEqual(got.passes.find((p) => p.key === 'draft').model, 'azure/pa');
    assert.ok(Array.isArray(got.profiles));
    await chatTools.handle('agent_settings_set', { pass_models: { draft: null }, chat_model: null });
    // The policy: reads allowed, writes ask.
    const policy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'policy', 'default.policy.json'), 'utf8'));
    const rule = (id) => policy.rules.find((r) => r.id === id).tools;
    for (const n of ['profile_list', 'profile_get', 'agent_settings_get']) assert.ok(rule('read-surface-allow').includes(n), `${n} is allowed`);
    for (const n of ['profile_set', 'profile_delete', 'profile_reset', 'agent_settings_set']) assert.ok(rule('chat-actions-ask').includes(n) && !rule('read-surface-allow').includes(n), `${n} asks`);
  }

  // ------------------------------------------------------------------------------------- pa ----
  {
    // Pure: flags to patches.
    const ps = (flags, lists = {}) => cliAgents.profilePatch(flags, lists, (f) => (f === 'subs.json' ? '[{"name":"a","description":"d"}]' : 'from file'));
    assert.deepStrictEqual(ps({ model: 'fable', effort: 'medium', 'cost-cap': '3', 'permission-mode': 'dontAsk', repo: false, 'subagent-model': 'inherit' }).patch,
      { model: 'fable', effort: 'medium', costCapUsd: 3, permissionMode: 'dontAsk', repoPath: null, subagentModel: 'inherit' });
    assert.deepStrictEqual(ps({ mcp: 'a, b', allow: 'Read', deny: false }, { allow: ['Read', 'Grep'] }).patch, { tools: { mcp: ['a', 'b'], allow: ['Read', 'Grep'], deny: [] } });
    assert.deepStrictEqual(ps({ 'prompt-file': 'p.md', 'subagents-file': 'subs.json' }).patch, { prompt: 'from file', subagents: [{ name: 'a', description: 'd' }] });
    assert.strictEqual(ps({ prompt: false }).patch.prompt, '');
    assert.match(ps({}).error, /nothing to set/);
    assert.match(ps({ model: true }).error, /needs a value/);
    assert.match(ps({ 'cost-cap': '-1' }).error, /positive/);
    assert.match(ps({ prompt: 'x', 'prompt-file': 'y' }).error, /not both/);
    const as = (flags, lists = {}) => cliAgents.agentsPatch(flags, lists);
    assert.deepStrictEqual(as({ 'chat-model': 'opus' }, { pass: ['planner=azure/pa', 'brief=cli/claude-opus-5'], 'clear-pass': ['draft'] }).patch,
      { chatModel: 'opus', passModels: { planner: 'azure/pa', brief: 'cli/claude-opus-5', draft: null } });
    assert.deepStrictEqual(as({ 'clear-chat-model': true }).patch, { chatModel: null });
    assert.match(as({}).error, /nothing to set/);
    assert.match(as({}, { pass: ['planner'] }).error, /<pass>=<model>/);

    // Through the real commands, writing to the store and reading back.
    const cli = require('../src/cli/index.ts');
    const run = async (verb, args, flags = {}, lists = {}) => {
      let text = '';
      const write = process.stdout.write;
      process.stdout.write = (s) => { text += s; return true; };
      const code = process.exitCode;
      try { await cli.commands[verb](args, flags, lists); } finally { process.stdout.write = write; }
      assert.strictEqual(process.exitCode, code, `pa ${verb} ${args.join(' ')} failed`);
      return text;
    };
    assert.match(await run('profile', ['list']), /chore\s+sonnet\s+low/);
    await run('profile', ['set', 'chore'], { model: 'fable', effort: 'medium' }, {});
    assert.strictEqual((await P.get('chore')).model, 'fable');
    assert.match(await run('profile', ['get', 'chore']), /ships as:/);
    assert.match(JSON.parse(await run('profile', ['get', 'chore'], { json: true })).default.model, /sonnet/);
    await run('profile', ['reset', 'chore']);
    assert.strictEqual((await P.get('chore')).model, 'sonnet');
    await run('profile', ['set', 'pa-tmp'], { description: 'tmp' });
    assert.match(await run('profile', ['delete', 'pa-tmp']), /deleted pa-tmp/);
    assert.match(await run('agents', ['set'], { 'chat-model': 'sonnet' }, { pass: ['eval=azure/pa'] }), /eval azure\/pa \(store\)/);
    assert.match(await run('agents', ['get']), /eval\s+azure\/pa\s+store/);
    await run('agents', ['set'], { 'clear-chat-model': true }, { 'clear-pass': ['eval'] });
    assert.deepStrictEqual(models.overrides(), {});
    // The verbs are on the right lists: reads allowed through the pa tool, writes ask.
    const chat = require('../src/chat');
    const mcp = require('../src/mcp/server.ts');
    for (const v of ['profile list', 'profile get', 'agents get']) assert.ok(chat.ALLOW_COMMANDS.includes(v) && mcp.READ_VERBS[v], v);
    for (const v of ['profile set', 'profile delete', 'profile reset', 'agents set']) assert.ok(chat.ASK_COMMANDS.includes(v) && !chat.ALLOW_COMMANDS.includes(v) && !mcp.READ_VERBS[v], v);
    assert.deepStrictEqual(mcp.paToolArgv('profile list', []), ['profile', 'list']);
    assert.throws(() => mcp.paToolArgv('profile set', ['chore']), /not a read-only/);
  }

  console.log('agentSettings ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
