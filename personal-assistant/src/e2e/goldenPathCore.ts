'use strict';

// The golden path's rules (plan Track E, item E4), kept pure so they are tested
// without a stack: which hops there are and when each counts as reached, what
// every view's API must say about one run's id chain (E1), whether an API step
// was watchable (E2), and the report and timing table. The runner
// (goldenPath.js) does the I/O and asks this module what it saw.
//
//   parseOptions(flags, lists)            `pa e2e` flags → options (throws on nonsense)
//   observe(timeline, job, {at, output})  one factory status poll → hops newly reached
//   chainIds(job, start)                  the ids one run must be linked by
//   check*(…)                             one view's API against those ids → [{view, check, ok, detail}]
//   summarize / table                     the JSON report and the hop/timing table
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type Hop = { id: string; label: string; after?: string };
type Timeouts = Record<string, number>;
/** `pa e2e` flags as cli/args parsed them: a value, or true/false for a bare flag. */
type Flags = Record<string, string | boolean | undefined>;
type Lists = { timeout?: string[] };
type Options = {
  dryRun: boolean; sweep: boolean; keep: boolean; resume: boolean; json: boolean;
  runtime: string; model: string | null; repo: string; branch: string | null; poll: number; timeouts: Timeouts;
  stack: string | null; on: string | null; remotePath: string | null; report: string | null;
};
/** Hop id → when it was first seen (ms since epoch). */
type Timeline = Record<string, number | null | undefined>;
/** One job as the factory's `job status --json` prints it (JOBS-API v1.4). */
type Job = Json;
type StepSession = { id: string; machine: string | null; url: string | null; links: Json | null };
type Step = { step: string; story: number | null; runtime: string | null; persona: string | null; state: string | null; session: StepSession | null };
type Pr = { number: number | null; url: string; branch: string | null; story: number | null; state: string | null; ci: string | null };
type Ids = { card: string | null; run: number | null; job: string; state: string | null; steps: Step[]; prs: Pr[] };
type Check = { view: string; check: string; ok: boolean; detail?: string; skipped?: boolean };
type HopRow = { hop: string; label: string; reached: boolean; at: string | null; sinceStartS: number | null; hopS: number | null };
type Report = {
  ok: boolean; kind: string; marker: string | null; stack: string | null; variant: string | null; startedAt: string | null;
  hops: HopRow[]; ids: Ids | null; checks: Check[]; failed: string[]; errors: string[]; cleanup: string[];
};

const MARKER_RE = /\be2e-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

// card → job started → first session output → PR opened → CI done (PLAN.md E4).
const HOPS: Hop[] = [
  { id: 'card', label: 'card created' },
  { id: 'job_started', label: 'job started' },
  { id: 'first_output', label: 'first session output' },
  { id: 'pr_opened', label: 'PR opened' },
  { id: 'ci_done', label: 'CI done' },
];
// The resume variant kills the step after its first output and resumes the job.
const RESUME_HOPS: Hop[] = [
  { id: 'killed', label: 'step killed', after: 'first_output' },
  { id: 'resumed', label: 'job resumed', after: 'killed' },
];

// Seconds each hop may take, counted from the hop before it. `views` is how long
// every view's API may take to show the chain once the PR is open: the worker
// records it on its factory poll (PA_FACTORY_POLL_SECONDS, 120 s by default).
const DEFAULT_TIMEOUTS: Timeouts = {
  card: 60,
  job_started: 300,
  first_output: 600,
  killed: 120,
  resumed: 600,
  pr_opened: 5400,
  ci_done: 1800,
  views: 300,
};

const RUNTIMES = ['claude_session', 'api'];
const DEFAULT_REPO = 'xvanov/dev-tools';
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const STARTED = new Set(['triaging', 'in_progress', 'blocked', 'needs_human', 'done', 'failed']);

