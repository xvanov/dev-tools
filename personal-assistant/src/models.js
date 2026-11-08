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

const { config, secret } = require('./config.ts');

const COMPAT = ['openai', 'azure', 'openrouter', 'deepseek', 'local'];
const PROVIDERS = ['anthropic', 'cli', ...COMPAT];

function parseModel(value) {
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

function capabilities(provider) {
  if (provider === 'auto' || provider === 'cli') return ['text', 'json', 'toolCalls'];
  return ['text', 'json'];
}

// The secret each provider needs; null when it needs none. Read lazily, and
// only its presence ever leaves this module.
const KEY_NAMES = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY', 'AZURE_FOUNDRY_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  local: null,
};

function providerKey(provider, read = secret) {
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
function route(value, { needs = 'text', hasAnthropicKey = Boolean(config.anthropic.apiKey), envName = null } = {}) {
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
function parsePrices(text) {
  const out = {};
  for (const entry of String(text || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.+?)=([\d.]+):([\d.]+)$/.exec(entry);
    if (!m) continue;
    const inp = Number(m[2]);
    const outp = Number(m[3]);
    if (Number.isFinite(inp) && Number.isFinite(outp)) out[m[1].trim().toLowerCase()] = [inp, outp];
  }
  return out;
}

// ----------------------------------------------------------- purposes ----

// Every pass that calls a model, the variable that picks its model, and what
// it needs. `get` reads the resolved value from config, so the precedence
// (own variable, PA_MODEL, built-in default) lives in one place: config.js.
const PURPOSES = [
  { key: 'distill', env: 'PA_DISTILL_MODEL', needs: 'json', get: (c) => c.anthropic.model, what: 'commitments from each item' },
  { key: 'connector', env: 'PA_CONNECTOR_MODEL', needs: 'toolCalls', get: (c) => c.m365.connectorModel, what: 'Microsoft 365 / Jira connector relay' },
  { key: 'memory-extract', env: 'PA_MEMORY_EXTRACT_MODEL', needs: 'json', get: (c) => c.memory.extractModel, what: 'claims from items' },
  { key: 'memory-decide', env: 'PA_MEMORY_DECIDE_MODEL', needs: 'json', get: (c) => c.memory.decideModel, what: 'consolidation, dream, notes, recall planning' },
  { key: 'memory-page', env: 'PA_MEMORY_PAGE_MODEL', needs: 'text', get: (c) => c.memory.pageModel, what: 'people and project pages' },
  { key: 'brief', env: 'PA_BRIEF_MODEL', needs: 'text', get: (c) => c.meetings.model, what: 'pre-meeting briefs' },
  { key: 'brief-classify', env: 'PA_BRIEF_CLASSIFY_MODEL', needs: 'json', get: (c) => c.meetings.classifyModel, what: 'meeting kind' },
  { key: 'debrief', env: 'PA_DEBRIEF_MODEL', needs: 'json', get: (c) => c.meetings.debriefModel, what: 'post-meeting debriefs' },
  { key: 'reply-close', env: 'PA_REPLY_CLOSE_MODEL', needs: 'json', get: (c) => c.replyClose.model, what: 'closing asks on my replies' },
  { key: 'reconcile', env: 'PA_RECONCILE_MODEL', needs: 'json', get: (c) => c.reconcile.model, what: 'closing on newer evidence' },
  { key: 'card-context', env: 'PA_CARD_CONTEXT_MODEL', needs: 'text', get: (c) => c.cardContext.model, what: 'dashboard card paragraphs' },
  { key: 'repo-profile', env: 'PA_REPO_PROFILE_MODEL', needs: 'json', get: (c) => c.repos.profileModel, what: 'what each repo is (registry)' },
  { key: 'planner', env: 'PA_PLANNER_MODEL', needs: 'json', get: (c) => c.planner.model, what: 'what to do with each new ask' },
  { key: 'draft', env: 'PA_DRAFT_MODEL', needs: 'text', get: (c) => c.drafts.model, what: 'reply drafts' },
  { key: 'routine', env: 'PA_ROUTINE_MODEL', needs: 'text', get: (c) => c.routines.model, what: 'routines: parse, reports, suggestions' },
  { key: 'eval', env: 'PA_EVAL_MODEL', needs: 'json', get: (c) => c.eval.model, what: 'retrieval evals' },
  { key: 'fast-lane', env: 'PA_FAST_MODEL', needs: 'text', get: (c) => c.fastLane.model, what: 'voice fast lane: quick replies and routing' },
  { key: 'fast-lane-fallback', env: 'PA_FAST_FALLBACK_MODEL', needs: 'text', get: (c) => c.fastLane.fallback, what: 'voice fast lane when the local model is down or slow' },
];

function purpose(key) {
  const p = PURPOSES.find((x) => x.key === key);
  if (!p) throw new Error(`unknown model purpose "${key}"`);
  return p;
}

/** The model string configured for a purpose. */
function modelFor(key, c = config) {
  return purpose(key).get(c);
}

/**
 * One row per purpose for `pa doctor`: { purpose, env, model, backend,
 * needs, capable, keyConfigured, ok, problem }. Never throws; a bad string
 * is a row with a problem. `claudeAvailable` says whether `claude` runs here
 * (the CLI backend's only requirement).
 */
function report({ c = config, claudeAvailable = true, read = secret } = {}) {
  const hasAnthropicKey = Boolean(c.anthropic.apiKey);
  return PURPOSES.map((p) => {
    const model = p.get(c);
    const row = { purpose: p.key, env: p.env, needs: p.needs, model, backend: null, capable: false, keyConfigured: false, ok: false, problem: null };
    let r;
    try {
      r = route(model, { needs: p.needs, hasAnthropicKey, envName: p.env });
    } catch (err) {
      row.problem = err.message;
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

module.exports = { PROVIDERS, COMPAT, PURPOSES, KEY_NAMES, parseModel, capabilities, route, providerKey, parsePrices, purpose, modelFor, report };
