'use strict';

// Every knob the assistant has, resolved once, in one place.
//
// Two rules govern what lives here:
//
//  - **Nothing secret has a default.** A missing `AZURE_OPENAI_API_KEY` must surface
//    as "embeddings are not configured" in `pa doctor`, never as a confusing
//    401 from a worker three layers down. Secrets resolve to `null` and the
//    feature that needs them reports itself unconfigured.
//  - **Everything non-secret has a working default**, so `pa doctor` on a fresh
//    clone tells you what is missing rather than crashing on a missing env var.
//
// `.env` is read from this tool's directory and from the repo root, in that
// order, because `summarize-recording` already documents a repo-root `.env` and
// the Azure keys are shared with it. Real environment variables always win over
// both — a file on disk must never shadow what the operator exported.

const fs = require('fs');
const os = require('os');
const path = require('path');

// OS-specific defaults (data dir, repos root, venv layout, Teams cache, how
// backups reach pg_dump) come from the platform layer, not from inline
// `process.platform` tests.
const platform = require('./platform');

const TOOL_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TOOL_DIR, '..');

function parseEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

// Loaded once at require time. Later files do not override earlier ones, and
// neither overrides process.env.
const fileEnv = {
  ...parseEnvFile(path.join(REPO_ROOT, '.env')),
  ...parseEnvFile(path.join(TOOL_DIR, '.env')),
};

// `~` and %VAR% so the same `.env` line works typed by hand.
function expandHome(p) {
  if (!p) return '';
  return path.resolve(
    String(p)
      .replace(/^~(?=$|[\\/])/, os.homedir())
      .replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m)
  );
}

function env(name, fallback = null) {
  const v = process.env[name] ?? fileEnv[name];
  if (v === undefined || v === null || v === '') return fallback;
  return v;
}

function envInt(name, fallback) {
  const v = env(name);
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function defaultDataDir() {
  return platform.defaults.dataDir();
}

// Other machines a run can be dispatched to (src/dispatch/remote.js) and
// commands run on (src/dispatch/exec.js), each with its own termhub and its
// own repos root, and optionally its OS:
//   PA_MACHINES=mv-automated-vm=http://mv-automated-vm.example.ts.net:7000|C:\source
//   PA_MACHINES=lab=http://lab.example.ts.net:7000|/home/k/repos|linux
// Comma-separated for more than one. A machine not listed here is unknown.
// The OS (windows | linux | macos) is optional: without it, it is what that
// termhub reports (`/api/info` platform), else read off the repos root's shape.
const MACHINE_OS = { windows: 'windows', win32: 'windows', win: 'windows', linux: 'linux', macos: 'macos', darwin: 'macos', mac: 'macos' };

function parseMachines(text) {
  const machines = {};
  for (const entry of String(text || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^=]+)=([^|]+)\|([^|]+?)(?:\|([^|]*))?$/.exec(entry);
    if (!m) throw new Error(`PA_MACHINES: cannot read "${entry}" — want name=termhubUrl|reposRoot[|os]`);
    const machine = { name: m[1].trim(), url: m[2].trim().replace(/\/+$/, ''), reposRoot: m[3].trim() };
    if (m[4] != null && m[4].trim()) {
      const os = MACHINE_OS[m[4].trim().toLowerCase()];
      if (!os) throw new Error(`PA_MACHINES: "${m[4].trim()}" is not an OS — one of windows, linux, macos`);
      machine.os = os;
    }
    machines[machine.name] = machine;
  }
  return machines;
}

function defaultReposRoot() {
  return platform.defaults.reposRoot();
}

// The Teams cache reader runs by default only where the platform has the new
// Teams desktop client (Windows). Elsewhere it runs only when you point
// PA_TEAMS_CACHE_DIR at a cache yourself — and never when PA_TEAMS_CACHE=0.
const teamsCacheDir = env('PA_TEAMS_CACHE_DIR', platform.defaults.teamsCacheDir());

const dataDir = env('PA_DATA_DIR', defaultDataDir());

// A pass's model: its own variable, else PA_MODEL (one default for every
// text/JSON pass), else the pass's built-in default. A value is a model
// string, `provider/model` or a bare Claude name (src/models.js parses it).
// The connector relay does not read PA_MODEL: it must stay on Claude Code.
function modelEnv(name, fallback) {
  return env(name) || env('PA_MODEL') || fallback;
}
const distillModel = modelEnv('PA_DISTILL_MODEL', 'claude-opus-5');
const reconcileModel = modelEnv('PA_RECONCILE_MODEL', 'claude-sonnet-5-5');

