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
// The mode boundary still holds, enforced rather than requested: the PA mode
// maps to a delivery level (factoryCore.deliveryFor) that the factory clamps
// to the app's own ceiling — a job can only lower autonomy, never raise it.
// And a factory job changes code, so the planner never starts one on its own:
// it is always a proposal you say yes to (src/agent/planner.js).

const fs = require('fs');
const os = require('os');
const path = require('path');

const { config } = require('../config');
const { one, rows, query } = require('../db');
const { mode: resolveMode } = require('./modes');
const F = require('./factoryCore');
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
  return { ...F.parseModels(config.factory.models), ...F.parseModels(extra || []) };
}

// The ask and the flow must be files the factory can read, so on another
// machine they are written there first, through the same runCommand: a fixed
// Python program (the factory checkout always has Python under uv) that reads
// the contents as JSON on STDIN — never on a command line, where `ps` shows
// them and a big brief overflows the argument limit — and writes them into a
// fresh private directory (mkdtemp: unpredictable name, 0700) with
// O_CREAT|O_EXCL|O_NOFOLLOW (0600), printing the directory and paths as JSON.
// The directory is removed once the factory has the job (submit copies both
// into its direction); CLEANER only removes a directory WRITER could have made.
const STAGE_PREFIX = 'pa-factory-ask-';
const WRITER = [
  'import json, os, sys, tempfile',
  'req = json.loads(sys.stdin.buffer.read().decode("utf-8"))',
  `d = tempfile.mkdtemp(prefix='${STAGE_PREFIX}' + str(int(req['run'])) + '-')`,
  'flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)',
  'out = {}',
  'for name, text in req["files"].items():',
  '    p = os.path.join(d, os.path.basename(name))',
  '    fd = os.open(p, flags, 0o600)',
  '    with os.fdopen(fd, "wb") as f:',
  '        f.write(text.encode("utf-8"))',
  '    out[name] = p',
  "print(json.dumps({'dir': d, 'paths': out}))",
].join('\n');
const CLEANER = [
  'import json, os, shutil, sys, tempfile',
  'd = os.path.realpath(sys.argv[1])',
  'root = os.path.realpath(tempfile.gettempdir())',
  `ok = os.path.dirname(d) == root and os.path.basename(d).startswith('${STAGE_PREFIX}') and not os.path.islink(sys.argv[1])`,
  'if ok: shutil.rmtree(d, ignore_errors=True)',
  "print(json.dumps({'removed': ok}))",
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
    return { paths: out, dir: null };
  }
  const argv = ['uv', 'run', 'python', '-c', WRITER];
  const stdin = JSON.stringify({ run: Number(runId), files });
  const r = F.parseResult(await runCommand(where, argv, { cwd: config.factory.path, timeoutMs: config.factory.timeoutMs, stdin }));
  for (const name of Object.keys(files)) if (!r.paths?.[name]) throw new Error(`could not stage ${name} on ${where}`);
  return { paths: r.paths, dir: typeof r.dir === 'string' ? r.dir : null };
}

