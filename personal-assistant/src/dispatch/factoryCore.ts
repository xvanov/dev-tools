'use strict';

// The pure half of the factory route (src/dispatch/factory.ts): how a PA run
// becomes a `factory job submit` command line, and what a job's status means
// for the run row and its commitment. No database, no processes, so every rule
// here is a test away (test/factoryDispatch.test.js).
//
// The one interface is the factory's job contract (software-factory
// docs/JOBS-API.md, v1, and the v1.2 additions: job kinds, runtimes, runs,
// reports — every v1.2 field optional, so a v1 factory still works for code
// jobs). The PA never imports factory code or reads its
// sqlite: it runs `uv run factory job …` on the factory's machine and parses
// the single JSON object each `--json` command prints.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** A job as the factory's `--json` commands print it (JOBS-API.md): read field by field, every v1.2 field optional. */
type Job = import('../types.ts').Json;
/** A run row (sql/001) or the PA run a job came from: loose until the run repository's rows are typed. */
type RunRow = import('../types.ts').Json;
type ExecResult = { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean };
type PrLink = { url: string; number: number | null; story_id: number | null; state: string | null; ci_state: string | null; ci_failing: string[] | null };
type StepLink = { step_id: string; job_id: string | null; story_id: number | null; persona: string | null; runtime: string | null; model: string | null; state: string | null; started_at: string | null; ended_at: string | null; machine: string | null; termhub_session_id: string | null; url: string | null };
type Notice = { key: string; title: string; body: string; url: string | null };
type NoticeMemo = Map<string, { state: string; ciFailing: boolean }>;
type JobView = ReturnType<typeof jobView>;

// Delivery levels are the shared vocabulary in deliveryCore.ts. The operator
// chooses one per job (operator decision 2026-11-02, no ceiling) and it is
// sent on every submit; a legacy PA mode no longer decides it.
const { DELIVERIES } = require('./deliveryCore.ts');
const PIPELINES = ['chain', 'solo', 'auto'];
const STATES = ['queued', 'triaging', 'in_progress', 'blocked', 'needs_human', 'done', 'failed', 'cancelled'];
const ACTIVE_STATES = new Set(['queued', 'triaging', 'in_progress', 'blocked', 'needs_human']);

// `<app>:<direction_id>`. Checked before it is ever typed into a terminal
// (the walk-in session's command line), so it can carry nothing a shell reads.
const JOB_ID = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;
const PERSONA = /^[A-Za-z0-9_-]+$/;
const MODEL = /^[A-Za-z0-9_.:/@-]+$/;
// A plain git branch name: no leading '-', no '..', no spaces or shell syntax.
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]{1,200}(?<!\/)$/;

function pipeline(name: string | null | undefined): string {
  const p = String(name || 'auto').toLowerCase();
  if (!PIPELINES.includes(p)) throw new Error(`unknown pipeline "${name}" — one of: ${PIPELINES.join(', ')}`);
  return p;
}

/**
 * Per-persona model overrides, from config and flags: `persona=model`, one per
 * entry or comma-separated. Later entries win. A malformed one is an error,
 * not a silent drop: a run on the wrong model is a measurement you trust.
 * @param {Array<string>|string} list
 * @returns {Object<string,string>}
 */
