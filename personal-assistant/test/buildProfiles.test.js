'use strict';

// Build profiles (src/build/profiles.ts; docs/native/BUILD-ENRICHMENT.md, A): the pure half (checking, the
// resolution order, the claude flags/env/subagent files a profile adds), then a real run's launch on a
// throwaway SQLite store with a stubbed termhub: the command line and env the session is created with,
// the files in the run's folder, and the profile on the run row and in summary.json.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-build-profiles-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_build_profiles.sqlite');
process.env.PA_SQLITE_KEY = 'build-profiles-test-key';
process.env.PA_WORKTREES_ROOT = path.join(dir, 'wt');
process.env.PA_DATA_DIR = dir;
process.env.PA_TOASTS = '0';
process.env.PA_NTFY = 'off';
process.env.PA_CHAT_NUDGE = '0';
delete process.env.PA_BUILD_COST_CAP_USD;
delete process.env.PA_BUILD_WALL_CAP_MIN;
delete process.env.PA_BUILD_IDLE_AFTER_S;

const P = require('../src/build/profiles.ts');
const B = require('../src/build/index.ts');
const termhub = require('../src/dispatch/termhub.ts');
const { available } = require('../src/db/sqlite.ts');

const DEFAULTS = { model: 'sonnet', costCapUsd: 5, wallCapMin: 120, idleAfterS: 240 };

// ---- checking ---------------------------------------------------------------------

{
  const p = P.normalize('Feature', { model: 'OPUS', effort: 'medium', permission_mode: 'plan', tools: '{"mcp":["a"],"allow":["Read"]}', subagents: [{ name: 'Scout', description: 'finds\nthings', model: 'haiku', prompt: ' look ', tools: ['Read', 'Grep'] }], cost_cap_usd: '3' });
  assert.deepStrictEqual([p.name, p.model, p.effort, p.permissionMode, p.costCapUsd], ['feature', 'opus', 'medium', 'plan', 3]);
  assert.deepStrictEqual(p.tools, { mcp: ['a'], allow: ['Read'], deny: [] });
  assert.deepStrictEqual(p.subagents, [{ name: 'scout', description: 'finds things', model: 'haiku', prompt: 'look', tools: ['Read', 'Grep'] }]);
  assert.throws(() => P.normalize('x y', {}), /profile name/);
  assert.throws(() => P.normalize('x', { model: 'gpt' }), /model must be haiku, sonnet, opus, fable/);
  assert.throws(() => P.normalize('x', { effort: 'extreme' }), /effort must be low, medium, high, xhigh, max/);
  assert.throws(() => P.normalize('x', { permissionMode: 'yolo' }), /permission mode must be/);
  assert.throws(() => P.normalize('x', { costCapUsd: -1 }), /cost cap must be a positive number/);
  assert.throws(() => P.normalize('x', { subagents: [{ name: 'a/b' }] }), /subagent name/);
  assert.throws(() => P.normalize('x', { subagents: [{ name: 'a' }, { name: 'a' }] }), /listed twice/);
  assert.deepStrictEqual(P.normalize('x', {}).tools, { mcp: [], allow: [], deny: [] }, 'an empty profile is valid and falls through');
  // The row round trip keeps what was set.
  assert.deepStrictEqual(P.normalize('feature', P.toRow(p)), p);
  assert.strictEqual(B.MODEL_IDS.fable, 'claude-fable-5-2', 'fable launches by its 5.2 id');
  assert.strictEqual(B.checkModel('claude-fable-5-2'), 'fable');
}

// ---- profile for a task kind ------------------------------------------------------

assert.deepStrictEqual(['investigate', 'review', 'coding', 'admin', 'reply', null].map(P.profileForKind), ['research', 'research', 'feature', 'chore', null, null]);

// ---- the resolution order: this call > the card > the profile > the defaults ------------

