'use strict';

// Settings per agent (docs/native/BUILD-ENRICHMENT.md, B): one place that says what each agent runs
// with, and the only code that changes it. The dashboard's Agents page (/agents), the chat tools
// (profile_*, agent_settings_*) and `pa profile` / `pa agents` all call this, so none of them can do
// something the others cannot.
//
//   Build profiles   src/build/profiles.ts, table build_profile (a saved, named Build agent)
//   PA chat model    the `agent.settings` setting, chatModel; env PA_CHAT_MODEL is the default
//   pass models      the same setting, passModels; each pass's env variable (src/models.ts PURPOSES) is the default
//
// Env stays the fallback: a field without a stored override is what env or the built-in default says,
// and `source` on every value says which (store | env | default). Writes are validated here (known
// models, effort and permission-mode lists, caps > 0, provider/model strings for passes).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('./types.ts').Json;

const fs = require('fs');
const path = require('path');

const profiles = () => require('./build/profiles.ts');
const models = () => require('./models.ts');

/** The stored `build.mcp` registry's names: the MCP servers a profile may list. */
async function mcpNames(): Promise<string[]> {
  const row = await require('./repo').system.setting('build.mcp').catch(() => null);
  const v = row?.value && typeof row.value === 'object' ? row.value : {};
  return Object.keys(v);
}

/** The read-only base of every Build agent's prompt; a profile's own text is appended after it. */
function basePrompt(): string {
  try {
    return fs.readFileSync(path.join(require('./config.ts').config.toolDir, 'src', 'build', 'agent-prompt.md'), 'utf8');
  } catch {
    return '';
  }
}

/** What the Agents page and `pa agents get` show: every Build profile, the chat, the passes, and the lists a form needs. */
async function get(): Promise<Json> {
  await models().refresh({ force: true });
  const B = require('./build/index.ts');
  const P = profiles();
  const v = await P.view();
  const { chat, passes } = models().effective();
  return {
    profiles: v.profiles,
    missingSeeds: v.missingSeeds,
    chat,
    passes,
    options: {
      models: P.MODELS,
      subagentModels: [...P.MODELS, 'inherit'],
      efforts: P.EFFORTS,
      permissionModes: P.PERMISSION_MODES,
      mcpServers: await mcpNames(),
      providers: models().PROVIDERS,
      buildDefaults: B.DEFAULTS(),
      basePrompt: basePrompt(),
    },
  };
}

/** One profile, with the marks (seed, modified) and, for a seed, what it ships as. */
async function getProfile(name: string): Promise<Json> {
  const P = profiles();
  const p = await P.need(name);
  return { ...P.describe(p), default: P.seedOf(p.name) };
}

/** Creates or changes a profile (only the fields in `patch`); returns it as getProfile does. */
async function setProfile(name: string, patch: Json): Promise<Json> {
  const p = await profiles().update(name, patch);
  return getProfile(p.name);
}

async function deleteProfile(name: string): Promise<Json> {
  const n = String(name || '').trim().toLowerCase();
  // The planner names research, feature and chore by kind (profileForKind), and a run asking for a missing
  // profile is a 400: deleting a built-in one would break planner-started runs. Edit it or reset it instead.
  if (profiles().seedOf(n)) throw Object.assign(new Error(`"${n}" is a built-in profile and the planner uses it: edit it, or \`reset\` it to what ships (only profiles you made can be deleted)`), { status: 400 });
  const ok = await profiles().remove(n);
  if (!ok) throw Object.assign(new Error(`no profile "${n}"`), { status: 404 });
  return { deleted: n, note: null };
}

async function resetProfile(name: string): Promise<Json> {
  const p = await profiles().reset(name);
  return getProfile(p.name);
}

/** Sets the chat model and/or pass models ({chatModel?, passModels?: {pass: model | null}}); null clears an override. */
async function setAgents(patch: Json): Promise<Json> {
  const keys = Object.keys(patch || {}).filter((k) => !['chatModel', 'passModels'].includes(k));
  if (keys.length) throw Object.assign(new Error(`not a setting: ${keys.join(', ')} (chatModel, passModels)`), { status: 400 });
  if (patch.chatModel === undefined && patch.passModels === undefined) throw Object.assign(new Error('nothing to set: give chatModel and/or passModels'), { status: 400 });
  await models().save(patch);
  const { chat, passes } = models().effective();
  return { chat, passes };
}

/** The same as get() for the chat tool, without the long lists (the base prompt and the full profiles). */
async function summary(): Promise<Json> {
  const v = await get();
  return {
    profiles: v.profiles.map((p: Json) => profileLine(p)),
    chat: v.chat,
    passes: v.passes,
  };
}

/** Pure. One profile as a short row: what a list shows. */
function profileLine(p: Json): Json {
  return {
    name: p.name, description: p.description, model: p.model, effort: p.effort, permission_mode: p.permissionMode,
    cost_cap_usd: p.costCapUsd, wall_cap_min: p.wallCapMin, idle_after_s: p.idleAfterS,
    mcp: p.tools.mcp, subagents: p.subagents.map((s: Json) => s.name), repo: p.repoPath, seed: p.seed, modified: p.modified,
  };
}

module.exports = { get, summary, getProfile, setProfile, deleteProfile, resetProfile, setAgents, profileLine, basePrompt, mcpNames };