function parseModels(list: string[] | string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = (Array.isArray(list) ? list : [list])
    .flatMap((s) => String(s ?? '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const e of entries) {
    const eq = e.indexOf('=');
    const persona = eq > 0 ? e.slice(0, eq).trim() : '';
    const model = eq > 0 ? e.slice(eq + 1).trim() : '';
    if (!PERSONA.test(persona) || !MODEL.test(model)) throw new Error(`model override "${e}" — want persona=model_id`);
    out[persona] = model;
  }
  return out;
}

/**
 * `uv run factory …` — the factory's CLI, run from its checkout. `uv` is the
 * program to run (PA_FACTORY_UV): termhub's own PATH often lacks ~/.local/bin.
 */
function factoryArgv(sub: string[], uv: string | null | undefined = 'uv'): string[] {
  return [uvBinary(uv), 'run', 'factory', ...sub];
}

// A path or a bare program name. The walk-in session types it into a shell,
// so it may hold nothing a shell reads. A Windows path (`C:\…\uv.exe`) is
// allowed: a drive prefix and backslashes, still no spaces or shell syntax.
const UV = /^(?:[A-Za-z]:)?[A-Za-z0-9_./~\\-]+$/;
function uvBinary(uv: string | null | undefined): string {
  const v = String(uv || 'uv').trim();
  if (!UV.test(v)) throw new Error(`PA_FACTORY_UV "${v}" — want a path or a program name`);
  return v;
}

// ---- v1.2: what kind of work, and who does it (JOBS-API v1.2) ---------------
// code      a direction → stories → PRs at the job's delivery level (v1's only kind)
// research  answer a question; the deliverable is a report the factory keeps
// report    write a document; same deliverable, same rules
// A research/report job delivers `none` (no branch, no PR) and needs no repo.
const KINDS = ['code', 'research', 'report'];
// api             the factory's own model routing (LiteLLM, API keys: metered)
// claude_session  Claude Code on the factory machine (the operator's subscription)
const RUNTIMES = ['api', 'claude_session'];

function jobKind(name: string | null | undefined): string {
  const k = String(name || 'code').toLowerCase().trim();
  if (!KINDS.includes(k)) throw new Error(`unknown kind "${name}" — one of: ${KINDS.join(', ')}`);
  return k;
}

function runtime(name: string | null | undefined): string {
  const r = String(name || 'api').toLowerCase().trim().replace(/-/g, '_');
  const v = r === 'claude' || r === 'subscription' ? 'claude_session' : r;
  if (!RUNTIMES.includes(v)) throw new Error(`unknown runtime "${name}" — one of: ${RUNTIMES.join(', ')}`);
  return v;
}

/**
 * The ask for a research/report job: the operator's own words and the
 * questions it must answer. No composing model — the ask is short, the user's,
 * and nothing in it is private material gathered by the assistant.
 */
function researchAsk({ kind, title, ask = null, done = [], repo = null }: { kind: string; title: string; ask?: string | null; done?: string[] | null; repo?: string | null }): string {
  const { redactSecrets } = require('./composeCore.ts');
  const k = jobKind(kind);
  if (k === 'code') throw new Error('researchAsk is for research and report jobs');
  const lines = [
    `# ${k === 'report' ? 'Write' : 'Research'}: ${clip(redactSecrets(title), 200)}`,
    '',
    k === 'report'
      ? 'Write the document asked for below as markdown. It is the deliverable: no code changes, no branch, no PR.'
      : 'Investigate the question below and answer it in a markdown report: what you found, the evidence (files, links, commands run), and what you are unsure of. No code changes, no branch, no PR.',
    '',
    '## The ask',
    '',
    redactSecrets(String(ask || title)).trim(),
  ];
  if (repo) lines.push('', `Repository: ${repo} (read it; change nothing).`);
  const qs = (done || []).map((d) => redactSecrets(String(d)).trim()).filter(Boolean);
  if (qs.length) lines.push('', `## ${k === 'report' ? 'It must cover' : 'Questions it must answer'}`, '', ...qs.map((q) => `- ${q}`));
  return `${lines.join('\n')}\n`;
}

/**
 * The `factory job submit` argv for one PA run. `externalId` is the run id:
 * the factory makes (source, external-id) idempotent, so a resubmit after a
 * lost answer returns the same job instead of a second one.
 */
//
// `kind` and `runtime` (v1.2) are sent when given; a v1 factory refuses the
// unknown flags (`unsupported_option`) and factory.ts resends a plain code/api
// job without them. A research/report job needs no app and delivers `none`.
//
// `branch` / `pr` continue existing work: the job starts on that branch or
// that PR's head instead of a fresh one (`job submit --branch|--pr`, a
// factory newer than v1.2; an older one refuses the flag in its parser).
function submitArgv({ app, title, ask = null, askFile = null, flowFile = null, done = [], pipeline: pipe = 'auto', delivery, models = {}, externalId, source = 'pa', kind = null, runtime: rt = null, branch = null, pr = null }: {
  app?: string | null;
  title: string;
  ask?: string | null;
  askFile?: string | null;
  flowFile?: string | null;
  done?: string[];
  pipeline?: string | null;
  delivery: string;
  models?: Record<string, string> | null;
  externalId: string | number | null | undefined;
  source?: string;
  kind?: string | null;
  runtime?: string | null;
  branch?: string | null;
  pr?: number | string | null;
}): string[] {
  const k = kind == null ? 'code' : jobKind(kind);
  if (!app && k === 'code') throw new Error('submit needs a factory app');
  if (!title) throw new Error('submit needs a title');
  if (!ask && !askFile) throw new Error('submit needs the ask');
  if (externalId === undefined || externalId === null || externalId === '') throw new Error('submit needs an external id');
  if (!DELIVERIES.includes(delivery)) throw new Error(`unknown delivery "${delivery}"`);
  if (k !== 'code' && delivery !== 'none') throw new Error(`a ${k} job delivers a report, not ${delivery} — its delivery is none`);
  if (branch != null && pr != null) throw new Error('continue a branch or a PR, not both');
  if ((branch != null || pr != null) && k !== 'code') throw new Error('only a code job continues a branch or PR');
  if (branch != null && !BRANCH.test(String(branch))) throw new Error(`"${branch}" is not a branch name`);
  if (pr != null && !(Number.isInteger(Number(pr)) && Number(pr) > 0)) throw new Error(`"${pr}" is not a PR number`);
  // Free text goes as `--flag=value`: a title or criterion that starts with
  // "-" must not be read as an option by the factory's CLI parser.
  // The title and criteria are on the factory's command line (visible in `ps`)
  // and in its direction: redacted like the brief.
  const { redactSecrets } = require('./composeCore.ts');
  const argv = ['job', 'submit', '--json'];
  if (app) argv.push('--app', String(app));
  argv.push(`--title=${clip(redactSecrets(title), 200)}`);
  if (kind != null) argv.push('--kind', k);
  if (rt != null) argv.push('--runtime', runtime(rt));
  if (askFile) argv.push('--ask-file', String(askFile));
  else argv.push(`--ask=${String(ask)}`);
  // The factory's backpressure gate needs a flow.md (or an api_spec.md): a
  // job without one parks as needs_human every time (JOBS-API.md v1.1).
  if (flowFile) argv.push('--flow-file', String(flowFile));
  for (const d of done) argv.push(`--done=${redactSecrets(String(d))}`);
  if (branch != null) argv.push(`--branch=${branch}`);
  if (pr != null) argv.push('--pr', String(Number(pr)));
  argv.push('--pipeline', pipeline(pipe), '--delivery', delivery);
  for (const [persona, model] of Object.entries(models || {})) argv.push('--model', `${persona}=${model}`);
  argv.push('--source', source, '--external-id', String(externalId));
  return argv;
}

// The factory's own refusals of a submit, raised BEFORE it writes anything
// (software-factory factory/jobs/submit.py, job_routing.py). Only these mean
// "no job was made"; any other error after a submit went out (`internal`,
// `conflict`, …) may have come after the direction was written, so the run is
// settled against the factory instead of failed. `duplicate_key` is ours: a
// first submit that came back `created: false` (someone else's job holds the key).
const REFUSAL_CODES = new Set([
  'unknown_repo', 'unknown_app', 'invalid_app_config', 'missing_argument', 'invalid_argument', 'bad_pipeline',
  'invalid_delivery', 'file_unreadable', 'bad_model_flag', 'bad_models', 'unknown_persona', 'bad_model_id',
  'review_independence', 'pipeline_unavailable', 'duplicate_key',
  // v1.2 refusals.
  'invalid_kind', 'invalid_runtime', 'runtime_unavailable',
  // v1.3 (`--branch` / `--pr`): submit asks GitHub before writing anything,
  // and refuses work it cannot safely continue.
  'invalid_branch', 'branch_is_default', 'branch_not_found', 'pr_not_found', 'pr_not_open', 'pr_from_fork',
  'github_unavailable', 'branch_busy',
  // Ours: the factory's CLI parser refused a flag it does not know (a v1
  // factory and --kind/--runtime). The parser stops before any command runs.
  'unsupported_option',
]);

// The CLI parser's (typer/click) refusal of an unknown flag: usage on stderr,
// exit 2, no JSON — before the command body runs, so nothing was written.
const UNKNOWN_OPTION = /\bNo such option\b|\bno such option\b|Got unexpected extra argument/;
const UNKNOWN_COMMAND = /\bNo such command\b/i;

function isRefusal(err: unknown): boolean {
  return err instanceof FactoryError && REFUSAL_CODES.has(err.code);
}

class NotSentError extends Error {
  code: string;
  constructor(message: string) {
    super(message);
    this.name = 'NotSentError';
    this.code = 'not_sent';
  }
}

class FactoryError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ? `factory ${code}: ${message}` : `factory ${code}`);
    this.name = 'FactoryError';
    this.code = code;
  }
}