{
  const feature = P.normalize('feature', { model: 'opus', effort: 'medium', costCapUsd: 8, wallCapMin: 180 });
  const base = P.resolve({ defaults: DEFAULTS });
  assert.deepStrictEqual([base.profile, base.model, base.effort, base.permissionMode, base.costCapUsd, base.wallCapMin, base.idleAfterS], [null, 'sonnet', null, null, 5, 120, 240], 'no profile, no card: exactly the old defaults');
  const viaProfile = P.resolve({ profile: feature, defaults: DEFAULTS });
  assert.deepStrictEqual([viaProfile.profile, viaProfile.model, viaProfile.effort, viaProfile.costCapUsd, viaProfile.wallCapMin, viaProfile.idleAfterS], ['feature', 'opus', 'medium', 8, 180, 240], 'a field the profile leaves unset falls to the default');
  const viaCard = P.resolve({ card: { model: 'haiku', costCapUsd: 2 }, profile: feature, defaults: DEFAULTS });
  assert.deepStrictEqual([viaCard.model, viaCard.effort, viaCard.costCapUsd, viaCard.wallCapMin], ['haiku', 'medium', 2, 180], 'the card overrides the profile, field by field');
  const viaCall = P.resolve({ explicit: { model: 'fable', effort: 'max' }, card: { model: 'haiku', effort: 'low' }, profile: feature, defaults: DEFAULTS });
  assert.deepStrictEqual([viaCall.model, viaCall.effort], ['fable', 'max'], 'this call overrides the card');
  assert.strictEqual(P.resolve({ explicit: { model: null, effort: '' }, profile: feature, defaults: DEFAULTS }).model, 'opus', 'null and empty are "not set"');
  const old = P.resolve({ card: { model: 'opus' }, defaults: DEFAULTS });
  assert.deepStrictEqual([old.profile, old.model], [null, 'opus'], 'a build.card.<id> setting with no profile works as before');
}

// ---- what a resolved run adds to claude -------------------------------------------

