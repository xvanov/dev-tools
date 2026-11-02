'use strict';

// Which agent CLI the PA chat runs (PA_CHAT_AGENT: claude | opencode), on
// which model (PA_CHAT_MODEL), and the permission guarantee for each.
//
// The guarantee (AGENT.md, "The PA chat acts only behind permission prompts")
// is the same for both: read-only `pa` commands and read MCP tools run
// without asking; every `pa` command that acts, every other shell command,
// every edit and every web fetch asks. What differs is how it is enforced:
//
//  - **claude** reads .claude/settings.json (src/chat/index.js). The command
//    must not skip permissions; chatCommand() refuses one that does.
//  - **opencode** reads opencode.json in the chat's home, written here.
//    opencode's defaults allow nearly everything, so the rules start with
//    `"*": "ask"`; the last matching rule wins. **Every shell command asks**,
//    with no allow-pattern at all: a pattern is matched against opencode's own
//    reading of the command line, which this file cannot reproduce, and every
//    allow-pattern we tried was a way round it (`export NODE_OPTIONS=…; pa
//    brief`, a bare `> file`, `{ …; } > f`). The read-only `pa` verbs reach
//    the chat as the MCP tool `pa` instead (src/mcp/server.js, on only for
//    this chat), where they are an enum, not a command line. The verbs that
//    act stay shell commands behind the prompt, through one launcher per verb
//    (`bin/pa-do`, …, written by src/chat/index.js) so that opencode's "Allow
//    always" — which saves the command's first word + ` *`, cannot be switched
//    off, and outranks the config — approves at most that one verb, never
//    `node *`. Subagents (`task`) are denied — a subagent would run under its
//    own ruleset — and so is `--auto`. Because a project config can be ignored
//    (OPENCODE_DISABLE_PROJECT_CONFIG) or outranked, the rules are not taken
//    on trust: verifyOpencodePermissions() asks opencode itself for the
//    resolved ruleset (`opencode debug agent <name>`) and checks its SHAPE —
//    nothing after the bash catch-all may allow a shell command — as well as
//    the outcomes that matter. `pa chat` will not start an opencode chat that
//    fails it, and `pa doctor` reports it.

const path = require('path');
const { execFile } = require('child_process');
const { config } = require('../config');
const { agentOf, hasFlag, modelArg, AGENTS } = require('../agentCli');

// Flags that would take the chat out from behind its prompts.
const CLAUDE_UNSAFE = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--allowedTools', '--allowed-tools'];
const OPENCODE_UNSAFE = ['--auto'];
// `--permission-mode` values that keep every prompt.
const SAFE_PERMISSION_MODES = ['default', 'plan'];

/**
 * Pure. The chat's command line: { agent, model, command }. Throws when the
 * configuration cannot give the chat its permission guarantee.
 */
function chatCommand({ agent = config.chat.agent, model = config.chat.model, command = config.chat.command } = {}) {
  let kind;
  let line;
  if (command) {
    kind = agentOf(command);
    if (!kind) throw new Error(`PA_CHAT_COMMAND must start claude or opencode, not "${String(command).split(/\s/)[0]}"`);
    if (agent && agent !== kind) throw new Error(`PA_CHAT_AGENT=${agent} but PA_CHAT_COMMAND starts ${kind}`);
    line = String(command).trim();
  } else {
    kind = agent || 'claude';
    if (!AGENTS.includes(kind)) throw new Error(`PA_CHAT_AGENT must be ${AGENTS.join(' or ')}, not "${kind}"`);
    line = kind;
  }
  if (kind === 'claude') {
    // Only the modes that still ask: acceptEdits, dontAsk, auto and
    // bypassPermissions each let an action through without the prompt.
    const modes = [...line.matchAll(/(?:^|\s)--permission-mode(?:[\s=]+(\S+))?/gi)].map((m) => String(m[1] || ''));
    if (hasFlag(line, ...CLAUDE_UNSAFE) || modes.some((v) => !SAFE_PERMISSION_MODES.includes(v.toLowerCase()))) {
      throw new Error('the PA chat must not skip permissions (it reads other people\'s messages) — remove the flag from PA_CHAT_COMMAND');
    }
  } else {
    if (hasFlag(line, ...OPENCODE_UNSAFE)) {
      throw new Error('the PA chat must not run opencode with --auto (it approves every action) — remove it from PA_CHAT_COMMAND');
    }
    const named = /(^|\s)--agent[\s=]+(\S+)/.exec(line);
    if (named && named[2] !== 'pa') throw new Error(`the PA chat runs opencode's "pa" agent, whose permissions it writes — not "${named[2]}"`);
    if (!named) line += ' --agent pa';
  }
  const arg = modelArg(kind, model);
  if (arg) {
    if (hasFlag(line, '--model', '-m')) throw new Error('PA_CHAT_MODEL is set and PA_CHAT_COMMAND already has --model — keep one');
    line += ` --model ${arg}`;
  }
  return { agent: kind, model: arg, command: line };
}

