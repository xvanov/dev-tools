'use strict';

// Which model, on which provider, for which pass — and whether that provider
// can do what the pass needs. Pure apart from reading config; src/llm.js makes
// the calls, `pa doctor` prints `report()`.
//
// A model string is `provider/model` or a bare name:
//
//   claude-sonnet-5-5             bare: today's meaning — the Anthropic API when
//                                 ANTHROPIC_API_KEY is set, else `claude -p`
//   anthropic/claude-sonnet-5-5   the Anthropic API, always (needs the key)
//   cli/claude-opus-5             a headless `claude -p`, always
//   azure/gpt-5.4                 Azure OpenAI; the part after `azure/` is the deployment
//   openai/gpt-5.4                api.openai.com (or OPENAI_BASE_URL)
//   openrouter/deepseek/deepseek-v4   OpenRouter; everything after the first `/` is its id
//   deepseek/deepseek-chat        DeepSeek's own API
//   local/qwen3:32b               any OpenAI-compatible server at PA_LOCAL_LLM_URL
//
// Only the first segment is the provider, so a model id may hold slashes. A
// prefix that is not a provider is an error, not a bare name: a typo must not
// quietly become a `claude -p --model azur/gpt` call.
//
// Capabilities are what a pass may ask of a backend:
//   text       a reply in prose
//   json       a reply the pass parses as JSON (every backend: llm.extractJson
//              reads it out of the text)
//   toolCalls  calls to the claude.ai connectors (Microsoft 365, Atlassian) —
//              only Claude Code holds those logins, so only `claude -p` can
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Config = import('./types.ts').Config;
type Json = import('./types.ts').Json;
type ReadSecret = (name: string) => string | null | undefined;
/** A pass that calls a model: its variable, what it needs, and where config holds the resolved value. */
type Purpose = { key: string; env: string; needs: string; get: (c: Config) => string; set: (c: Config, v: string) => void; what: string };
type ReportRow = { purpose: string; env: string; needs: string; model: string; backend: string | null; capable: boolean; keyConfigured: boolean; ok: boolean; problem: string | null };

const { config, secret } = require('./config.ts');

const COMPAT = ['openai', 'azure', 'openrouter', 'deepseek', 'local'];
const PROVIDERS = ['anthropic', 'cli', ...COMPAT];

function parseModel(value: string) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('empty model string');
  const slash = raw.indexOf('/');
  if (slash < 0) return { raw, provider: 'auto', model: raw };
  const provider = raw.slice(0, slash).toLowerCase();
  const model = raw.slice(slash + 1).trim();
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`unknown provider "${raw.slice(0, slash)}" in model "${raw}" — use one of ${PROVIDERS.join(', ')}, or a bare Claude model name`);
  }
  if (!model) throw new Error(`model "${raw}" names a provider but no model`);
  return { raw, provider, model };
}

function capabilities(provider: unknown) {
  if (provider === 'auto' || provider === 'cli') return ['text', 'json', 'toolCalls'];
  return ['text', 'json'];
}

// The secret each provider needs; null when it needs none. Read lazily, and
// only its presence ever leaves this module.
const KEY_NAMES: Record<string, string[] | null> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY', 'AZURE_FOUNDRY_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  local: null,
};

function providerKey(provider: string, read: ReadSecret = secret) {
  if (provider === 'anthropic') return config.anthropic.apiKey || read('ANTHROPIC_API_KEY');
  if (provider === 'azure' && config.embeddings.apiKey) return config.embeddings.apiKey;
  if (provider === 'local') return read('PA_LOCAL_LLM_API_KEY') || null;
  for (const name of KEY_NAMES[provider] || []) {
    const v = read(name);
    if (v) return v;
  }
  return null;
}

/**
 * Where a call on this model string goes. `backend` is what `llm_spend`
 * records: 'api' (Anthropic) | 'cli' | an OpenAI-compatible provider's name.
 * `needs` is the capability the caller requires; a backend without it throws
 * here, before any call is made, naming the variable to change.
 */
function route(value: string, { needs = 'text', hasAnthropicKey = Boolean(config.anthropic.apiKey), envName = null }: { needs?: string; hasAnthropicKey?: unknown; envName?: unknown } = {}) {
  const m = parseModel(value);
  const caps = capabilities(m.provider);
  if (!caps.includes(needs)) {
    throw new Error(
      `${envName ? `${envName}=` : 'model '}${m.raw} cannot make connector tool calls: only Claude Code reaches the ` +
        `claude.ai connectors — use cli/<claude model> or a bare Claude model name`
    );
  }
  let backend;
  if (m.provider === 'auto') backend = needs === 'toolCalls' || !hasAnthropicKey ? 'cli' : 'api';
  else if (m.provider === 'anthropic') backend = 'api';
  else backend = m.provider;
  return { ...m, backend, caps };
}

