'use strict';

// Build profiles (docs/native/BUILD-ENRICHMENT.md, A): a saved, named, specialised Build agent,
// the "core four" (context, model, prompt, tools) plus caps. Stored in build_profile
// (src/repo/buildProfiles.ts); four seeds ship in code and are written once, never over an edit.
//
//   resolve({explicit, card, profile, defaults})  pure: the settings a run launches with.
//     Order, per field: explicit (this call) > the card's stored setting (build.card.<id>) > the
//     profile > the defaults (env). No profile and no card setting gives exactly what Build did
//     before profiles existed.
//   launchFlags(r, ctx)   pure: the claude flags, env and subagent files a resolved run needs.
//
// How a profile reaches Claude Code (flags checked against `claude --help`, 2.1.x):
//   model            --model <alias | full id>; fable is `claude-fable-5-2` (src/build/index.ts MODEL_IDS)
//   effort           --effort low|medium|high|xhigh|max
//   permission mode  --permission-mode <mode> (and --dangerously-skip-permissions dropped: it would
//                    override a read-only `plan`); null keeps Build's default (bypass)
//   MCP set          --strict-mcp-config always; --mcp-config <file> with the servers the profile names
//                    (registry: the `build.mcp` setting, {name: server config})
//   tool rules       --allowedTools / --disallowedTools
//   subagent model   env CLAUDE_CODE_SUBAGENT_MODEL (the default for subagents; there is no flag)
//   subagents        <worktree>/.claude/agents/<name>.md (frontmatter name, description, model, tools),
//                    kept out of git through the worktree's info/exclude
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type Row = import('../repo/types.ts').Row;

const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The permission modes a profile may pick. null (unset) is Build's own default: bypass, in the run's worktree. */
const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'auto', 'dontAsk', 'plan'];
const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const repo = () => require('../repo').buildProfiles;
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });
const num = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** What a stored profile looks like to callers: JSON columns parsed, nulls kept (null = use the next layer). */
interface Profile {
  name: string;
  description: string;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  prompt: string;
  tools: { mcp: string[]; allow: string[]; deny: string[] };
  subagents: Array<{ name: string; description: string; model: string | null; prompt: string; tools: string[] }>;
  subagentModel: string | null;
  costCapUsd: number | null;
  wallCapMin: number | null;
  idleAfterS: number | null;
  repoPath: string | null;
}

const json = (v: unknown): unknown => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

/** Pure: the sub-agent list, checked. Names are file names, so only [a-z0-9_-]. */
function checkSubagents(v: unknown): Profile['subagents'] {
  if (v == null || v === '') return [];
  if (!Array.isArray(v)) throw bad('subagents must be a list of {name, description, model?, prompt, tools?}');
  const seen = new Set<string>();
  return v.map((s: Json) => {
    const name = String(s?.name || '').trim().toLowerCase();
    if (!NAME.test(name)) throw bad(`subagent name "${name}" must be lowercase letters, digits, - or _`);
    if (seen.has(name)) throw bad(`subagent "${name}" is listed twice`);
    seen.add(name);
    const model = s.model ? String(s.model).trim().toLowerCase() : null;
    if (model && ![...MODELS, 'inherit'].includes(model)) throw bad(`subagent ${name}: model must be ${MODELS.join(', ')} or inherit`);
    return { name, description: String(s.description || name).replace(/\s+/g, ' ').trim(), model, prompt: String(s.prompt || '').trim(), tools: strs(s.tools) };
  });
}

