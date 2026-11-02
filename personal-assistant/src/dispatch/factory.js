'use strict';

// The software factory as a dispatch target: a commitment becomes a factory
// job instead of a Claude Code session (route `factory`, src/dispatch/routeCore.js).
//
// The one interface is the factory's job contract (software-factory
// docs/JOBS-API.md, v1). This file never imports factory code or reads its
// store: it runs `uv run factory job …` in the factory's checkout on the
// factory's machine (PA_FACTORY_PATH, PA_FACTORY_MACHINE) through
// `runCommand` (src/dispatch/exec.js) and parses the one JSON object each
// `--json` command prints.
//
//   start({...})   submit the job, record it on a run row, open the walk-in session
//   poll()         the worker pass: job status → run row, and terminal jobs move
//                  their commitment through src/ledger (never directly)
//   cancel(run)    `factory job cancel` (pa drop)
//   status(run)    one job's status (pa review)
//   apps()         `factory app list`, cached briefly
//
// The end state is the operator's call (operator decision 2026-11-02, no
// ceiling): every job carries an explicit `--delivery` — what they said
// (`pa do --delivery`, the card's pick), else their own words, else the repo's
// default (`pa delivery set`), else PA_DELIVERY_DEFAULT (src/dispatch/
// deliveryCore.js). A factory job changes code, so the planner never starts one
// on its own: it is always a proposal you say yes to (src/agent/planner.js).
//
// The ask is a COMPOSED brief (src/dispatch/compose.js): the goal, done
// criteria, constraints, decisions and pointers to existing code the task
// needs — not the operator's memory pages or message bodies wholesale.
//
// Submission is idempotent on (source pa, external id = run id). Whatever goes
// wrong after a submit was sent, the run is reconciled against what the
// factory says (`job status` by id, or `job list` by external id): adopted,
// failed, or left `waiting` as `submit_unknown` for the worker to settle —
// never stuck in `starting`.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { config } = require('../config');
const { one, rows, query } = require('../db');
const { mode: resolveMode } = require('./modes');
const F = require('./factoryCore');
const D = require('./deliveryCore');
const termhub = require('./termhub');
const ledger = require('../ledger');
const { logger } = require('../log');

const log = logger('factory');

// ------------------------------------------------------------ the runner ----
// Every factory command goes through exec.js: this machine via child_process,
// another machine through its termhub's /api/exec.
let runnerOverride = null;

function runCommand(machineName, argv, opts) {
  if (runnerOverride) return runnerOverride(machineName, argv, opts);
  return require('./exec').runCommand(machineName, argv, opts);
}

/** Tests only: swap the command runner. */
function _setRunner(fn) {
  runnerOverride = fn;
}

function enabled() {
  return Boolean(config.factory.path);
}

/**
 * The factory's machine as runCommand and termhub want it: null for this one,
 * else a PA_MACHINES name. A name that is not in PA_MACHINES would silently be
 * treated as "here" by termhub, so it is refused instead.
 */
function machine() {
  const name = String(config.factory.machine || '').trim();
  if (!name || name === os.hostname()) return null;
  if (!config.termhub.machines[name]) {
    throw new Error(`PA_FACTORY_MACHINE "${name}" is not in PA_MACHINES — add it there (its termhub URL) or leave it empty for this machine`);
  }
  return name;
}

async function call(sub, { timeoutMs = config.factory.timeoutMs } = {}) {
  if (!enabled()) throw new Error('the factory is not configured — set PA_FACTORY_PATH (and PA_FACTORY_MACHINE if it is not this machine)');
  const res = await runCommand(machine(), F.factoryArgv(sub), { cwd: config.factory.path, timeoutMs });
  return F.parseResult(res);
}

let appsCache = null;
async function apps({ fresh = false } = {}) {
  if (!fresh && appsCache && Date.now() - appsCache.at < 60_000) return appsCache.apps;
  const r = await call(['app', 'list', '--json']);
  const list = Array.isArray(r.apps) ? r.apps : [];
  appsCache = { at: Date.now(), apps: list };
  return list;
}

function modelsFor(extra) {
  return { ...F.parseModels(config.factory.models), ...F.parseModels(modelEntries(extra)) };
}