{
  const none = P.launchFlags(P.resolve({ defaults: DEFAULTS }));
  assert.deepStrictEqual([none.flags, none.env, none.files], ['', {}, []], 'no profile adds nothing');

  const research = P.resolve({ profile: P.normalize('research', P.SEEDS.find((s) => s.name === 'research')), defaults: DEFAULTS });
  const r = P.launchFlags(research);
  assert.match(r.flags, / --effort medium/);
  assert.match(r.flags, / --allowedTools "Bash\(node \*pa\.js\* run \*\)"/, 'plan mode keeps the pa run verbs usable');
  assert.deepStrictEqual(r.files.map((f) => f.path), ['.claude/agents/explorer.md']);

  const rich = P.resolve({ profile: P.normalize('x', { subagentModel: 'haiku', tools: { mcp: ['m'], allow: ['Read', 'Grep'], deny: ['WebFetch'] }, effort: 'xhigh' }), defaults: DEFAULTS });
  const f = P.launchFlags(rich, { mcpFile: 'C:\\wt\\m.json' });
  assert.strictEqual(f.flags, ' --effort xhigh --mcp-config "C:\\wt\\m.json" --allowedTools "Read Grep" --disallowedTools "WebFetch"');
  assert.deepStrictEqual(f.env, { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
  assert.deepStrictEqual(P.launchFlags(P.resolve({ profile: P.normalize('x', { subagentModel: 'inherit' }), defaults: DEFAULTS })).env, {}, 'inherit sets nothing');

  const agent = P.agentFile({ name: 'explorer', description: 'Read "only" searcher', model: 'haiku', prompt: 'Search.', tools: ['Read', 'Grep'] });
  assert.strictEqual(agent, '---\nname: explorer\ndescription: "Read \\"only\\" searcher"\nmodel: haiku\ntools: Read, Grep\n---\n\nSearch.\n');

  const line = 'claude --dangerously-skip-permissions --model opus';
  assert.strictEqual(P.withPermissionMode(line, null), line, 'unset keeps Build\'s default');
  assert.strictEqual(P.withPermissionMode(line, 'bypassPermissions'), line);
  assert.strictEqual(P.withPermissionMode(line, 'plan'), 'claude --model opus --permission-mode plan', 'bypass would override plan, so it goes');
  assert.strictEqual(P.withPermissionMode('claude --permission-mode auto', 'plan'), 'claude --permission-mode plan');
}

// ---- a run, end to end -------------------------------------------------------------

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP build profiles lifecycle: no SQLite driver');
  }
  const db = require('../src/db');
  const repo = require('../src/repo');
  const created = [];
  termhub.createSession = async (spec) => { created.push(spec); return { id: `s${created.length}` }; };
  termhub.killSession = async () => true;
  termhub.sessionUrl = async (id) => `http://hub/#session=${id}`;
  termhub.answerTrust = async () => true;
  require('../src/dispatch/trust.ts').ensureTrusted = () => {};
  const wt = process.env.PA_WORKTREES_ROOT;
  const read = (f) => fs.readFileSync(f, 'utf8');
  try {
    await require('../src/db/migrate.ts').migrate();

    // The seeds are in the store, once, and an edit sticks.
    assert.deepStrictEqual((await P.list()).map((p) => p.name), ['chore', 'feature', 'quick', 'research']);
    const chore = await P.get('chore');
    assert.deepStrictEqual([chore.model, chore.effort], ['sonnet', 'low']);
    assert.deepStrictEqual([(await P.get('quick')).model, (await P.get('research')).permissionMode], ['haiku', 'plan']);
    await P.save('chore', { ...chore, effort: 'medium', description: 'edited' });
    P.resetSeeds();
    assert.strictEqual((await P.get('chore')).effort, 'medium', 'seeding again does not overwrite an edit');
    await assert.rejects(() => P.need('nope'), /no profile "nope" \(known: chore, feature, quick, research\)/);

    // No profile: the command is what Build always launched.
    const plain = await B.start({ task: 'plain task' });
    assert.deepStrictEqual([plain.profile, plain.effort, plain.permission_mode, plain.model], [null, null, null, 'sonnet']);
    assert.ok(!/--effort|--permission-mode|--allowedTools|--mcp-config/.test(created[0].command), created[0].command);
    assert.match(created[0].command, /--dangerously-skip-permissions/);
    assert.match(created[0].command, /--model sonnet/);
    assert.ok(!fs.existsSync(path.join(plain.cwd, '.claude')), 'no subagent files without a profile');
    assert.strictEqual(created[0].env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);

    // feature: opus, medium, its subagent file, its caps; the profile's text follows the common prompt.
    const feat = await B.start({ task: 'feature task', profile: 'feature' });
    const cmd = created[1].command;
    assert.deepStrictEqual([feat.profile, feat.model, feat.effort, Number(feat.cost_cap_usd), Number(feat.wall_cap_min)], ['feature', 'opus', 'medium', 8, 180]);
    assert.match(cmd, /--model opus/);
    assert.match(cmd, / --effort medium/);
    assert.match(cmd, / --strict-mcp-config/);
    assert.match(cmd, /--dangerously-skip-permissions/, 'feature keeps the default permission mode');
    const agentFile = path.join(feat.cwd, '.claude', 'agents', 'explorer.md');
    assert.match(read(agentFile), /^---\nname: explorer\n[\s\S]*model: haiku\ntools: Read, Grep, Glob\n---/);

    // Fable launches by its full id.
    const fab = await B.start({ task: 'fable task', model: 'fable' });
    assert.match(created[2].command, /--model claude-fable-5-2( |$)/);
    assert.strictEqual(fab.model, 'fable');

    // The card's override beats the profile; this call's beats the card's.
    const viaCard = await B.start({ task: 'card task', commitmentId: null, profile: 'feature', effort: 'max', model: 'sonnet' });
    assert.deepStrictEqual([viaCard.model, viaCard.effort], ['sonnet', 'max'], 'an explicit model and effort beat the profile');
    assert.match(created[3].command, / --effort max/);

    // research: read-only. Plan permission mode, never bypass; the pa verbs allowed; the report goes in the result.
    const res = await B.start({ task: 'research task', profile: 'research' });
    const rc = created[4].command;
    assert.strictEqual(res.permission_mode, 'plan');
    assert.match(rc, / --permission-mode plan/);
    assert.ok(!/dangerously-skip-permissions/.test(rc), rc);
    assert.match(rc, / --allowedTools "Bash\(node \*pa\.js\* run \*\)"/);
    assert.match(rc, / --effort medium/);
    const prompt = read(path.join(wt, `build-${res.id}.PROMPT.md`));
    assert.match(prompt, /^# Jarvis task #/);
    assert.match(prompt, /## This is a read-only research run/);
    assert.match(prompt, /run done --result "<the report>"/);
    assert.ok(!/\{\{/.test(prompt), 'every placeholder is filled, the profile\'s too');

    // MCP set: the servers a profile names come from the build.mcp setting, through --mcp-config.
    await repo.system.setSetting('build.mcp', { docs: { command: 'node', args: ['docs-server.js'] } });
    await P.save('docs', { model: 'haiku', tools: { mcp: ['docs'] }, subagentModel: 'haiku' });
    const mcp = await B.start({ task: 'docs task', profile: 'docs' });
    const mcpFile = path.join(wt, `build-${mcp.id}.mcp.json`);
    assert.deepStrictEqual(JSON.parse(read(mcpFile)), { mcpServers: { docs: { command: 'node', args: ['docs-server.js'] } } });
    assert.ok(created[5].command.includes(` --mcp-config "${mcpFile}"`), created[5].command);
    assert.strictEqual(created[5].env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
    await P.save('lost', { tools: { mcp: ['missing'] } });
    await assert.rejects(() => B.start({ task: 'x', profile: 'lost' }), /MCP server "missing" is not in the build.mcp setting \(known: docs\)/);
    await assert.rejects(() => B.start({ task: 'x', profile: 'nope' }), /no profile "nope"/);
    await assert.rejects(() => B.start({ task: 'x', effort: 'extreme' }), /effort must be/);
    assert.strictEqual(created.length, 6, 'a refused start opens no session');

    // The card picker: setForCard stores the profile and effort, forCard answers with them applied.
    await repo.system.setSetting('build.card.9', { profile: 'quick' });
    const fc = await B.forCard(9);
    assert.deepStrictEqual([fc.settings.profile, fc.settings.model, fc.settings.effort, fc.settings.costCapUsd], ['quick', 'haiku', 'low', 1]);
    assert.deepStrictEqual(fc.options.profiles.map((p) => p.name), ['chore', 'docs', 'feature', 'lost', 'quick', 'research']);
    assert.deepStrictEqual(fc.options.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    // A card whose profile was deleted starts on the defaults rather than failing.
    await repo.system.setSetting('build.card.10', { profile: 'gone' });
    assert.strictEqual((await B.forCard(10)).settings.profile, null);

    // The run row and summary.json record the profile.
    const row = await repo.buildRuns.byId(res.id);
    assert.deepStrictEqual([row.profile, row.effort, row.permission_mode], ['research', 'medium', 'plan']);
    const dest = await require('../src/build/track.ts').archive(row, null);
    const summary = JSON.parse(read(path.join(dest, 'summary.json')));
    assert.deepStrictEqual([summary.profile, summary.effort, summary.permission_mode, summary.model], ['research', 'medium', 'plan', 'sonnet']);

    // Subagent files stay out of git: a real worktree's exclude list (its .git is a file).
    const main = path.join(dir, 'repo');
    fs.mkdirSync(main);
    const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(main, 'init', '-q');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const tree = path.join(dir, 'tree');
    git(main, 'worktree', 'add', '-q', '-b', 'jarvis/x', tree);
    await B.writeSubagents(tree, [{ path: '.claude/agents/explorer.md', text: 'x' }], true);
    await B.writeSubagents(tree, [{ path: '.claude/agents/explorer.md', text: 'x' }], true);
    assert.strictEqual(git(tree, 'status', '--porcelain').trim(), '', 'the agent files are not changes');
    assert.ok(fs.existsSync(path.join(tree, '.claude', 'agents', 'explorer.md')));
    const exclude = fs.readFileSync(path.join(main, '.git', 'info', 'exclude'), 'utf8');
    assert.strictEqual(exclude.split('/.claude/agents/').length - 1, 1, 'listed once');
  } finally {
    await db.close?.().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('build profiles ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