// ------------------------------------------------------------- prices ----

// `azure/gpt-5.4=1.25:10,deepseek/deepseek-chat=0.28:0.42` → { id: [in, out] }.
// A malformed entry is skipped, not guessed at.
function parsePrices(text: string) {
  const out: Record<string, [number, number]> = {};
  for (const entry of String(text || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.+?)=([\d.]+):([\d.]+)$/.exec(entry);
    if (!m) continue;
    const inp = Number(m[2]);
    const outp = Number(m[3]);
    if (Number.isFinite(inp) && Number.isFinite(outp)) out[m[1]!.trim().toLowerCase()] = [inp, outp];
  }
  return out;
}

// ----------------------------------------------------------- purposes ----

// Every pass that calls a model, the variable that picks its model, and what
// it needs. `get` reads the resolved value from config, so the precedence
// (own variable, PA_MODEL, built-in default) lives in one place: config.js.
// `at` makes the getter and setter of one config path, so a store override (below) can be written
// to the same field the pass reads.
const at = (path: string): Pick<Purpose, 'get' | 'set'> => {
  const [a, b] = path.split('.') as [string, string];
  return {
    get: (c) => (c as Record<string, Record<string, string>>)[a]![b]!,
    set: (c, v) => { (c as Record<string, Record<string, string>>)[a]![b] = v; },
  };
};
const PURPOSES: Purpose[] = [
  { key: 'distill', env: 'PA_DISTILL_MODEL', needs: 'json', ...at('anthropic.model'), what: 'commitments from each item' },
  { key: 'connector', env: 'PA_CONNECTOR_MODEL', needs: 'toolCalls', ...at('m365.connectorModel'), what: 'Microsoft 365 / Jira connector relay' },
  { key: 'memory-extract', env: 'PA_MEMORY_EXTRACT_MODEL', needs: 'json', ...at('memory.extractModel'), what: 'claims from items' },
  { key: 'memory-decide', env: 'PA_MEMORY_DECIDE_MODEL', needs: 'json', ...at('memory.decideModel'), what: 'consolidation, dream, notes, recall planning' },
  { key: 'memory-page', env: 'PA_MEMORY_PAGE_MODEL', needs: 'text', ...at('memory.pageModel'), what: 'people and project pages' },
  { key: 'brief', env: 'PA_BRIEF_MODEL', needs: 'text', ...at('meetings.model'), what: 'pre-meeting briefs' },
  { key: 'brief-classify', env: 'PA_BRIEF_CLASSIFY_MODEL', needs: 'json', ...at('meetings.classifyModel'), what: 'meeting kind' },
  { key: 'debrief', env: 'PA_DEBRIEF_MODEL', needs: 'json', ...at('meetings.debriefModel'), what: 'post-meeting debriefs' },
  { key: 'reply-close', env: 'PA_REPLY_CLOSE_MODEL', needs: 'json', ...at('replyClose.model'), what: 'closing asks on my replies' },
  { key: 'reconcile', env: 'PA_RECONCILE_MODEL', needs: 'json', ...at('reconcile.model'), what: 'closing on newer evidence' },
  { key: 'card-context', env: 'PA_CARD_CONTEXT_MODEL', needs: 'text', ...at('cardContext.model'), what: 'dashboard card paragraphs' },
  { key: 'repo-profile', env: 'PA_REPO_PROFILE_MODEL', needs: 'json', ...at('repos.profileModel'), what: 'what each repo is (registry)' },
  { key: 'planner', env: 'PA_PLANNER_MODEL', needs: 'json', ...at('planner.model'), what: 'what to do with each new ask' },
  { key: 'draft', env: 'PA_DRAFT_MODEL', needs: 'text', ...at('drafts.model'), what: 'reply drafts' },
  { key: 'routine', env: 'PA_ROUTINE_MODEL', needs: 'text', ...at('routines.model'), what: 'routines: parse, reports, suggestions' },
  { key: 'eval', env: 'PA_EVAL_MODEL', needs: 'json', ...at('eval.model'), what: 'retrieval evals' },
  { key: 'fast-lane', env: 'PA_FAST_MODEL', needs: 'text', ...at('fastLane.model'), what: 'voice fast lane: quick replies and routing' },
  { key: 'fast-lane-fallback', env: 'PA_FAST_FALLBACK_MODEL', needs: 'text', ...at('fastLane.fallback'), what: 'voice fast lane when the local model is down or slow' },
];

function purpose(key: number | string) {
  const p = PURPOSES.find((x) => x.key === key);
  if (!p) throw new Error(`unknown model purpose "${key}"`);
  return p;
}