// Best effort: a leftover private temp dir is litter, not a leak.
async function unstage(where, dir) {
  if (!where || !dir) return;
  await runCommand(where, ['uv', 'run', 'python', '-c', CLEANER, dir], { cwd: config.factory.path, timeoutMs: 60_000 }).catch((err) =>
    log.warn('could not remove the staged ask on the factory machine', { dir, message: err.message })
  );
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
 * @param {string} [o.task]
 * @param {string} [o.mode]   PA mode; plan is refused
 * @param {string} [o.pipeline]
 * @param {Array<string>|string} [o.models]  `persona=model` entries, over PA_FACTORY_MODELS
 * @param {Array<string>} [o.done]  acceptance criteria
 * @param {string} [o.routeReason]
 */
async function start({ target, app, task = null, mode: modeName, pipeline = null, models = null, done = [], routeReason = null }) {
  const m = resolveMode(modeName);
  const delivery = F.deliveryFor(m.name);
  const where = machine();
  const commitmentId = target.commitment ? Number(target.commitment.id) : null;
  const label = task || target.commitment?.summary;
  if (!label) throw new Error('nothing to do — give a commitment id or a --task');
  if (!app) throw new Error('no factory app for this work');
  const pipe = F.pipeline(pipeline || config.factory.pipeline);
  const overrides = modelsFor(models);

  const run = await one(
    `insert into run (commitment_id, mode, task, repo_path, status, machine, route, route_reason, kind,
                      pipeline, delivery_requested, models)
     values ($1,$2,$3,$4,'starting',$5,'factory',$6,$7,$8,$9,$10) returning *`,
    [commitmentId, m.name, label, target.repoPath || null, where || os.hostname(), routeReason, target.commitment?.kind || null,
      pipe, delivery, Object.keys(overrides).length ? overrides : null]
  );

  // The ask is the BRIEF the Claude route would have written, minus what only
  // a Claude session can use (src/dispatch/brief.js, `factory`).
  const brief = await require('./index').briefFor(target, { modeName: m.name, run, task, factory: { app, delivery } });
  // Without a flow the factory parks the job as needs_human (JOBS-API v1.1).
  const flow = F.flowMarkdown({ title: label, summary: task || target.commitment?.summary, app, done, delivery });
  // This machine's copy is the record (brief_path), wherever the factory runs.
  const briefPath = path.join(config.worktreesRoot, `run-${run.id}-BRIEF.md`);
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, brief, 'utf8');

  let job;
  let stagedDir = null;
  try {
    const { paths: staged, dir } = await stage(where, run.id, where ? { 'BRIEF.md': brief, 'flow.md': flow } : { 'flow.md': flow });
    stagedDir = dir;
    job = await submit(
      F.submitArgv({
        app,
        title: label,
        askFile: staged['BRIEF.md'] || briefPath,
        flowFile: staged['flow.md'],
        done,
        pipeline: pipe,
        delivery,
        models: overrides,
        externalId: run.id,
      })
    );
    if (!F.JOB_ID.test(String(job.job_id || ''))) throw new F.FactoryError('bad_output', `job id "${job.job_id}"`);
  } catch (err) {
    await unstage(where, stagedDir);
    await query(
      `update run set status = 'failed', outcome = 'failed', outcome_at = now(), ended_at = now(), exit_note = $2, brief_path = $3 where id = $1`,
      [run.id, String(err.message).slice(0, 500), briefPath]
    );
    throw err;
  }

  await unstage(where, stagedDir);
  const warnings = Array.isArray(job.warnings) ? job.warnings.map((w) => F.clip(w, 300)).slice(0, 20) : [];
  await query(
    `update run set factory_job_id = $2, delivery = $3, pipeline = $4, brief_path = $5, status = 'running', factory_state = 'queued',
                    factory_warnings = $6, exit_note = $7
      where id = $1`,
    [run.id, job.job_id, job.delivery || delivery, job.pipeline || pipe, briefPath,
      warnings.length ? JSON.stringify(warnings) : null, warnings.length ? F.clip(`factory warned: ${warnings.join('; ')}`, 500) : null]
  );
  if (warnings.length) log.warn('factory accepted the job with warnings', { run: run.id, job: job.job_id, warnings });
  if (commitmentId) {
    await ledger.transition({ commitmentId, to: 'dispatched', actor: 'dispatch', reason: `run #${run.id}: factory job ${job.job_id}`, from: ['open'] });
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

  log.info('dispatched to the factory', { run: run.id, job: job.job_id, app, delivery: job.delivery || delivery, pipeline: job.pipeline || pipe });
  return {
    id: run.id,
    route: 'factory',
    mode: m.name,
    jobId: job.job_id,
    created: job.created !== false,
    app,
    delivery: job.delivery || delivery,
    deliveryRequested: delivery,
    pipeline: job.pipeline || pipe,
    machine: where,
    repoPath: target.repoPath || null,
    briefPath,
    sessionId,
    url,
    routeReason,
    warnings,
  };
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
  const watched = await rows(
    `select * from run
      where route = 'factory' and factory_job_id is not null
        and (status in ('starting','running','waiting')
             or (outcome = 'delivered' and ended_at > now() - interval '14 days'))`
  );
  if (!watched.length) return { checked: 0 };
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
  return { checked: watched.length, changed, ended };
}

module.exports = { enabled, machine, call, apps, start, status, cancel, apply, poll, runCommand, _setRunner };
