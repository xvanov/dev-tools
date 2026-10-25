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

// Other machines a run can be dispatched to (src/dispatch/remote.js), each
// with its own termhub and its own repos root:
//   PA_MACHINES=mv-automated-vm=http://mv-automated-vm.example.ts.net:7000|C:\source
// Comma-separated for more than one. A machine not listed here is unknown.
function parseMachines(text) {
  const machines = {};
  for (const entry of String(text || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^=]+)=([^|]+)\|(.+)$/.exec(entry);
    if (!m) throw new Error(`PA_MACHINES: cannot read "${entry}" — want name=termhubUrl|reposRoot`);
    machines[m[1].trim()] = { name: m[1].trim(), url: m[2].trim().replace(/\/+$/, ''), reposRoot: m[3].trim() };
  }
  return machines;
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
    // Evenings and weekends: chat still arrives in seconds through the Teams
    // cache, so the connector pass (about $0.20 each) only needs to catch up.
    offHoursPollSeconds: envInt('PA_M365_OFF_HOURS_POLL_SECONDS', 1800),
    calendarPollSeconds: envInt('PA_M365_CALENDAR_POLL_SECONDS', 900),
    // The model that relays connector calls. Not Sonnet: headless, it made no
    // tool calls at all (a pass "succeeded" with nothing read), so a cheaper
    // relay must be proven against a real read before it becomes the default.
    connectorModel: env('PA_CONNECTOR_MODEL', 'claude-opus-5'),
    // Channel posts: `mentions` (kept when they name you), `all`, or `off`.
    teamsChannels: env('PA_TEAMS_CHANNELS', 'mentions'),
  },

  // Teams in seconds, from the new Teams client's own IndexedDB cache on this
  // disk (src/ingest/teamsLocal.js). The connector still runs: it backfills
  // and upgrades what this reads. A missing cache or venv is a quiet no-op.
  teamsCache: {
    enabled: env('PA_TEAMS_CACHE', '1') !== '0',
    pollSeconds: envInt('PA_TEAMS_CACHE_POLL_SECONDS', 5),
    dir: env(
      'PA_TEAMS_CACHE_DIR',
      path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Packages', 'MSTeams_8wekyb3d8bbwe', 'LocalCache', 'Microsoft', 'MSTeams', 'EBWebView',
        'WV2Profile_tfw', 'IndexedDB', 'https_teams.microsoft.com_0.indexeddb'
      )
    ),
    // Its own venv, not the capture one: the reader is pinned to a forensic
    // library that is not on PyPI and must not be able to break capture.
    python: env('PA_TEAMS_PYTHON', path.join(dataDir, 'teams-venv', 'Scripts', 'python.exe')),
    timeoutMs: envInt('PA_TEAMS_CACHE_TIMEOUT_MS', 60_000),
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
    machines: parseMachines(env('PA_MACHINES', '')),
  },

  // The PA chat (src/chat): one Claude Code session in termhub. Deliberately
  // without --dangerously-skip-permissions — it reads other people's
  // messages, so its actions stay behind permission prompts.
  chat: {
    command: env('PA_CHAT_COMMAND', 'claude'),
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
      pollSeconds: envInt('PA_AUDIO_GATE_POLL_SECONDS', 20),
      leadMinutes: envInt('PA_AUDIO_GATE_LEAD_MINUTES', 2),
      graceMinutes: envInt('PA_AUDIO_GATE_GRACE_MINUTES', 5),
      callGraceSeconds: envInt('PA_AUDIO_GATE_CALL_GRACE_SECONDS', 120),
    },
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

  // Proactive messages (src/notify): a feed in the dashboard, and a Windows
  // toast for each unless PA_TOASTS=0.
  notify: {
    toasts: env('PA_TOASTS', '1') !== '0',
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
    model: env('PA_BRIEF_MODEL', 'claude-sonnet-5-5'),
    classifyModel: env('PA_BRIEF_CLASSIFY_MODEL', 'claude-sonnet-5-5'),
    effort: env('PA_BRIEF_EFFORT', 'low'),
    // Post-meeting debriefs (src/meetings/debrief.js): your to-dos and updates
    // to your open work, minutes after a recorded meeting or call ends.
    debrief: env('PA_DEBRIEF', '1') !== '0',
    debriefModel: env('PA_DEBRIEF_MODEL', 'claude-sonnet-5-5'),
    debriefEffort: env('PA_DEBRIEF_EFFORT', 'medium'),
  },

  // Closing an owed_by_me commitment from Teams or mail once my own later
  // reply in the thread settles it (src/commitments/replyClose.js). One small
  // judgement per new reply, so a cheaper model at low effort.
  replyClose: {
    enabled: env('PA_REPLY_CLOSE', '1') !== '0',
    model: env('PA_REPLY_CLOSE_MODEL', 'claude-sonnet-5-5'),
    effort: env('PA_REPLY_CLOSE_EFFORT', 'low'),
  },

  // The reconciler (src/ledger/reconcile.js): open commitments judged against
  // newer related items, closed on verified evidence. PA_RECONCILE_AUTO=0
  // keeps every close a proposal on the dashboard.
  reconcile: {
    enabled: env('PA_RECONCILE', '1') !== '0',
    auto: env('PA_RECONCILE_AUTO', '1') !== '0',
    model: env('PA_RECONCILE_MODEL', 'claude-sonnet-5-5'),
    effort: env('PA_RECONCILE_EFFORT', 'medium'),
  },

  // The planner (src/agent/planner.js): each new ask gets a kind, and some an
  // action ahead of me — a read-only research run (at most researchPerDay a
  // day), a "start a run?" card, or a "which repo?" question. PA_PLANNER=0
  // turns it off.
  planner: {
    enabled: env('PA_PLANNER', '1') !== '0',
    model: env('PA_PLANNER_MODEL', 'claude-sonnet-5-5'),
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
    discretionary: env('PA_BUDGET_DISCRETIONARY', 'eager,research,digest,planner').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // Recurring typed actions (src/routines). PA_ROUTINES=0 stops the worker
  // running them; `pa routine run` still works by hand.
  routines: {
    enabled: env('PA_ROUTINES', '1') !== '0',
    // Local hour after which the nightly suggestion pass may run.
    suggestHour: envInt('PA_ROUTINE_SUGGEST_HOUR', 3),
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

// ------------------------------------------------------------- secrets ----
// `secret(name)`: a credential, resolved real env → Windows Credential
// Manager → `.env` (this tool's, then the repo root's). Same rule as above:
// nothing secret has a default, a missing one is null and its feature reports
// itself "not configured".
//
// Values are cached in memory once found. A miss is cached for a minute only,
// so a token pasted into the dashboard or set with `pa secret set` in another
// process is picked up without restarting the worker. The value is returned
// to the caller and nowhere else: never logged, never put in an error.

const secretCache = new Map();
const MISS_TTL_MS = 60_000;

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
    if (vault.available()) {
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

function forgetSecret(name) {
  if (name) secretCache.delete(name);
  else secretCache.clear();
}

module.exports = { config, env, envInt, parseEnvFile, parseMachines, secret, secretSource, forgetSecret };