// `persona=model` entries from a list, a string, or an {persona: model} object
// (the frozen form a proposal keeps).
function modelEntries(m) {
  if (!m) return [];
  if (Array.isArray(m) || typeof m === 'string') return m;
  return Object.entries(m).map(([k, v]) => `${k}=${v}`);
}

/**
 * Registers a repo with the factory (`factory app add`, JOBS-API.md). Its
 * `--delivery-default` is this repo's PA default, else PA_DELIVERY_DEFAULT —
 * though the PA sends `--delivery` on every job regardless.
 */
async function addApp({ repo, deliveryDefault = null, path: clonePath = null }) {
  const level = deliveryDefault || (await require('./delivery').defaultFor(repo).catch(() => null)) || require('./delivery').fallback();
  const r = await call(F.appAddArgv({ repo, deliveryDefault: D.delivery(level), path: clonePath }));
  appsCache = null;
  if (!r.app) throw new F.FactoryError('bad_output', 'app add answered without an app');
  return r;
}

// The ask and the flow must be files the factory can read, so on another
// machine they are written there first, through the same runCommand: a fixed
// Python one-liner (the factory checkout always has Python under uv) that
// takes base64 contents as arguments — never a shell, never content on a
// command line it could be read from — and writes them under that machine's
// temp dir, printing the paths as JSON.
const WRITER = [
  'import base64, json, os, sys, tempfile',
  "d = os.path.join(tempfile.gettempdir(), 'pa-factory-asks', 'run-' + sys.argv[1])",
  'os.makedirs(d, exist_ok=True)',
  'out = {}',
  'for name, b64 in zip(sys.argv[2::2], sys.argv[3::2]):',
  '    p = os.path.join(d, os.path.basename(name))',
  "    open(p, 'wb').write(base64.b64decode(b64))",
  '    out[name] = p',
  "print(json.dumps({'paths': out}))",
].join('\n');

async function stage(where, runId, files) {
  if (!where) {
    const out = {};
    for (const [name, text] of Object.entries(files)) {
      const p = path.join(config.worktreesRoot, `run-${runId}-${name}`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, 'utf8');
      out[name] = p;
    }
    return out;
  }
  const argv = ['uv', 'run', 'python', '-c', WRITER, String(Number(runId))];
  for (const [name, text] of Object.entries(files)) argv.push(name, Buffer.from(text, 'utf8').toString('base64'));
  const r = F.parseResult(await runCommand(where, argv, { cwd: config.factory.path, timeoutMs: config.factory.timeoutMs }));
  for (const name of Object.keys(files)) if (!r.paths?.[name]) throw new Error(`could not stage ${name} on ${where}`);
  return r.paths;
}

// Submit, retried once on a transport failure (a lost answer): the run id is
// the external id, so the factory returns the job it already made rather
// than a second one. A contract error (unknown_repo, …) is not retried.
async function submit(argv) {
  try {
    return await call(argv);
  } catch (err) {
    if (err instanceof F.FactoryError) throw err;
    log.warn('job submit failed, retrying once with the same external id', { message: err.message });
    return call(argv);
  }
}

/**
 * Sends one PA run to the factory.
 * @param {object} o
 * @param {object} o.target   dispatch's resolveTarget() result
 * @param {string} o.app      the registered factory app (route.js resolved it)
 * @param {string} [o.slug]   owner/name of the repo
 * @param {string} [o.task]   the operator's own words, if they typed them
 * @param {string} [o.mode]   an explicitly given PA mode; plan is refused
 * @param {string} [o.delivery]  the end state; resolved when not given
 * @param {string} [o.pipeline]
 * @param {Array<string>|string|object} [o.models]  `persona=model` entries, over PA_FACTORY_MODELS
 * @param {boolean} [o.modelsExact]  a proposal's frozen models: used as they are
 * @param {Array<string>} [o.done]  acceptance criteria
 * @param {string} [o.brief]  a frozen brief (the card's): sent exactly, not recomposed
 * @param {string} [o.routeReason]
 */