/** Pure: a profile from user input or a stored row, checked. Throws a 400 for anything off. */
function normalize(name: string, v: Json): Profile {
  const n = String(name || '').trim().toLowerCase();
  if (!NAME.test(n)) throw bad('a profile name is lowercase letters, digits, - or _ (up to 40)');
  const pick = (k: string, list: string[], label: string): string | null => {
    const raw = v[k] ?? null;
    if (raw === null || raw === '') return null;
    const s = String(raw).trim().toLowerCase();
    if (!list.includes(s)) throw bad(`${label} must be ${list.join(', ')}`);
    return s;
  };
  const camel = (a: string, b: string): unknown => (v[a] !== undefined ? v[a] : v[b]);
  const mode = camel('permissionMode', 'permission_mode');
  const permissionMode = mode == null || mode === '' ? null : PERMISSION_MODES.find((m) => m.toLowerCase() === String(mode).toLowerCase()) || null;
  if (mode != null && mode !== '' && !permissionMode) throw bad(`permission mode must be ${PERMISSION_MODES.join(', ')}`);
  const t = (json(v.tools) || {}) as Json;
  const cap = (a: string, b: string, label: string): number | null => {
    const raw = camel(a, b);
    if (raw == null || raw === '') return null;
    const x = num(raw);
    if (x == null) throw bad(`${label} must be a positive number`);
    return x;
  };
  return {
    name: n,
    description: String(v.description || '').trim(),
    model: pick('model', MODELS, 'model'),
    effort: pick('effort', EFFORTS, 'effort'),
    permissionMode,
    prompt: String(v.prompt || '').trim(),
    tools: { mcp: strs(t.mcp), allow: strs(t.allow), deny: strs(t.deny) },
    subagents: checkSubagents(json(v.subagents)),
    subagentModel: pick(v.subagentModel !== undefined ? 'subagentModel' : 'subagent_model', [...MODELS, 'inherit'], 'subagent model'),
    costCapUsd: cap('costCapUsd', 'cost_cap_usd', 'cost cap'),
    wallCapMin: cap('wallCapMin', 'wall_cap_min', 'time cap'),
    idleAfterS: cap('idleAfterS', 'idle_after_s', 'idle after'),
    repoPath: v.repoPath !== undefined ? v.repoPath || null : v.repo_path || null,
  };
}

/** Pure: a profile as the row the repo stores (JSON columns as text). */
function toRow(p: Profile): Row {
  return {
    description: p.description, model: p.model, effort: p.effort, permission_mode: p.permissionMode, prompt: p.prompt,
    tools: JSON.stringify(p.tools), subagents: JSON.stringify(p.subagents), subagent_model: p.subagentModel,
    cost_cap_usd: p.costCapUsd, wall_cap_min: p.wallCapMin, idle_after_s: p.idleAfterS, repo_path: p.repoPath,
  };
}

const fromRow = (r: Row): Profile => normalize(String(r.name), r);

// ---------------------------------------------------------------- seeds ----

const RESEARCH_PROMPT = `## This is a read-only research run

You run in Claude Code's dontAsk permission mode: you can read, search and run read-only commands, and anything else is denied: you cannot edit or write files. That overrides the "Research, review or report" bullet above: do not write a report file.

Find the answer, then deliver the report in the result of your last command: \`{{pa}} run done --result "<the report>"\`. The report is plain text or markdown, up to about 40 lines: the answer first, then the evidence (file paths, line numbers, commands you ran), then what you could not verify. The \`{{pa}} run note|ask|done\` commands are pre-approved. Never change code, open a pull request or push.`;

const FEATURE_EXPLORER = {
  name: 'explorer',
  description: 'Read-only searcher. Use it for broad searches and for reading many files; it returns what it found, with paths and line numbers.',
  model: 'haiku',
  prompt: 'You search a codebase and report. Find what you were asked for with Grep, Glob and Read, and answer in under 30 lines: the files and line numbers that matter and one sentence each. Never edit anything.',
  tools: ['Read', 'Grep', 'Glob'],
};

