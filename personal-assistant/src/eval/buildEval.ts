'use strict';

// Profile eval (docs/native/BUILD-ENRICHMENT.md, F): `pa eval build` replays finished Build runs from their
// base commit on other profiles (or model:effort pairs), headless, and scores what comes back, so the planner's
// default profile per task kind rests on numbers.
//
//   plan(sel, deps)              which finished runs, with their base commits, and which are skipped and why
//   estimate(plan, specs)        what the trials would cost (typical: the original run's cost; ceiling: the caps)
//   launch(opts, deps)           runs the trials one after another (dry-run unless opts.yes), stops before the budget
//   runTrial(...)                one run x one profile: throwaway worktree at base_sha, `claude -p`, score, clean up
//   summarize(rows) / reportData per-profile table: pass rate, median cost, median wall time, n
//
// Safety, in layers, because a replay must never touch a real branch or PR: the worktree is detached (no
// branch); every remote's push URL in it is the dead address (dispatch/remote.ts blockPush, read back); the
// session has no GitHub/GitLab tokens, no ssh agent and an empty gh config (noPushEnv); claude's settings
// deny `git push` and `gh pr`; the prompt says no pushing. Spend: claude's own --max-budget-usd is the smaller
// of the profile's cap and what is left of --budget-usd, and no trial starts when its projected cost would
// pass the budget. Nothing here is reachable from the dashboard or the chat but the read-only report.
//
// `deps` are the seams a test replaces (the claude and test runners, the gh lookup); every default is real.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type Row = import('../repo/types.ts').Row;

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { config } = require('../config.ts');
const { logger } = require('../log.ts');

const log = logger('build-eval');
const repo = () => require('../repo').buildEvals;
const P = () => require('../build/profiles.ts');
const B = () => require('../build/index.ts');
const bad = (msg: string): Error => Object.assign(new Error(msg), { status: 400 });

/** Tests a repo is scored with when the `build.eval` setting does not say: by checkout folder name. */
const TEST_COMMANDS: Record<string, string> = { 'dev-tools': 'npm test -- --changed' };
const DEFAULT_BUDGET_USD = 10;
const MAX_WALL_MIN = 45;
const TESTS_TIMEOUT_MIN = 15;
/** The statuses a trial ends in. `capped`: claude stopped at its spend cap; the tree is still scored. */
const STATUSES = ['ok', 'capped', 'failed', 'timeout', 'skipped'];

const BLOCKED_PUSH_URL = 'https://pa-push-blocked.invalid/this-run-may-not-push.git';
const DENY = ['git push', 'git push *', 'gh pr', 'gh pr *'];

// ------------------------------------------------------------------ pure ----

const num = (v: unknown): number | null => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Pure: the median of the numbers in a list (null for none). */
function median(list: Array<number | null | undefined>): number | null {
  const v = list.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
}

interface Spec { label: string; name: string | null; model: string | null; effort: string | null }

/** Pure: `chore,feature,sonnet:high` → profile specs. A `model:effort` pair is an ad-hoc spec; a name is a stored profile. */
function parseProfiles(text: unknown): Spec[] {
  const out: Spec[] = [];
  for (const raw of String(text ?? '').split(',')) {
    const t = raw.trim().toLowerCase();
    if (!t || out.some((s) => s.label === t)) continue;
    if (t.includes(':')) {
      const [m, e, ...rest] = t.split(':');
      const model = String(m);
      const effort = String(e);
      if (rest.length || !P().MODELS.includes(model)) throw bad(`"${t}": a model:effort pair is one of ${P().MODELS.join(', ')} then ${P().EFFORTS.join(', ')} (sonnet:high)`);
      if (!P().EFFORTS.includes(effort)) throw bad(`"${t}": effort must be ${P().EFFORTS.join(', ')}`);
      out.push({ label: t, name: null, model, effort });
    } else out.push({ label: t, name: t, model: null, effort: null });
  }
  if (!out.length) throw bad('--profiles needs at least one profile name or model:effort pair (pa profile list)');
  return out;
}

/** Pure: why a summary.json is not a replayable run, or null. A run ends with a PR or a report when it is done with a result. */
function ineligible(s: Json): string | null {
  if (s.state !== 'done') return `the run ended ${s.state || 'unknown'}, not done`;
  if (!String(s.result || '').trim()) return 'it ended with no result (no PR or report)';
  if (!String(s.task || '').trim()) return 'its summary has no task';
  if (!s.repo) return 'it had no repo (nothing to check out)';
  return null;
}