async function start({
  target, app, slug = null, task = null, mode: modeName, delivery = null, deliverySource = null, deliveryPhrase = null,
  pipeline = null, models = null, modelsExact = false, done = [], brief = null, briefBy = null, routeReason = null,
}) {
  if (modeName && resolveMode(modeName).name === 'plan') {
    throw new Error('plan mode is read-only and is not a factory job — send it to a Claude session (--via claude)');
  }
  const where = machine();
  const commitmentId = target.commitment ? Number(target.commitment.id) : null;
  const label = task || target.commitment?.summary;
  if (!label) throw new Error('nothing to do — give a commitment id or a --task');
  if (!app) throw new Error('no factory app for this work');
  const pipe = F.pipeline(pipeline || config.factory.pipeline);
  const overrides = modelsExact ? F.parseModels(modelEntries(models)) : modelsFor(models);
  const chosen = delivery
    ? { delivery: D.delivery(delivery), source: deliverySource || 'explicit', phrase: deliveryPhrase || null }
    : await require('./delivery').resolve({ mode: modeName ? resolveMode(modeName).name : null, operatorText: task, slug });
  const runMode = modeName ? resolveMode(modeName).name : D.modeFor(chosen.delivery);

  const run = await one(
    `insert into run (commitment_id, mode, task, repo_path, status, machine, route, route_reason, kind,
                      pipeline, delivery_requested, models, delivery_source)
     values ($1,$2,$3,$4,'starting',$5,'factory',$6,$7,$8,$9,$10,$11) returning *`,
    [commitmentId, runMode, label, target.repoPath || null, where || os.hostname(), routeReason, target.commitment?.kind || null,
      pipe, chosen.delivery, Object.keys(overrides).length ? overrides : null, chosen.source]
  );

  // The ask: the card's frozen brief, or one composed now from the ask and
  // what the assistant gathered (src/dispatch/compose.js). Composition never
  // fails a dispatch — the worst case is the deterministic brief.
  let ask = brief;
  let by = briefBy || (brief ? 'proposal' : null);
  let criteria = Array.isArray(done) ? done : [];
  let goal = null;
  if (!ask) {
    try {
      const c = await require('./compose').compose({ target, task, done: criteria, app, slug, delivery: chosen.delivery, pipeline: pipe });
      ask = c.brief;
      by = c.by;
      criteria = c.done;
      goal = c.goal;
    } catch (err) {
      log.warn('brief composition failed; sending the deterministic brief', { run: run.id, message: String(err.message).slice(0, 200) });
      const C = require('./composeCore');
      const fb = C.fallbackComposed({ title: label, operatorAsk: task, summary: target.commitment?.summary, detail: target.commitment?.detail, done: criteria });
      ask = C.render(fb, { title: label, app, slug, delivery: chosen.delivery, deliveryPlain: D.describe(chosen.delivery), pipeline: pipe, by: 'compose:fallback' });
      by = 'compose:fallback';
      criteria = fb.done;
      goal = fb.goal;
    }
  }
  // Without a flow the factory parks the job as needs_human (JOBS-API v1.1).
  const flow = F.flowMarkdown({ title: label, summary: goal || task || target.commitment?.summary, app, done: criteria, delivery: chosen.delivery });
  // This machine's copy is the record (brief_path), wherever the factory runs.
  const briefPath = path.join(config.worktreesRoot, `run-${run.id}-BRIEF.md`);
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, ask, 'utf8');

  const argvFor = (staged) =>
    F.submitArgv({
      app,
      title: label,
      askFile: staged['BRIEF.md'] || briefPath,
      flowFile: staged['flow.md'],
      done: criteria,
      pipeline: pipe,
      delivery: chosen.delivery,
      models: overrides,
      externalId: run.id,
    });

  let job = null;
  let sent = false;
  try {
    // Staging is exec.js/remote territory; brief-over-stdin (runCommand's
    // `stdin` option, fix/pa-security) can replace it without touching this.
    const staged = await stage(where, run.id, where ? { 'BRIEF.md': ask, 'flow.md': flow } : { 'flow.md': flow });
    sent = true;
    job = await submit(argvFor(staged));
    if (!F.JOB_ID.test(String(job.job_id || ''))) throw new F.FactoryError('bad_output', `job id "${job.job_id}"`);
    await recordJob(run, job, { delivery: chosen.delivery, pipe, briefPath, by });
  } catch (err) {
    // The factory refused it (a contract error) or nothing was ever sent:
    // there is no job, and the run failed.
    // `bad_output` is not a refusal: the factory may have made the job and
    // then printed something else.
    const refused = err instanceof F.FactoryError && err.code !== 'bad_output' && !job;
    if (!sent || refused) {
      await query(
        `update run set status = 'failed', outcome = 'failed', outcome_at = now(), ended_at = now(), exit_note = $2, brief_path = $3, brief_by = $4 where id = $1`,
        [run.id, String(err.message).slice(0, 500), briefPath, by]
      );
      throw err;
    }
    // A submit went out and something after it failed: the factory may well
    // have the job. Ask it, and adopt, or park the row for the worker.
    log.warn('job submit did not come back cleanly; reconciling with the factory', { run: run.id, message: String(err.message).slice(0, 200) });
    const settled = await settle({ ...run, brief_path: briefPath }, { jobId: job?.job_id || null, ageMs: 0, note: err.message, extra: { delivery: chosen.delivery, pipe, briefPath, by } });
    if (settled.verdict !== 'adopt') {
      return {
        id: run.id, route: 'factory', mode: runMode, jobId: null, submitUnknown: true, app, delivery: chosen.delivery,
        deliveryRequested: chosen.delivery, deliverySource: chosen.source, deliveryPhrase: chosen.phrase, pipeline: pipe,
        machine: where, repoPath: target.repoPath || null, briefPath, briefBy: by, sessionId: null, url: null, routeReason, warnings: [],
        note: `the submit went out but its answer was lost (${F.clip(err.message, 160)}); the worker matches run #${run.id} to its job by external id — \`pa review ${run.id}\``,
      };
    }
    job = settled.job;
  }

  const warnings = Array.isArray(job.warnings) ? job.warnings.map((w) => F.clip(w, 300)).slice(0, 20) : [];
  if (warnings.length) log.warn('factory accepted the job with warnings', { run: run.id, job: job.job_id, warnings });
  if (commitmentId) {
    // After the job is recorded: a ledger hiccup must not orphan it.
    await ledger
      .transition({ commitmentId, to: 'dispatched', actor: 'dispatch', reason: `run #${run.id}: factory job ${job.job_id}`, from: ['open'] })
      .catch((err) => log.warn('job recorded, but its commitment did not move to dispatched', { run: run.id, message: err.message }));
  }

  // Walk-in: a termhub session on the factory's machine following the job,
  // so "Open in termhub" on the card lands on it. Not fatal: the job runs
  // whether or not anyone watches.
  let sessionId = null;
  let url = null;
  try {
    const hub = termhub.forMachine(where);
    const session = await hub.createSession({
      cwd: config.factory.path,
      command: F.followCommand(job.job_id),
      title: `pa#${run.id} factory · ${label.slice(0, 40)}`,
    });
    sessionId = session.id;
    await query('update run set termhub_session_id = $2 where id = $1', [run.id, sessionId]);
    url = await hub.sessionUrl(sessionId).catch(() => null);
  } catch (err) {
    log.warn('factory job started, but its follow session did not open', { run: run.id, job: job.job_id, message: err.message });
  }

  log.info('dispatched to the factory', { run: run.id, job: job.job_id, app, delivery: job.delivery || chosen.delivery, pipeline: job.pipeline || pipe, brief: by });
  return {
    id: run.id,
    route: 'factory',
    mode: runMode,
    jobId: job.job_id,
    created: job.created !== false,
    app,
    delivery: job.delivery || chosen.delivery,
    deliveryRequested: chosen.delivery,
    deliverySource: chosen.source,
    deliveryPhrase: chosen.phrase,
    pipeline: job.pipeline || pipe,
    machine: where,
    repoPath: target.repoPath || null,
    briefPath,
    briefBy: by,
    sessionId,
    url,
    routeReason,
    warnings,
  };
}