const USAGE = `pa e2e — the golden path, headless, against the live stack (plan E4)

  pa e2e [--runtime claude_session|api] [--model m] [--resume] [--branch name] [--keep]
         [--repo owner/name] [--poll 10] [--timeout hop=seconds]... [--json] [--report file]
  pa e2e --dry-run      check config and that every API answers; creates nothing
  pa e2e --sweep        close leftover e2e cards, PRs, jobs and sessions (by marker)
  pa e2e --on <machine> [same flags]  run it on a PA_MACHINES machine (the other stack) and
                                      collect its JSON report
  --stack work|personal  a label for the report

  Hops: card → job started → first session output → PR opened → CI done (+ killed, resumed
  with --resume). Timeouts per hop (seconds): ${Object.entries(DEFAULT_TIMEOUTS).map(([k, v]) => `${k}=${v}`).join(' ')}.
  Exits non-zero on any hop not reached or any link that does not resolve.`;

function bad(message: string): Error & { usage: true } {
  return Object.assign(new Error(message), { usage: true as const });
}

function str(flags: Flags, name: string): string | null {
  const v = flags[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function bool(flags: Flags, name: string): boolean {
  const v = flags[name];
  if (v === undefined || v === false) return false;
  if (v === true) return true;
  return !/^(0|false|no)$/i.test(String(v));
}

/**
 * Pure. `pa e2e` flags → options. A boolean flag that swallowed the next word
 * (`--keep foo`) is an error, not a silent value.
 */
function parseOptions(flags: Flags = {}, lists: Lists = {}): Options {
  for (const b of ['dry-run', 'sweep', 'keep', 'resume', 'json']) {
    if (typeof flags[b] === 'string' && !/^(0|1|true|false|yes|no)$/i.test(flags[b])) {
      throw bad(`--${b} takes no value (got "${flags[b]}")`);
    }
  }
  const runtime = str(flags, 'runtime') || 'claude_session';
  if (!RUNTIMES.includes(runtime)) throw bad(`--runtime is one of ${RUNTIMES.join(', ')}`);
  const model = str(flags, 'model');
  if (model && runtime !== 'api' && !/^claude/i.test(model)) {
    throw bad(`--model ${model} needs --runtime api (a claude_session step runs a Claude model)`);
  }
  const repo = str(flags, 'repo') || DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw bad(`--repo is owner/name (got "${repo}")`);
  const branch = str(flags, 'branch');
  if (branch && !/^[\w./-]{1,200}$/.test(branch)) throw bad(`--branch "${branch}" is not a branch name`);
  const timeouts = { ...DEFAULT_TIMEOUTS };
  for (const t of lists.timeout || []) {
    const m = /^([a-z_]+)=(\d+)$/.exec(String(t));
    if (!m || !((m[1] as string) in DEFAULT_TIMEOUTS)) throw bad(`--timeout wants hop=seconds, hop one of ${Object.keys(DEFAULT_TIMEOUTS).join(', ')} (got "${t}")`);
    timeouts[m[1] as string] = Number(m[2]);
  }
  const poll = flags.poll === undefined ? 10 : Number(flags.poll);
  if (!Number.isFinite(poll) || poll < 1 || poll > 600) throw bad('--poll is seconds between 1 and 600');
  const stack = str(flags, 'stack');
  if (stack && !['work', 'personal'].includes(stack)) throw bad('--stack is work or personal');
  const o: Options = {
    dryRun: bool(flags, 'dry-run'),
    sweep: bool(flags, 'sweep'),
    keep: bool(flags, 'keep'),
    resume: bool(flags, 'resume'),
    json: bool(flags, 'json'),
    runtime,
    model,
    repo,
    branch,
    poll,
    timeouts,
    stack,
    on: str(flags, 'on'),
    remotePath: str(flags, 'remote-path'),
    report: str(flags, 'report'),
  };
  if (o.dryRun && o.sweep) throw bad('--dry-run and --sweep are separate runs');
  return o;
}

/** Pure. The variant this run exercises, for the report. */
function variant(o: Pick<Options, 'runtime' | 'model' | 'resume' | 'branch'>): string {
  const parts = [o.runtime === 'api' ? `api${o.model ? `:${o.model}` : ''}` : 'claude_session'];
  if (o.resume) parts.push('resume');
  if (o.branch) parts.push(`branch:${o.branch}`);
  return parts.join('+');
}

/** Pure. The hops a run with these options must reach, in order. */
function hopsFor(o: { resume?: boolean } = {}): Hop[] {
  if (!o.resume) return HOPS.slice();
  const out: Hop[] = [];
  for (const h of HOPS) {
    out.push(h);
    if (h.id === 'first_output') out.push(...RESUME_HOPS.map(({ id, label }) => ({ id, label })));
  }
  return out;
}

/** Pure. The dummy card: small, real, harmless (PLAN.md Track E), tagged with the run's marker. */
function dummyCard(marker: string): { text: string; ask: string; title: string } {
  return {
    text: `Add a \`pa version\` verb that prints the served commit (${marker})`,
    ask:
      'In personal-assistant, add a `pa version` CLI verb that prints the commit the running worker serves ' +
      '(GET /api/version on the dashboard; when the dashboard does not answer, `git rev-parse --short HEAD` of the checkout, ' +
      'saying which it was). Add it to the HELP text and a unit test for the pure part. Keep it small. ' +
      `This is an automated golden-path run (${marker}): open a draft PR and do not merge it.`,
    title: `e2e: pa version verb (${marker})`,
  };
}

function storiesOf(job: Job | null | undefined): Json[] {
  return Array.isArray(job?.stories) ? job.stories : [];
}

function runsOf(job: Job | null | undefined): Json[] {
  return Array.isArray(job?.runs) ? job.runs : [];
}

function prNumberOf(n: unknown, url: unknown): number | null {
  if (Number.isInteger(Number(n)) && Number(n) > 0) return Number(n);
  const m = /\/pull\/(\d+)/.exec(String(url || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Pure. The ids one run is linked by, from the factory's own status
 * (JOBS-API v1.4) and what factory_start returned: card, run, job, every step
 * with its session, every PR with its story's branch.
 */
function chainIds(job: Job | null | undefined, start: { card?: unknown; run?: unknown; job?: unknown } = {}): Ids {
  const steps: Step[] = runsOf(job).map((r) => ({
    step: String(r.id),
    story: r.story_id != null ? Number(r.story_id) : null,
    runtime: r.runtime || null,
    persona: r.persona || null,
    state: r.state || null,
    session: r.session && r.session.termhub_session_id
      ? { id: String(r.session.termhub_session_id), machine: r.session.machine || null, url: r.session.url || null, links: r.session.links || null }
      : null,
  }));
  const prs: Pr[] = storiesOf(job)
    .filter((s) => s.pr_url)
    .map((s) => ({
      number: prNumberOf(s.pr_number, s.pr_url),
      url: s.pr_url,
      branch: s.branch || null,
      story: s.id != null ? Number(s.id) : null,
      state: s.pr_state || null,
      ci: s.ci?.state || null,
    }));
  return {
    card: start.card != null ? String(start.card) : null,
    run: start.run != null ? Number(start.run) : null,
    job: String(job?.job_id || start.job || ''),
    state: job?.state || null,
    steps,
    prs,
  };
}

/**
 * Pure. One factory status poll → the timeline with every hop it newly shows.
 * `output` is true once any step session has shown output (the runner reads
 * the scrollback). A hop is timestamped the first time it is seen, never
 * moved; a later hop seen at the same poll as an earlier one gets the same
 * time (the poll is the resolution).
 */
function observe(timeline: Timeline, job: Job | null | undefined, { at, output = false }: { at?: number; output?: boolean } = {}): { timeline: Timeline; reached: string[] } {
  const t: Timeline = { ...timeline };
  const reached: string[] = [];
  const mark = (id: string) => {
    if (t[id] == null) {
      t[id] = at;
      reached.push(id);
    }
  };
  const runs = runsOf(job);
  if (STARTED.has(job?.state) || runs.length) mark('job_started');
  if (output) mark('first_output');
  const stories = storiesOf(job);
  if (stories.some((s) => s.pr_url)) mark('pr_opened');
  if (stories.some((s) => s.pr_url && ['passing', 'failing'].includes(s.ci?.state))) mark('ci_done');
  return { timeline: t, reached };
}

/** Pure. The hop the run is waiting for, or null when all are reached. */
function nextHop(hops: Hop[], timeline: Timeline): Hop | null {
  return hops.find((h) => timeline[h.id] == null) || null;
}

/**
 * Pure. Whether the hop being waited for is past its timeout: counted from
 * the last hop reached before it (or the run's start).
 */
function overdue(hops: Hop[], timeline: Timeline, timeouts: Timeouts, now: number, t0: number): { hop: string; waitedS: number; limitS: number | undefined } | null {
  const h = nextHop(hops, timeline);
  if (!h) return null;
  const i = hops.indexOf(h);
  let since = t0;
  for (let k = i - 1; k >= 0; k--) {
    const seen = timeline[(hops[k] as Hop).id];
    if (seen != null) {
      since = seen;
      break;
    }
  }
  const limit = (timeouts[h.id] ?? 600) * 1000;
  return now - since > limit ? { hop: h.id, waitedS: Math.round((now - since) / 1000), limitS: timeouts[h.id] } : null;
}

/** Pure. The job ended without a PR: nothing more will come. */
function deadEnd(job: Job | null | undefined): boolean {
  return TERMINAL.has(job?.state) && !storiesOf(job).some((s) => s.pr_url);
}

// ------------------------------------------------------------- the views ----

function result(view: string, check: string, ok: unknown, detail: unknown = null): Check {
  const r: Check = { view, check, ok: Boolean(ok) };
  if (detail) r.detail = String(detail).slice(0, 300);
  return r;
}

/** Pure. The first object in `tree` whose `id` is `id` and that carries a `chain` list. */
function findCard(tree: unknown, id: unknown, seen: Set<object> = new Set()): Json | null {
  if (!tree || typeof tree !== 'object' || seen.has(tree)) return null;
  seen.add(tree);
  const node = tree as Json;
  if (!Array.isArray(tree) && String(node.id) === String(id) && Array.isArray(node.chain)) return node;
  for (const v of Array.isArray(tree) ? tree : Object.values(node)) {
    const f = findCard(v, id, seen);
    if (f) return f;
  }
  return null;
}

// One factoryCore.runChain entry against the ids (Plan board and card detail share the shape).
function checkChain(view: string, chain: unknown, ids: Ids): Check[] {
  const out: Check[] = [];
  const entry = (Array.isArray(chain) ? (chain as Json[]) : []).find((c) => Number(c.run) === ids.run);
  out.push(result(view, 'run on the card', entry, entry ? null : `no chain entry for run ${ids.run}`));
  if (!entry) return out;
  out.push(result(view, 'card ↔ run', String(entry.card) === ids.card, `card ${entry.card}`));
  out.push(result(view, 'run → job', entry.job === ids.job, `job ${entry.job}`));
  for (const s of ids.steps) {
    const got = ((entry.steps || []) as Json[]).find((x) => String(x.step) === s.step);
    out.push(result(view, `job → step ${s.step}`, got, got ? null : 'step missing'));
    if (got && s.session) out.push(result(view, `step ${s.step} → session`, got.session?.id === s.session.id, `session ${got.session?.id || 'none'}`));
  }
  for (const p of ids.prs) {
    const got = ((entry.prs || []) as Json[]).find((x) => Number(x.number) === p.number);
    out.push(result(view, `run → PR #${p.number}`, got, got ? `ci ${got.ci || 'none'}` : 'PR missing'));
  }
  return out;
}

/**
 * Pure. Plan: GET /api/state — the card on the board carries the whole chain.
 * A delivered job closes its card (dispatched → done), and the board shows
 * open cards only: a closed card is found in `closed` instead, and its chain
 * is left to the card detail check.
 */
function checkPlanBoard(state: Json | null | undefined, ids: Ids): Check[] {
  const card = findCard(state, ids.card);
  if (card) return [result('plan', 'card on the board', true), ...checkChain('plan', card.chain, ids)];
  const closed = (Array.isArray(state?.closed) ? (state.closed as Json[]) : []).find((c) => String(c.id) === ids.card);
  if (closed) return [result('plan', 'card on the board', true, `closed as ${closed.status || 'done'} (delivered); chain checked on the card detail`)];
  return [result('plan', 'card on the board', false, `card ${ids.card} not in /api/state (or has no chain)`)];
}

/** Pure. Plan: GET /api/commitments/:id — the card's own detail. */
function checkCardDetail(detail: Json | null | undefined, ids: Ids): Check[] {
  if (!detail || String(detail.id) !== ids.card) return [result('plan-card', 'card detail', false, detail?.error || 'no such card')];
  return [result('plan-card', 'card detail', true), ...checkChain('plan-card', detail.chain, ids)];
}

/** Pure. Build: GET /api/factory — the job links back to its run and card, its stories to the PR, its steps to sessions. */
function checkBuild(factory: Json | null | undefined, ids: Ids): Check[] {
  if (!factory || factory.enabled === false) return [result('build', 'factory board', false, 'the factory is not configured')];
  const jobs = (Object.values(factory.groups || {}) as Json[][]).flat();
  const job = jobs.find((j) => j.jobId === ids.job);
  const out = [result('build', 'job on the board', job, job ? `group ${job.group}` : `job ${ids.job} not in /api/factory`)];
  if (!job) return out;
  out.push(result('build', 'job → run', Number(job.paRun?.id) === ids.run, `run ${job.paRun?.id ?? 'none'}`));
  out.push(result('build', 'job → card', String(job.paRun?.card) === ids.card, `card ${job.paRun?.card ?? 'none'}`));
  for (const p of ids.prs) {
    out.push(result('build', `story → PR #${p.number}`, ((job.stories || []) as Json[]).some((s) => Number(s.prNumber) === p.number)));
  }
  for (const s of ids.steps) {
    const got = ((job.runs || []) as Json[]).find((r) => String(r.id) === s.step);
    out.push(result('build', `job → step ${s.step}`, got, got ? null : 'step missing'));
    if (got && s.session) out.push(result('build', `step ${s.step} → session`, got.session?.id === s.session.id, `session ${got.session?.id || 'none'}`));
  }
  return out;
}

/**
 * Pure. Run: termhub GET /api/sessions — each step's session is there, says
 * which job and step it belongs to, and is alive or has scrollback to review.
 * `sessionsByMachine` maps a machine name ('' for the factory's own) to its list.
 */
function checkRun(
  sessionsByMachine: Record<string, Json[] | null | undefined>,
  ids: Ids,
  { scrollback = {}, stopped = new Set() }: { scrollback?: Record<string, string | null | undefined>; stopped?: Set<string> } = {}
): Check[] {
  const out: Check[] = [];
  const withSession = ids.steps.filter((s): s is Step & { session: StepSession } => Boolean(s.session));
  if (!withSession.length) return [result('run', 'step sessions', false, 'no step has a session')];
  for (const s of withSession) {
    const list = sessionsByMachine[s.session.machine || ''] || sessionsByMachine[''] || [];
    const got = list.find((x) => String(x.id) === s.session.id);
    // The attempt the resume variant cancelled may be gone; the resumed one is checked.
    if (!got && stopped.has(s.session.id)) {
      out.push(result('run', `session ${s.session.id} (cancelled attempt)`, true, 'cancelled by --resume, not listed'));
      continue;
    }
    out.push(result('run', `session ${s.session.id} listed`, got, got ? null : `not in termhub /api/sessions${s.session.machine ? ` on ${s.session.machine}` : ''}`));
    if (!got) continue;
    const L = got.links || {};
    out.push(result('run', `session ${s.session.id} → job`, L.job === ids.job, `links.job ${L.job || 'none'}`));
    out.push(result('run', `session ${s.session.id} → step`, String(L.step) === s.step, `links.step ${L.step || 'none'}`));
    if (L.card != null) out.push(result('run', `session ${s.session.id} → card`, String(L.card) === ids.card, `links.card ${L.card}`));
    if (L.run != null) out.push(result('run', `session ${s.session.id} → run`, Number(L.run) === ids.run, `links.run ${L.run}`));
    const text = scrollback[s.session.id];
    out.push(result('run', `session ${s.session.id} watchable`, got.alive !== false || nonEmpty(text), got.alive !== false ? 'alive' : nonEmpty(text) ? 'ended, scrollback kept' : 'ended, no scrollback'));
  }
  return out;
}

/** Pure. MCP: the chat's `card` tool — the card's runs carry job, steps and PRs. */
function checkMcpCard(card: Json | null | undefined, ids: Ids): Check[] {
  const run = ((card?.runs || []) as Json[]).find((r) => Number(r.run) === ids.run);
  const out = [result('mcp', 'card tool → run', run, run ? null : `no run ${ids.run} on the card tool's answer`)];
  if (!run) return out;
  out.push(result('mcp', 'card tool → job', run.job === ids.job, `job ${run.job || 'none'}`));
  for (const s of ids.steps) out.push(result('mcp', `card tool → step ${s.step}`, ((run.steps || []) as Json[]).some((x) => String(x.step) === s.step)));
  for (const p of ids.prs) {
    out.push(result('mcp', `card tool → PR #${p.number}`, ((run.prs || []) as Json[]).some((x) => Number(x.number) === p.number || x.url === p.url)));
  }
  return out;
}

/** Pure. MCP: the chat's `factory_job` tool — back to the card, on to the PRs and sessions. */
function checkMcpJob(job: Json | null | undefined, ids: Ids): Check[] {
  if (!job || job.error) return [result('mcp', 'factory_job tool', false, job?.error || 'no answer')];
  const out = [result('mcp', 'factory_job → card', String(job.card) === ids.card, `card ${job.card ?? 'none'}`)];
  for (const p of ids.prs) out.push(result('mcp', `factory_job → PR #${p.number}`, ((job.stories || []) as Json[]).some((s) => Number(s.pr_number) === p.number)));
  for (const s of ids.steps) {
    const session = s.session;
    if (!session) continue;
    out.push(result('mcp', `factory_job → step ${s.step} session`, ((job.runs || []) as Json[]).some((r) => String(r.id) === s.step && r.session_id === session.id)));
  }
  return out;
}

/** Pure. GitHub: `gh pr view --json number,headRefName,isDraft,state` — the story's branch, a draft, still open. */
function checkGithub(pr: Json | null | undefined, want: { number: number | null; branch?: string | null }, { draft = true }: { draft?: boolean } = {}): Check[] {
  if (!pr || pr.error) return [result('github', `PR #${want.number}`, false, pr?.error || 'not found')];
  const out = [result('github', `PR #${want.number} exists`, Number(pr.number) === want.number)];
  if (want.branch) out.push(result('github', `PR #${want.number} head = story branch`, pr.headRefName === want.branch, `head ${pr.headRefName}, story ${want.branch}`));
  out.push(draft
    ? result('github', `PR #${want.number} is a draft`, pr.isDraft === true)
    : result('github', `PR #${want.number} is ready for review`, pr.isDraft === false));
  out.push(result('github', `PR #${want.number} not merged`, pr.state !== 'MERGED', `state ${pr.state}`));
  return out;
}

function stripAnsi(text: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]/g, '');
}

function nonEmpty(text: unknown): boolean {
  return stripAnsi(text).replace(/\s+/g, '').length > 0;
}

/**
 * Pure. E2: an API-runtime step must have had a termhub session from the
 * start, and its scrollback must show a model turn (some rendered output).
 * A claude_session run has no API step to check: reported as skipped.
 */
function checkWatchable(ids: Ids, { runtime, scrollback = {} }: { runtime?: string; scrollback?: Record<string, string | null | undefined> } = {}): Check[] {
  const api = ids.steps.filter((s) => s.runtime === 'api');
  if (runtime !== 'api' && !api.length) return [{ ...result('e2', 'API step watchable', true, 'no API step in this variant'), skipped: true }];
  if (!api.length) return [result('e2', 'API step watchable', false, 'the job reported no api-runtime step')];
  const out: Check[] = [];
  for (const s of api) {
    out.push(result('e2', `api step ${s.step} has a session`, s.session, s.session ? s.session.id : 'runs[].session is null'));
    if (s.session) out.push(result('e2', `api step ${s.step} shows a model turn`, nonEmpty(scrollback[s.session.id]), nonEmpty(scrollback[s.session.id]) ? null : 'scrollback empty'));
  }
  return out;
}

// --------------------------------------------------------------- report ----

/** Pure. The JSON report. `ok` only when every hop was reached and every check passed. */
function summarize({ marker, stack, options, hops, timeline, t0, checks = [], errors = [], cleanup = [], ids = null, dryRun = false }: {
  marker?: string | null; stack?: string | null; options?: Options | null; hops?: Hop[] | null; timeline?: Timeline | null; t0: number;
  checks?: Check[]; errors?: string[]; cleanup?: string[]; ids?: Ids | null; dryRun?: boolean;
}): Report {
  const hopRows: HopRow[] = (hops || []).map((h, i, all) => {
    const at = timeline?.[h.id] ?? null;
    let prev = t0;
    for (let k = i - 1; k >= 0; k--) {
      const seen = timeline?.[(all[k] as Hop).id];
      if (seen != null) {
        prev = seen;
        break;
      }
    }
    return {
      hop: h.id,
      label: h.label,
      reached: at != null,
      at: at != null ? new Date(at).toISOString() : null,
      sinceStartS: at != null ? round1((at - t0) / 1000) : null,
      hopS: at != null ? round1((at - prev) / 1000) : null,
    };
  });
  const failed = checks.filter((c) => !c.ok);
  const missed = hopRows.filter((h) => !h.reached);
  return {
    ok: !errors.length && !failed.length && !missed.length,
    kind: dryRun ? 'dry-run' : 'golden-path',
    marker: marker || null,
    stack: stack || null,
    variant: options ? variant(options) : null,
    startedAt: t0 != null ? new Date(t0).toISOString() : null,
    hops: dryRun ? [] : hopRows,
    ids,
    checks,
    failed: failed.map((c) => `${c.view}: ${c.check}${c.detail ? ` (${c.detail})` : ''}`),
    errors,
    cleanup,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pad(v: unknown, n: number): string {
  const s = String(v);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** Pure. The hop/timing table and the checks, as text. */
function table(report: Report): string {
  const lines: string[] = [];
  lines.push(`pa e2e ${report.kind} · ${report.variant || ''}${report.stack ? ` · ${report.stack} stack` : ''}${report.marker ? ` · ${report.marker}` : ''}`);
  if (report.hops.length) {
    lines.push('');
    lines.push(`  ${pad('hop', 22)}${pad('hop s', 10)}${pad('total s', 10)}`);
    for (const h of report.hops) {
      lines.push(`  ${pad(h.label, 22)}${pad(h.reached ? h.hopS : '-', 10)}${pad(h.reached ? h.sinceStartS : 'NOT REACHED', 10)}`);
    }
  }
  if (report.checks.length) {
    lines.push('');
    const byView = new Map<string, { ok: number; n: number }>();
    for (const c of report.checks) {
      const v = byView.get(c.view) || { ok: 0, n: 0 };
      v.n++;
      if (c.ok) v.ok++;
      byView.set(c.view, v);
    }
    lines.push(`  checks: ${[...byView].map(([v, s]) => `${v} ${s.ok}/${s.n}`).join(' · ')}`);
    for (const c of report.checks.filter((x) => !x.ok)) lines.push(`  FAIL ${c.view}: ${c.check}${c.detail ? ` — ${c.detail}` : ''}`);
    for (const c of report.checks.filter((x) => x.ok && x.skipped)) lines.push(`  skip ${c.view}: ${c.check}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  for (const e of report.errors) lines.push(`  ERROR ${e}`);
  for (const c of report.cleanup) lines.push(`  cleanup ${c}`);
  lines.push('');
  lines.push(report.ok ? '  OK' : '  FAILED');
  return lines.join('\n');
}

/** Pure. A `pa e2e` argv to pass on to another machine: only plain tokens, never --on or --report. */
function remoteArgv(flags: Flags = {}, lists: Lists = {}): string[] {
  const argv = ['e2e', '--json'];
  const SAFE = /^[\w./:=@-]+$/;
  for (const [k, v] of Object.entries(flags)) {
    if (['on', 'remote-path', 'report', 'json', 'timeout'].includes(k)) continue;
    if (v === true) argv.push(`--${k}`);
    else if (v === false) argv.push(`--no-${k}`);
    else {
      if (!SAFE.test(String(v))) throw bad(`--${k} "${v}" cannot be passed to another machine`);
      argv.push(`--${k}`, String(v));
    }
  }
  for (const t of lists.timeout || []) {
    if (!SAFE.test(String(t))) throw bad(`--timeout "${t}" cannot be passed to another machine`);
    argv.push('--timeout', String(t));
  }
  return argv;
}

module.exports = {
  MARKER_RE, HOPS, RESUME_HOPS, DEFAULT_TIMEOUTS, DEFAULT_REPO, TERMINAL, USAGE,
  parseOptions, variant, hopsFor, dummyCard, chainIds, observe, nextHop, overdue, deadEnd,
  findCard, checkPlanBoard, checkCardDetail, checkBuild, checkRun, checkMcpCard, checkMcpJob, checkGithub, checkWatchable,
  stripAnsi, nonEmpty, summarize, table, remoteArgv, prNumberOf,
};