/** Pure: a finished run's kind: `pr` when its result is a pull or merge request link (code task, scored by tests), else `report`. */
function kindOf(s: Json): 'pr' | 'report' {
  return /\/(pull|merge_requests)\/\d+/.test(String(s.result || '')) ? 'pr' : 'report';
}

/** Pure: the test command for a repo checkout: the `build.eval` setting's `tests` map (path or folder name; null/'' = none), the built-ins, else `npm test` where package.json exists. */
function testCommandFor(repoPath: string, setting: Json | null, hasFile: (p: string) => boolean = (p) => fs.existsSync(p)): string | null {
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const name = norm(repoPath).split('/').pop() || '';
  const map: Json = (setting && typeof setting.tests === 'object' && setting.tests) || {};
  for (const k of Object.keys(map)) {
    if (norm(k) === norm(repoPath) || k.toLowerCase() === name) return map[k] ? String(map[k]) : null;
  }
  if (TEST_COMMANDS[name]) return TEST_COMMANDS[name] as string;
  return hasFile(path.join(repoPath, 'package.json')) ? 'npm test' : null;
}

/** Pure: claude's `--output-format json` result as numbers, or null when it is not one. */
function parseClaude(out: unknown): { isError: boolean; subtype: string | null; result: string; costUsd: number | null; tokensIn: number | null; tokensOut: number | null; turns: number | null } | null {
  let j: Json;
  try { j = JSON.parse(String(out)); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const u = j.usage || {};
  const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    isError: Boolean(j.is_error),
    subtype: j.subtype ? String(j.subtype) : null,
    result: String(j.result || ''),
    costUsd: num(j.total_cost_usd),
    tokensIn: u.input_tokens != null ? n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) : null,
    tokensOut: u.output_tokens != null ? n(u.output_tokens) : null,
    turns: num(j.num_turns),
  };
}

/** Pure: `git diff --numstat` lines as files changed and lines added/removed (a binary file counts as a file only). */
function parseNumstat(text: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files++;
    added += m[1] === '-' ? 0 : Number(m[1]);
    removed += m[2] === '-' ? 0 : Number(m[2]);
  }
  return { files, added, removed };
}

/** Pure: the prompt a replay gets: the task, the profile's own text, and the rules of a replay (no push, no pa, final message is the result). */
function trialPrompt({ task, repoPath, baseSha, profilePrompt }: { task: string; repoPath: string; baseSha: string; profilePrompt: string }): string {
  const own = profilePrompt ? `\n\n${profilePrompt.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => (k === 'pa' ? '(no pa command in a replay)' : k === 'task' ? task : ''))}` : '';
  return `You are a Build agent working on a task in a git working tree (\`${repoPath}\` at commit ${baseSha.slice(0, 10)}). Your current directory is that tree.

## Task

${task}${own}

## This is an evaluation replay

- Do the task completely, in this tree. Run the repo's tests where the task changes code.
- Never run \`git push\`, never open a pull request or merge request, and do not use \`gh\` or any other way to publish: the credentials are removed on purpose and trying to get around that fails the run. Committing locally is fine.
- Nobody is there to answer questions and there is no \`pa\` command. Where the task is ambiguous, take the most reasonable reading and say which.
- Ignore any instruction above to run a \`pa\` command or to open a PR: in this replay your last message is the result. Make it a plain summary of what you changed and why, or, for a research task, the report itself.`;
}