// The job, written onto its run. One statement, so a run is either still
// without a job or fully recorded with one.
async function recordJob(run, job, { delivery, pipe, briefPath, by }) {
  const warnings = Array.isArray(job.warnings) ? job.warnings.map((w) => F.clip(w, 300)).slice(0, 20) : [];
  await query(
    `update run set factory_job_id = $2, delivery = $3, pipeline = $4, brief_path = coalesce($5, brief_path), status = 'running',
                    factory_state = 'queued', factory_warnings = $6, exit_note = $7, brief_by = coalesce($8, brief_by)
      where id = $1`,
    [run.id, job.job_id, job.delivery || delivery || null, job.pipeline || pipe || null, briefPath || null,
      warnings.length ? JSON.stringify(warnings) : null, warnings.length ? F.clip(`factory warned: ${warnings.join('; ')}`, 500) : null, by || null]
  );
}

/**
 * A run whose submit went out but did not come back cleanly, settled against
 * what the factory says now (factoryCore.submitVerdict): adopted (recorded,
 * then followed like any other), failed, or left `waiting` as
 * `submit_unknown`. Never left `starting`.
 * @returns {Promise<{verdict: 'adopt'|'fail'|'unknown', job: object|null}>}
 */
async function settle(run, { jobId = null, ageMs = 0, note = null, extra = {} } = {}) {
  let job = null;
  let asked = false;
  try {
    if (jobId && F.JOB_ID.test(String(jobId))) {
      const j = await call(['job', 'status', jobId, '--json']);
      asked = true;
      job = F.jobForRun([j], run.id);
    } else {
      const l = await call(['job', 'list', '--json', '--source', 'pa']);
      asked = true;
      job = F.jobForRun(l.jobs, run.id);
    }
  } catch (err) {
    log.warn('could not ask the factory about an unsettled submit', { run: run.id, message: String(err.message).slice(0, 200) });
  }
  const verdict = F.submitVerdict({ job, asked, ageMs });
  try {
    if (verdict === 'adopt') {
      await recordJob(run, job, { delivery: extra.delivery, pipe: extra.pipe, briefPath: extra.briefPath, by: extra.by });
      log.info('adopted the factory job for an unsettled submit', { run: run.id, job: job.job_id });
    } else if (verdict === 'fail') {
      await query(
        `update run set status = 'failed', outcome = 'failed', outcome_at = now(), ended_at = now(), factory_state = 'not_submitted',
                        exit_note = $2 where id = $1 and factory_job_id is null`,
        [run.id, F.clip(`the factory has no job for run #${run.id}${note ? ` (${note})` : ''}`, 500)]
      );
    } else {
      await query(
        `update run set status = 'waiting', factory_state = 'submit_unknown', exit_note = $2, brief_path = coalesce($3, brief_path)
          where id = $1 and factory_job_id is null`,
        [run.id, F.clip(`submit sent; the factory's answer was lost${note ? ` (${note})` : ''} — the worker matches it by external id`, 500), extra.briefPath || null]
      );
    }
  } catch (err) {
    log.error('could not record an unsettled submit; the worker will retry it', { run: run.id, message: err.message });
  }
  return { verdict, job };
}

