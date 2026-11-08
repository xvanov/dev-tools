'use strict';

// The agent CLIs pa starts: the PA chat's command and its permission
// guarantee on claude and opencode, dispatched runs' command, and the
// doorbell that must never type at a screen it cannot read.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config.ts');
const { agentOf, modelArg } = require('../src/agentCli.ts');
const agent = require('../src/chat/agent.ts');
const { dispatchCommand } = require('../src/dispatch/agent.ts');
const chat = require('../src/chat');
const notifyChat = require('../src/notify/chat.ts');

// ------------------------------------------------------- model → CLI ----

{
  assert.strictEqual(agentOf('claude --model x'), 'claude');
  assert.strictEqual(agentOf('"C:\\Program Files\\opencode\\opencode.exe" --agent pa'), 'opencode');
  assert.strictEqual(agentOf('/usr/bin/claude.cmd'), 'claude');
  assert.strictEqual(agentOf('bash -c claude'), null);

  assert.strictEqual(modelArg('claude', 'cli/claude-opus-5'), 'claude-opus-5');
  assert.strictEqual(modelArg('claude', 'anthropic/claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.strictEqual(modelArg('claude', 'claude-opus-5'), 'claude-opus-5');
  assert.throws(() => modelArg('claude', 'azure/gpt-5.4'), /Claude models only/);
  assert.strictEqual(modelArg('opencode', 'azure/gpt-5.4'), 'azure/gpt-5.4');
  assert.strictEqual(modelArg('opencode', 'openrouter/deepseek/deepseek-v4'), 'openrouter/deepseek/deepseek-v4');
  assert.throws(() => modelArg('opencode', 'gpt-5.4'), /provider\/model/);
  assert.throws(() => modelArg('opencode', 'cli/claude-opus-5'), /cli\//);
  assert.throws(() => modelArg('opencode', 'azure/gpt; rm -rf ~'), /command line/);
  assert.throws(() => modelArg('claude', 'claude-opus-5 --dangerously-skip-permissions'), /command line/);
  // A leading '-' would be read as the next flag after --model.
  assert.throws(() => modelArg('claude', '--dangerously-skip-permissions'), /command line/);
  assert.throws(() => modelArg('opencode', '-x/y'), /command line/);
  assert.throws(() => modelArg('opencode', '--auto'), /command line/);
  assert.strictEqual(modelArg('claude', null), null);
}

// ------------------------------------------------------- chat command ----

{
  const cmd = (o) => agent.chatCommand({ agent: null, model: null, command: null, ...o });
  assert.deepStrictEqual(cmd({}), { agent: 'claude', model: null, command: 'claude --permission-mode default' }, 'the mode is explicit (MUST-FIX 6)');
  assert.strictEqual(cmd({ model: 'claude-sonnet-5-5' }).command, 'claude --permission-mode default --model claude-sonnet-5-5');
  assert.strictEqual(cmd({ mcpConfig: '/h/pa-chat.mcp.json' }).command, 'claude --permission-mode default --mcp-config "/h/pa-chat.mcp.json"');
  assert.strictEqual(cmd({ agent: 'opencode', model: 'azure/gpt-5.4' }).command, 'opencode --agent pa --model azure/gpt-5.4');
  assert.strictEqual(cmd({ command: 'opencode' }).command, 'opencode --agent pa');
  assert.strictEqual(cmd({ command: 'claude' }).agent, 'claude');

  // Never without permission prompts.
  assert.throws(() => cmd({ command: 'claude --dangerously-skip-permissions' }), /must not skip permissions/);
  assert.throws(() => cmd({ command: 'claude --permission-mode bypassPermissions' }), /must not skip permissions/);
  // Every permission mode that lets an action through without the prompt.
  for (const m of ['acceptEdits', 'dontAsk', 'auto', 'bypassPermissions', 'AcceptEdits', '']) {
    assert.throws(() => cmd({ command: `claude --permission-mode ${m}` }), /must not skip permissions/, m);
    assert.throws(() => cmd({ command: `claude --permission-mode=${m}` }), /must not skip permissions/, m);
  }
  assert.throws(() => cmd({ command: 'claude --permission-mode plan --permission-mode acceptEdits' }), /must not skip permissions/);
  assert.throws(() => cmd({ command: 'claude --permission-mode plan' }), /runs in --permission-mode default/);
  assert.strictEqual(cmd({ command: 'claude --permission-mode default' }).agent, 'claude');
  assert.throws(() => cmd({ command: 'claude --allowedTools Bash' }), /must not skip permissions/);
  assert.throws(() => cmd({ command: 'opencode --auto' }), /--auto/);
  assert.throws(() => cmd({ command: 'opencode --agent build' }), /"pa" agent/);
  // Misconfigurations are refused, not guessed at.
  assert.throws(() => cmd({ agent: 'opencode', command: 'claude' }), /PA_CHAT_AGENT=opencode/);
  assert.throws(() => cmd({ agent: 'aider' }), /claude or opencode/);
  assert.throws(() => cmd({ command: 'bash' }), /must start claude or opencode/);
  assert.throws(() => cmd({ model: 'azure/gpt-5.4' }), /Claude models only/);
  assert.throws(() => cmd({ command: 'claude --model x', model: 'claude-opus-5' }), /keep one/);
}

// --------------------------------------------- opencode permissions ----

{
  const conf = agent.opencodeConfig();
  assert.strictEqual(conf.default_agent, 'pa');
  for (const name of ['pa', 'build', 'plan']) assert.deepStrictEqual(conf.agent[name].permission, conf.permission, `${name} carries the rules`);
  const keys = Object.keys(conf.permission);
  assert.strictEqual(keys[0], '*', 'the catch-all comes first: the last match wins');
  assert.strictEqual(conf.permission['*'], 'ask');
  assert.strictEqual(conf.permission.task, 'deny');
  // Every shell command asks: no allow-pattern for opencode to read differently.
  assert.strictEqual(conf.permission.bash, 'ask');
  assert.strictEqual(conf.permission['personal-assistant_pa'], 'allow', 'the read-only verbs are the pa tool');
  assert.deepStrictEqual(conf.mcp['personal-assistant'].environment, { PA_MCP_CHAT_TOOLS: '1' }, 'listed for this chat only');
  assert.ok(conf.mcp['personal-assistant'].command[1].endsWith('src/mcp/server.js'));

  // MUST-FIX 7: the Claude Code chat reads through the same pa tool; no `pa` shell command is allowed.
  const s = chat.settingsJson();
  const pa = chat.paCommand();
  assert.ok(!s.permissions.allow.some((r) => r.startsWith('Bash(')), 'no Bash allow rule at all');
  assert.ok(s.permissions.allow.includes(`mcp__${chat.CHAT_MCP}__pa`));
  assert.ok(s.permissions.ask.includes(`Bash(${pa}:*)`), 'every pa shell command asks');
  for (const c of [...chat.ASK_COMMANDS, ...chat.ALLOW_COMMANDS, 'propose']) assert.ok(s.permissions.ask.includes(`Bash(${pa} ${c}:*)`), c);
  assert.deepStrictEqual(chat.mcpJson().mcpServers[chat.CHAT_MCP].env, { PA_MCP_CHAT_TOOLS: '1' });
  // MUST-FIX 6: default mode, bypass disabled, read back before the chat starts.
  assert.strictEqual(s.permissions.defaultMode, 'default');
  assert.strictEqual(s.permissions.disableBypassPermissionsMode, 'disable');
  const okCmd = agent.chatCommand({ agent: 'claude', model: null, command: null }).command;
  assert.deepStrictEqual(chat.verifyClaudeHome({ settings: s, command: okCmd }), []);
  assert.match(chat.verifyClaudeHome({ settings: s, local: { permissions: { defaultMode: 'auto' } }, command: okCmd }).join(), /defaultMode is "auto"/, 'a settings.local.json cannot switch it');
  assert.match(chat.verifyClaudeHome({ settings: { permissions: { defaultMode: 'default' } }, command: okCmd }).join(), /bypass/);
  assert.match(chat.verifyClaudeHome({ settings: s, local: { permissions: { allow: [`Bash(${pa} memory:*)`] } }, command: okCmd }).join(), /allowed without asking/);
  assert.match(chat.verifyClaudeHome({ settings: s, command: 'claude' }).join(), /--permission-mode default/);
  // MUST-FIX 8: the tool refuses what writes, whatever its spelling.
  const { paToolArgv } = require('../src/mcp/server.ts');
  for (const [c, a] of [['memory', ['RUN', 'dream']], ['memory', ['Run']], ['projects', ['SYNC']], ['review', ['5', '--done']], ['show', ['5', '--project=x']],
    ['meeting', ['brief', 'next', '--notify']], ['meeting', ['brief', '--force']], ['meeting', ['debrief']], ['meeting', ['undo', '3']], ['meeting', ['learn']],
    ['runs', ['reconcile']], ['notify ack', ['all']], ['doctor', []], ['brief', ['--Force']]]) {
    assert.throws(() => paToolArgv(c, a), /not read-only|writes|not a read-only/, `${c} ${a.join(' ')}`);
  }
  for (const [c, a] of [['memory', ['Dana']], ['meeting', ['brief', 'next']], ['runs', []], ['runs', ['stats']], ['projects', []], ['search', ['renewal']]]) {
    assert.doesNotThrow(() => paToolArgv(c, a), `${c} ${a.join(' ')}`);
  }
  // ...and every read-only verb it may run is a verb of the opencode chat's pa tool.
  const mcp = require('../src/mcp/server.ts');
  for (const c of chat.ALLOW_COMMANDS) assert.ok(Object.prototype.hasOwnProperty.call(mcp.READ_VERBS, c), `pa tool carries ${c}`);

  // Wildcards as opencode reads them.
  assert.ok(agent.wildcard('git *', 'git status'));
  assert.ok(agent.wildcard('git *', 'git'), 'a trailing " *" also matches the bare command');
  assert.ok(!agent.wildcard('git *', 'gitk'));
  assert.ok(agent.wildcard('*>*', 'x > y'));
  assert.ok(agent.wildcard('personal-assistant_*', 'personal-assistant_recall'));

  // The ruleset opencode 1.18.15 actually resolved for the "pa" agent from
  // this config (`opencode debug agent pa`, captured).
  const resolved = require('./opencodeRules.fixture.js');
  assert.deepStrictEqual(agent.checkRuleset('pa', resolved, pa), []);
  for (const cmdline of [
    `${pa} brief`,
    `export NODE_OPTIONS='--import data:text/javascript,x'; ${pa} brief`,
    '> notes.txt',
    `{ ${pa} brief; } > f`,
    `for i in 1; do ${pa} brief; done >> f`,
    'git push',
  ]) assert.strictEqual(agent.evaluate(resolved, 'bash', cmdline), 'ask', cmdline);
  assert.strictEqual(agent.evaluate(resolved, 'personal-assistant_pa', '*'), 'allow');
  assert.strictEqual(agent.evaluate(resolved, 'read', '.env'), 'ask');
  assert.strictEqual(agent.evaluate(resolved, 'read', 'INBOX.md'), 'allow');

  // The old shape — bash allowed by pattern — is refused by shape, whatever
  // the command text: this is the check that does not depend on how opencode
  // splits a command line.
  const oldResolved = JSON.parse(JSON.stringify(require('./opencodeRules.allowPatterns.fixture.js')).split('__PA__').join(pa));
  const oldHoles = agent.checkBashShape('pa', oldResolved);
  assert.ok(oldHoles.length > 0 && oldHoles.every((h) => /allowed after the ask-everything rule/.test(h)), oldHoles.join('\n'));
  assert.ok(agent.checkRuleset('pa', oldResolved, pa).length > 0);
  // A later wildcard allow also counts as a bash allow.
  assert.ok(agent.checkBashShape('x', [{ permission: 'bash', pattern: '*', action: 'ask' }, { permission: '*', pattern: 'node *', action: 'allow' }]).length === 1);
  assert.ok(agent.checkBashShape('x', [{ permission: '*', pattern: '*', action: 'allow' }]).length === 1, 'no ask-everything rule at all');

  // opencode's defaults alone (our file not loaded) allow everything: refused.
  const defaults = [{ permission: '*', action: 'allow', pattern: '*' }, { permission: 'doom_loop', action: 'ask', pattern: '*' }];
  const holes = agent.checkRuleset('build', defaults, pa);
  assert.ok(holes.some((h) => /no rule makes every shell command ask/.test(h)));
  assert.ok(holes.some((h) => h.includes(' do --task')));
  assert.ok(holes.some((h) => h.startsWith('build: task')));
}

(async () => {
  const pa = chat.paCommand();
  const fixture = JSON.stringify(require('./opencodeRules.fixture.js'));
  const good = async () => ({ err: null, stdout: `{"name":"x","permission":${fixture}}` });
  assert.deepStrictEqual(await agent.verifyOpencodePermissions('/h', { exec: good, env: {} }), { ok: true, problems: [] });
  // Fails closed: an opencode that cannot be asked, or an environment that can override the file.
  const broken = async () => ({ err: new Error('Agent pa not found'), stdout: '' });
  const r1 = await agent.verifyOpencodePermissions('/h', { exec: broken, env: {} });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.problems[0], /could not read/);
  const r2 = await agent.verifyOpencodePermissions('/h', { exec: good, env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } });
  assert.strictEqual(r2.ok, false);
  // An opencode that resolved an allow-pattern for bash (an old opencode.json,
  // a global config, an "always" written into a config) is refused.
  const allowing = async () => ({ err: null, stdout: `{"permission":${JSON.stringify([...JSON.parse(fixture), { permission: 'bash', pattern: 'node *', action: 'allow' }])}}` });
  const r3 = await agent.verifyOpencodePermissions('/h', { exec: allowing, env: {} });
  assert.strictEqual(r3.ok, false);
  assert.ok(r3.problems.some((p) => /bash "node \*" is allowed/.test(p)));

  // --------------------------------------------------- dispatch ----
  const c = { termhub: { claudeCommand: 'claude --dangerously-skip-permissions', agent: 'claude', model: null } };
  const prompt = 'Read BRIEF.md in this worktree, then do what it asks.';
  assert.deepStrictEqual(dispatchCommand({ c, prompt }), {
    agent: 'claude', model: null, command: 'claude --dangerously-skip-permissions', typesPrompt: true,
  }, 'default unchanged; the prompt is typed');
  assert.strictEqual(dispatchCommand({ c, model: 'cli/claude-opus-5' }).command, 'claude --dangerously-skip-permissions --model claude-opus-5');
  const oc = dispatchCommand({ c, agent: 'opencode', model: 'deepseek/deepseek-chat', prompt });
  assert.strictEqual(oc.command, `opencode --auto --model deepseek/deepseek-chat --prompt "${prompt}"`);
  assert.strictEqual(oc.typesPrompt, false, 'opencode is never typed at');
  // Defaults from config, overridable per run.
  const ocDefault = { termhub: { ...c.termhub, agent: 'opencode', model: 'azure/gpt-5.4' } };
  assert.strictEqual(dispatchCommand({ c: ocDefault }).command, 'opencode --auto --model azure/gpt-5.4');
  assert.strictEqual(dispatchCommand({ c: ocDefault, agent: 'claude', model: 'claude-opus-5' }).agent, 'claude');
  assert.throws(() => dispatchCommand({ c, agent: 'opencode', prompt: 'echo "$HOME"' }), /cannot be put/);
  assert.throws(() => dispatchCommand({ c, model: 'azure/gpt-5.4' }), /Claude models only/);
  assert.throws(() => dispatchCommand({ c, agent: 'cursor' }), /claude or opencode/);
  assert.throws(() => dispatchCommand({ c: { termhub: { ...c.termhub, claudeCommand: 'claude --model x' } }, model: 'claude-opus-5' }), /keep one/);
  // The real opening prompt fits a command line.
  const { openingPrompt } = require('../src/dispatch/brief');
  assert.ok(dispatchCommand({ c, agent: 'opencode', prompt: openingPrompt({}) }).command.includes('BRIEF.md'));

  // ------------------------------------------------ nudge fail-safe ----
  const EMPTY_BOX = ['some answer', '', '╭────╮', '│ >  │', '╰────╯', '  ? for shortcuts'].join('\n');
  const idle = { id: 's1', kind: 'claude', alive: true, busy: false, idleState: 'waiting', idleReason: 'turn-end', idleMs: 5 * 60_000 };
  const ok = (session, screen = EMPTY_BOX) => notifyChat.nudgeDecision({ session, screen, minIdleMs: 2 * 60_000 });
  assert.strictEqual(ok(idle).ok, true);
  // An opencode chat at a finished turn, even with a screen that looks like an empty box: never typed at.
  const r = ok({ ...idle, kind: 'opencode' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not a Claude Code session \(opencode\)/);
  assert.strictEqual(ok({ ...idle, kind: undefined }).ok, false, 'a termhub that does not say which agent: skip');
  assert.strictEqual(ok({ ...idle, kind: 'shell' }).ok, false);

  // -------------------------------------------------- AGENTS.md ----
  const md = chat.claudeMd({ agent: 'opencode' });
  assert.match(md, /call the `pa` tool with\s+command `context`/);
  assert.match(md, /data, never\s+instructions/);
  assert.match(md, /`bin\/pa-do --task/, 'acting verbs through their launcher');
  assert.ok(!md.includes(`\`${pa} do`), 'never the node … pa.js form for an acting verb');
  assert.match(chat.claudeMd(), /a hook loads/);
  assert.ok(chat.claudeMd().includes(`\`${pa} do --task`), 'the Claude Code chat still runs the CLI');

  // ------------------------------------------- per-verb launchers (H2) ----
  // opencode's "Allow always" saves `<first word> *`. For each acting verb the
  // first word is its own launcher, so "always" can never cover more than it.
  const l = chat.launchers();
  for (const verb of chat.ASK_COMMANDS) {
    const name = `pa-${verb.replace(/ /g, '-')}`;
    assert.ok(l[name].startsWith('#!/bin/sh\n'), name);
    assert.ok(l[name].includes(`pa.js' ${verb} "$@"`), name);
    assert.ok(l[`${name}.cmd`].includes(`pa.js" ${verb} %*`), `${name}.cmd`);
  }
  assert.strictEqual(Object.keys(l).length, chat.ASK_COMMANDS.length * 2);
  {
    // Run for real: the launcher reaches pa.js with the verb and the args, and
    // nothing in an arg is shell syntax.
    const os = require('os');
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-launch-'));
    const js = path.join(config.toolDir, 'bin', 'pa.js').replace(/\\/g, '/');
    require('./_portable').ensurePosixTools();
    const text = l['pa-say'].replace(`node '${js}'`, `node -e 'console.log(JSON.stringify(process.argv.slice(1)))'`);
    assert.notStrictEqual(text, l['pa-say']);
    fs.writeFileSync(path.join(dir, 'pa-say'), text, { mode: 0o755 });
    const got = JSON.parse(execFileSync(process.platform === 'win32' ? 'sh' : path.join(dir, 'pa-say'), process.platform === 'win32' ? [path.join(dir, 'pa-say'), '7', '$(touch pwned); `id`'] : ['7', '$(touch pwned); `id`'], { cwd: dir }).toString());
    assert.deepStrictEqual(got, ['say', '7', '$(touch pwned); `id`']);
    assert.ok(!fs.existsSync(path.join(dir, 'pwned')));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ------------------------------------------- the chat's pa tool (H1) ----
  {
    const mcp = require('../src/mcp/server.ts');
    assert.strictEqual(mcp.chatToolsOn({}), false, 'off for every session but the opencode chat');
    assert.strictEqual(mcp.chatToolsOn({ PA_MCP_CHAT_TOOLS: '1' }), true);
    await assert.rejects(mcp.handle('pa', { command: 'brief' }), /unknown tool pa/, 'refused when not switched on');
    assert.deepStrictEqual(mcp.paToolArgv('search', ['renewal', '--since', '2026-01-01']), ['search', 'renewal', '--since', '2026-01-01']);
    assert.throws(() => mcp.paToolArgv('notify ack', ['4']), /not a read-only/, 'notify ack writes a read mark: off the tool');
    assert.deepStrictEqual(mcp.paToolArgv('meeting', ['next']), ['meeting', 'next']);
    // Only read-only verbs, and none of their writing sub-commands or flags.
    for (const [c, a] of [
      ['do', ['--task', 'x']], ['land', ['1']], ['remember', ['x']], ['notify feedback', ['1', 'up']], ['routine add', ['x']],
      ['memory', ['run']], ['memory', ['--', 'run']], ['projects', ['sync']], ['show', ['3', '--project', 'x']],
      ['show', ['3', '--project=x']], ['show', ['3', '--no-project']], ['meeting', ['debrief']], ['meeting', ['undo', '3']],
      ['meeting', ['learn']], ['review', ['3', '--done']], ['brief', [1]], ['brief', 'x'],
    ]) assert.throws(() => mcp.paToolArgv(c, a), Error, `${c} ${JSON.stringify(a)}`);
    assert.ok(mcp.PA_TOOL.inputSchema.properties.command.enum.every((v) => Object.prototype.hasOwnProperty.call(mcp.READ_VERBS, v)));
  }

  void config;
  console.log('agents: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