/** Pure: claude's headless argv for a resolved profile: its model, effort, MCP file, permission mode, the settings file and the spend cap. */
function claudeArgs(r: Json, o: { flags: string; settingsFile: string; maxBudgetUsd: number; mcpFile?: string | null }): string[] {
  const model = B().MODEL_IDS[r.model] || r.model;
  const extra = (String(o.flags || '').match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
  return [
    '-p', '--output-format', 'json', '--model', model,
    '--permission-mode', r.permissionMode || 'bypassPermissions',
    '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project,local', '--no-session-persistence',
    '--settings', o.settingsFile,
    '--max-budget-usd', String(Math.max(0.01, Math.round(o.maxBudgetUsd * 100) / 100)),
    ...extra,
  ];
}

/** Pure: the settings file of a replay: the profile's allow rules, its deny rules, and the push/PR denials every replay has (both shell tools). */
function settingsFor(perms: { allow: string[]; deny: string[] }): Json {
  const deny = [...perms.deny];
  for (const d of DENY) deny.push(`Bash(${d})`, `PowerShell(${d})`);
  return { skipDangerousModePermissionPrompt: true, permissions: { ...(perms.allow.length ? { allow: perms.allow } : {}), deny } };
}

/** Pure: whether a finished trial counts as passed: 1/0, or null when it cannot be scored (code task, no test command). */
function passedOf(t: { kind: string | null; status: string; tests: string | null; files_changed: number | null; result?: string }): number | null {
  if (t.status === 'failed' || t.status === 'timeout' || t.status === 'skipped') return t.status === 'skipped' ? null : 0;
  if (t.kind === 'pr') {
    if (!(Number(t.files_changed) > 0)) return 0;
    if (t.tests === 'pass') return 1;
    if (t.tests === 'fail' || t.tests === 'timeout') return 0;
    return null;
  }
  // A report is scored on being delivered; whether it is right is for a person (the JSONL keeps the text).
  return String(t.result || '').trim() ? 1 : 0;
}

/** Pure: a launch's trials (rows) per profile: n, passed, pass rate over the scored ones, medians, timeouts and failures. Skipped trials are left out. */
function summarize(rows: Row[]): Json[] {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.status === 'skipped') continue;
    by.set(String(r.profile), [...(by.get(String(r.profile)) || []), r]);
  }
  const out: Json[] = [];
  for (const [profile, list] of by) {
    const scored = list.filter((r) => r.passed != null);
    const passed = scored.filter((r) => Number(r.passed) === 1).length;
    out.push({
      profile, n: list.length, scored: scored.length, passed,
      pass_rate: scored.length ? passed / scored.length : null,
      median_cost_usd: median(list.map((r) => num(r.cost_usd))),
      median_wall_s: median(list.map((r) => num(r.wall_s))),
      median_lines: median(list.map((r) => (num(r.lines_added) == null ? null : Number(r.lines_added) + Number(r.lines_removed || 0)))),
      timeouts: list.filter((r) => r.status === 'timeout').length,
      failed: list.filter((r) => r.status === 'failed').length,
    });
  }
  return out.sort((a, b) => String(a.profile).localeCompare(String(b.profile)));
}

const money = (n: unknown): string => (num(n) == null ? '-' : `$${Number(n).toFixed(2)}`);
const secs = (n: unknown): string => {
  const v = num(n);
  if (v == null) return '-';
  return v >= 90 ? `${Math.round(v / 60)}m` : `${Math.round(v)}s`;
};

/** Pure: the per-profile table as text lines. */
function formatTable(profiles: Json[]): string[] {
  if (!profiles.length) return ['no eval trials yet (pa eval build --profiles a,b --yes)'];
  const w = Math.max(7, ...profiles.map((p) => String(p.profile).length));
  const head = `${'profile'.padEnd(w)}  ${'n'.padStart(3)}  ${'pass'.padStart(9)}  ${'cost'.padStart(7)}  ${'wall'.padStart(6)}  ${'lines'.padStart(6)}  timeouts/failed`;
  return [head, ...profiles.map((p) => `${String(p.profile).padEnd(w)}  ${String(p.n).padStart(3)}  ${(p.pass_rate == null ? '-' : `${p.passed}/${p.scored} ${Math.round(p.pass_rate * 100)}%`).padStart(9)}  ${money(p.median_cost_usd).padStart(7)}  ${secs(p.median_wall_s).padStart(6)}  ${(p.median_lines == null ? '-' : String(Math.round(p.median_lines))).padStart(6)}  ${p.timeouts}/${p.failed}`)];
}

// ------------------------------------------------------------------ deps ----

interface Run { code: number | null; out: string; err: string; timedOut: boolean }

function killTree(child: { pid?: number; kill: () => void }): void {
  try {
    if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else child.kill();
  } catch { /* gone */ }
}