/**
 * One `--json` command's answer. Exit 0 is the success shape; non-zero is
 * `{"error", "message"}` on stdout. Anything else — no JSON, a JSON array,
 * extra lines — breaks the contract and is reported, never guessed at.
 */
function parseResult({ code, stdout, stderr, timedOut = false }: ExecResult): Job {
  // exec.ts answers a timeout (124) and a missing program (127) as results,
  // not throws. Neither is the factory's answer, so they surface as transport
  // failures — plain Errors, which submit() retries once (idempotent on the
  // external id) — never as a FactoryError, which it would not.
  if (timedOut || code === 124) throw new Error(`the factory did not answer in time (exit ${code})`);
  // 127: the command never ran (no such program, or no such cwd) — so nothing
  // was sent, and a submit can be failed outright.
  if (code === 127) throw new NotSentError('could not start the factory command (exit 127) — is uv on that machine\'s PATH, and PA_FACTORY_PATH right?');
  const text = String(stdout || '').trim();
  let obj: Job | null = null;
  try {
    obj = text ? JSON.parse(text) : null;
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    if (code === 2 && UNKNOWN_OPTION.test(String(stderr || ''))) {
      const m = /No such option:?\s*'?([-\w]+)/i.exec(String(stderr || ''));
      throw new FactoryError('unsupported_option', `this factory does not know ${m ? m[1] : 'a flag that was sent'} — it predates JOBS-API v1.2`);
    }
    if (code === 2 && UNKNOWN_COMMAND.test(String(stderr || ''))) {
      const m = /No such command:?\s*'?([-\w]+)/i.exec(String(stderr || ''));
      throw new FactoryError('unsupported_command', `this factory has no \`${m ? m[1] : '?'}\` command — it predates JOBS-API v1.2`);
    }
    const tail = String(stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new FactoryError('bad_output', `exit ${code}, no JSON object on stdout${tail ? ` — ${clip(tail, 300)}` : ''}`);
  }
  if (code !== 0 || obj.error) throw new FactoryError(String(obj.error || `exit_${code}`), obj.message ? String(obj.message) : '');
  return obj;
}

/**
 * The job's flow.md: the intended change as numbered steps, from the
 * commitment and its done-criteria. Deterministic on purpose — no model call,
 * nothing invented: the steps restate the ask and turn each criterion into a
 * check. The factory's direction validator requires a flow (or an API spec);
 * the requester's own words travel in the ask file next to it.
 */
function flowMarkdown({ title: rawTitle, summary: rawSummary = null, app = null, done: rawDone = [], delivery = null, continues = null }: { title: string; summary?: string | null; app?: string | null; done?: string[] | null; delivery?: string | null; continues?: { branch?: string | null; pr?: number | null } | null }): string {
  const { redactSecrets } = require('./composeCore.ts');
  const title: string = redactSecrets(rawTitle);
  const summary: string | null = rawSummary === null ? null : redactSecrets(rawSummary);
  const done: string[] = (rawDone || []).map((d) => redactSecrets(d));
  const steps: string[] = [];
  steps.push(`Start from how ${app ? `\`${app}\`` : 'the repository'} behaves today, as the ask (the job's ask file) describes it.`);
  steps.push(`Make the change: ${clip(summary || title, 400)}.`);
  for (const d of done) steps.push(`Check: ${clip(d, 400)}`);
  steps.push('The existing tests still pass, and new behaviour is covered by a test.');
  if (continues && (continues.pr || continues.branch)) {
    steps.push(continues.pr
      ? `Commit onto PR #${continues.pr}'s branch; that PR is updated and no new one is opened.`
      : `Commit onto the existing branch \`${clip(continues.branch, 120)}\`.`);
  } else if (delivery) steps.push(`Deliver \`${delivery}\`.`);
  return [
    `# Flow: ${clip(title, 200)}`,
    '',
    'Written by the personal assistant from the ask and its done-criteria; the ask file holds the requester\'s own words.',
    '',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
  ].join('\n');
}

/**
 * `factory app add` for a repo the factory does not know yet (JOBS-API.md).
 * `--delivery-default` is the app's own default; the PA still sends
 * `--delivery` on every job, so it only matters for jobs submitted elsewhere.
 */
function appAddArgv({ repo, deliveryDefault = 'draft_pr', path: clonePath = null }: { repo: string; deliveryDefault?: string; path?: string | null }): string[] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))) throw new Error(`not a repo: "${repo}" — want owner/name`);
  if (!DELIVERIES.includes(deliveryDefault)) throw new Error(`unknown delivery "${deliveryDefault}"`);
  const argv = ['app', 'add', '--json', '--repo', String(repo), '--delivery-default', deliveryDefault];
  if (clonePath) argv.push(`--path=${String(clonePath)}`);
  return argv;
}