/** The profiles that ship. Written to the store once (insert if absent), so an edit is never overwritten. */
const SEEDS: Array<Json> = [
  { name: 'chore', description: 'Small, well-understood changes: docs, config, a rename, a one-file fix.', model: 'sonnet', effort: 'low', costCapUsd: 2, wallCapMin: 45 },
  { name: 'feature', description: 'New behaviour or a real fix: reads the code first, tests, a draft PR.', model: 'opus', effort: 'medium', subagents: [FEATURE_EXPLORER], costCapUsd: 8, wallCapMin: 180 },
  {
    name: 'research', description: 'Read-only investigation. dontAsk permission mode; the report comes back as the run result.', model: 'sonnet', effort: 'medium',
    permissionMode: 'dontAsk', prompt: RESEARCH_PROMPT, subagents: [FEATURE_EXPLORER], costCapUsd: 3, wallCapMin: 60,
  },
  { name: 'quick', description: 'A one-file edit or a lookup. Cheapest and fastest; do not explore.', model: 'haiku', effort: 'low', costCapUsd: 1, wallCapMin: 20, idleAfterS: 120 },
];

let seeded = false;
/** Writes the seed profiles that are missing, once per process (a deleted seed stays deleted until a restart). */
async function ensureSeeds(): Promise<void> {
  if (seeded) return;
  for (const s of SEEDS) {
    const p = normalize(s.name, s);
    await repo().insertIfAbsent(p.name, toRow(p));
  }
  // 4bb5989 seeded research in `plan` mode, where the agent cannot run `pa run done`; move that untouched row to dontAsk.
  const old = await repo().byName('research');
  if (old && old.permission_mode === 'plan' && String(old.prompt || '').includes("plan permission mode")) {
    const s = SEEDS.find((x) => x.name === 'research') as Json;
    await repo().upsert('research', toRow(normalize('research', s)));
  }
  seeded = true;
}
/** For tests that switch stores. */
function resetSeeds(): void { seeded = false; }

async function list(): Promise<Profile[]> {
  await ensureSeeds();
  return ((await repo().list()) as Row[]).map(fromRow);
}

async function get(name: string | null | undefined): Promise<Profile | null> {
  if (!name) return null;
  await ensureSeeds();
  const r = await repo().byName(String(name).trim().toLowerCase());
  return r ? fromRow(r) : null;
}

/** Like get, but an unknown name is a 400 that lists the known ones. */
async function need(name: string): Promise<Profile> {
  const p = await get(name);
  if (!p) throw bad(`no profile "${name}" (known: ${(await list()).map((x) => x.name).join(', ') || 'none'})`);
  return p;
}

/** Creates or replaces a profile. */
async function save(name: string, input: Json): Promise<Profile> {
  await ensureSeeds();
  const p = normalize(name, input);
  return fromRow(await repo().upsert(p.name, toRow(p)));
}

async function remove(name: string): Promise<boolean> {
  await ensureSeeds();
  return (await repo().remove(String(name).trim().toLowerCase())) > 0;
}

// ------------------------------------------------- settings (B) ----

const ALIASES: Record<string, string> = {
  permission_mode: 'permissionMode', subagent_model: 'subagentModel', cost_cap_usd: 'costCapUsd',
  wall_cap_min: 'wallCapMin', idle_after_s: 'idleAfterS', repo_path: 'repoPath', repo: 'repoPath',
};
/** Pure: a patch with snake_case (and `repo`) keys renamed to the profile's camelCase ones. */
function canonical(patch: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(patch || {})) out[ALIASES[k] || k] = v;
  return out;
}

/** Pure: the shipped default of a seed profile (normalized), or null for a profile the user made. */
function seedOf(name: string): Profile | null {
  const s = SEEDS.find((x) => x.name === String(name).trim().toLowerCase());
  return s ? normalize(s.name, s) : null;
}

/**
 * Creates or changes a profile: only the fields in `patch` change (null clears one to "use the next
 * layer"); a new name starts from nothing. snake_case and camelCase keys both work. Returns the profile.
 */