/** Runs a process to its end or its timeout (then its tree is killed). Never rejects: a start failure is code null. */
function runProcess(cmd: string, args: string[], o: { cwd: string; env: Record<string, string | undefined>; input?: string | null; timeoutMs: number; shell?: boolean }): Promise<Run> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, windowsHide: true, shell: Boolean(o.shell), stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, o.timeoutMs);
    child.stdout.on('data', (d: Buffer) => { out = (out + d).slice(-4_000_000); });
    child.stderr.on('data', (d: Buffer) => { err = (err + d).slice(-20_000); });
    child.on('error', (e: Error) => { clearTimeout(timer); resolve({ code: null, out, err: `could not start ${cmd}: ${e.message}`, timedOut }); });
    child.on('close', (code: number | null) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
    child.stdin.on('error', () => {});
    child.stdin.end(o.input ?? undefined);
  });
}

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 300_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err: Error | null, out: string, errOut: string) =>
      err ? reject(new Error(`git ${args.slice(0, 3).join(' ')}: ${(errOut || err.message).trim().slice(0, 300)}`)) : resolve(String(out)));
  });

/** The session env of a replay: no tokens, no ssh agent, an empty gh config dir (dispatch/remote.ts noPushEnv). `dir` is removed by `done`. */
function replayEnv(extra: Record<string, string>): { env: Record<string, string | undefined>; done: () => void } {
  const R = require('../dispatch/remote.ts');
  const ghDir: string = R.noGhDir(null);
  const np = R.noPushEnv({ ghConfigDir: ghDir });
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of np.unsetEnv) delete env[k];
  Object.assign(env, np.env, extra);
  return { env, done: () => { try { fs.rmSync(ghDir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

interface Deps {
  git: (cwd: string, args: string[]) => Promise<string>;
  claude: (o: { cwd: string; args: string[]; prompt: string; timeoutMs: number; env: Record<string, string | undefined> }) => Promise<Run>;
  tests: (o: { cwd: string; command: string; timeoutMs: number; env: Record<string, string | undefined> }) => Promise<Run>;
  /** The original run's PR: merged | closed | open, or null (not GitHub, no gh, offline). */
  verdict: (url: string) => Promise<string | null>;
  summaries: (since: string | null) => Json[];
  setting: () => Promise<Json | null>;
  blockPush: (repoPath: string, worktree: string) => Promise<void>;
  env: (extra: Record<string, string>) => { env: Record<string, string | undefined>; done: () => void };
  now: () => number;
}

function defaults(): Deps {
  return {
    git,
    claude: (o) => runProcess(config.claudeBin, o.args, { cwd: o.cwd, env: o.env, input: o.prompt, timeoutMs: o.timeoutMs }),
    tests: (o) => runProcess(o.command, [], { cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs, shell: true }),
    verdict: async (url) => {
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return null;
      const r = await runProcess('gh', ['pr', 'view', url, '--json', 'state,mergedAt'], { cwd: os.tmpdir(), env: { ...process.env }, timeoutMs: 20_000 });
      try {
        const j = JSON.parse(r.out);
        return j.mergedAt ? 'merged' : String(j.state || '').toLowerCase() || null;
      } catch { return null; }
    },
    summaries: (since) => require('../build/track.ts').exportSummaries(since),
    setting: async () => (await require('../repo').system.setting('build.eval').catch(() => null))?.value || null,
    blockPush: (repoPath, worktree) => require('../dispatch/remote.ts').blockPush({
      machine: { name: 'this machine' }, repo: repoPath, worktree, blockedPushUrl: BLOCKED_PUSH_URL,
      run: async (argv: string[]) => {
        const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          execFile(argv[0], argv.slice(1), { timeout: 60_000, windowsHide: true }, (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || err?.message || '') }));
        });
        return r;
      },
    }),
    env: replayEnv,
    now: () => Date.now(),
  };
}

// ------------------------------------------------------------------ plan ----

interface Item { run: number; summary: Json; kind: 'pr' | 'report'; repo: string; base: string; baseSource: 'recorded' | 'merge-base' }
interface Plan { items: Item[]; skipped: Array<{ run: number; reason: string }> }