/**
 * This run's job in a `job list` answer: source pa, external id = the run's
 * key (`<install>-<run>`; a run from before sql/026 used its bare id).
 */
function jobForRun(jobs: Job[] | null | undefined, key: string | number): Job | null {
  return (Array.isArray(jobs) ? jobs : []).find(
    (j: Job) => (j?.source == null || j.source === 'pa') && j?.external_id != null && String(j.external_id) === String(key) && JOB_ID.test(String(j.job_id || ''))
  ) || null;
}

// How long a run may sit with its submit unanswered before "the factory has
// no job for it" is believed: a submit that timed out here may still be
// finishing there.
const SUBMIT_GRACE_MS = 10 * 60_000;
const UNKNOWN_CAP_MS = 24 * 3600_000;

/**
 * Pure. What to do with a run whose submit did not come back cleanly (a lost
 * answer, a crash between submit and recording it), from what the factory
 * says now. Never "leave it starting".
 *   adopt   the factory has the job: record it, then follow it like any other
 *   fail    the factory answered and has no job for it, and the grace is over
 *   unknown the factory could not be asked, or it is too early to be sure:
 *           the row waits as `submit_unknown`, and the worker asks again
 * @param {{job?: object|null, asked: boolean, ageMs: number}} o
 */
function submitVerdict({ job = null, asked, ageMs }: { job?: Job | null; asked: boolean; ageMs: number }): 'adopt' | 'fail' | 'unknown' {
  if (job) return 'adopt';
  // A day without an answer either way: failed, and said so — never a row
  // waiting forever (the factory's own job, if it ever appears, is then
  // nobody's, and `factory job list --source pa` shows it).
  if (ageMs >= UNKNOWN_CAP_MS) return 'fail';
  if (!asked) return 'unknown';
  return ageMs >= SUBMIT_GRACE_MS ? 'fail' : 'unknown';
}

/** This install's idempotency key for a run (sql/026). */
function externalKey(installId: string | null | undefined, runId: number | string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(String(installId || ''))) throw new Error('no install id');
  return `${installId}-${Number(runId)}`;
}

/** The command a termhub session runs to "walk into" a job. */
function followCommand(jobId: string, uv: string | null | undefined = 'uv'): string {
  if (!JOB_ID.test(String(jobId || ''))) throw new Error(`not a factory job id: "${jobId}"`);
  return `${uvBinary(uv)} run factory job follow ${jobId}`;
}

/** `factory job report <id> --json` (v1.2). */
function reportArgv(jobId: string): string[] {
  if (!JOB_ID.test(String(jobId || ''))) throw new Error(`not a factory job id: "${jobId}"`);
  return ['job', 'report', String(jobId), '--json'];
}

/** `factory job resume <id> --json`: carry on a job that stopped. */
function resumeArgv(jobId: string): string[] {
  if (!JOB_ID.test(String(jobId || ''))) throw new Error(`not a factory job id: "${jobId}"`);
  return ['job', 'resume', String(jobId), '--json'];
}