// ---------------------------------------------------- opencode rules ----

// The MCP tool that carries the read-only `pa` verbs (src/mcp/server.js).
const PA_TOOL = 'pa';
// Set only in the chat's opencode.json: the shared MCP server lists the tool
// for this chat and for no other session.
const PA_TOOL_ENV = 'PA_MCP_CHAT_TOOLS';

/** Pure. The permission ruleset for every agent in the chat's opencode. */
function opencodeRules() {
  const chat = require('./index');
  const rules = {
    '*': 'ask',
    read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask' },
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    todowrite: 'allow',
    question: 'allow',
    edit: 'ask',
    webfetch: 'ask',
    websearch: 'ask',
    external_directory: 'ask',
    task: 'deny',
    // Every shell command asks. No allow-pattern: see the header.
    bash: 'ask',
  };
  for (const t of chat.ALLOW_MCP_TOOLS) rules[`personal-assistant_${t}`] = 'allow';
  rules[`personal-assistant_${PA_TOOL}`] = 'allow';
  return rules;
}

/** Pure. opencode.json for the chat's home. */
function opencodeConfig() {
  const rules = opencodeRules();
  const server = path.join(config.toolDir, 'src', 'mcp', 'server.js').replace(/\\/g, '/');
  return {
    $schema: 'https://opencode.ai/config.json',
    default_agent: 'pa',
    // The user's own additions, as for Claude Code.
    instructions: ['CLAUDE.local.md'],
    mcp: {
      'personal-assistant': { type: 'local', command: ['node', server], enabled: true, environment: { [PA_TOOL_ENV]: '1' } },
    },
    // Top level and on every primary agent: switching agents in the TUI must
    // not switch the rules off.
    permission: rules,
    agent: {
      pa: { mode: 'primary', description: 'The personal assistant', permission: rules },
      build: { permission: rules },
      plan: { permission: rules },
    },
  };
}

// opencode's wildcard: `*` any run of characters, `?` one; a trailing " *"
// also matches the bare command.
function wildcard(pattern, text) {
  let re = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (re.endsWith(' .*')) re = `${re.slice(0, -3)}( .*)?`;
  return new RegExp(`^${re}$`, 's').test(String(text));
}

/** Pure. What a resolved ruleset does with one request: last match wins. */
function evaluate(ruleset, permission, pattern) {
  let action = 'ask';
  for (const r of ruleset || []) {
    if (wildcard(r.permission, permission) && wildcard(r.pattern, pattern)) action = r.action;
  }
  return action;
}