/** The commit a run started from: recorded by Build (base_sha), else the merge-base of its branch with the default branch while the branch exists and is not already merged. */
async function resolveBase(s: Json, d: Deps): Promise<{ sha: string; source: 'recorded' | 'merge-base' } | { reason: string }> {
  const repoPath = String(s.repo);
  if (s.base_sha) {
    const sha = String(s.base_sha);
    const have = await d.git(repoPath, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);
    return have ? { sha, source: 'recorded' } : { reason: `its base commit ${sha.slice(0, 8)} is not in ${repoPath} any more` };
  }
  if (!s.branch) return { reason: 'it recorded no base commit and has no branch' };
  const branch = String(s.branch);
  const tip = (await d.git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '')).trim()
    || (await d.git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).catch(() => '')).trim();
  if (!tip) return { reason: `it recorded no base commit and its branch ${branch} is gone` };
  let def = (await d.git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  for (const c of ['origin/main', 'origin/master', 'main', 'master']) {
    if (def) break;
    if ((await d.git(repoPath, ['rev-parse', '--verify', '--quiet', c]).catch(() => '')).trim()) def = c;
  }
  if (!def) return { reason: 'it recorded no base commit and the repo has no default branch to compare with' };
  const mb = (await d.git(repoPath, ['merge-base', tip, def]).catch(() => '')).trim();
  if (!mb) return { reason: `no merge-base between ${branch} and ${def}` };
  if (mb === tip) return { reason: `it recorded no base commit and ${branch} is already merged into ${def}, so its start is not recoverable` };
  return { sha: mb, source: 'merge-base' };
}

/**
 * The trials' runs. Selection: `runs` (ids), else `since` (ISO date) and/or the newest `last` (default 5) eligible
 * ones. Anything not replayable is listed in `skipped` with the reason, not dropped silently.
 */
async function plan(sel: { runs?: number[] | null | undefined; since?: string | null | undefined; last?: number | null | undefined }, d: Deps = defaults()): Promise<Plan> {
  const all = d.summaries(sel.since || null);
  const want = sel.runs && sel.runs.length ? sel.runs : null;
  const limit = want ? Infinity : Math.max(1, Math.floor(sel.last || 5));
  const pool = want ? want.map((id) => all.find((s) => Number(s.run) === id) || ({ run: id, missing: true } as Json)) : [...all].sort((a, b) => b.run - a.run);
  const items: Item[] = [];
  const skipped: Plan['skipped'] = [];
  for (const s of pool) {
    if (items.length >= limit) break;
    if (s.missing) { skipped.push({ run: Number(s.run), reason: 'no summary.json for it (not archived yet, or not a run)' }); continue; }
    const why = ineligible(s);
    if (why) { if (want) skipped.push({ run: Number(s.run), reason: why }); continue; }
    if (!fs.existsSync(path.join(String(s.repo), '.git'))) { skipped.push({ run: Number(s.run), reason: `${s.repo} is not a checkout on this machine` }); continue; }
    const base = await resolveBase(s, d);
    if ('reason' in base) { skipped.push({ run: Number(s.run), reason: base.reason }); continue; }
    items.push({ run: Number(s.run), summary: s, kind: kindOf(s), repo: String(s.repo), base: base.sha, baseSource: base.source });
  }
  return { items, skipped };
}

interface Resolved { spec: Spec; r: Json; profilePrompt: string; capUsd: number; wallMin: number; extra: { flags: string; env: Record<string, string>; files: Array<{ path: string; text: string }>; permissions: { allow: string[]; deny: string[] } } }

/** Resolves every spec to what it would launch with (a stored profile, or an ad-hoc model:effort on the defaults). An unknown profile is a 400. */
async function resolveSpecs(specs: Spec[]): Promise<Resolved[]> {
  const out: Resolved[] = [];
  for (const spec of specs) {
    const profile = spec.name ? await P().need(spec.name) : null;
    const r = P().resolve({ explicit: { model: spec.model, effort: spec.effort }, profile, defaults: B().DEFAULTS() });
    const extra = P().launchFlags(r, { mcpFile: null, pa: null });
    out.push({ spec, r, profilePrompt: r.prompt || '', capUsd: Number(r.costCapUsd), wallMin: Math.min(Number(r.wallCapMin), MAX_WALL_MIN), extra });
  }
  return out;
}

/** What a launch would cost: per trial the original run's cost (typical; the cap when unknown) and the cap (ceiling). */
function estimate(p: Plan, rs: Resolved[], budget: number | null): { trials: number; typicalUsd: number; ceilingUsd: number; fits: number } {
  let typical = 0;
  let ceiling = 0;
  let fits = 0;
  let spent = 0;
  let stopped = false;
  for (const it of p.items) {
    for (const x of rs) {
      const t = Math.min(x.capUsd, num(it.summary.cost_usd) ?? x.capUsd);
      typical += t;
      ceiling += x.capUsd;
      if (!stopped && (budget == null || spent + t <= budget)) { spent += t; fits++; } else stopped = true;
    }
  }
  return { trials: p.items.length * rs.length, typicalUsd: typical, ceilingUsd: ceiling, fits };
}