/** `factory job cancel <id> --json`. */
function cancelArgv(jobId: string): string[] {
  if (!JOB_ID.test(String(jobId || ''))) throw new Error(`not a factory job id: "${jobId}"`);
  return ['job', 'cancel', String(jobId), '--json'];
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const APPROVE = /factory approve-direction\s+([A-Za-z0-9_.-]+)\s+--app\s+([A-Za-z0-9_.-]+)/;

/**
 * Pure. The approval a `needs_human` job asks for, as an argv — or null. Only
 * when the factory itself names `factory approve-direction <id> --app <app>`
 * (JOBS-API v1: the warning a non-pa/human source's job carries), and only
 * for this job's own app and direction: a `why` cannot point the button at
 * another job.
 */
function approveArgv(job: Job | null | undefined): string[] | null {
  if (job?.state !== 'needs_human') return null;
  const texts = [...(Array.isArray(job.warnings) ? job.warnings : []), job.why || ''].map(String);
  const [app, dir] = String(job.job_id || '').split(':');
  for (const t of texts) {
    const m = APPROVE.exec(t);
    if (!m) continue;
    const [, direction = '', mApp = ''] = m;
    if (!NAME.test(direction) || !NAME.test(mApp)) continue;
    if (mApp !== app || (direction !== dir && !direction.startsWith(`${dir}-`))) continue;
    return ['approve-direction', direction, '--app', mApp, '--note=approved from the personal assistant\'s factory page'];
  }
  return null;
}

/** Only http(s) links reach a page or a notification. */
function safeUrl(u: unknown): string | null {
  const s = String(u || '');
  return /^https?:\/\/[^\s"'<>]+$/.test(s) ? s : null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Pure. A PR's number: JOBS-API v1.4 `pr_number`, else read off its URL. */
function prNumber(n: unknown, url: unknown): number | null {
  const v = Number(n);
  if (Number.isInteger(v) && v > 0) return v;
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(String(url || ''));
  return m ? Number(m[1]) : null;
}

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Pure. A session link as a person opens it (plan 8.4.17). A loopback link
 * other than `front` (the factory machine's termhub front) is re-pointed at
 * `front`, keeping its `#session=` anchor: an older factory reported its API
 * base, sessiond on :7010, which serves no page, and a loopback address means
 * nothing off the factory's machine. Any other link is kept.
 */
function frontUrl(url: unknown, front: string | null | undefined): string | null {
  const s = safeUrl(url);
  if (!s || !front) return s;
  let u: URL;
  let f: URL;
  try {
    u = new URL(s);
    f = new URL(front);
  } catch {
    return s;
  }
  if (!LOOPBACK.has(u.hostname) || u.origin === f.origin) return s;
  return `${front.replace(/\/+$/, '')}/${u.hash}`;
}

/**
 * Pure. A factory answer (a job or `{jobs: [...]}`) with every
 * `runs[].session.url` through frontUrl, in place.
 */
function frontSessions<T>(result: T, front: string | null | undefined): T {
  if (!front || !result || typeof result !== 'object') return result;
  const r = result as Job;
  for (const j of Array.isArray(r.jobs) ? r.jobs : [r]) {
    for (const run of Array.isArray(j?.runs) ? j.runs : []) {
      if (run?.session && typeof run.session === 'object' && run.session.url) run.session.url = frontUrl(run.session.url, front);
    }
  }
  return result;
}

/**
 * Pure. One id chain (plan E1): what a job's status says about its PRs and its
 * agent steps, as the rows of run_pr and run_step (sql/033). Every field the
 * factory may omit is null; nothing is invented from a title.
 * @returns {{prs: Array<{url, number, story_id, state, ci_state, ci_failing}>,
 *            steps: Array<{step_id, job_id, story_id, persona, runtime, model, state, started_at, ended_at, machine, termhub_session_id, url}>}}
 */
function chainOf(job: Job | null | undefined): { prs: PrLink[]; steps: StepLink[] } {
  const jobId = JOB_ID.test(String(job?.job_id || '')) ? String(job?.job_id) : null;
  const intOrNull = (v: unknown) => (Number.isInteger(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const prs: PrLink[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(job?.stories) ? job.stories : []) {
    const url = safeUrl(s?.pr_url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const ci = s?.ci && typeof s.ci === 'object' ? s.ci : null;
    prs.push({
      url,
      number: prNumber(s?.pr_number, url),
      story_id: intOrNull(s?.id),
      state: ['open', 'merged', 'closed'].includes(s?.pr_state) ? s.pr_state : null,
      ci_state: ci ? String(ci.state || 'none').slice(0, 20) : null,
      ci_failing: ci && Array.isArray(ci.failing) ? ci.failing.slice(0, 8).map((f: any) => clip(typeof f === 'string' ? f : f?.name || '?', 80)) : null,
    });
  }
  for (const u of Array.isArray(job?.pr_urls) ? job.pr_urls : []) {
    const url = safeUrl(u);
    if (url && !seen.has(url)) {
      seen.add(url);
      prs.push({ url, number: prNumber(null, url), story_id: null, state: null, ci_state: null, ci_failing: null });
    }
  }
  const steps: StepLink[] = [];
  for (const r of (Array.isArray(job?.runs) ? job.runs : []).slice(0, 50)) {
    if (r?.id == null || !SESSION_ID.test(String(r.id))) continue;
    const s = r.session && typeof r.session === 'object' ? r.session : null;
    const sid = s && SESSION_ID.test(String(s.termhub_session_id || '')) ? String(s.termhub_session_id) : null;
    steps.push({
      step_id: String(r.id),
      job_id: JOB_ID.test(String(r.job_id || '')) ? String(r.job_id) : jobId,
      story_id: intOrNull(r.story_id),
      persona: r.persona ? clip(r.persona, 40) : null,
      runtime: RUNTIMES.includes(r.runtime) ? r.runtime : null,
      model: r.model ? clip(r.model, 80) : null,
      state: ['running', 'ok', 'failed'].includes(r.state) ? r.state : null,
      started_at: isoOrNull(r.started_at),
      ended_at: isoOrNull(r.ended_at),
      machine: s?.machine ? clip(s.machine, 60) : null,
      termhub_session_id: sid,
      url: s ? safeUrl(s.url) : null,
    });
  }
  return { prs, steps };
}

/**
 * Pure. One PA run's id chain as pages and tools show it (plan E1):
 * card → run → job → steps, each with its session → PRs with CI. `stored` is
 * what factory.chains() read from run_step / run_pr; `sessionUrl` the run's own
 * termhub session (a Claude run's terminal, or a factory run's follow session).
 * A run with no stored PR still shows the one on run.mr_url (a Claude run's PR).
 */
function runChain(run: RunRow | null | undefined, stored: { prs?: PrLink[]; steps?: StepLink[] } | null = null, { sessionUrl = null }: { sessionUrl?: string | null } = {}) {
  const st = stored || {};
  const prs = (Array.isArray(st.prs) ? st.prs : [])
    .map((p) => ({
      number: prNumber(p.number, p.url),
      url: safeUrl(p.url),
      state: p.state || null,
      ci: p.ci_state || null,
      ciFailing: Array.isArray(p.ci_failing) ? p.ci_failing.slice(0, 8).map((f) => clip(f, 80)) : [],
      story: p.story_id != null ? Number(p.story_id) : null,
    }))
    .filter((p) => p.url);
  const mr = safeUrl(run?.mr_url);
  if (mr && !prs.some((p) => p.url === mr)) prs.unshift({ number: prNumber(null, mr), url: mr, state: null, ci: null, ciFailing: [], story: null });
  const steps = (Array.isArray(st.steps) ? st.steps : []).slice(0, 20).map((s) => ({
    step: String(s.step_id),
    story: s.story_id != null ? Number(s.story_id) : null,
    persona: s.persona || null,
    runtime: s.runtime || null,
    model: s.model || null,
    state: s.state || null,
    session: s.termhub_session_id || safeUrl(s.url)
      ? { id: s.termhub_session_id || null, machine: s.machine || null, url: safeUrl(s.url) }
      : null,
  }));
  const job = JOB_ID.test(String(run?.factory_job_id || '')) ? String(run?.factory_job_id) : null;
  return {
    card: run?.commitment_id != null ? String(run.commitment_id) : null,
    run: Number(run?.id),
    status: run?.status || null,
    route: run?.route || 'claude',
    job,
    jobState: job ? run?.factory_state || null : null,
    session: run?.termhub_session_id ? { id: String(run.termhub_session_id), url: safeUrl(sessionUrl) } : null,
    steps,
    prs,
  };
}

/** A job's open PRs with CI failing (JOBS-API: `stories[].ci`, open PRs only). */
function ciFailing(job: Job | null | undefined): Job[] {
  return (Array.isArray(job?.stories) ? job.stories : []).filter((s: Job) => s?.ci?.state === 'failing');
}

const GROUPS = ['needs_you', 'running', 'delivered', 'ended'];

/**
 * Pure. Which column of the factory page a job goes in:
 *   needs_you  needs_human or blocked, still going with a PR whose CI fails,
 *              or waiting on an app nothing ticks (JOBS-API v1.6 `ticked: false`)
 *   running    queued, triaging, in_progress
 *   delivered  done
 *   ended      failed or cancelled
 */
function groupOf(job: Job | null | undefined): string {
  const s = job?.state;
  if (s === 'done') return 'delivered';
  if (s === 'failed' || s === 'cancelled') return 'ended';
  if (s === 'needs_human' || s === 'blocked' || ciFailing(job).length || notTicked(job)) return 'needs_you';
  return 'running';
}

/** A live job whose app no `factory serve` or timer ticks: it never moves on its own. */
function notTicked(job: Job | null | undefined): boolean {
  return job?.ticked === false && !job?.terminal && !['done', 'failed', 'cancelled', 'needs_human'].includes(job?.state);
}

/** Pure. The PR or branch a continuation works on (JOBS-API v1.3 `base`), else null. */
function baseView(base: Job | null | undefined) {
  if (!base || typeof base !== 'object' || !base.branch) return null;
  const pr = Number(base.pr);
  return {
    branch: clip(String(base.branch), 120),
    pr: Number.isInteger(pr) && pr > 0 ? pr : null,
    into: base.into ? clip(String(base.into), 120) : null,
  };
}

/**
 * Pure. One job as the factory page shows it, from a `job list --json` row.
 * Every field v1.2 added is optional: a v1 factory's job is a code job on the
 * api runtime with no report and no runs.
 * @param {object} job
 * @param {object} [pa]  the PA run that submitted it: {id, url}
 */
function jobView(job: Job | null | undefined, pa: { id: number; url?: string | null; card?: unknown } | null = null) {
  const kind: string = KINDS.includes(job?.kind) ? job?.kind : 'code';
  const report = job?.report && typeof job.report === 'object'
    ? { title: clip(job.report.title || '', 200), excerpt: clip(job.report.excerpt || '', 800), words: num(job.report.words) || null }
    : null;
  const runs = (Array.isArray(job?.runs) ? (job?.runs as Job[]) : []).slice(0, 30).map((r) => ({
    id: r?.id ?? null,
    storyId: r?.story_id ?? null,
    persona: r?.persona ? clip(r.persona, 40) : null,
    runtime: RUNTIMES.includes(r?.runtime) ? r.runtime : null,
    model: r?.model ? clip(r.model, 80) : null,
    state: ['running', 'ok', 'failed'].includes(r?.state) ? r.state : String(r?.state || 'unknown').slice(0, 20),
    costUsd: num(r?.cost_usd),
    billing: r?.billing === 'subscription' ? 'subscription' : 'metered',
    startedAt: r?.started_at || null,
    endedAt: r?.ended_at || null,
    session: r?.session && safeUrl(r.session.url)
      ? {
        machine: r.session.machine ? clip(r.session.machine, 60) : null,
        url: safeUrl(r.session.url),
        id: SESSION_ID.test(String(r.session.termhub_session_id || '')) ? String(r.session.termhub_session_id) : null,
      }
      : null,
  }));
  return {
    jobId: String(job?.job_id || ''),
    app: job?.app || null,
    title: clip(job?.title || job?.job_id || '', 200),
    kind,
    runtime: RUNTIMES.includes(job?.runtime) ? (job?.runtime as string) : 'api',
    state: STATES.includes(job?.state) ? (job?.state as string) : String(job?.state || 'unknown').slice(0, 30),
    group: groupOf(job),
    why: job?.why ? clip(job.why, 400) : null,
    ticked: typeof job?.ticked === 'boolean' ? (job.ticked as boolean) : null,
    waiting: notTicked(job) ? 'app not ticked' : null,
    base: baseView(job?.base),
    terminal: Boolean(job?.terminal) || ['done', 'failed', 'cancelled'].includes(job?.state),
    delivery: job?.delivery || null,
    pipeline: job?.pipeline || null,
    source: job?.source || null,
    stories: (Array.isArray(job?.stories) ? (job?.stories as Job[]) : []).slice(0, 30).map((s) => ({
      id: s?.id ?? null,
      state: String(s?.state || '').slice(0, 40),
      prUrl: safeUrl(s?.pr_url),
      prNumber: safeUrl(s?.pr_url) ? prNumber(s?.pr_number, s.pr_url) : null,
      prState: s?.pr_state || null,
      ci: s?.ci && typeof s.ci === 'object'
        ? { state: String(s.ci.state || 'none'), failing: (Array.isArray(s.ci.failing) ? s.ci.failing : []).slice(0, 8).map((f: any) => clip(typeof f === 'string' ? f : f?.name || JSON.stringify(f), 80)) }
        : null,
    })),
    ciFailing: ciFailing(job).length > 0,
    merged: Boolean(job?.merged),
    costUsd: num(job?.cost_usd),
    subscriptionEquivUsd: num(job?.subscription_equiv_usd),
    report,
    runs,
    updatedAt: job?.updated_at || null,
    canApprove: Boolean(approveArgv(job)),
    canCancel: !(Boolean(job?.terminal) || ['done', 'failed', 'cancelled'].includes(job?.state)),
    // The PA run that submitted it, and that run's card (plan E1: Build links back to Plan).
    paRun: pa ? { id: pa.id, url: safeUrl(pa.url), card: pa.card != null && /^\d+$/.test(String(pa.card)) ? String(pa.card) : null } : null,
  };
}

/**
 * Pure. The factory page's data from the latest snapshot: jobs grouped, newest
 * first in each group, and the spend line. `paRuns` maps a job id to the PA
 * run that submitted it.
 */
function board(jobs: Job[] | null | undefined, { paRuns = new Map(), paSpendToday = null, now = new Date() }: { paRuns?: Map<string, { id: number; url?: string | null; card?: unknown }>; paSpendToday?: number | null; now?: Date | string | number } = {}) {
  const views = (Array.isArray(jobs) ? jobs : []).filter((j) => JOB_ID.test(String(j?.job_id || ''))).map((j) => jobView(j, paRuns.get(j.job_id) || null));
  views.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const groups: Record<string, JobView[]> = Object.fromEntries(GROUPS.map((g) => [g, views.filter((v) => v.group === g)]));
  const day = new Date(now).toISOString().slice(0, 10);
  const today = views.filter((v) => String(v.updatedAt || '').slice(0, 10) === day);
  const sum = (list: JobView[], k: 'costUsd' | 'subscriptionEquivUsd') => Math.round(list.reduce((s, v) => s + v[k], 0) * 100) / 100;
  return {
    groups,
    counts: Object.fromEntries(GROUPS.map((g) => [g, (groups[g] || []).length])),
    spend: {
      paToday: paSpendToday == null ? null : Math.round(Number(paSpendToday) * 100) / 100,
      factoryToday: { metered: sum(today, 'costUsd'), subscriptionEquiv: sum(today, 'subscriptionEquivUsd'), jobs: today.length },
      factoryListed: { metered: sum(views, 'costUsd'), subscriptionEquiv: sum(views, 'subscriptionEquivUsd'), jobs: views.length },
    },
  };
}

/**
 * Pure. What to tell the user after a poll, from the previous snapshot's
 * per-job state and the new list: a job that reached done, needs_human or
 * failed, and a job whose open PR's CI turned red. The first poll after a
 * start (no previous snapshot) says nothing — it would replay history.
 * `covered`: job ids whose state changes the run pass already announces
 * (factory.apply, keyed per run); only their CI is announced here.
 * @returns {Array<{key, title, body, url}>}
 */
function notices(prev: NoticeMemo | null | undefined, jobs: Job[] | null | undefined, { covered = new Set() }: { covered?: Set<string> } = {}): Notice[] {
  if (!prev) return [];
  const out: Notice[] = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const id = String(job?.job_id || '');
    if (!JOB_ID.test(id)) continue;
    const was = prev.get(id) || null;
    const title = clip(job.title || id, 120);
    const firstPr = (Array.isArray(job.pr_urls) ? job.pr_urls : []).map(safeUrl).find(Boolean) || null;
    if (!covered.has(id) && job.state !== was?.state && ['done', 'needs_human', 'failed'].includes(job.state)) {
      const what = ({ done: 'done', needs_human: 'needs you', failed: 'failed' } as Record<string, string>)[job.state];
      const kind = KINDS.includes(job.kind) && job.kind !== 'code' ? `${job.kind} ` : '';
      out.push({
        key: `factory-job:${id}:${job.state}`,
        title: clip(`Factory ${kind}job ${id} ${what}: ${title}`, 200),
        body: [job.why ? clip(job.why, 300) : null, job.state === 'done' && job.report?.excerpt ? clip(job.report.excerpt, 300) : null].filter(Boolean).join('\n') || title,
        url: firstPr,
      });
    }
    const red = ciFailing(job);
    if (red.length && !was?.ciFailing) {
      const s = red[0] as Job;
      out.push({
        key: `factory-ci:${id}:${red.map((r) => r.id).join(',')}`,
        title: clip(`Factory job ${id}: CI failing on ${red.length === 1 ? 'its PR' : `${red.length} PRs`}`, 200),
        body: [title, ...(s.ci.failing || []).slice(0, 4).map((f: any) => `- ${typeof f === 'string' ? f : f?.name || '?'}`)].join('\n'),
        url: safeUrl(s.pr_url) || firstPr,
      });
    }
  }
  return out;
}

/** Pure. The per-job memory `notices` compares against next time. */
function noticeState(jobs: Job[] | null | undefined): NoticeMemo {
  return new Map((Array.isArray(jobs) ? jobs : []).filter((j) => j?.job_id).map((j): [string, { state: string; ciFailing: boolean }] => [String(j.job_id), { state: j.state, ciFailing: ciFailing(j).length > 0 }]));
}

/**
 * What a job's status means for its run row. Run statuses are the dispatcher's
 * own (sql/001): a job the factory is working on is `running`; one that is
 * blocked or wants a human is `waiting` (your turn); one that delivered past
 * `none` is `landed` (it pushed); `none` is `done` (committed in the factory's
 * worktree, nothing pushed); failed is `failed`; cancelled is `dropped`.
 *
 * `outcome` is the measured result (sql/024): delivered | merged | failed |
 * dropped, or null while it is still going.
 */
function runUpdate(job: Job | null | undefined) {
  const state: string | null = STATES.includes(job?.state) ? job?.state : null;
  const prs: string[] = Array.isArray(job?.pr_urls) ? job?.pr_urls.filter((u: unknown) => /^https?:\/\//.test(String(u))) : [];
  const cost = Number(job?.cost_usd);
  const equiv = Number(job?.subscription_equiv_usd);
  const base = {
    factory_state: state || String(job?.state || 'unknown'),
    cost_usd: Number.isFinite(cost) ? cost : null,
    subscription_equiv_usd: Number.isFinite(equiv) ? equiv : null,
    mr_url: prs[0] || null,
    exit_note: job?.why ? clip(job.why, 500) : null,
    delivery: (DELIVERIES.includes(job?.delivery) ? job?.delivery : null) as string | null,
    terminal: Boolean(job?.terminal) || ['done', 'failed', 'cancelled'].includes(state as string),
  };
  if (state === 'done') {
    return { ...base, status: base.delivery === 'none' ? 'done' : 'landed', outcome: job?.merged ? 'merged' : 'delivered' };
  }
  if (state === 'failed') return { ...base, status: 'failed', outcome: 'failed' };
  if (state === 'cancelled') return { ...base, status: 'dropped', outcome: 'dropped' };
  if (state === 'blocked' || state === 'needs_human') return { ...base, status: 'waiting', outcome: null, terminal: false };
  return { ...base, status: 'running', outcome: null, terminal: false };
}

/**
 * What a terminal job does to its commitment, as a ledger transition (the only
 * writer of commitment status, AGENT.md) — or null for "leave it".
 *
 * Only from `dispatched`: a commitment you closed or reopened yourself in the
 * meantime is yours, and GitHub reconcile (src/ingest/githubReconcile.js) only
 * ever closes `open` ones, so the two never close the same thing twice.
 *
 *   done, delivery past `none` → done (the same moment a Claude run's `pa land` closes it)
 *   done, delivery `none`      → left dispatched: the work is in the factory's worktree, nothing pushed
 *   failed / cancelled         → back to open, with why
 */
function commitmentMove(job: Job | null | undefined): { to: string; from: string[]; reason: string } | null {
  const id = job?.job_id || '?';
  if (job?.state === 'done') {
    if (job.delivery === 'none') return null;
    const prs = Array.isArray(job.pr_urls) ? job.pr_urls : [];
    const what = job.merged ? 'merged' : `delivered (${job.delivery || 'unknown'})`;
    return { to: 'done', from: ['dispatched'], reason: clip(`factory job ${id} ${what}${prs.length ? `: ${prs.join(' ')}` : ''}`, 500) };
  }
  if (job?.state === 'failed') {
    return { to: 'open', from: ['dispatched'], reason: clip(`factory job ${id} failed${job.why ? `: ${job.why}` : ''}`, 500) };
  }
  if (job?.state === 'cancelled') {
    return { to: 'open', from: ['dispatched'], reason: clip(`factory job ${id} cancelled`, 500) };
  }
  return null;
}

function clip(s: unknown, n: number): string {
  return require('./composeCore.ts').clip(s, n);
}

module.exports = {
  DELIVERIES,
  PIPELINES,
  STATES,
  ACTIVE_STATES,
  JOB_ID,
  SUBMIT_GRACE_MS,
  UNKNOWN_CAP_MS,
  REFUSAL_CODES,
  isRefusal,
  NotSentError,
  externalKey,
  pipeline,
  parseModels,
  factoryArgv,
  uvBinary,
  KINDS,
  RUNTIMES,
  jobKind,
  runtime,
  researchAsk,
  reportArgv,
  cancelArgv,
  resumeArgv,
  BRANCH,
  approveArgv,
  safeUrl,
  frontUrl,
  frontSessions,
  prNumber,
  chainOf,
  runChain,
  GROUPS,
  groupOf,
  jobView,
  board,
  notices,
  noticeState,
  submitArgv,
  flowMarkdown,
  parseResult,
  followCommand,
  appAddArgv,
  jobForRun,
  submitVerdict,
  runUpdate,
  commitmentMove,
  FactoryError,
  clip,
};