/** Pure. The outcomes the chat's guarantee rests on, as [permission, pattern, wanted]. */
function probes(pa = require('./index').paCommand()) {
  return [
    // Every shell command asks — the read-only ones too (they are the `pa`
    // tool now), and the ways round an allow-pattern that once worked.
    ['bash', `${pa} brief`, 'ask'],
    ['bash', `${pa} search "renewal"`, 'ask'],
    ['bash', `export NODE_OPTIONS='--import data:text/javascript,x'; ${pa} brief`, 'ask'],
    ['bash', '> notes.txt', 'ask'],
    ['bash', `{ ${pa} brief; } > notes.txt`, 'ask'],
    ['bash', `for i in 1; do ${pa} brief; done >> notes.txt`, 'ask'],
    ['bash', `${pa} do --task "x" --mode local`, 'ask'],
    ['bash', 'bin/pa-do --task "x" --mode local', 'ask'],
    ['bash', `${pa} done 12`, 'ask'],
    ['bash', `${pa} answer 9 yes --delivery push_to_main`, 'ask'],
    ['bash', 'bin/pa-delivery-set acme/widget auto_merge', 'ask'],
    ['bash', `${pa} propose --task "x" --delivery draft_pr`, 'ask'],
    ['bash', `${pa} brief > notes.txt`, 'ask'],
    ['bash', 'rm -rf build', 'ask'],
    ['bash', 'curl https://example.com', 'ask'],
    ['edit', 'CLAUDE.md', 'ask'],
    ['webfetch', 'https://example.com', 'ask'],
    ['task', 'general', 'deny'],
    ['personal-assistant_remember', '*', 'ask'],
    ['personal-assistant_recall', '*', 'allow'],
    [`personal-assistant_${PA_TOOL}`, '*', 'allow'],
  ];
}

/**
 * Pure. The shape every shell rule must have, whatever the command text: a
 * catch-all (`bash` / `*` pattern) that asks or denies, and after it no rule
 * that could allow a shell command. This is what makes the probes above
 * independent of how opencode splits a command line — no pattern of ours is
 * ever matched against it. Problems as strings; [] when it holds.
 */
function checkBashShape(name, ruleset) {
  const list = Array.isArray(ruleset) ? ruleset : [];
  let last = -1;
  list.forEach((r, i) => {
    if (wildcard(r.permission, 'bash') && r.pattern === '*' && (r.action === 'ask' || r.action === 'deny')) last = i;
  });
  if (last < 0) return [`${name}: no rule makes every shell command ask`];
  const out = [];
  for (const r of list.slice(last + 1)) {
    if (wildcard(r.permission, 'bash') && r.action === 'allow') out.push(`${name}: bash "${r.pattern}" is allowed after the ask-everything rule (permission "${r.permission}")`);
  }
  return out;
}

/** Pure. Problems with one agent's resolved ruleset; [] when it holds. */
function checkRuleset(name, ruleset, pa) {
  const out = checkBashShape(name, ruleset);
  for (const [perm, pattern, wanted] of probes(pa)) {
    const got = evaluate(ruleset, perm, pattern);
    const unsafe = wanted !== 'allow' && got === 'allow';
    // An allow that turned into an ask is a nuisance, not a hole; report holes.
    if (unsafe || (wanted === 'deny' && got !== 'deny')) out.push(`${name}: ${perm} "${pattern}" is ${got}, must be ${wanted}`);
  }
  return out;
}

function run(bin, args, cwd) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

/**
 * Asks the installed opencode for the ruleset it would actually apply in the
 * chat's home, for every primary agent the user can switch to, and checks it.
 * { ok, problems }. Fails closed: an opencode that cannot be asked is refused.
 */
async function verifyOpencodePermissions(home, { exec = run, env = process.env } = {}) {
  const problems = [];
  for (const v of ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION']) {
    if (env[v]) problems.push(`${v} is set, which can override the chat's opencode.json`);
  }
  const bin = (config.chat.command && agentOf(config.chat.command) === 'opencode' && String(config.chat.command).trim().split(/\s+/)[0]) || 'opencode';
  const pa = require('./index').paCommand();
  for (const name of ['pa', 'build', 'plan']) {
    const { err, stdout } = await exec(bin, ['debug', 'agent', name], home);
    const at = stdout.indexOf('{');
    let parsed = null;
    try {
      parsed = at >= 0 ? JSON.parse(stdout.slice(at)) : null;
    } catch {}
    if (!parsed || !Array.isArray(parsed.permission)) {
      problems.push(`could not read opencode's rules for agent ${name}${err ? `: ${String(err.message).slice(0, 120)}` : ''}`);
      continue;
    }
    problems.push(...checkRuleset(name, parsed.permission, pa));
  }
  return { ok: problems.length === 0, problems };
}

module.exports = {
  chatCommand, opencodeRules, opencodeConfig, wildcard, evaluate, probes, checkRuleset, checkBashShape, verifyOpencodePermissions,
  PA_TOOL, PA_TOOL_ENV,
};