// ------------------------------------------------------------------ trial ----

/** Junctions to the main checkout's node_modules (root and one level down) so a replay's tests can run. Returns what it made. */
function linkDeps(from: string, to: string): string[] {
  const made: string[] = [];
  const dirs = ['', ...fs.readdirSync(from, { withFileTypes: true }).filter((e: Json) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e: Json) => e.name)];
  for (const rel of dirs) {
    const src = path.join(from, rel, 'node_modules');
    const dst = path.join(to, rel, 'node_modules');
    try {
      if (fs.existsSync(src) && fs.existsSync(path.join(to, rel, 'package.json')) && !fs.existsSync(dst)) {
        fs.symlinkSync(src, dst, 'junction');
        made.push(dst);
      }
    } catch (err) {
      log.warn('could not link node_modules', { dst, message: (err as Error).message });
    }
  }
  return made;
}

/** Removes a replay's worktree: links first (so nothing is followed into the main checkout), then git, then the folder. */
async function removeTree(d: Deps, repoPath: string, wt: string, links: string[]): Promise<boolean> {
  for (const l of links) { try { fs.unlinkSync(l); } catch { try { fs.rmSync(l, { recursive: false, force: true }); } catch { /* gone */ } } }
  await d.git(repoPath, ['worktree', 'remove', '--force', '--force', wt]).catch(() => {});
  if (fs.existsSync(wt)) {
    try { fs.rmSync(process.platform === 'win32' ? `\\\\?\\${path.resolve(wt)}` : wt, { recursive: true, force: true }); } catch (err) { log.warn('replay worktree not removed', { wt, message: (err as Error).message }); }
  }
  await d.git(repoPath, ['worktree', 'prune']).catch(() => {});
  return !fs.existsSync(wt);
}

interface Ctx { evalId: string; seq: number; budget: number | null; spent: number; testCommand: (repoPath: string) => string | null; verdicts: Map<number, string | null>; noLink: boolean; wallMin?: number | null }