const config = {
  toolDir: TOOL_DIR,
  repoRoot: REPO_ROOT,
  dataDir,

  // Where audio, token caches and worktrees land. All rebuildable except the
  // token cache, which is a credential and is treated as one (see auth/store).
  audioDir: env('PA_AUDIO_DIR', path.join(dataDir, 'audio')),
  worktreesRoot: env('PA_WORKTREES_ROOT', path.join(dataDir, 'worktrees')),
  reposRoot: env('PA_REPOS_ROOT', defaultReposRoot()),

  databaseUrl: env('PA_DATABASE_URL', 'postgres://pa:pa@127.0.0.1:5433/pa'),
  // The store (plan 3.1, D2): postgres (the default until the 3.5 cutover) or
  // sqlite, one file per stack at PA_SQLITE_PATH (src/db/sqlite.js). With
  // PA_SQLITE_KEY set the file is encrypted (SQLCipher); the key belongs in the
  // OS vault or the gitignored .env, never in a commit.
  db: env('PA_DB', 'postgres'),
  sqlitePath: env('PA_SQLITE_PATH', path.join(dataDir, 'pa.sqlite')),
  sqliteKey: env('PA_SQLITE_KEY', ''),

  // Mail, calendar and Teams through the claude.ai Microsoft 365 connector via
  // `claude -p` — no app registration, no Graph token. Connect it once with
  // `/mcp` in Claude Code. Each pass is a headless session, so these polls are
  // minutes, not seconds.
  m365: {
    enabled: env('PA_M365', '1') !== '0',
    pollSeconds: envInt('PA_M365_POLL_SECONDS', 180),
    // Evenings and weekends: chat still arrives in seconds through the Teams
    // cache, so the connector pass (about $0.20 each) only needs to catch up.
    offHoursPollSeconds: envInt('PA_M365_OFF_HOURS_POLL_SECONDS', 1800),
    calendarPollSeconds: envInt('PA_M365_CALENDAR_POLL_SECONDS', 900),
    // The model that relays connector calls: it only picks the calls, results
    // are read verbatim (llm.toolCalls). Haiku was proven against a real
    // outlook_email_search (2026-11-06): $0.02 a call against Opus's $0.30.
    // Sonnet once made no tool calls at all headless — prove any other relay
    // against a real read before making it the default.
    connectorModel: env('PA_CONNECTOR_MODEL', 'claude-haiku-5-5'),
    // Channel posts: `mentions` (kept when they name you), `all`, or `off`.
    teamsChannels: env('PA_TEAMS_CHANNELS', 'mentions'),
  },

  // Teams in seconds, from the new Teams client's own IndexedDB cache on this
  // disk (src/ingest/teamsLocal.js). The connector still runs: it backfills
  // and upgrades what this reads. A missing cache or venv is a quiet no-op.
  teamsCache: {
    enabled: env('PA_TEAMS_CACHE', '1') !== '0' && Boolean(teamsCacheDir),
    // Why it is off on this platform when nobody turned it off (`pa doctor`).
    unsupported: teamsCacheDir ? null : platform.teamsCache.why,
    // A pass runs on a change notification for the cache directory, once
    // writes have been quiet for debounceMs (never more than maxWaitMs after
    // the first); the fallback poll catches what a notification missed, and
    // pollSeconds is the poll used while no watcher is armed (or with
    // PA_TEAMS_CACHE_WATCH=0). The reader stays resident unless
    // PA_TEAMS_CACHE_RESIDENT=0.
    watch: env('PA_TEAMS_CACHE_WATCH', '1') !== '0',
    debounceMs: envInt('PA_TEAMS_CACHE_DEBOUNCE_MS', 300),
    maxWaitMs: envInt('PA_TEAMS_CACHE_MAX_WAIT_MS', 1500),
    fallbackSeconds: envInt('PA_TEAMS_CACHE_FALLBACK_SECONDS', 60),
    pollSeconds: envInt('PA_TEAMS_CACHE_POLL_SECONDS', 5),
    resident: env('PA_TEAMS_CACHE_RESIDENT', '1') !== '0',
    dir: teamsCacheDir,
    // Its own venv, not the capture one: the reader is pinned to a forensic
    // library that is not on PyPI and must not be able to break capture.
    python: env('PA_TEAMS_PYTHON', platform.defaults.venvPython(path.join(dataDir, 'teams-venv'))),
    timeoutMs: envInt('PA_TEAMS_CACHE_TIMEOUT_MS', 60_000),
  },

  // Claude Code transcripts (~/.claude/projects here, and each PA_MACHINES
  // machine's through its termhub) as source items. PA_SESSIONS=0 reads none:
  // a stack that ingests nothing (the personal one on Linux) also leaves the
  // sessions of whatever account the box's `claude` is signed in to alone.
  sessions: {
    enabled: env('PA_SESSIONS', '1') !== '0',
  },

  // Through the `gh` CLI and its keyring login — no token in `.env`. Projects
  // v2 additionally needs `gh auth refresh -s read:project`.
  github: {
    enabled: env('PA_GITHUB', '1') !== '0',
    bin: env('PA_GH_BIN', 'gh'),
    // Orgs whose project boards are read. Empty means every org you belong to.
    orgs: (env('PA_GITHUB_ORGS', '') || '').split(/[\s,]+/).filter(Boolean),
    pollSeconds: envInt('PA_GITHUB_POLL_SECONDS', 300),
    // Board items followed by a field value, not by assignee — a pod's board,
    // e.g. `innergy-dev/7:Pod=Xi`. Parsed by ingest/github.js.
    boardsSpec: env('PA_GITHUB_BOARDS', ''),
  },

  // Two routes. With an API token (the `PA_JIRA_API_TOKEN` secret, see
  // `secret()` below) and an email, Jira's REST API directly. Without one,
  // the claude.ai Atlassian connector via `claude -p`, signed in once with
  // `/mcp`. The site and cloud id are discovered by the connector on its
  // first pass and remembered; set them only to pin a site.
  jira: {
    enabled: env('PA_JIRA', '1') !== '0',
    cloudId: env('PA_JIRA_CLOUD_ID'),
    // `acme` or `https://acme.atlassian.net`.
    site: env('PA_JIRA_SITE'),
    // The Atlassian account the token belongs to. Defaults to the Microsoft
    // 365 address `pa login` recorded.
    email: env('PA_JIRA_EMAIL'),
    pollSeconds: envInt('PA_JIRA_POLL_SECONDS', 900),
  },

  // Replies the worker writes on its own for fresh asks from mail and Teams.
  // They sit in the dashboard until you send or discard them; nothing sends.
  drafts: {
    auto: env('PA_AUTODRAFT', '1') !== '0',
    minConfidence: Number(env('PA_AUTODRAFT_MIN_CONFIDENCE', '0.6')),
    // Reply drafts (src/draft): the distill model unless set.
    model: env('PA_DRAFT_MODEL') || distillModel,
  },

  // The memory layer (src/memory): claims with evidence, consolidated into
  // people and project pages. Unlike distillation, most of this is many small
  // judgements, so it runs on cheaper models than the commitment extractor.
  memory: {
    enabled: env('PA_MEMORY', '1') !== '0',
    extractModel: modelEnv('PA_MEMORY_EXTRACT_MODEL', 'claude-sonnet-5-5'),
    decideModel: modelEnv('PA_MEMORY_DECIDE_MODEL', 'claude-sonnet-5-5'),
    pageModel: modelEnv('PA_MEMORY_PAGE_MODEL', 'claude-sonnet-5-5'),
    // A person gets a page once this many items, commitments or claims tie
    // them to you — below it they are a name in a CC line.
    minInteractions: envInt('PA_MEMORY_MIN_INTERACTIONS', 4),
    // Local hour after which the nightly dream pass may run.
    dreamHour: envInt('PA_MEMORY_DREAM_HOUR', 2),
  },

  // The cross-thread duplicate pass (src/commitments/dedupe.js): new open
  // commitments compared by embedding and anchors with every open one of the
  // last 60 days, confirmed by a cheap model in batches. Discretionary spend
  // (PA_BUDGET_DISCRETIONARY lists `dedupe`).
  // Which sources may create commitments (src/commitments/sourcePolicy.js):
  // groups (teams, mail, meetings, github, jira, requests, sessions) or source
  // names, `-name` to take one out. Claude sessions are not in the default:
  // the assistant's own work is evidence, never a task.
  commitments: {
    sources: env('PA_COMMITMENT_SOURCES', 'default'),
  },

  // Whether what people owe you blocks one of your tasks (src/commitments/blocks.js).
  blocks: {
    enabled: env('PA_BLOCKS', '1') !== '0',
    model: modelEnv('PA_BLOCKS_MODEL', 'azure/pa'),
  },

  dedupe: {
    enabled: env('PA_DEDUPE', '1') !== '0',
    model: modelEnv('PA_DEDUPE_MODEL', 'azure/pa'),
  },

  anthropic: {
    apiKey: null, // the keychain, then env: lazySecrets() below
    // Distillation is extraction, not reasoning-heavy work: the cost lever is
    // effort, not a smaller model. See AGENT.md.
    model: distillModel,
    effort: env('PA_DISTILL_EFFORT', 'low'),
  },

  // Without an API key, model calls go through a headless `claude -p` on the
  // operator's own login (see llm.js). Also the only route to the connectors.
  claudeBin: env('PA_CLAUDE_BIN', 'claude'),

  // Where the non-Claude model providers live (src/models.js). Endpoints only:
  // their keys are secrets, read with secret() when a call needs one —
  // OPENAI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, PA_LOCAL_LLM_API_KEY,
  // and for Azure the AZURE_OPENAI_API_KEY embeddings already use.
  providers: {
    openai: { baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1') },
    // The embeddings resource by default; PA_AZURE_CHAT_ENDPOINT when chat
    // models are deployed elsewhere. `v1` is Azure's version-less API (the
    // model string names the deployment); a dated version uses the
    // per-deployment route instead.
    azure: {
      endpoint: env('PA_AZURE_CHAT_ENDPOINT') || env('AZURE_OPENAI_ENDPOINT') || env('AZURE_FOUNDRY_ENDPOINT'),
      apiVersion: env('PA_AZURE_CHAT_API_VERSION', 'v1'),
    },
    openrouter: { baseUrl: env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1') },
    deepseek: { baseUrl: env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com') },
    // Any OpenAI-compatible server (ollama, llama.cpp, vLLM, LM Studio).
    local: { baseUrl: env('PA_LOCAL_LLM_URL', 'http://127.0.0.1:11434/v1') },
  },
  // Dollars per million tokens for models pa has no price for, as
  // `provider/model=in:out` pairs, comma-separated. Without one a call's cost
  // is recorded as unknown (null) — never guessed.
  modelPrices: env('PA_MODEL_PRICES', ''),
  // Which Claude Code login those calls use: a config folder of its own
  // (CLAUDE_CONFIG_DIR for that child only), so pa can stay on one
  // subscription while your own sessions switch between others. Empty: your
  // default login. Agent sessions dispatched through termhub never get it —
  // they run on the login of the machine they run on.
  claudeConfigDir: expandHome(env('PA_CLAUDE_CONFIG_DIR', '')),

  // Optional. Without it, search falls back to full-text only, which is worse
  // at paraphrase and perfectly usable.
  embeddings: {
    endpoint: env('AZURE_OPENAI_ENDPOINT') || env('AZURE_FOUNDRY_ENDPOINT'),
    apiKey: null, // the keychain, then env: lazySecrets() below
    deployment: env('PA_EMBED_DEPLOYMENT', 'text-embedding-3-small'),
    apiVersion: env('PA_EMBED_API_VERSION', '2024-05-01-preview'),
    dimensions: envInt('PA_EMBED_DIMENSIONS', 1536),
    // text-embedding-3-small list price, USD per million tokens; what llm_spend records.
    usdPerMTokens: Number(env('PA_EMBED_USD_PER_MTOK', '0.02')) || 0.02,
    // Query-embedding cache (src/search/embedCache.js): in-memory entries, and rows kept in the table.
    cacheEntries: envInt('PA_EMBED_CACHE_ENTRIES', 500),
    cacheRows: envInt('PA_EMBED_CACHE_ROWS', 5000),
  },

  // Cohere Rerank, deployed on the same Azure AI resource and reached with the
  // same key as embeddings. Optional: without it search keeps its fused order.
  rerank: {
    enabled: env('PA_RERANK', '1') !== '0',
    deployment: env('PA_RERANK_DEPLOYMENT', 'cohere-rerank-v4-fast'),
    // How many fused candidates the reranker reads. One search unit covers
    // up to 100 documents, so this costs the same as reranking ten.
    candidates: envInt('PA_RERANK_CANDIDATES', 40),
    timeoutMs: envInt('PA_RERANK_TIMEOUT_MS', 8000),
  },

  termhub: {
    url: env('PA_TERMHUB_URL', 'http://127.0.0.1:7000'),
    claudeCommand: env('PA_CLAUDE_COMMAND', 'claude --dangerously-skip-permissions'),
    // Which agent a dispatched run starts (claude | opencode) and on which
    // model, unless `pa do --agent/--model` says otherwise (src/dispatch/agent.js).
    // PA_CLAUDE_COMMAND stays the claude command line.
    agent: env('PA_DISPATCH_AGENT', 'claude'),
    model: env('PA_DISPATCH_MODEL'),
    machines: parseMachines(env('PA_MACHINES', '')),
  },

  // The PA chat (src/chat): one Claude Code session in termhub. Deliberately
  // without --dangerously-skip-permissions — it reads other people's
  // messages, so its actions stay behind permission prompts.
  // PA_CHAT_AGENT picks the CLI (claude | opencode), PA_CHAT_MODEL its model;
  // PA_CHAT_COMMAND, when set, is the whole command line instead. Either way
  // src/chat/agent.js refuses a command that skips permissions.
  // PA_CHAT_ENGINE: `sdk` (the default since plan 4.2: the Claude Agent SDK
  // in this process, prompts as typed callbacks, src/chat/sdkFeed.js) or
  // `terminal` (the termhub session, its prompts answered by reading the
  // screen). An SDK approval nobody answers is a deny after
  // PA_CHAT_APPROVAL_TIMEOUT_MS.
  chat: {
    agent: env('PA_CHAT_AGENT'),
    model: env('PA_CHAT_MODEL'),
    command: env('PA_CHAT_COMMAND'),
    engine: env('PA_CHAT_ENGINE', 'sdk'),
    approvalTimeoutMs: envInt('PA_CHAT_APPROVAL_TIMEOUT_MS', 300_000),
  },

  // The voice page's fast lane ("System 1", src/chat/fastLane.js): a quick
  // model answers simple spoken turns itself and acknowledges the rest while
  // handing them to the PA chat. PA_FAST_ROUTER: `logprob` (decide, then
  // speak: calibrated probabilities from one-token log-probabilities, the
  // fast model speaks only above PA_FAST_ANSWER_THRESHOLD), `same` (the fast
  // model decides and replies in one call), `rules` (built-in keyword router),
  // a model string (a separate router call), or an http(s) URL (POST
  // { text, context, history } -> decision JSON).
  //
  // The default is local: Llama 3.2 3B in Ollama (PA_LOCAL_LLM_URL), the
  // `logprob` router then the answerer (with `same`, one streamed call whose
  // decision is forced to JSON {label, route, say}; PA_FAST_JSON=auto uses
  // that for local/ models), kept loaded for
  // PA_FAST_KEEP_ALIVE. When it is down, or has not decided within
  // PA_FAST_LOCAL_TIMEOUT_MS (a model still loading), the turn goes to
  // PA_FAST_FALLBACK_MODEL instead.
  fastLane: {
    enabled: env('PA_FAST_LANE', '1') !== '0',
    model: env('PA_FAST_MODEL', 'local/llama3.2:3b'),
    fallback: env('PA_FAST_FALLBACK_MODEL', 'azure/pa'),
    json: env('PA_FAST_JSON', 'auto'),
    keepAlive: env('PA_FAST_KEEP_ALIVE', '24h'),
    localTimeoutMs: envInt('PA_FAST_LOCAL_TIMEOUT_MS', 2500),
    // `logprob`: decide, then speak (src/chat/fastRouter.js); needs a local/ model, else `same`.
    router: env('PA_FAST_ROUTER', 'logprob'),
    // The answerer speaks only when the router's p(answer_here) is at least this
    // (fitted with `pa eval router --fit`).
    answerThreshold: env('PA_FAST_ANSWER_THRESHOLD', '0.85'),
    // Reasoning effort for an OpenAI/Azure reasoning model (the fallback too); Claude effort otherwise.
    effort: env('PA_FAST_EFFORT', 'low'),
    contextTtlMs: envInt('PA_FAST_CONTEXT_SECONDS', 60) * 1000,
    decisionTimeoutMs: envInt('PA_FAST_DECISION_TIMEOUT_MS', 6000),
  },

  // The local voice stack (voice/server.py, windows/install-voice.ps1): Kokoro
  // speech and the smart-turn end-of-turn judge on loopback, proxied by the
  // dashboard as /api/talk/tts and /api/talk/endpoint; the page's own models
  // (Silero VAD, the "hey jarvis" wake word, onnxruntime-web) are served from
  // `models` at /talk/models/. PA_VOICE_URL=off turns the service off: the
  // page speaks with the browser's voices and ends turns on silence alone.
  voice: {
    url: env('PA_VOICE_URL', 'http://127.0.0.1:47830') === 'off' ? '' : env('PA_VOICE_URL', 'http://127.0.0.1:47830').replace(/\/+$/, ''),
    defaultVoice: env('PA_VOICE', 'bf_isabella'),
    models: expandHome(env('PA_VOICE_MODELS', path.join(dataDir, 'voice-models'))),
    python: env('PA_VOICE_PYTHON', platform.defaults.venvPython(path.join(dataDir, 'voice-venv'))),
  },

  dispatch: {
    port: envInt('PA_DISPATCH_PORT', 7300),
    // Loopback only. This process starts agents; it is not tailnet-safe.
    host: env('PA_DISPATCH_HOST', '127.0.0.1'),
    // Repos where a finished run's PR is merged once its checks pass
    // (src/dispatch/merge.js): mine alone. Elsewhere it stays a draft for me.
    mergeRepos: env(
      'PA_MERGE_REPOS',
      'innergy-dev/mv-assistant,innergy-dev/engineering-assistant,innergy-dev/mv-pipeline,innergy-dev/innergy-dispatch,xvanov/*'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // The end state a run or factory job gets when the operator did not say
    // and its repo has no default of its own (`pa delivery set`,
    // src/dispatch/deliveryCore.js): none | branch | draft_pr | pr |
    // auto_merge | push_to_main.
    deliveryDefault: env('PA_DELIVERY_DEFAULT', 'draft_pr'),
    // The model that writes a factory job's brief from the ask and what the
    // assistant gathered (src/dispatch/compose.js). Any text-capable model.
    composeModel: modelEnv('PA_COMPOSE_MODEL', 'claude-sonnet-5-5'),
    // Used instead of a bare Claude composeModel when there is no
    // ANTHROPIC_API_KEY, so compose skips `claude -p` (~4 s startup): a keyed
    // provider model string, e.g. azure/<deployment>. Unset, or its key
    // missing: `claude -p`.
    composeFallbackModel: env('PA_COMPOSE_FALLBACK_MODEL'),
  },

  // The software factory as a second dispatch target (src/dispatch/factory.js,
  // contract: software-factory docs/JOBS-API.md). Off until PA_FACTORY_PATH
  // names the factory's checkout on its machine. Its commands run there
  // through src/dispatch/exec.js; the walk-in session opens in that
  // machine's termhub, so a remote factory machine must be in PA_MACHINES.
  factory: {
    // The checkout `uv run factory …` runs in, as a path on the factory's machine.
    path: env('PA_FACTORY_PATH', ''),
    // A PA_MACHINES name; '' = this machine.
    machine: env('PA_FACTORY_MACHINE', ''),
    // The `uv` the factory's commands run with on its machine. termhub's
    // /api/exec runs without a login shell, so ~/.local/bin is often not on
    // its PATH: give the full path there (e.g. /home/me/.local/bin/uv).
    uv: env('PA_FACTORY_UV', 'uv'),
    // `factory serve`'s localhost API (plan 2.1), tried first when the factory
    // is on this machine; empty disables it (every call spawns the CLI).
    serveUrl: env('PA_FACTORY_SERVE_URL', 'http://127.0.0.1:7330'),
    // `pa do`'s route when --via is not given: claude | factory | auto.
    // Unset: the factory once it is configured (it dispatches and tracks all
    // work: code, research, reports), else a Claude session.
    via: env('PA_DISPATCH_VIA', '') || (env('PA_FACTORY_PATH', '') ? 'factory' : 'claude'),
    // chain | solo | auto (the factory decides). Solo by default: on the
    // factory's own benchmark one agent beat the role chain.
    pipeline: env('PA_FACTORY_PIPELINE', 'solo'),
    // A job's runtime when none is picked: api (the factory's metered model
    // routing) | claude_session (Claude Code on the factory machine, the
    // operator's subscription). JOBS-API v1.2.
    runtime: env('PA_FACTORY_RUNTIME', 'api'),
    // Per-persona model overrides passed with every job: `dev=model,reviewer=model`.
    models: env('PA_FACTORY_MODELS', ''),
    // How `auto` picks: `rule` (src/dispatch/routeCore.js). The seam for others.
    chooser: env('PA_ROUTE_CHOOSER', 'rule'),
    // The worker's factory pass (src/dispatch/factoryPace.js): every
    // pollSeconds when nothing moves, every activePollSeconds while a job is
    // queued, triaging or in progress, and at once when a local factory writes
    // its state.
    pollSeconds: envInt('PA_FACTORY_POLL_SECONDS', 120),
    activePollSeconds: envInt('PA_FACTORY_ACTIVE_POLL_SECONDS', 5),
    timeoutMs: envInt('PA_FACTORY_TIMEOUT_MS', 120_000),
  },

  audio: {
    enabled: env('PA_AUDIO_ENABLED', '1') !== '0',
    sampleRate: envInt('PA_AUDIO_SAMPLE_RATE', 16000),
    rollMinutes: envInt('PA_AUDIO_ROLL_MINUTES', 15),
    // How long a silence ends an episode.
    episodeGapSeconds: envInt('PA_AUDIO_EPISODE_GAP_SECONDS', 90),
    // voice-dictation's faster-whisper server, reused rather than reinstalled.
    transcribeHost: env('PA_TRANSCRIBE_HOST', '127.0.0.1'),
    transcribePort: envInt('PA_TRANSCRIBE_PORT', 47821),
    pauseFile: env('PA_AUDIO_PAUSE_FILE', path.join(dataDir, 'audio.paused')),
    // Below this much free space on the spool's drive the worker warns you:
    // a full disk silently stopped call recording once.
    lowDiskGb: Number(env('PA_LOW_DISK_GB', '5')),
    // Touched by the worker when a meeting ends; capture finishes its current
    // file within a second (audio/capture.py, audio/naming.py).
    rollFile: env('PA_AUDIO_ROLL_FILE', path.join(dataDir, 'audio.roll')),
    // The meeting gate (src/audio/gate.js): capture records only while a
    // calendar meeting is on or another app holds the microphone.
    gate: {
      enabled: env('PA_AUDIO_MEETING_GATE', '1') !== '0',
      pollSeconds: envInt('PA_AUDIO_GATE_POLL_SECONDS', 5),
      leadMinutes: envInt('PA_AUDIO_GATE_LEAD_MINUTES', 2),
      graceMinutes: envInt('PA_AUDIO_GATE_GRACE_MINUTES', 5),
      callGraceSeconds: envInt('PA_AUDIO_GATE_CALL_GRACE_SECONDS', 180),
    },
    // The venv that owns soundcard/soundfile. Separate from voice-dictation's
    // so upgrading one cannot break the other's hotkey.
    python: env('PA_AUDIO_PYTHON', platform.defaults.venvPython(path.join(dataDir, 'venv'))),
  },

  retention: {
    rawItemDays: envInt('PA_RETENTION_RAW_DAYS', 180),
    rawAudioHours: envInt('PA_RETENTION_RAW_AUDIO_HOURS', 6),
  },

  // Proactive messages (src/notify): a feed in the dashboard, and a desktop
  // notification for each (a Windows toast, notify-send on Linux) unless
  // PA_TOASTS=0.
  notify: {
    toasts: env('PA_TOASTS', '1') !== '0',
    // ntfy pushes (src/notify/ntfy.js), live once the PA_NTFY_TOPIC secret is
    // set: 'fallback' when the desktop one did not show, 'always', or 'off'.
    ntfyMode: env('PA_NTFY', 'fallback'),
    ntfyServer: env('PA_NTFY_SERVER', 'https://ntfy.sh'),
    // Titles only unless asked: a body can quote your mail.
    ntfyBody: env('PA_NTFY_BODY', '0') === '1',
    // The interrupt budget (src/notify/budget.js): this many real-time pushes
    // a day; past it, and in quiet hours, the rest wait for a digest.
    pushBudget: envInt('PA_PUSH_BUDGET', 4),
    // Local hours, "from-to"; '' or 'off' for none. Wraps midnight.
    quietHours: env('PA_QUIET_HOURS', '19-08'),
    // Local times the digest is built (src/notify/digest.js).
    digestTimes: env('PA_DIGEST_TIMES', '09:00,14:00'),
    // Pushes also land in <dataDir>/pa-home/INBOX.md for the PA chat, and the
    // chat session is nudged when it is provably idle (src/notify/chat.js).
    chatNudge: env('PA_CHAT_NUDGE', '1') !== '0',
    chatNudgeIdleMinutes: envInt('PA_CHAT_NUDGE_IDLE_MINUTES', 2),
  },

  // Pre-meeting briefs (src/meetings): a short numbered note, delivered
  // through notify, this many minutes before each meeting you will speak in.
  meetings: {
    enabled: env('PA_BRIEFS', '1') !== '0',
    leadMinutes: envInt('PA_BRIEF_LEAD_MINUTES', 60),
    // More invitees than this is a broadcast you sit in; not briefed unless you organised it.
    maxAttendees: envInt('PA_BRIEF_MAX_ATTENDEES', 40),
    // Solo blocks on your own calendar (focus time) get a brief too.
    focusBlocks: env('PA_BRIEF_FOCUS', '0') === '1',
    model: modelEnv('PA_BRIEF_MODEL', 'claude-sonnet-5-5'),
    classifyModel: modelEnv('PA_BRIEF_CLASSIFY_MODEL', 'claude-sonnet-5-5'),
    effort: env('PA_BRIEF_EFFORT', 'low'),
    // Post-meeting debriefs (src/meetings/debrief.js): your to-dos and updates
    // to your open work, minutes after a recorded meeting or call ends.
    debrief: env('PA_DEBRIEF', '1') !== '0',
    debriefModel: modelEnv('PA_DEBRIEF_MODEL', 'claude-sonnet-5-5'),
    debriefEffort: env('PA_DEBRIEF_EFFORT', 'medium'),
  },

  // Closing an owed_by_me commitment from Teams or mail once my own later
  // reply in the thread settles it (src/commitments/replyClose.js). One small
  // judgement per new reply, so a cheaper model at low effort.
  replyClose: {
    enabled: env('PA_REPLY_CLOSE', '1') !== '0',
    model: modelEnv('PA_REPLY_CLOSE_MODEL', 'claude-sonnet-5-5'),
    effort: env('PA_REPLY_CLOSE_EFFORT', 'low'),
  },

  // The reconciler (src/ledger/reconcile.js): open commitments judged against
  // newer related items, closed on verified evidence. PA_RECONCILE_AUTO=0
  // keeps every close a proposal on the dashboard.
  reconcile: {
    enabled: env('PA_RECONCILE', '1') !== '0',
    auto: env('PA_RECONCILE_AUTO', '1') !== '0',
    model: reconcileModel,
    effort: env('PA_RECONCILE_EFFORT', 'medium'),
  },

  // Card context (src/commitments/context.js): the cause-and-effect paragraph on
  // dashboard cards, written by the worker a few at a time on the reconcile
  // model. Discretionary spend (purpose card-context). PA_CARD_CONTEXT=0 stops it.
  cardContext: {
    enabled: env('PA_CARD_CONTEXT', '1') !== '0',
    model: env('PA_CARD_CONTEXT_MODEL') || reconcileModel,
  },

  // The repo registry (src/repos): `pa repos sync` and the hourly worker pass.
  // The model only writes a profile for a repo that is new or whose README or
  // manifests changed, a handful of repos per call, on the cheap pass model.
  // PA_REPOS=0 stops the worker pass; PA_REPO_PROFILE=0 stops the model calls.
  repos: {
    enabled: env('PA_REPOS', '1') !== '0',
    syncSeconds: envInt('PA_REPOS_SYNC_SECONDS', 3600),
    profile: env('PA_REPO_PROFILE', '1') !== '0',
    // raven (INNERGY's knowledge base) as the repo map. PA_REPOS_RAVEN=0 for a
    // stack whose `gh` cannot, or must not, read it.
    raven: env('PA_REPOS_RAVEN', '1') !== '0',
    profileModel: env('PA_REPO_PROFILE_MODEL') || reconcileModel,
    profilesPerSync: envInt('PA_REPO_PROFILES_PER_SYNC', 60),
  },

  // The planner (src/agent/planner.js): each new ask gets a kind, and some an
  // action ahead of me — a read-only research run (at most researchPerDay a
  // day), a "start a run?" card, or a "which repo?" question. PA_PLANNER=0
  // turns it off.
  planner: {
    enabled: env('PA_PLANNER', '1') !== '0',
    model: modelEnv('PA_PLANNER_MODEL', 'claude-sonnet-5-5'),
    researchPerDay: Number(env('PA_EAGER_RUNS_PER_DAY', '2')) || 0,
  },

  // Durable tasks on Absurd (src/durable). PA_DURABLE=0 stops the worker
  // running them and spawning new ones; tasks already in the store wait.
  durable: {
    enabled: env('PA_DURABLE', '1') !== '0',
  },

  // The daily model budget (src/budget.js). Every call is recorded in
  // `llm_spend`; once today's spend reaches the cap, *discretionary* purposes
  // (eager, speculative work) are refused until local midnight. *Essential*
  // ones keep the board true and are never refused — a cap that stopped
  // distillation would trade a bill for a stale board. A purpose matches an
  // entry exactly or as a prefix ('eager' covers 'eager-draft').
  budget: {
    dailyUsd: (() => {
      const n = Number.parseFloat(env('PA_DAILY_BUDGET_USD', '15'));
      return Number.isFinite(n) ? n : 15;
    })(),
    essential: env('PA_BUDGET_ESSENTIAL', 'distill,reconcile,connector,reply-close').split(',').map((s) => s.trim()).filter(Boolean),
    discretionary: env('PA_BUDGET_DISCRETIONARY', 'eager,research,digest,planner,card,propose,dedupe').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // OpenTelemetry into Meter (plan 7.5; src/telemetry). Spans of the main hops
  // (voice turn, tool call, factory hop, deploy) go to the `trace_span` table
  // through a local exporter, never to a cloud collector; Meter shows p50/p95
  // per hop. PA_TELEMETRY=0 turns the instruments into no-ops.
  telemetry: {
    enabled: env('PA_TELEMETRY', '1') !== '0',
    retentionDays: envInt('PA_TELEMETRY_RETENTION_DAYS', 30),
  },

  // The Claude subscription credit pool (since 15 Jun 2026 headless Claude Code,
  // `claude -p` and claude_session runs, draws from a pool apart from the
  // interactive allowance; src/claudePool.js). monthlyUsd is the pool in
  // API-equivalent dollars (PA_CLAUDE_POOL_USD); unset or 0 = not tracked, no
  // fallback. The pool resets on resetDay of each month (local time).
  // fallbackApi (PA_CLAUDE_POOL_FALLBACK_API=1, default off): once the pool is
  // spent, a claude_session job is dispatched on the api runtime instead.
  claudePool: {
    monthlyUsd: (() => {
      const n = Number.parseFloat(env('PA_CLAUDE_POOL_USD', ''));
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    resetDay: Math.min(28, Math.max(1, envInt('PA_CLAUDE_POOL_RESET_DAY', 1))),
    fallbackApi: env('PA_CLAUDE_POOL_FALLBACK_API', '0') === '1',
  },

  // Recurring typed actions (src/routines). PA_ROUTINES=0 stops the worker
  // running them; `pa routine run` still works by hand.
  routines: {
    enabled: env('PA_ROUTINES', '1') !== '0',
    // Local hour after which the nightly suggestion pass may run.
    suggestHour: envInt('PA_ROUTINE_SUGGEST_HOUR', 3),
    // Parsing a typed routine, its prompt reports, and the nightly suggestions.
    model: modelEnv('PA_ROUTINE_MODEL', 'claude-sonnet-5-5'),
  },

  // Retrieval evals (src/eval): the distill model unless set.
  eval: {
    model: env('PA_EVAL_MODEL') || distillModel,
  },

  // Nightly pg_dump of the whole store (see src/backup.js). Local disk by
  // default — the dumps hold everything the assistant knows, so where they go
  // is a privacy decision as much as a durability one.
  backup: {
    dir: env('PA_BACKUP_DIR', path.join(dataDir, 'backups')),
    keep: envInt('PA_BACKUP_KEEP', 14),
    everyHours: envInt('PA_BACKUP_EVERY_HOURS', 24),
    // PA_DB=sqlite: the rolling snapshot pa-latest.sqlite is refreshed by the
    // hourly backup pass when older than this (src/backupSqlite.js).
    snapshotMinutes: envInt('PA_SQLITE_SNAPSHOT_MINUTES', 60),
    // The distro that hosts Postgres on Windows; pg_dump runs inside it.
    wslDistro: env('PA_WSL_DISTRO', 'Ubuntu'),
    // How pg_dump/pg_restore are reached: 'wsl:<distro>' (Windows), 'native',
    // or 'docker:<container>' (the compose store). Default per platform.
    pgTools: env('PA_PG_TOOLS', null) || platform.defaults.pgTools({ wslDistro: env('PA_WSL_DISTRO', 'Ubuntu') }),
  },
};

// ------------------------------------------------------------- secrets ----
// `secret(name)`: a credential, resolved real env → the OS vault (Windows
// Credential Manager, the Linux Secret Service) → `.env` (this tool's, then the repo root's). Same rule as above:
// nothing secret has a default, a missing one is null and its feature reports
// itself "not configured".
//
// Values are cached in memory once found. A miss is cached for a minute only,
// so a token pasted into the dashboard or set with `pa secret set` in another
// process is picked up without restarting the worker. The value is returned
// to the caller and nowhere else: never logged, never put in an error.

const secretCache = new Map();
const MISS_TTL_MS = 60_000;

// Every vault read is a synchronous process (PowerShell on Windows, ~0.6 s),
// and a miss was re-read every minute per name: a fresh worker generation's
// first passes asked for a dozen unset names at once and blocked its event
// loop past the deploy's health watch, which rolled it back. So the vault's
// NAMES are listed once (one process) and kept for five minutes; a name not
// in the list is a miss without asking. A secret stored from another process
// is picked up within five minutes (forgetSecret() at once).
const VAULT_LIST_TTL_MS = 5 * 60_000;
let vaultNames = null; // { names: Set | null, at }

function inVault(vault, name) {
  if (!vaultNames || Date.now() - vaultNames.at > VAULT_LIST_TTL_MS) {
    try {
      vaultNames = { names: new Set(vault.list()), at: Date.now() };
    } catch {
      vaultNames = { names: null, at: Date.now() }; // cannot list: ask per name, as before
    }
  }
  return vaultNames.names ? vaultNames.names.has(name) : true;
}

function envFileSecret(name) {
  const tool = parseEnvFile(path.join(TOOL_DIR, '.env'))[name];
  if (tool) return { value: tool, source: '.env' };
  const root = parseEnvFile(path.join(REPO_ROOT, '.env'))[name];
  return root ? { value: root, source: 'repo .env' } : null;
}

function resolveSecret(name) {
  const hit = secretCache.get(name);
  if (hit && (hit.value !== null || Date.now() - hit.at < MISS_TTL_MS)) return hit;
  let found = null;
  if (process.env[name]) found = { value: process.env[name], source: 'env' };
  if (!found) {
    const vault = require('./secrets/vault');
    if (vault.available() && inVault(vault, name)) {
      try {
        const v = vault.get(name);
        if (v) found = { value: v, source: 'credential-manager' };
      } catch {
        // An unreachable vault is a miss, not a crash; `pa secret list`
        // reports the vault's own error.
      }
    }
  }
  if (!found) found = envFileSecret(name);
  const entry = { value: found ? found.value : null, source: found ? found.source : null, at: Date.now() };
  secretCache.set(name, entry);
  return entry;
}

function secret(name) {
  return resolveSecret(name).value;
}

// Where a secret comes from ('env' | 'credential-manager' | '.env' | 'repo .env'),
// or null — for `pa doctor` and the dashboard, which must never see the value.
function secretSource(name) {
  return resolveSecret(name).source;
}

// The two keys the config object carries are read through secret() on every
// access, not once at load: the keychain is a process per read (~0.6 s on
// Windows), which no pa verb that never calls a model should pay, and a key
// stored after startup is picked up. Assignable, because tests and callers
// that hold a key of their own set one.
function lazySecret(obj, prop, ...names) {
  let override;
  Object.defineProperty(obj, prop, {
    enumerable: true,
    configurable: true,
    get: () => (override !== undefined ? override : names.map((n) => secret(n)).find(Boolean) || null),
    set: (v) => { override = v; },
  });
}
lazySecret(config.anthropic, 'apiKey', 'ANTHROPIC_API_KEY');
lazySecret(config.embeddings, 'apiKey', 'AZURE_OPENAI_API_KEY', 'AZURE_FOUNDRY_API_KEY');

function forgetSecret(name) {
  vaultNames = null;
  if (name) secretCache.delete(name);
  else secretCache.clear();
}

// PA_SQLITE_KEY resolves as any secret does (the environment, the OS vault,
// then .env), at use: `pa secret set PA_SQLITE_KEY` keeps it out of files.
Object.defineProperty(config, 'sqliteKey', { enumerable: true, configurable: true, get: () => secret('PA_SQLITE_KEY') || '' });

module.exports = { config, env, envInt, parseEnvFile, parseMachines, MACHINE_OS, secret, secretSource, forgetSecret };