/** The model string configured for a purpose. */
function modelFor(key: number | string, c: Config = config) {
  return purpose(key).get(c);
}

/**
 * One row per purpose for `pa doctor`: { purpose, env, model, backend,
 * needs, capable, keyConfigured, ok, problem }. Never throws; a bad string
 * is a row with a problem. `claudeAvailable` says whether `claude` runs here
 * (the CLI backend's only requirement).
 */
function report({ c = config, claudeAvailable = true, read = secret }: { c?: Config; claudeAvailable?: boolean; read?: ReadSecret } = {}) {
  const hasAnthropicKey = Boolean(c.anthropic.apiKey);
  return PURPOSES.map((p) => {
    const model = p.get(c);
    const row: ReportRow = { purpose: p.key, env: p.env, needs: p.needs, model, backend: null, capable: false, keyConfigured: false, ok: false, problem: null };
    let r;
    try {
      r = route(model, { needs: p.needs, hasAnthropicKey, envName: p.env });
    } catch (err) {
      row.problem = (err as Error).message;
      return row;
    }
    row.backend = r.backend;
    row.capable = true;
    if (r.backend === 'cli') {
      row.keyConfigured = true; // rides the Claude Code login
      if (!claudeAvailable) row.problem = `${c.claudeBin} not found — set PA_CLAUDE_BIN`;
    } else if (r.backend === 'local') {
      row.keyConfigured = true;
    } else {
      row.keyConfigured = Boolean(providerKey(r.provider === 'auto' ? 'anthropic' : r.provider, read));
      if (!row.keyConfigured) row.problem = `no key — set ${(KEY_NAMES[r.provider === 'auto' ? 'anthropic' : r.provider] || []).join(' or ')}`;
      if (r.backend === 'azure' && !c.providers.azure.endpoint) row.problem = 'no endpoint — set AZURE_OPENAI_ENDPOINT or PA_AZURE_CHAT_ENDPOINT';
    }
    row.ok = !row.problem;
    return row;
  });
}

// ------------------------------------------------- store overrides ----
//
// Env stays the default. The dashboard's Agents page (and `pa agents set`, the chat's
// agent_settings_set) writes overrides to the `agent.settings` setting:
//   { chatModel?: string, passModels?: { <purpose key>: <model string> } }
// A pass reads its model from `config` (config.drafts.model, …) at call time, so an override is
// applied by writing the same field, once the store is read: refresh() does that, at most every
// TTL_MS, and the worker calls it before every pass (src/util/exclusive.ts `before`) and `pa`
// before every command that has a store. The env/default value of each field is captured the first
// time, so clearing an override puts it back. refresh() never throws: a store that cannot be read
// keeps the last overrides (none at first), which is today's env-only behaviour.

const SETTING = 'agent.settings';
const TTL_MS = 10_000;
type Stored = { chatModel?: string; passModels?: Record<string, string> };
const CHAT = 'chat';
const baseline = new WeakMap<object, Record<string, string>>();
let stored: Stored = {};
let loadedAt = 0;
let inflight: Promise<void> | null = null;

/** Pure. The setting's value (an object, or its JSON text) as overrides; anything unknown is dropped. */
function parseStored(v: unknown): Stored {
  let o: unknown = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  if (!o || typeof o !== 'object') return {};
  const raw = o as Stored;
  const out: Stored = {};
  if (typeof raw.chatModel === 'string' && raw.chatModel.trim()) out.chatModel = raw.chatModel.trim();
  if (raw.passModels && typeof raw.passModels === 'object') {
    const m: Record<string, string> = {};
    for (const [k, val] of Object.entries(raw.passModels)) {
      if (PURPOSES.some((p) => p.key === k) && typeof val === 'string' && val.trim()) m[k] = val.trim();
    }
    if (Object.keys(m).length) out.passModels = m;
  }
  return out;
}

/** What each field held before any override: env, PA_MODEL or the built-in default. Captured once per config object. */
function baselineOf(c: Config): Record<string, string> {
  let b = baseline.get(c);
  if (!b) {
    b = {};
    for (const p of PURPOSES) b[p.key] = p.get(c);
    b[CHAT] = (c.chat && c.chat.model) || '';
    baseline.set(c, b);
  }
  return b;
}

/** Writes the overrides into `c` (the fields the passes and the chat read); a field without one gets its baseline back. */
function applyStored(s: Stored, c: Config = config): void {
  const b = baselineOf(c);
  for (const p of PURPOSES) p.set(c, s.passModels?.[p.key] ?? (b[p.key] as string));
  if (c.chat) c.chat.model = s.chatModel ?? (b[CHAT] || null);
}