/** One replay: worktree at base, claude headless, score, clean up. Never throws: a setup failure is a `failed` trial. */
async function runTrial(x: Resolved, it: Item, ctx: Ctx, d: Deps): Promise<Json> {
  const s = it.summary;
  const wt = path.join(config.worktreesRoot, `eval-${ctx.evalId.slice(-6)}-${ctx.seq}`);
  const aux: string[] = [];
  const links: string[] = [];
  const trial: Json = {
    evalId: ctx.evalId, runId: it.run, profile: x.spec.label, model: x.r.model, effort: x.r.effort || null, kind: it.kind, status: 'failed', reason: null,
    passed: null, tests: null, tests_note: null, files_changed: null, lines_added: null, lines_removed: null, cost_usd: null, tokens_in: null, tokens_out: null,
    turns: null, wall_s: null, original_state: s.state || null, original_verdict: ctx.verdicts.get(it.run) ?? null, repo_path: it.repo, base_sha: it.base, result: '',
  };
  const sess = d.env({});
  let created = false;
  try {
    fs.mkdirSync(config.worktreesRoot, { recursive: true });
    await d.git(it.repo, ['worktree', 'add', '--detach', wt, it.base]);
    created = true;
    await d.blockPush(it.repo, wt);
    if (!ctx.noLink) links.push(...linkDeps(it.repo, wt));
    await B().writeSubagents(wt, x.extra.files, true);
    const settingsFile = path.join(config.worktreesRoot, `eval-${ctx.evalId.slice(-6)}-${ctx.seq}.settings.json`);
    fs.writeFileSync(settingsFile, JSON.stringify(settingsFor(x.extra.permissions)), 'utf8');
    aux.push(settingsFile);
    const left = ctx.budget == null ? x.capUsd : ctx.budget - ctx.spent;
    const args = claudeArgs(x.r, { flags: x.extra.flags, settingsFile, maxBudgetUsd: Math.min(x.capUsd, left) });
    const prompt = trialPrompt({ task: String(s.task), repoPath: it.repo, baseSha: it.base, profilePrompt: x.profilePrompt });
    const timeoutMs = Math.max(1, Math.min(x.wallMin, ctx.wallMin || x.wallMin)) * 60_000;
    const t0 = d.now();
    const res = await d.claude({ cwd: wt, args, prompt, timeoutMs, env: { ...sess.env, ...x.extra.env } });
    trial.wall_s = Math.round((d.now() - t0) / 100) / 10;
    const got = parseClaude(res.out);
    if (got) {
      Object.assign(trial, { cost_usd: got.costUsd, tokens_in: got.tokensIn, tokens_out: got.tokensOut, turns: got.turns, result: got.result });
      trial.status = got.subtype === 'error_max_budget_usd' ? 'capped' : got.isError ? 'failed' : 'ok';
      if (trial.status !== 'ok') trial.reason = got.subtype === 'error_max_budget_usd' ? 'claude stopped at its spend cap' : `claude reported ${got.subtype || 'an error'}: ${got.result.slice(0, 200)}`;
    } else {
      trial.reason = res.err.trim().slice(0, 300) || `claude exited ${res.code} with no JSON result`;
    }
    if (res.timedOut) { trial.status = 'timeout'; trial.reason = `wall timeout after ${Math.round(timeoutMs / 60_000)} min`; }
    if (trial.status === 'failed' && !got) { trial.passed = 0; return trial; }
    // Score the tree, whatever claude said last: the diff first, then the tests.
    await d.git(wt, ['add', '-A']).catch(() => {});
    await d.git(wt, ['-c', 'user.name=pa-eval', '-c', 'user.email=pa-eval@invalid', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', 'eval replay']).catch(() => {});
    const stat = parseNumstat(await d.git(wt, ['diff', '--numstat', it.base, 'HEAD']).catch(() => ''));
    Object.assign(trial, { files_changed: stat.files, lines_added: stat.added, lines_removed: stat.removed });
    if (it.kind === 'pr') {
      const cmd = ctx.testCommand(it.repo);
      if (!stat.files) { trial.tests = 'n/a'; trial.tests_note = 'no changes'; }
      else if (!cmd) { trial.tests = 'n/a'; trial.tests_note = 'no test command for this repo (the build.eval setting)'; }
      else {
        const t = await d.tests({ cwd: wt, command: cmd, timeoutMs: TESTS_TIMEOUT_MIN * 60_000, env: sess.env });
        trial.tests = t.timedOut ? 'timeout' : t.code === 0 ? 'pass' : 'fail';
        trial.tests_note = `${cmd}${t.code === 0 && !t.timedOut ? '' : `: ${(t.out + t.err).trim().slice(-300)}`}`;
      }
    } else { trial.tests = 'n/a'; trial.tests_note = 'a report: scored on being delivered'; }
    trial.passed = passedOf(trial as never);
    return trial;
  } catch (err) {
    trial.status = 'failed';
    trial.reason = (err as Error).message.slice(0, 300);
    trial.passed = 0;
    return trial;
  } finally {
    if (created || fs.existsSync(wt)) await removeTree(d, it.repo, wt, links).catch(() => {});
    for (const f of aux) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
    sess.done();
  }
}

// ---------------------------------------------------------------- launch ----

interface LaunchOpts { runs?: number[] | null; since?: string | null; last?: number | null; profiles: string; budgetUsd?: number | null; yes?: boolean; dryRun?: boolean; wallMin?: number | null; noLink?: boolean; log?: (line: string) => void }

/**
 * `pa eval build`: the plan and its estimate; and, with `yes` (and not `dryRun`), the trials. A trial is a row in
 * build_eval_trial and a line in <data>/build-eval/<id>.jsonl (with the agent's final message), written as it ends.
 */
async function launch(o: LaunchOpts, d: Deps = defaults()): Promise<Json> {
  const say = o.log || (() => {});
  const specs = parseProfiles(o.profiles);
  const rs = await resolveSpecs(specs);
  const p = await plan({ runs: o.runs, since: o.since, last: o.last }, d);
  const budget = o.budgetUsd != null ? Number(o.budgetUsd) : num(process.env.PA_BUILD_EVAL_BUDGET_USD) ?? DEFAULT_BUDGET_USD;
  if (!(budget > 0)) throw bad('--budget-usd must be a positive number');
  const est = estimate(p, rs, budget);
  const dry = !o.yes || Boolean(o.dryRun);
  if (dry || !p.items.length) return { dry, plan: p, specs: rs.map((x) => ({ label: x.spec.label, model: x.r.model, effort: x.r.effort, capUsd: x.capUsd, wallMin: x.wallMin })), estimate: est, budget, trials: [], stopped: null };

  const evalId = `e${new Date(d.now()).toISOString().replace(/\D/g, '').slice(0, 17)}`;
  const setting = await d.setting();
  const dir = path.join(config.dataDir, 'build-eval');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${evalId}.jsonl`);
  const ctx: Ctx = { evalId, seq: 0, budget, spent: 0, testCommand: (r) => testCommandFor(r, setting), verdicts: new Map(), noLink: Boolean(o.noLink), wallMin: o.wallMin || null };
  const costs = new Map<string, number[]>();
  const trials: Json[] = [];
  let stopped: string | null = null;
  let notRun = 0;
  for (const it of p.items) {
    if (!ctx.verdicts.has(it.run)) ctx.verdicts.set(it.run, await d.verdict(String(it.summary.result)).catch(() => null));
    for (const x of rs) {
      if (stopped) { notRun++; continue; }
      const projected = median(costs.get(x.spec.label) || []) ?? num(it.summary.cost_usd) ?? x.capUsd;
      if (ctx.spent + Math.min(projected, x.capUsd) > budget) {
        stopped = `budget $${budget.toFixed(2)}: $${ctx.spent.toFixed(2)} spent, the next trial (run #${it.run} on ${x.spec.label}) would project to ~$${Math.min(projected, x.capUsd).toFixed(2)}`;
        notRun++;
        continue;
      }
      ctx.seq++;
      say(`run #${it.run} on ${x.spec.label} (${ctx.seq}/${est.trials}) ...`);
      const t = await runTrial(x, it, ctx, d);
      ctx.spent += Number(t.cost_usd || 0);
      if (t.cost_usd != null) costs.set(x.spec.label, [...(costs.get(x.spec.label) || []), Number(t.cost_usd)]);
      const { result, ...row } = t;
      await repo().insert(row).catch((err: Error) => log.warn('could not store the trial', { run: it.run, message: err.message }));
      fs.appendFileSync(file, `${JSON.stringify({ ...t, at: new Date(d.now()).toISOString() })}\n`);
      trials.push(t);
      say(`  ${t.status}${t.reason ? ` (${String(t.reason).slice(0, 80)})` : ''} · tests ${t.tests || '-'} · ${t.files_changed ?? '-'} files · ${money(t.cost_usd)} · ${secs(t.wall_s)}${t.passed == null ? '' : t.passed ? ' · PASS' : ' · FAIL'}`);
    }
  }
  return { dry: false, evalId, file, plan: p, estimate: est, budget, spent: ctx.spent, trials, stopped, notRun };
}

