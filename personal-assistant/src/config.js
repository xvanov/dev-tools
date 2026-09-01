'use strict';

// Every knob the assistant has, resolved once, in one place.
//
// Two rules govern what lives here:
//
//  - **Nothing secret has a default.** A missing `PA_GITLAB_TOKEN` must surface
//    as "GitLab ingest is not configured" in `pa doctor`, never as a confusing
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

  graph: {
    clientId: env('PA_GRAPH_CLIENT_ID'),
    tenantId: env('PA_GRAPH_TENANT_ID', 'organizations'),
    // Read-only by default. `Mail.Send`/`ChatMessage.Send` are added only when
    // the operator opts in, because consent for them is a separate ask.
    scopes: (env('PA_GRAPH_SCOPES', 'Mail.Read Calendars.Read Chat.Read User.Read') || '')
      .split(/\s+/)
      .filter(Boolean),
    pollSeconds: envInt('PA_GRAPH_POLL_SECONDS', 120),
  },

  gitlab: {
    url: env('PA_GITLAB_URL', 'https://gitlab.com'),
    token: env('PA_GITLAB_TOKEN'),
    pollSeconds: envInt('PA_GITLAB_POLL_SECONDS', 300),
  },

  anthropic: {
    apiKey: env('ANTHROPIC_API_KEY'),
    // Distillation is extraction, not reasoning-heavy work: the cost lever is
    // effort, not a smaller model. See AGENT.md.
    model: env('PA_DISTILL_MODEL', 'claude-opus-5'),
    effort: env('PA_DISTILL_EFFORT', 'low'),
  },

  // Optional. Without it, search falls back to full-text only, which is worse
  // at paraphrase and perfectly usable.
  embeddings: {
    endpoint: env('AZURE_OPENAI_ENDPOINT') || env('AZURE_FOUNDRY_ENDPOINT'),
    apiKey: env('AZURE_OPENAI_API_KEY') || env('AZURE_FOUNDRY_API_KEY'),
    deployment: env('PA_EMBED_DEPLOYMENT', 'text-embedding-3-small'),
    apiVersion: env('PA_EMBED_API_VERSION', '2024-05-01-preview'),
    dimensions: envInt('PA_EMBED_DIMENSIONS', 1536),
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
    transcribePort: envInt('PA_TRANSCRIBE_PORT', 8765),
    pauseFile: env('PA_AUDIO_PAUSE_FILE', path.join(dataDir, 'audio.paused')),
  },

  retention: {
    rawItemDays: envInt('PA_RETENTION_RAW_DAYS', 180),
    rawAudioHours: envInt('PA_RETENTION_RAW_AUDIO_HOURS', 6),
  },
};

module.exports = { config, env, envInt, parseEnvFile };