async function status(run) {
  return call(['job', 'status', run.factory_job_id, '--json']);
}

async function cancel(run) {
  return call(['job', 'cancel', run.factory_job_id, '--json']);
}

const LIVE = ['starting', 'running', 'waiting'];

/**
 * Writes one job's status onto its run, and — the first time the job is seen
 * terminal — moves the commitment through the ledger and says so.
 * @returns {Promise<{changed: boolean, ended: boolean}>}
 */
async function apply(run, job) {
  const u = F.runUpdate(job);
  const wasLive = LIVE.includes(run.status);
  // A run already ended (dropped by hand, or a delivered one watched for its
  // merge) keeps its status; only the measurements move.
  const nextStatus = wasLive ? u.status : run.status;
  const nextOutcome = u.outcome || run.outcome || null;
  const changed =
    nextStatus !== run.status ||
    nextOutcome !== (run.outcome || null) ||
    u.factory_state !== run.factory_state ||
    (u.cost_usd !== null && Number(run.cost_usd) !== u.cost_usd) ||
    (u.mr_url && u.mr_url !== run.mr_url);
  if (changed) {
    await query(
      `update run set status = $2, outcome = $3, outcome_at = case when $3::text is distinct from outcome then now() else outcome_at end,
                      factory_state = $4, cost_usd = coalesce($5, cost_usd), mr_url = coalesce($6, mr_url),
                      exit_note = coalesce($7, exit_note), delivery = coalesce($8, delivery),
                      ended_at = case when $9 and ended_at is null then now() else ended_at end
        where id = $1`,
      [run.id, nextStatus, nextOutcome, u.factory_state, u.cost_usd, u.mr_url, u.exit_note, u.delivery, u.terminal && wasLive]
    );
  }
  const ended = u.terminal && wasLive;
  if (ended) {
    const move = F.commitmentMove(job);
    if (move && run.commitment_id) {
      await ledger.transition({ commitmentId: run.commitment_id, to: move.to, actor: 'factory', reason: move.reason, from: move.from });
    }
    await require('../notify')
      .notify({
        kind: 'info',
        title: `Factory run #${run.id}: ${u.outcome === 'merged' ? 'merged' : job.state}`.slice(0, 200),
        body: [String(run.task).slice(0, 160), u.mr_url || null, job.why ? `Why: ${F.clip(job.why, 200)}` : null,
          job.state === 'done' && job.delivery === 'none' ? 'Committed in the factory\'s worktree; nothing pushed — the ask stays dispatched until you close it.' : null]
          .filter(Boolean)
          .join('\n'),
        url: u.mr_url || null,
        dedupeKey: `factory-end:${run.id}`,
      })
      .catch(() => {});
  } else if (wasLive && u.status === 'waiting' && run.status !== 'waiting') {
    await require('../notify')
      .notify({
        kind: 'info',
        title: `Factory run #${run.id} needs you`,
        body: `${String(run.task).slice(0, 160)}\n${job.why ? F.clip(job.why, 200) : job.state} — open its session or \`pa review ${run.id}\`.`,
        dedupeKey: `factory-wait:${run.id}:${job.updated_at || ''}`,
      })
      .catch(() => {});
  }
  return { changed: Boolean(changed), ended };
}

