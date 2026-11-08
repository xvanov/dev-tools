'use strict';

// The agent a dispatched run starts: `claude` (PA_CLAUDE_COMMAND, by default
// with --dangerously-skip-permissions) or `opencode --auto`, on an optional
// model. PA_DISPATCH_AGENT / PA_DISPATCH_MODEL are the defaults; `pa do
// --agent --model` choose per run. Pure.
//
// Skipping permissions is right here and wrong in the chat: a run works in its
// own worktree, and its mode's limits are enforced by the dispatcher (a
// `local` run's push URL is blocked), not by prompts nobody is watching.
//
// claude gets its opening prompt typed once its input box is up
// (termhub.briefClaude reads Claude's screen). opencode's screen is not
// Claude's, so it gets the same fixed prompt as `--prompt` on its command line
// and nothing is typed.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Config = import('../types.ts').Config;

const { config } = require('../config.ts');
const { agentOf, hasFlag, modelArg, AGENTS } = require('../agentCli.ts');

// The opening prompt rides a command line typed into a shell: a fixed text,
// so anything a shell would interpret means the text changed and is refused.
const SAFE_PROMPT = /^[^"$`%\\\r\n!]*$/;

function dispatchCommand({ agent = null, model = null, prompt = null, c = config }: { agent?: string | null; model?: string | null; prompt?: string | null; c?: Config } = {}): { agent: string; model: string | null; command: string; typesPrompt: boolean } {
  const kind: string = agent || c.termhub.agent || 'claude';
  if (!AGENTS.includes(kind)) throw new Error(`dispatch agent must be ${AGENTS.join(' or ')}, not "${kind}"`);
  const chosen = model || c.termhub.model || null;
  let line: string;
  if (kind === 'claude') {
    line = String(c.termhub.claudeCommand).trim();
    if (agentOf(line) !== 'claude') throw new Error(`PA_CLAUDE_COMMAND must start claude, not "${line.split(/\s/)[0]}"`);
  } else {
    line = 'opencode --auto';
  }
  const arg = modelArg(kind, chosen);
  if (arg) {
    if (hasFlag(line, '--model', '-m')) throw new Error('a dispatch model is set and PA_CLAUDE_COMMAND already has --model — keep one');
    line += ` --model ${arg}`;
  }
  if (kind === 'opencode' && prompt) {
    if (!SAFE_PROMPT.test(prompt)) throw new Error('the opening prompt cannot be put on an opencode command line');
    line += ` --prompt "${prompt}"`;
  }
  return { agent: kind, model: arg, command: line, typesPrompt: kind === 'claude' };
}

module.exports = { dispatchCommand };
