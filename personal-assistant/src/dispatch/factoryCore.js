'use strict';

// The pure half of the factory route (src/dispatch/factory.js): how a PA run
// becomes a `factory job submit` command line, and what a job's status means
// for the run row and its commitment. No database, no processes, so every rule
// here is a test away (test/factoryDispatch.test.js).
//
// The one interface is the factory's job contract (software-factory
// docs/JOBS-API.md, v1). The PA never imports factory code or reads its
// sqlite: it runs `uv run factory job …` on the factory's machine and parses
// the single JSON object each `--json` command prints.

// PA mode → factory delivery level. The contract gives the PA side this
// mapping. `plan` is read-only and the factory only builds, so it is not a
// factory job at all. `full` is `draft_pr` too: the factory never drafts the
// reply, and nothing ever sends one.
const DELIVERY_BY_MODE = {
  plan: null,
  local: 'none',
  branch: 'branch',
  mr: 'draft_pr',
  full: 'draft_pr',
};

const DELIVERIES = ['none', 'branch', 'draft_pr', 'pr', 'auto_merge', 'push_to_main'];
const PIPELINES = ['chain', 'solo', 'auto'];
const STATES = ['queued', 'triaging', 'in_progress', 'blocked', 'needs_human', 'done', 'failed', 'cancelled'];
const ACTIVE_STATES = new Set(['queued', 'triaging', 'in_progress', 'blocked', 'needs_human']);

// `<app>:<direction_id>`. Checked before it is ever typed into a terminal
// (the walk-in session's command line), so it can carry nothing a shell reads.
const JOB_ID = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;
const PERSONA = /^[A-Za-z0-9_-]+$/;
const MODEL = /^[A-Za-z0-9_.:/@-]+$/;

function deliveryFor(modeName) {
  const key = String(modeName || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DELIVERY_BY_MODE, key)) throw new Error(`unknown mode "${modeName}"`);
  const d = DELIVERY_BY_MODE[key];
  if (!d) throw new Error('plan mode is read-only and is not a factory job — send it to a Claude session (--via claude)');
  return d;
}

function pipeline(name) {
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
function parseModels(list) {
  const out = {};
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

/** `uv run factory …` — the factory's CLI, run from its checkout. */
function factoryArgv(sub) {
  return ['uv', 'run', 'factory', ...sub];
}

/**
 * The `factory job submit` argv for one PA run. `externalId` is the run id:
 * the factory makes (source, external-id) idempotent, so a resubmit after a
 * lost answer returns the same job instead of a second one.
 */
function submitArgv({ app, title, ask = null, askFile = null, flowFile = null, done = [], pipeline: pipe = 'auto', delivery, models = {}, externalId, source = 'pa' }) {
  if (!app) throw new Error('submit needs a factory app');
  if (!title) throw new Error('submit needs a title');
  if (!ask && !askFile) throw new Error('submit needs the ask');
  if (externalId === undefined || externalId === null || externalId === '') throw new Error('submit needs an external id');
  if (!DELIVERIES.includes(delivery)) throw new Error(`unknown delivery "${delivery}"`);
  // Free text goes as `--flag=value`: a title or criterion that starts with
  // "-" must not be read as an option by the factory's CLI parser.
  const argv = ['job', 'submit', '--json', '--app', String(app), `--title=${clip(title, 200)}`];
  if (askFile) argv.push('--ask-file', String(askFile));
  else argv.push(`--ask=${String(ask)}`);
  // The factory's backpressure gate needs a flow.md (or an api_spec.md): a
  // job without one parks as needs_human every time (JOBS-API.md v1.1).
  if (flowFile) argv.push('--flow-file', String(flowFile));
  for (const d of done) argv.push(`--done=${String(d)}`);
  argv.push('--pipeline', pipeline(pipe), '--delivery', delivery);
  for (const [persona, model] of Object.entries(models || {})) argv.push('--model', `${persona}=${model}`);
  argv.push('--source', source, '--external-id', String(externalId));
  return argv;
}

class FactoryError extends Error {
  constructor(code, message) {
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
function parseResult({ code, stdout, stderr }) {
  const text = String(stdout || '').trim();
  let obj = null;
  try {
    obj = text ? JSON.parse(text) : null;
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
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
function flowMarkdown({ title, summary = null, app = null, done = [], delivery = null }) {
  const steps = [];
  steps.push(`Start from how ${app ? `\`${app}\`` : 'the repository'} behaves today, as the ask (the job's ask file) describes it.`);
  steps.push(`Make the change: ${clip(summary || title, 400)}.`);
  for (const d of done) steps.push(`Check: ${clip(d, 400)}`);
  steps.push('The existing tests still pass, and new behaviour is covered by a test.');
  if (delivery) steps.push(`Deliver at most \`${delivery}\`.`);
  return [
    `# Flow: ${clip(title, 200)}`,
    '',
    'Written by the personal assistant from the ask and its done-criteria; the ask file holds the requester\'s own words.',
    '',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
  ].join('\n');
}

/** The command a termhub session runs to "walk into" a job. */
function followCommand(jobId) {
  if (!JOB_ID.test(String(jobId || ''))) throw new Error(`not a factory job id: "${jobId}"`);
  return `uv run factory job follow ${jobId}`;
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
function runUpdate(job) {
  const state = STATES.includes(job?.state) ? job.state : null;
  const prs = Array.isArray(job?.pr_urls) ? job.pr_urls.filter((u) => /^https?:\/\//.test(String(u))) : [];
  const cost = Number(job?.cost_usd);
  const base = {
    factory_state: state || String(job?.state || 'unknown'),
    cost_usd: Number.isFinite(cost) ? cost : null,
    mr_url: prs[0] || null,
    exit_note: job?.why ? clip(job.why, 500) : null,
    delivery: DELIVERIES.includes(job?.delivery) ? job.delivery : null,
    terminal: Boolean(job?.terminal) || ['done', 'failed', 'cancelled'].includes(state),
  };
  if (state === 'done') {
    return { ...base, status: base.delivery === 'none' ? 'done' : 'landed', outcome: job.merged ? 'merged' : 'delivered' };
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
function commitmentMove(job) {
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

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

module.exports = {
  DELIVERY_BY_MODE,
  DELIVERIES,
  PIPELINES,
  STATES,
  ACTIVE_STATES,
  JOB_ID,
  deliveryFor,
  pipeline,
  parseModels,
  factoryArgv,
  submitArgv,
  flowMarkdown,
  parseResult,
  followCommand,
  runUpdate,
  commitmentMove,
  FactoryError,
  clip,
};