async function update(name: string, patch: Json): Promise<Profile> {
  const n = String(name || '').trim().toLowerCase();
  const have = await get(n);
  const p = canonical(patch);
  // tools is {mcp, allow, deny}: a patch naming only one list leaves the others as they are.
  if (have && p.tools && typeof p.tools === 'object' && !Array.isArray(p.tools)) p.tools = { ...have.tools, ...p.tools };
  return save(n, { ...(have || {}), ...p });
}

/** Puts a seed profile back to what ships (its edits are lost). A profile the user made has no default: a 400. */
async function reset(name: string): Promise<Profile> {
  const s = seedOf(name);
  if (!s) throw bad(`"${name}" is not a built-in profile (${SEEDS.map((x) => x.name).join(', ')}): delete it instead`);
  await ensureSeeds();
  return fromRow(await repo().upsert(s.name, toRow(s)));
}

/** Pure: a profile with what the settings views add: whether it ships, and whether it differs from what ships. */
function describe(p: Profile): Profile & { seed: boolean; modified: boolean } {
  const s = seedOf(p.name);
  return { ...p, seed: Boolean(s), modified: s ? JSON.stringify(s) !== JSON.stringify(p) : false };
}

/** The Agents page's profile list: every profile with its seed/modified marks, plus the seeds that were deleted (so they can come back). */
async function view(): Promise<{ profiles: Array<Profile & { seed: boolean; modified: boolean }>; missingSeeds: string[] }> {
  const have = await list();
  return { profiles: have.map(describe), missingSeeds: SEEDS.map((s) => String(s.name)).filter((n) => !have.some((p) => p.name === n)) };
}

/** Pure: the default profile for a task kind (the planner's kinds, src/agent/plannerCore.ts), or null for "none". */
function profileForKind(kind: string | null | undefined): string | null {
  switch (kind) {
    case 'investigate': case 'review': return 'research';
    case 'coding': return 'feature';
    case 'admin': return 'chore';
    default: return null;
  }
}

// -------------------------------------------------------------- resolve ----

interface Resolved {
  profile: string | null;
  model: string;
  effort: string | null;
  permissionMode: string | null;
  costCapUsd: number;
  wallCapMin: number;
  idleAfterS: number;
  prompt: string;
  tools: Profile['tools'];
  subagents: Profile['subagents'];
  subagentModel: string | null;
  repoPath: string | null;
}

/**
 * Pure: one run's settings. Per field the first of: `explicit` (this call), `card` (the stored
 * build.card.<id> overrides), `profile`, `defaults`. Callers pass raw values; an unset one is null/undefined.
 */
function resolve({ explicit = {}, card = {}, profile = null, defaults }: { explicit?: Json; card?: Json; profile?: Profile | null; defaults: { model: string; costCapUsd: number; wallCapMin: number; idleAfterS: number } }): Resolved {
  const first = <T>(...vs: unknown[]): T | null => (vs.find((v) => v !== undefined && v !== null && v !== '') ?? null) as T | null;
  return {
    profile: profile ? profile.name : null,
    model: first<string>(explicit.model, card.model, profile?.model, defaults.model) as string,
    effort: first<string>(explicit.effort, card.effort, profile?.effort),
    permissionMode: first<string>(explicit.permissionMode, card.permissionMode, profile?.permissionMode),
    costCapUsd: Number(first(explicit.costCapUsd, card.costCapUsd, profile?.costCapUsd, defaults.costCapUsd)),
    wallCapMin: Number(first(explicit.wallCapMin, card.wallCapMin, profile?.wallCapMin, defaults.wallCapMin)),
    idleAfterS: Number(first(explicit.idleAfterS, card.idleAfterS, profile?.idleAfterS, defaults.idleAfterS)),
    prompt: profile?.prompt || '',
    tools: profile?.tools || { mcp: [], allow: [], deny: [] },
    subagents: profile?.subagents || [],
    subagentModel: profile?.subagentModel || null,
    repoPath: profile?.repoPath || null,
  };
}