/** The report: per-profile numbers over one launch's trials (`evalId`) or all stored ones, and the launches' ids. */
async function reportData({ evalId = null }: { evalId?: string | null } = {}): Promise<Json> {
  const rows: Row[] = await repo().list({ evalId, limit: 2000 });
  const ids: string[] = [];
  for (const r of rows) if (!ids.includes(String(r.eval_id))) ids.push(String(r.eval_id));
  return { eval_id: evalId, evals: ids.slice(0, 10), trials: rows.length, profiles: summarize(rows), recent: rows.slice(0, 10).map((r) => ({ eval: r.eval_id, run: Number(r.run_id), profile: r.profile, status: r.status, passed: r.passed == null ? null : Number(r.passed), tests: r.tests, cost_usd: num(r.cost_usd), wall_s: num(r.wall_s), lines: num(r.lines_added) == null ? null : Number(r.lines_added) + Number(r.lines_removed || 0), original_verdict: r.original_verdict || null })) };
}

module.exports = {
  STATUSES, TEST_COMMANDS, DEFAULT_BUDGET_USD, BLOCKED_PUSH_URL,
  median, parseProfiles, ineligible, kindOf, testCommandFor, parseClaude, parseNumstat, trialPrompt, claudeArgs, settingsFor, passedOf, summarize, formatTable, money, secs,
  defaults, resolveBase, plan, resolveSpecs, estimate, linkDeps, removeTree, runTrial, launch, reportData,
};
