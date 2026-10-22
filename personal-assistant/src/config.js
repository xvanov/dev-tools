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
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'personal-assistant');
  }
  return path.join(os.homedir(), '.local', 'share', 'personal-assistant');
}

function defaultReposRoot() {
  return process.platform === 'win32' ? 'C:\\repos' : path.join(os.homedir(), 'repos');
}

const dataDir = env('PA_DATA_DIR', defaultDataDir());

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

  // Mail, calendar and Teams through the claude.ai Microsoft 365 connector via
  // `claude -p` — no app registration, no Graph token. Connect it once with
  // `/mcp` in Claude Code. Each pass is a headless session, so these polls are
  // minutes, not seconds.
  m365: {
    enabled: env('PA_M365', '1') !== '0',
    pollSeconds: envInt('PA_M365_POLL_SECONDS', 180),
    calendarPollSeconds: envInt('PA_M365_CALENDAR_POLL_SECONDS', 900),
    // Channel posts: `mentions` (kept when they name you), `all`, or `off`.
    teamsChannels: env('PA_TEAMS_CHANNELS', 'mentions'),
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

  // Through the claude.ai Atlassian connector via `claude -p` — no Jira token.
  // Sign in once with `/mcp` in Claude Code. The cloud id is discovered on the
  // first pass and remembered; set it only to pin a site.
  jira: {
    enabled: env('PA_JIRA', '1') !== '0',
    cloudId: env('PA_JIRA_CLOUD_ID'),
    pollSeconds: envInt('PA_JIRA_POLL_SECONDS', 900),
  },

  // Replies the worker writes on its own for fresh asks from mail and Teams.
  // They sit in the dashboard until you send or discard them; nothing sends.
  drafts: {
    auto: env('PA_AUTODRAFT', '1') !== '0',
    minConfidence: Number(env('PA_AUTODRAFT_MIN_CONFIDENCE', '0.6')),
  },

  // The memory layer (src/memory): claims with evidence, consolidated into
  // people and project pages. Unlike distillation, most of this is many small
  // judgements, so it runs on cheaper models than the commitment extractor.
  memory: {
    enabled: env('PA_MEMORY', '1') !== '0',
    extractModel: env('PA_MEMORY_EXTRACT_MODEL', 'claude-sonnet-5-5'),
    decideModel: env('PA_MEMORY_DECIDE_MODEL', 'claude-sonnet-5-5'),
    pageModel: env('PA_MEMORY_PAGE_MODEL', 'claude-sonnet-5-5'),
    // A person gets a page once this many items, commitments or claims tie
    // them to you — below it they are a name in a CC line.
    minInteractions: envInt('PA_MEMORY_MIN_INTERACTIONS', 4),
    // Local hour after which the nightly dream pass may run.
    dreamHour: envInt('PA_MEMORY_DREAM_HOUR', 2),
  },

  anthropic: {
    apiKey: env('ANTHROPIC_API_KEY'),
    // Distillation is extraction, not reasoning-heavy work: the cost lever is
    // effort, not a smaller model. See AGENT.md.
    model: env('PA_DISTILL_MODEL', 'claude-opus-5'),
    effort: env('PA_DISTILL_EFFORT', 'low'),
  },

  // Without an API key, model calls go through a headless `claude -p` on the
  // operator's own login (see llm.js). Also the only route to the connectors.
  claudeBin: env('PA_CLAUDE_BIN', 'claude'),

  // Optional. Without it, search falls back to full-text only, which is worse
  // at paraphrase and perfectly usable.
  embeddings: {
    endpoint: env('AZURE_OPENAI_ENDPOINT') || env('AZURE_FOUNDRY_ENDPOINT'),
    apiKey: env('AZURE_OPENAI_API_KEY') || env('AZURE_FOUNDRY_API_KEY'),
    deployment: env('PA_EMBED_DEPLOYMENT', 'text-embedding-3-small'),
    apiVersion: env('PA_EMBED_API_VERSION', '2024-05-01-preview'),
    dimensions: envInt('PA_EMBED_DIMENSIONS', 1536),
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
  },

  dispatch: {
    port: envInt('PA_DISPATCH_PORT', 7300),
    // Loopback only. This process starts agents; it is not tailnet-safe.
    host: env('PA_DISPATCH_HOST', '127.0.0.1'),
  },

  audio: {
    enabled: env('PA_AUDIO_ENABLED', '1') !== '0',
    sampleRate: envInt('PA_AUDIO_SAMPLE_RATE', 16000),
    rollMinutes: envInt('PA_AUDIO_ROLL_MINUTES', 60),
    // How long a silence ends an episode.
    episodeGapSeconds: envInt('PA_AUDIO_EPISODE_GAP_SECONDS', 90),
    // voice-dictation's faster-whisper server, reused rather than reinstalled.
    transcribeHost: env('PA_TRANSCRIBE_HOST', '127.0.0.1'),
    transcribePort: envInt('PA_TRANSCRIBE_PORT', 47821),
    pauseFile: env('PA_AUDIO_PAUSE_FILE', path.join(dataDir, 'audio.paused')),
    // The venv that owns soundcard/soundfile. Separate from voice-dictation's
    // so upgrading one cannot break the other's hotkey.
    python: env(
      'PA_AUDIO_PYTHON',
      path.join(dataDir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    ),
  },

  retention: {
    rawItemDays: envInt('PA_RETENTION_RAW_DAYS', 180),
    rawAudioHours: envInt('PA_RETENTION_RAW_AUDIO_HOURS', 6),
  },

  // Nightly pg_dump of the whole store (see src/backup.js). Local disk by
  // default — the dumps hold everything the assistant knows, so where they go
  // is a privacy decision as much as a durability one.
  backup: {
    dir: env('PA_BACKUP_DIR', path.join(dataDir, 'backups')),
    keep: envInt('PA_BACKUP_KEEP', 14),
    everyHours: envInt('PA_BACKUP_EVERY_HOURS', 24),
    // The distro that hosts Postgres; pg_dump runs inside it.
    wslDistro: env('PA_WSL_DISTRO', 'Ubuntu'),
  },
};

module.exports = { config, env, envInt, parseEnvFile };