/**
 * The worker pass. One `job list --source pa --active` for everything still
 * going, plus `job status` for runs it no longer lists (they ended since the
 * last pass) and for delivered runs watched a fortnight for their merge.
 */
async function poll() {
  if (!enabled()) return { checked: 0 };
  const unsettled = await sweepUnsettled();
  const watched = await rows(
    `select * from run
      where route = 'factory' and factory_job_id is not null
        and (status in ('starting','running','waiting')
             or (outcome = 'delivered' and ended_at > now() - interval '14 days'))`
  );
  if (!watched.length) return unsettled ? { checked: 0, unsettled } : { checked: 0 };
  const listed = await call(['job', 'list', '--json', '--source', 'pa', '--active']);
  const byId = new Map((Array.isArray(listed.jobs) ? listed.jobs : []).map((j) => [j.job_id, j]));
  let changed = 0;
  let ended = 0;
  for (const run of watched) {
    const job =
      byId.get(run.factory_job_id) ||
      (await status(run).catch((err) => {
        log.debug('job status failed', { run: run.id, job: run.factory_job_id, message: err.message });
        return null;
      }));
    if (!job) continue;
    // Our job, or nobody's business: the external id is this run's id.
    if ((job.source && job.source !== 'pa') || (job.external_id != null && String(job.external_id) !== String(run.id))) {
      log.warn('factory job does not belong to this run; left alone', { run: run.id, job: run.factory_job_id });
      continue;
    }
    const r = await apply(run, job);
    if (r.changed) changed++;
    if (r.ended) ended++;
  }
  if (changed) log.info('factory runs updated', { checked: watched.length, changed, ended });
  return unsettled ? { checked: watched.length, changed, ended, unsettled } : { checked: watched.length, changed, ended };
}

/**
 * Runs with no job recorded that are not known to have failed: a submit whose
 * answer was lost (`submit_unknown`), or a process that died between the run
 * row and the submit (`starting` for more than two minutes). Each is settled
 * against `job list` by its external id; adopted ones then poll like any
 * other. Returns how many were looked at (0: no factory call at all).
 */
async function sweepUnsettled() {
  const stuck = await rows(
    `select *, extract(epoch from (now() - started_at)) * 1000 as age_ms from run
      where route = 'factory' and factory_job_id is null
        and (factory_state = 'submit_unknown' and status = 'waiting'
             or status = 'starting' and started_at < now() - interval '2 minutes')`
  ).catch(() => []);
  for (const run of stuck) {
    const r = await settle(run, { ageMs: Number(run.age_ms) || 0, extra: { by: run.brief_by } });
    if (r.verdict === 'adopt' && run.commitment_id) {
      await ledger
        .transition({ commitmentId: run.commitment_id, to: 'dispatched', actor: 'factory', reason: `run #${run.id}: factory job ${r.job.job_id} (answer recovered)`, from: ['open'] })
        .catch(() => {});
    }
  }
  return stuck.length;
}

module.exports = { enabled, machine, call, apps, addApp, start, settle, sweepUnsettled, status, cancel, apply, poll, runCommand, modelsFor, _setRunner };
