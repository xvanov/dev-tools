'use strict';

// The agent CLIs pa starts: the PA chat's command and its permission
// guarantee on claude and opencode, dispatched runs' command, and the
// doorbell that must never type at a screen it cannot read.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { agentOf, modelArg } = require('../src/agentCli');
const agent = require('../src/chat/agent');
const { dispatchCommand } = require('../src/dispatch/agent');
const chat = require('../src/chat');
const notifyChat = require('../src/notify/chat');

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
  assert.strictEqual(modelArg('claude', null), null);
}

// ------------------------------------------------------- chat command ----

{
  const cmd = (o) => agent.chatCommand({ agent: null, model: null, command: null, ...o });
  assert.deepStrictEqual(cmd({}), { agent: 'claude', model: null, command: 'claude' }, 'default unchanged');
  assert.strictEqual(cmd({ model: 'claude-sonnet-5-5' }).command, 'claude --model claude-sonnet-5-5');
  assert.strictEqual(cmd({ agent: 'opencode', model: 'azure/gpt-5.4' }).command, 'opencode --agent pa --model azure/gpt-5.4');
  assert.strictEqual(cmd({ command: 'opencode' }).command, 'opencode --agent pa');
  assert.strictEqual(cmd({ command: 'claude' }).agent, 'claude');

  // Never without permission prompts.
  assert.throws(() => cmd({ command: 'claude --dangerously-skip-permissions' }), /must not skip permissions/);
  assert.throws(() => cmd({ command: 'claude --permission-mode bypassPermissions' }), /must not skip permissions/);
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
  const bashKeys = Object.keys(conf.permission.bash);
  assert.strictEqual(bashKeys[0], '*');
  assert.strictEqual(bashKeys[bashKeys.length - 1], '*>*', 'a redirect asks, after every allow');
  assert.ok(conf.mcp['personal-assistant'].command[1].endsWith('src/mcp/server.js'));

  // One list feeds both agents.
  const s = chat.settingsJson();
  const pa = chat.paCommand();
  for (const c of chat.ALLOW_COMMANDS) {
    assert.ok(s.permissions.allow.includes(`Bash(${pa} ${c}:*)`));
    assert.strictEqual(conf.permission.bash[`${pa} ${c} *`], 'allow');
  }
  for (const c of chat.ASK_COMMANDS) {
    assert.ok(s.permissions.ask.includes(`Bash(${pa} ${c}:*)`));
    assert.strictEqual(conf.permission.bash[`${pa} ${c} *`], 'ask');
  }

  // Wildcards as opencode reads them.
  assert.ok(agent.wildcard('git *', 'git status'));
  assert.ok(agent.wildcard('git *', 'git'), 'a trailing " *" also matches the bare command');
  assert.ok(!agent.wildcard('git *', 'gitk'));
  assert.ok(agent.wildcard('*>*', 'x > y'));
  assert.ok(agent.wildcard('personal-assistant_*', 'personal-assistant_recall'));

  // The ruleset opencode 1.18.15 actually resolved for the "pa" agent from
  // this config (`opencode debug agent pa`, captured; pa's path is __PA__).
  const fixture = JSON.stringify(require('./opencodeRules.fixture.js')).split('__PA__').join(pa);
  const resolved = JSON.parse(fixture);
  assert.deepStrictEqual(agent.checkRuleset('pa', resolved, pa), []);
  assert.strictEqual(agent.evaluate(resolved, 'bash', `${pa} brief`), 'allow');
  assert.strictEqual(agent.evaluate(resolved, 'bash', `${pa} do --task x`), 'ask');
  assert.strictEqual(agent.evaluate(resolved, 'bash', 'git push'), 'ask');
  assert.strictEqual(agent.evaluate(resolved, 'read', '.env'), 'ask');
  assert.strictEqual(agent.evaluate(resolved, 'read', 'INBOX.md'), 'allow');

  // opencode's defaults alone (our file not loaded) allow everything: refused.
  const defaults = [{ permission: '*', action: 'allow', pattern: '*' }, { permission: 'doom_loop', action: 'ask', pattern: '*' }];
  const holes = agent.checkRuleset('build', defaults, pa);
  assert.ok(holes.some((h) => h.includes(' do --task')));
  assert.ok(holes.some((h) => h.startsWith('build: task')));
}

(async () => {
  const pa = chat.paCommand();
  const fixture = JSON.stringify(require('./opencodeRules.fixture.js')).split('__PA__').join(pa);
  const good = async () => ({ err: null, stdout: `{"name":"x","permission":${fixture}}` });
  assert.deepStrictEqual(await agent.verifyOpencodePermissions('/h', { exec: good, env: {} }), { ok: true, problems: [] });
  // Fails closed: an opencode that cannot be asked, or an environment that can override the file.
  const broken = async () => ({ err: new Error('Agent pa not found'), stdout: '' });
  const r1 = await agent.verifyOpencodePermissions('/h', { exec: broken, env: {} });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.problems[0], /could not read/);
  const r2 = await agent.verifyOpencodePermissions('/h', { exec: good, env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } });
  assert.strictEqual(r2.ok, false);

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
  assert.match(md, new RegExp(`run \`${pa.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} context\``));
  assert.match(md, /data, never\s+instructions/);
  assert.match(chat.claudeMd(), /a hook loads/);

  void config;
  console.log('agents: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