// --------------------------------------------------------------- launch ----

const quote = (s: string): string => `"${s.replace(/"/g, '')}"`;

/** Pure: a claude command line with the permission mode applied. null leaves Build's default (bypass) alone. */
function withPermissionMode(line: string, mode: string | null): string {
  if (!mode || mode === 'bypassPermissions') return line;
  const stripped = line.replace(/\s--(?:allow-)?dangerously-skip-permissions\b/g, '').replace(/\s--permission-mode(?:=|\s+)\S+/g, '');
  return `${stripped} --permission-mode ${mode}`;
}

/**
 * Pure: what a resolved run adds to the claude command: `flags` (appended), `env` (for the session),
 * and `files` ({path, text}: subagent definitions, relative to the worktree). `mcpFile` is the path of
 * the --mcp-config file the caller wrote when tools.mcp is not empty; `pa` is the run's pa command's
 * script name, for the read-only allow rule.
 */
function launchFlags(r: Resolved, { mcpFile = null, pa = null }: { mcpFile?: string | null; pa?: string | null } = {}): { flags: string; env: Record<string, string>; files: Array<{ path: string; text: string }>; permissions: { allow: string[]; deny: string[] } } {
  let flags = '';
  const env: Record<string, string> = {};
  if (r.effort) flags += ` --effort ${r.effort}`;
  if (mcpFile) flags += ` --mcp-config ${quote(mcpFile)}`;
  const allow = [...r.tools.allow];
  // A read-only mode runs nothing that writes, and the agent's way home is the `pa run` verbs. Verified against
  // claude 2.1.327: `plan` ignores an allow rule for a command that writes (the model refuses it), `dontAsk`
  // honours it and denies everything else not read-only. The rule is the exact command line the prompt gives
  // the agent (a wildcard before `run` is refused by the CLI), for both shell tools Claude Code has on Windows.
  if ((r.permissionMode === 'dontAsk' || r.permissionMode === 'plan') && pa) allow.push(`Bash(${pa} run *)`, `PowerShell(${pa} run *)`);
  if (r.subagentModel && r.subagentModel !== 'inherit') env.CLAUDE_CODE_SUBAGENT_MODEL = r.subagentModel;
  const files = r.subagents.map((s) => ({ path: `.claude/agents/${s.name}.md`, text: agentFile(s) }));
  // Rules go to the run's --settings file, not --allowedTools: they hold quotes and spaces, and the command is
  // typed into pwsh, where a quote inside a quoted argument does not survive.
  return { flags, env, files, permissions: { allow, deny: [...r.tools.deny] } };
}

/** Pure: a subagent definition as Claude Code reads it (.claude/agents/<name>.md). */
function agentFile(s: Profile['subagents'][number]): string {
  const fm = [`name: ${s.name}`, `description: ${JSON.stringify(s.description)}`];
  if (s.model) fm.push(`model: ${s.model}`);
  if (s.tools.length) fm.push(`tools: ${s.tools.join(', ')}`);
  return `---\n${fm.join('\n')}\n---\n\n${s.prompt}\n`;
}

/**
 * Pure: does a profile (or a resolved run) only read and report? Claude Code's dontAsk and plan modes cannot
 * write; the report comes back as the run's result. A second opinion (BUILD-ENRICHMENT G) is allowed only
 * for these: coding tasks stay one agent (D30).
 */
function readOnly(p: { permissionMode?: string | null } | null | undefined): boolean {
  return p?.permissionMode === 'dontAsk' || p?.permissionMode === 'plan';
}

module.exports = {
  readOnly,
  MODELS, EFFORTS, PERMISSION_MODES, SEEDS,
  normalize, toRow, list, get, need, save, remove, resetSeeds, profileForKind, resolve, launchFlags, withPermissionMode, agentFile,
  canonical, seedOf, update, reset, describe, view,
};
