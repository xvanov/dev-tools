'use strict';

// The agent CLIs pa starts in termhub — `claude` or `opencode` — and how a
// model string becomes that CLI's `--model`. Pure; shared by the PA chat
// (src/chat/agent.js) and dispatched runs (src/dispatch/agent.js).
//
// The two CLIs read model strings differently:
//   claude    a Claude id. `cli/…`, `anthropic/…` and bare names all mean that
//             id; any other provider is refused — Claude Code cannot run it.
//   opencode  opencode's own `provider/model` (its providers are configured in
//             opencode — `opencode auth login` — not in pa's .env). Passed
//             through verbatim; a bare name or `cli/…` is refused.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('./repo/types.ts').Row;
type Db = import('./repo/types.ts').Db;

const { parseModel } = require('./models.ts');

const AGENTS = ['claude', 'opencode'];

// Nothing that a shell would read as more than one word. The command line is
// typed by termhub into a shell; a model string must not be able to add to it.
// Nor may it start with `-`: after `--model` the CLI would read it as a flag.
const SAFE_MODEL = /^[A-Za-z0-9._:@/+][A-Za-z0-9._:@/+-]*$/;

/** The agent a command line starts: 'claude' | 'opencode' | null. */
function agentOf(command: unknown) {
  const first = String(command || '').trim().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  if (!first) return null;
  const tok = first[1] || first[2] || first[3] || '';
  const base = (tok.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd)$/, '');
  return AGENTS.includes(base) ? base : null;
}

function hasFlag(command: unknown, ...flags: string[]) {
  return flags.some((f) => new RegExp(`(^|\\s)${f.replace(/[-]/g, '\\-')}(\\s|=|$)`).test(String(command)));
}

/** The value for `--model` on this agent, or throws naming what is wrong. */
function modelArg(agent: unknown, model: string) {
  if (!model) return null;
  const value = String(model).trim();
  if (!SAFE_MODEL.test(value)) throw new Error(`model "${value}" has characters a command line cannot carry`);
  if (agent === 'claude') {
    const m = parseModel(value);
    if (!['auto', 'cli', 'anthropic'].includes(m.provider)) {
      throw new Error(`claude runs Claude models only, not ${value} — use the opencode agent for that provider`);
    }
    return m.model;
  }
  if (agent === 'opencode') {
    const slash = value.indexOf('/');
    if (slash < 1) throw new Error(`opencode needs provider/model, not "${value}"`);
    if (value.slice(0, slash).toLowerCase() === 'cli') throw new Error(`opencode cannot run ${value}: cli/ is pa's claude -p backend`);
    return value;
  }
  throw new Error(`unknown agent "${agent}" — use ${AGENTS.join(' or ')}`);
}

module.exports = { AGENTS, SAFE_MODEL, agentOf, hasFlag, modelArg };