/** Reads the store's overrides (at most every TTL_MS unless `force`) and applies them. Never throws. */
async function refresh({ force = false }: { force?: boolean } = {}): Promise<void> {
  if (!force && Date.now() - loadedAt < TTL_MS) return;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const row = await require('./repo').system.setting(SETTING);
      stored = parseStored(row?.value);
      applyStored(stored);
    } catch {
      /* keep what is applied */
    } finally {
      loadedAt = Date.now();
      inflight = null;
    }
  })();
  return inflight;
}

/** The overrides in force (as of the last refresh or save). */
function overrides(): Stored { return stored; }

/** Pure. A pass's model string checked: a known provider, a capable backend. Returns the trimmed value or throws a 400. */
function checkPassModel(key: string, value: unknown): string {
  const p = PURPOSES.find((x) => x.key === key);
  const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
  if (!p) throw bad(`unknown pass "${key}" (known: ${PURPOSES.map((x) => x.key).join(', ')})`);
  const v = String(value ?? '').trim();
  try {
    route(v, { needs: p.needs, envName: p.env });
  } catch (err) {
    throw bad((err as Error).message);
  }
  return v;
}

/** Pure. The chat's model checked for the agent the chat runs (claude: Claude models; opencode: provider/model). */
function checkChatModel(value: unknown, agent: string | null = config.chat.agent): string {
  const v = String(value ?? '').trim();
  const kind = agent || 'claude';
  try {
    require('./agentCli.ts').modelArg(kind, v);
  } catch (err) {
    throw Object.assign(new Error((err as Error).message), { status: 400 });
  }
  return v === 'fable' && kind === 'claude' ? 'claude-fable-5-2' : v;
}

/** Stores a patch ({chatModel?, passModels?: {key: model | null}}; null or '' clears one) and applies it now. Returns the overrides. */
async function save(patch: { chatModel?: string | null; passModels?: Record<string, string | null> }): Promise<Stored> {
  const next: Stored = { ...parseStored(stored) };
  if (patch.chatModel !== undefined) {
    if (patch.chatModel === null || String(patch.chatModel).trim() === '') delete next.chatModel;
    else next.chatModel = checkChatModel(patch.chatModel);
  }
  if (patch.passModels !== undefined) {
    if (typeof patch.passModels !== 'object' || patch.passModels === null) throw Object.assign(new Error('passModels is {pass: model}'), { status: 400 });
    const m = { ...(next.passModels || {}) };
    for (const [k, v] of Object.entries(patch.passModels)) {
      if (v === null || String(v).trim() === '') {
        if (!PURPOSES.some((p) => p.key === k)) throw Object.assign(new Error(`unknown pass "${k}" (known: ${PURPOSES.map((x) => x.key).join(', ')})`), { status: 400 });
        delete m[k];
      } else m[k] = checkPassModel(k, v);
    }
    if (Object.keys(m).length) next.passModels = m; else delete next.passModels;
  }
  await require('./repo').system.setSetting(SETTING, JSON.stringify(next));
  stored = next;
  loadedAt = Date.now();
  applyStored(stored);
  return stored;
}

/**
 * The Agents page's and `pa agents get`'s view: per pass and for the chat, the effective model, where it
 * comes from (store | env | default) and what it would be without the override.
 */
function effective(c: Config = config): { chat: Json; passes: Json[] } {
  const b = baselineOf(c);
  const { env } = require('./config.ts');
  const noGlobal = ['connector', 'fast-lane', 'fast-lane-fallback'];
  const envSet = (name: string, global: boolean) => Boolean(env(name) || (global && env('PA_MODEL')));
  const passes = PURPOSES.map((p) => {
    const ov = stored.passModels?.[p.key];
    return {
      key: p.key, env: p.env, needs: p.needs, what: p.what,
      model: p.get(c), source: ov ? 'store' : envSet(p.env, !noGlobal.includes(p.key)) ? 'env' : 'default', default: b[p.key],
    };
  });
  const chat = {
    model: c.chat.model || null, source: stored.chatModel ? 'store' : env('PA_CHAT_MODEL') ? 'env' : 'default', default: b[CHAT] || null,
    env: 'PA_CHAT_MODEL', note: "applies when the chat session next starts; empty is Claude Code's own default",
  };
  return { chat, passes };
}

/** For tests: forget what was read and applied. */
function resetOverrides(): void { stored = {}; loadedAt = 0; inflight = null; }

module.exports = {
  PROVIDERS, COMPAT, PURPOSES, KEY_NAMES, parseModel, capabilities, route, providerKey, parsePrices, purpose, modelFor, report,
  SETTING, parseStored, applyStored, refresh, overrides, checkPassModel, checkChatModel, save, effective, resetOverrides,
};
