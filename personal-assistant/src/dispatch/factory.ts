'use strict';

// The software factory as THE dispatch target (decision D28): every commitment
// the PA dispatches becomes a factory job (src/dispatch/index.ts start).
//
// The one interface is the factory's job contract (software-factory
// docs/JOBS-API.md, v1). This file never imports factory code or reads its
// store: it runs `uv run factory job …` in the factory's checkout on the
// factory's machine (PA_FACTORY_PATH, PA_FACTORY_MACHINE) through
// `runCommand` (src/dispatch/exec.ts) and parses the one JSON object each
// `--json` command prints.
//
//   start({...})   submit the job, record it on a run row, open the walk-in session
//   poll()         the worker pass: job status → run row, and terminal jobs move
//                  their commitment through src/ledger (never directly)
//   cancel(run)    `factory job cancel` (pa drop)
//   status(run)    one job's status (pa review)
//   apps()         `factory app list`, kept here and in the store
//   refreshBoard() the worker pass behind the /factory page: the whole
//                  `job list` into factory_board, and notices on what changed
//   report/cancelJob/approve/openFollow  the factory page's and `pa factory`'s actions
//   pushed()       a factory's pushed job statuses (POST /api/factory/events)
//                  merged into factory_board at once, for the live feed; a
//                  pushed end settles its run through apply (settlePushed)
//
// Every job carries a kind (code | research | report | plan) and a runtime (api |
// claude_session), JOBS-API v1.2 (plan: v1.8). A research/report/plan job needs no repo and
// delivers `none`: its deliverable is a report the factory keeps. A v1
// factory refuses the v1.2 flags; a code job on the api runtime is resent
// without them (submit), anything else fails saying the factory is too old.
//
// The end state is the operator's call (operator decision 2026-11-02, no
// ceiling): every job carries an explicit `--delivery` — what they said
// (`pa do --delivery`, the card's pick), else their own words, else the repo's
// default (`pa delivery set`), else PA_DELIVERY_DEFAULT (src/dispatch/
// deliveryCore.ts). A factory job changes code, so the planner never starts one
// on its own: it is always a proposal you say yes to (src/agent/planner.ts).
//
// The ask is a COMPOSED brief (src/dispatch/compose.ts): the goal, done
// criteria, constraints, decisions and pointers to existing code the task
// needs — not the operator's memory pages or message bodies wholesale.
//
// Submission is idempotent on (source pa, external id = run id). Whatever goes
// wrong after a submit was sent, the run is reconciled against what the
// factory says (`job status` by id, or `job list` by external id): adopted,
// failed, or left `waiting` as `submit_unknown` for the worker to settle —
// never stuck in `starting`.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type ErrorWithCode = import('../types.ts').ErrorWithCode;
/** A run row (repo/runs), read column by column. */
type Run = Json;
/** One job as the factory's `--json` commands print it (JOBS-API.md). */
type Job = Json;
/** A dispatch target (dispatch.resolveTarget): store rows, read column by column. */
type Target = Json;
type ExecOptions = { cwd?: string | null; timeoutMs?: number; maxOutputBytes?: number; stdin?: string | null; env?: Record<string, string> | null };
type ExecResult = { code: number; stdout: string; stderr: string; timedOut?: boolean; signal?: string; truncated?: Json; error?: string; ms?: number };
type Runner = (machineName: string | null, argv: string[], opts: ExecOptions) => Promise<ExecResult>;
type CallOptions = { timeoutMs?: number; maxOutputBytes?: number | undefined };
type Staged = { paths: Record<string, string>; dir: string | null };
type Models = Record<string, string>;
type ModelsInput = string[] | string | Models | null | undefined;
type RecordExtra = { delivery?: string | null; pipe?: string | null; briefPath?: string | null; by?: string | null };
type Verdict = 'adopt' | 'fail' | 'unknown' | 'cancelled';
type Settled = { verdict: Verdict; job: Job | null; asked: boolean };
type StartOptions = {
  /** dispatch's resolveTarget() result */
  target: Target;
  /** the registered factory app (route.ts resolved it) */
  app: string | null;
  /** owner/name of the repo */
  slug?: string | null;
  /** the operator's own words, if they typed them */
  task?: string | null;
  /** an explicitly given PA mode; plan is refused */
  mode?: string | null;
  /** the end state; resolved when not given */
  delivery?: string | null;
  /** JOBS-API v1.9: off | on | auto, only when chosen (settings.policyArgs) */
  review?: string | null;
  /** JOBS-API v1.9: {budget_usd, wall_clock_h, max_rounds}, only the ones chosen */
  caps?: Record<string, number> | null;
  deliverySource?: string | null;
  deliveryPhrase?: string | null;
  pipeline?: string | null;
  /** `persona=model` entries, over PA_FACTORY_MODELS */
  models?: ModelsInput;
  /** a proposal's frozen models: used as they are */
  modelsExact?: boolean;
  /** acceptance criteria */
  done?: string[];
  /** a frozen brief (the card's): sent exactly, not recomposed */
  brief?: string | null;
  briefBy?: string | null;
  routeReason?: string | null;
  confirmedUnattended?: boolean;
  again?: boolean;
  title?: string | null;
  jobKind?: string;
  runtime?: string | null;
  branch?: string | null;
  pr?: number | string | null;
  /** ms the caller spent before this (dispatch.start: `route`), reported with the rest */
  timings?: Record<string, number> | null;
};
type Chain = { prs: Json[]; steps: Json[] };
type Patch = { jobId: string; patch: Json };
type Notice = { key: string; title: string; body: string; url: string | null };

const fs = require('fs');
const os = require('os');
const path = require('path');

const { config } = require('../config.ts');
const repository = require('../repo');
const { mode: resolveMode } = require('./modes.ts');
const F = require('./factoryCore.ts');
const D = require('./deliveryCore.ts');
const termhub = require('./termhub.ts');
const ledger = require('../ledger');
const { logger } = require('../log.ts');

const log = logger('factory');

// ------------------------------------------------------------ the runner ----
// Every factory command goes through exec.ts: this machine via child_process,
// another machine through its termhub's /api/exec.
let runnerOverride: Runner | null = null;

function runCommand(machineName: string | null, argv: string[], opts: ExecOptions): Promise<ExecResult> {
  if (runnerOverride) return runnerOverride(machineName, argv, opts);
  return require('./exec.ts').runCommand(machineName, argv, opts);
}

/** Tests only: swap the command runner. */
function _setRunner(fn: Runner | null): void {
  runnerOverride = fn;
}

function enabled(): boolean {
  return Boolean(config.factory.path);
}

/**
 * The factory's machine as runCommand and termhub want it: null for this one,
 * else a PA_MACHINES name. Empty, `local` or this machine's hostname mean this
 * machine: commands run here through child_process (no termhub /api/exec) and
 * walk-in sessions open on the local termhub. A name that is not in
 * PA_MACHINES would silently be treated as "here" by termhub, so it is refused
 * instead.
 */
function machine(): string | null {
  return factoryMachine(config.factory.machine, config.termhub.machines);
}

/** Pure core of machine(); exported for tests. */
function factoryMachine(raw: string | null | undefined, machines: Record<string, unknown>, hostname: string = os.hostname()): string | null {
  const name = String(raw || '').trim();
  if (!name || name.toLowerCase() === 'local' || name.toLowerCase() === String(hostname).toLowerCase()) return null;
  if (!machines[name]) {
    throw new Error(`PA_FACTORY_MACHINE "${name}" is not in PA_MACHINES — add it there (its termhub URL), or leave it empty (or "local") for this machine`);
  }
  return name;
}

async function call(sub: string[], { timeoutMs = config.factory.timeoutMs, maxOutputBytes = undefined }: CallOptions = {}): Promise<Json> {
  if (!enabled()) throw new Error('the factory is not configured — set PA_FACTORY_PATH (and PA_FACTORY_MACHINE if it is not this machine)');
  const opts: ExecOptions = { cwd: config.factory.path, timeoutMs };
  if (maxOutputBytes) opts.maxOutputBytes = maxOutputBytes;
  const where = machine();
  // Step session links open on the factory machine's termhub front (8.4.17).
  const front = termhub.forMachine(where).base;
  // A factory on this machine with `factory serve` running answers in-process
  // over localhost (plan 2.1): ~50-200 ms instead of 5-10 s of `uv run`.
  if (!where && !runnerOverride) {
    const served = await viaServe(sub, timeoutMs);
    if (served) {
      const parsed = F.frontSessions(F.parseResult(served), front);
      // serve's own clock for this call (the reply's `ms`). start() copies it
      // onto the submit lap and drops it so it is not stored on the job.
      if (typeof served.ms === 'number' && parsed && typeof parsed === 'object') parsed.serve_ms = served.ms;
      return parsed;
    }
  }
  // A factory on this Windows machine runs in Python's UTF-8 mode, as on
  // Linux: without it every un-annotated read_text() decodes as cp1252.
  if (!where && process.platform === 'win32') opts.env = { PYTHONUTF8: '1' };
  // Meter's factory hop (plan 7.5): every factory CLI call (submit, status, cancel, ...), named by its verb.
  const verb = String(sub[0] || 'call');
  return require('../telemetry').span('factory.cli', `factory ${verb}`, { verb, sub: String(sub[1] || '').slice(0, 24) }, async () => {
    const res = await runCommand(where, F.factoryArgv(sub, config.factory.uv), opts);
    return F.frontSessions(F.parseResult(res), front);
  });
}

const READ_ONLY = new Set(['job status', 'job list', 'job report', 'app list']);

/**
 * `factory serve`'s POST /api/cli: the same CLI command, run in its warm
 * process, answering {code, stdout, stderr} like runCommand. Returns null —
 * the caller then spawns the CLI — only when the command did not run: nothing
 * listens (serve restarting or not installed), or serve does not serve that
 * verb. A request that was sent and then timed out is NOT retried by spawning
 * (it may have run; a second submit would be a second job): it answers like a
 * timed-out command. Other connection errors fall back for read-only verbs only.
 */
async function viaServe(sub: string[], timeoutMs: number, url: string | null | undefined = config.factory.serveUrl): Promise<ExecResult | null> {
  if (!url) return null;
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/api/cli`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Factory': '1' },
      body: JSON.stringify({ argv: sub }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as ErrorWithCode & { cause?: { code?: string } };
    const code = err?.cause?.code || err?.code;
    if (code === 'ECONNREFUSED') return null; // nothing listening: nothing ran
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { code: 124, timedOut: true, stdout: '', stderr: `factory serve did not answer within ${timeoutMs} ms` };
    }
    if (READ_ONLY.has(sub.slice(0, 2).join(' '))) return null;
    return { code: 1, stdout: '', stderr: `factory serve connection failed (${code || err?.message}); not retried: the command may have run` };
  }
  if (res.status !== 200) return null; // verb not served (400) or a guard mismatch (403): use the CLI
  const body = (await res.json().catch(() => null)) as Json | null;
  if (!body || typeof body.code !== 'number') return null;
  const out: ExecResult = { code: body.code, stdout: String(body.stdout || ''), stderr: String(body.stderr || '') };
  if (typeof body.ms === 'number') out.ms = body.ms;
  // A success with no JSON on stdout is not a success (seen live: serve's output
  // capture lost a verb's stdout). A read-only verb is asked again through the
  // CLI; a state-changing one may have run, so it is reported, never re-run.
  if (out.code === 0 && !out.stdout.includes('{')) {
    if (READ_ONLY.has(sub.slice(0, 2).join(' '))) return null;
    return { code: 1, stdout: '', stderr: 'factory serve answered exit 0 with no output; not retried: the command may have run' };
  }
  return out;
}

// The last `app list`, in this process and in the store (setting APPS_SETTING),
// so a process that just started (each chat's MCP server, `pa e2e`, the CLI)
// does not pay a factory call before its first dispatch: `uv run factory`
// takes 3-14 s on Windows when serve does not answer the verb.
const APPS_SETTING = 'factory.apps';
let appsCache: { at: number; apps: Json[] } | null = null;

/**
 * The factory's registered apps. A list up to a minute old is answered as is;
 * up to 15 min old (or of any age with `stale`), at once while a refresh runs
 * behind it. `stale` is for picking an app, where a miss asks again with
 * `fresh` (route.forced): a new app is found then, and a removed one is
 * refused by the submit. `fresh` shares a refresh in flight, or one that
 * ended in the last few seconds.
 */
async function apps({ fresh = false, stale = false }: { fresh?: boolean; stale?: boolean } = {}): Promise<Json[]> {
  if (fresh) return appsCache && Date.now() - appsCache.at < 5_000 ? appsCache.apps : refreshApps();
  const cached = appsCache || (appsCache = await storedApps());
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < 60_000) return cached.apps;
  if (cached && (stale || age < 15 * 60_000)) {
    refreshApps().catch((err: Error) => log.debug('apps refresh failed', { message: err.message }));
    return cached.apps;
  }
  return refreshApps();
}

async function storedApps(): Promise<{ at: number; apps: Json[] } | null> {
  const row: Json | null = await repository.system.setting(APPS_SETTING).catch(() => null);
  const at = Date.parse(row?.value?.at);
  return Number.isFinite(at) && Array.isArray(row?.value?.apps) ? { at, apps: row.value.apps } : null;
}

let appsRefresh: Promise<Json[]> | null = null;
function refreshApps(): Promise<Json[]> {
  if (!appsRefresh) {
    appsRefresh = call(['app', 'list', '--json'])
      .then((r) => {
        const list: Json[] = Array.isArray(r.apps) ? r.apps : [];
        appsCache = { at: Date.now(), apps: list };
        repository.system.setSetting(APPS_SETTING, { at: new Date(appsCache.at).toISOString(), apps: list })
          .catch((err: Error) => log.debug('apps not stored', { message: err.message }));
        return list;
      })
      .finally(() => { appsRefresh = null; });
  }
  return appsRefresh;
}

/** Forgets the known list, here and in the store (an app was just added). */
async function forgetApps(): Promise<void> {
  appsCache = null;
  await repository.system.setSetting(APPS_SETTING, { at: null, apps: [] }).catch(() => {});
}

function modelsFor(extra: ModelsInput): Models {
  return { ...F.parseModels(config.factory.models), ...F.parseModels(modelEntries(extra)) };
}

// `persona=model` entries from a list, a string, or an {persona: model} object
// (the frozen form a proposal keeps).
function modelEntries(m: ModelsInput): string[] | string {
  if (!m) return [];
  if (Array.isArray(m) || typeof m === 'string') return m;
  return Object.entries(m).map(([k, v]) => `${k}=${v}`);
}

/**
 * Registers a repo with the factory (`factory app add`, JOBS-API.md). Its
 * `--delivery-default` is this repo's PA default, else PA_DELIVERY_DEFAULT —
 * though the PA sends `--delivery` on every job regardless.
 */
async function addApp({ repo, deliveryDefault = null, path: clonePath = null }: { repo: string; deliveryDefault?: string | null; path?: string | null }): Promise<Json> {
  const level = deliveryDefault || (await require('./delivery.ts').defaultFor(repo).catch(() => null)) || require('./delivery.ts').fallback();
  const r = await call(F.appAddArgv({ repo, deliveryDefault: D.delivery(level), path: clonePath }));
  await forgetApps();
  if (!r.app) throw new F.FactoryError('bad_output', 'app add answered without an app');
  return r;
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

async function stage(where: string | null, runId: number | string, files: Record<string, string>): Promise<Staged> {
  if (!where) {
    const out: Record<string, string> = {};
    for (const [name, text] of Object.entries(files)) {
      const p = path.join(config.worktreesRoot, `run-${runId}-${name}`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, 'utf8');
      out[name] = p;
    }
    return { paths: out, dir: null };
  }
  const argv = [F.uvBinary(config.factory.uv), 'run', 'python', '-c', WRITER];
  const stdin = JSON.stringify({ run: Number(runId), files });
  const r = F.parseResult(await runCommand(where, argv, { cwd: config.factory.path, timeoutMs: config.factory.timeoutMs, stdin }));
  for (const name of Object.keys(files)) if (!r.paths?.[name]) throw new Error(`could not stage ${name} on ${where}`);
  return { paths: r.paths, dir: typeof r.dir === 'string' ? r.dir : null };
}

// Best effort: a leftover private temp dir is litter, not a leak.
async function unstage(where: string | null, dir: string | null): Promise<void> {
  if (!where || !dir) return;
  await runCommand(where, [F.uvBinary(config.factory.uv), 'run', 'python', '-c', CLEANER, dir], { cwd: config.factory.path, timeoutMs: 60_000 }).catch((err: Error) =>
    log.warn('could not remove the staged ask on the factory machine', { dir, message: err.message })
  );
}

// A v1 factory refuses --kind/--runtime in its CLI parser (nothing written).
// A code job on the api runtime is exactly what v1 does without them, so it
// is resent bare; anything else needs v1.2 and fails with that said.
async function submit(argv: string[], { kind = 'code', runtime: rt = 'api' }: { kind?: string; runtime?: string } = {}): Promise<Job> {
  try {
    return await submitOnce(argv);
  } catch (e) {
    const err = e as ErrorWithCode;
    if (!(err instanceof F.FactoryError && err.code === 'unsupported_option')) throw err;
    // Continuing a branch or PR needs a factory that has it: never resent without.
    if (argv.some((a: string) => a === '--pr' || String(a).startsWith('--branch'))) {
      throw new F.FactoryError('unsupported_option', 'this factory cannot continue an existing branch or PR yet (`job submit --branch/--pr`) — update the factory, or start a new job');
    }
    if (kind !== 'code' || rt !== 'api') {
      throw new F.FactoryError('unsupported_option', `${err.message.replace(/^factory unsupported_option: /, '')}: a ${kind} job on the ${rt} runtime needs it — update the factory`);
    }
    log.warn('the factory predates JOBS-API v1.2; resending the code job without --kind/--runtime');
    return submitOnce(withoutV12(argv));
  }
}

/** The submit argv minus the v1.2 flags (each a flag and its value). */
function withoutV12(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--kind' || a === '--runtime') { i++; continue; }
    out.push(a);
  }
  return out;
}

// Submit, retried once on a transport failure (a lost answer): the run id is
// the external id, so the factory returns the job it already made rather
// than a second one. A contract error (unknown_repo, …) is not retried.
async function submitOnce(argv: string[]): Promise<Job> {
  let first: Job;
  try {
    first = await call(argv);
  } catch (err) {
    if (err instanceof F.FactoryError || err instanceof F.NotSentError) throw err;
    log.warn('job submit failed, retrying once with the same external id', { message: (err as Error).message });
    try {
      return await call(argv);
    } catch (again) {
      // The first attempt may have made the job: "not sent" now says nothing about it.
      if (again instanceof F.NotSentError) throw new Error(`${(again as Error).message} (after an earlier attempt whose answer was lost)`);
      throw again;
    }
  }
  // A key no one used before cannot already have a job: created:false on the
  // FIRST attempt means someone else's job holds it — never adopt that.
  if (first && first.created === false) {
    throw new F.FactoryError('duplicate_key', `the factory already had job ${first.job_id} for this run's external id`);
  }
  return first;
}

// This install's id (sql/026 pa_install): made once, then read.
let installCache: string | null = null;
async function installId(): Promise<string> {
  if (installCache) return installCache;
  const made: string = require('crypto').randomUUID();
  await repository.system.insertInstallIfNone(made).catch(() => {});
  const r = await repository.system.firstInstall().catch(() => null);
  const id: string = r?.id || made;
  installCache = id;
  return id;
}

/** Sends one PA run to the factory. */
async function start({
  target, app, slug = null, task = null, mode: modeName, delivery = null, deliverySource = null, deliveryPhrase = null,
  pipeline = null, models = null, modelsExact = false, done = [], brief = null, briefBy = null, routeReason = null,
  confirmedUnattended = false, again = false, title = null, jobKind = 'code', runtime = null, branch = null, pr = null, timings = null,
  review = null, caps = null,
}: StartOptions): Promise<Json> {
  // Where the call's time went, in ms: logged and answered (factory_start's timings_ms).
  const ms: Record<string, number> = { ...(timings || {}) };
  let mark = Date.now();
  const lap = (name: string) => { const now = Date.now(); ms[name] = (ms[name] || 0) + now - mark; mark = now; };
  // Plan mode is the read-only plan job (JOBS-API v1.8), never a code job.
  const kind = F.jobKind(modeName && resolveMode(modeName).name === 'plan' && F.jobKind(jobKind) === 'code' ? 'plan' : jobKind);
  if ((branch != null || pr != null) && kind !== 'code') throw new Error('only a code job continues a branch or PR');
  const where = machine();
  const commitmentId = target.commitment ? Number(target.commitment.id) : null;
  const label: string = title || task || target.commitment?.summary;
  if (!label) throw new Error('nothing to do — give a commitment id or a --task');
  if (!app && kind === 'code') throw new Error('no factory app for this work');
  const pipe = F.pipeline(pipeline || config.factory.pipeline);
  const overrides = modelsExact ? F.parseModels(modelEntries(models)) : modelsFor(models);
  // A research/report job's deliverable is the factory's report: `none`, always (v1.2).
  if (kind !== 'code' && delivery && D.delivery(delivery) !== 'none') {
    throw new Error(`a ${kind} job delivers a report, not ${delivery} — leave the end state at none`);
  }
  // git grep is the slow part of gather and it does not touch the database, so
  // it runs while the pool check, the delivery lookup and the run insert do.
  // gather() joins the same in-flight search (compose.ts). The PR read on a
  // continuation stays inside job submit: that call refuses a missing or closed
  // PR before it creates the job, and it cannot start until this brief exists.
  if (!brief && kind === 'code') {
    require('./compose.ts').warmHints({ target, task, done: Array.isArray(done) ? done : [] });
  }
  // The credit pool (src/claudePool.js): with PA_CLAUDE_POOL_FALLBACK_API on and the pool spent,
  // a claude_session job runs on the api runtime instead. Off by default.
  const picked = await require('../claudePool.ts').route(runtime ? F.runtime(runtime) : F.defaultRuntime(kind, config.factory.runtime));
  const rt = picked.runtime;
  if (picked.fellBack) log.warn('dispatching on the api runtime', { reason: picked.reason });
  const chosen: { delivery: string; source: string; phrase: string | null } = kind !== 'code'
    ? { delivery: 'none', source: 'kind', phrase: null }
    : delivery
      ? { delivery: D.delivery(delivery), source: deliverySource || 'explicit', phrase: deliveryPhrase || null }
      : await require('./delivery.ts').resolve({ mode: modeName ? resolveMode(modeName).name : null, operatorText: task, slug });
  const runMode = kind !== 'code' ? 'plan' : modeName ? resolveMode(modeName).name : D.modeFor(chosen.delivery);
  D.requireConfirmed(chosen.delivery, confirmedUnattended);

  const install = await installId();
  const run: Run = await require('../repo').runs.insertFactory(
    {
      commitmentId, mode: runMode, task: label, repoPath: target.repoPath || null, machine: where || os.hostname(),
      routeReason, kind: target.commitment?.kind || null, pipeline: pipe, deliveryRequested: chosen.delivery,
      models: Object.keys(overrides).length ? overrides : null, deliverySource: chosen.source, jobKind: kind, runtime: rt,
    },
    // The idempotency key, in the insert's own transaction: before anything is sent.
    { commitmentId, again, externalId: (row: Run) => F.externalKey(install, row.id) }
  );
  lap('prepare');

  // The ask: the card's frozen brief, or one composed now from the ask and
  // what the assistant gathered (src/dispatch/compose.ts). Composition never
  // fails a dispatch — the worst case is the deterministic brief. A research
  // or report job's ask is the operator's own words (factoryCore.researchAsk):
  // no composing model, no gathered context.
  let ask: string | null = brief;
  let by: string | null = briefBy || (brief ? 'proposal' : null);
  let criteria: string[] = Array.isArray(done) ? done : [];
  let goal: string | null = null;
  const continues = branch != null || pr != null ? { branch: branch ?? null, pr: pr ?? null } : null;
  if (!ask && kind !== 'code') {
    ask = F.researchAsk({ kind, title: label, ask: task || target.commitment?.detail || target.commitment?.summary, done: criteria, repo: slug });
    by = 'research:operator';
  }
  if (!ask) {
    try {
      const c = await require('./compose.ts').compose({ target, task, done: criteria, app, slug, delivery: chosen.delivery, pipeline: pipe, continues });
      ask = c.brief;
      by = c.by;
      criteria = c.done;
      goal = c.goal;
      if (c.ms) Object.assign(ms, { gather: c.ms.gather, hints: c.ms.hints, compose_model: c.ms.model });
    } catch (err) {
      log.warn('brief composition failed; sending the deterministic brief', { run: run.id, message: String((err as Error).message).slice(0, 200) });
      const C = require('./composeCore.ts');
      const fb = C.fallbackComposed({ title: label, operatorAsk: task, summary: target.commitment?.summary, detail: target.commitment?.detail, done: criteria });
      ask = C.render(fb, { title: label, app, slug, delivery: chosen.delivery, deliveryPlain: D.describe(chosen.delivery), pipeline: pipe, by: 'compose:fallback', continues });
      by = 'compose:fallback';
      criteria = fb.done;
      goal = fb.goal;
    }
  }
  // Without a flow the factory parks the job as needs_human (JOBS-API v1.1).
  // A research/report job needs none (v1.2: no backpressure gate for them).
  const flow: string | null = kind === 'code' ? F.flowMarkdown({ title: label, summary: goal || task || target.commitment?.summary, app, done: criteria, delivery: chosen.delivery, continues }) : null;
  // This machine's copy is the record (brief_path), wherever the factory runs.
  const briefPath = path.join(config.worktreesRoot, `run-${run.id}-BRIEF.md`);
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, ask, 'utf8');
  lap('brief');

  const argvFor = (staged: Record<string, string>): string[] =>
    F.submitArgv({
      app,
      title: label,
      askFile: staged['BRIEF.md'] || briefPath,
      flowFile: staged['flow.md'],
      done: criteria,
      pipeline: pipe,
      delivery: chosen.delivery,
      models: overrides,
      externalId: run.external_id,
      kind,
      runtime: rt,
      branch,
      pr,
      // JOBS-API v1.9: review only for a code job; caps when the card set them;
      // failover on when the PA's one failover policy is (src/dispatch/failover.ts).
      review: kind === 'code' ? review : null,
      caps,
      failover: config.factory.failover ? 'on' : null,
    });

  let job: Job | null = null;
  let sent = false;
  let stagedDir: string | null = null;
  try {
    // On another machine the brief and flow travel over runCommand's stdin
    // into a private mkdtemp dir there (stage/WRITER), never on a command line.
    const files: Record<string, string> = where ? { 'BRIEF.md': ask as string } : {};
    if (flow) files['flow.md'] = flow;
    const { paths: staged, dir }: Staged = Object.keys(files).length ? await stage(where, run.id, files) : { paths: {}, dir: null };
    stagedDir = dir;
    sent = true;
    const submitted = await submit(argvFor(staged), { kind, runtime: rt });
    // Before recordJob and the ledger move, so ms.serve is the factory's
    // reply and ms.submit stays the whole lap (8.4.45).
    if (typeof submitted.serve_ms === 'number') {
      ms.serve = submitted.serve_ms;
      delete submitted.serve_ms;
    }
    job = submitted;
    if (!F.JOB_ID.test(String(submitted.job_id || ''))) throw new F.FactoryError('bad_output', `job id "${submitted.job_id}"`);
    if (!(await recordJob(run, submitted, { delivery: chosen.delivery, pipe, briefPath, by }))) {
      await unstage(where, stagedDir);
      throw Object.assign(new Error(`run #${run.id} was dropped while its job was being submitted; job ${submitted.job_id} was cancelled`), { code: 'run_ended' });
    }
  } catch (e) {
    const err = e as ErrorWithCode;
    if (err.code === 'run_ended') throw err;
    // The factory refused it before writing anything (F.REFUSAL_CODES), or the
    // command never ran (exit 127, F.NotSentError), or nothing was ever sent:
    // there is no job, and the run failed. Anything else — `internal`,
    // `bad_output`, a lost answer — may have come after the job was made.
    const refused = !job && (F.isRefusal(err) || err instanceof F.NotSentError);
    if (!sent || refused) {
      await unstage(where, stagedDir);
      await repository.runs.markSubmitRefused(run.id, String(err.message).slice(0, 500), briefPath, by);
      throw err;
    }
    // A submit went out and something after it failed: the factory may well
    // have the job. Ask it, and adopt, or park the row for the worker.
    log.warn('job submit did not come back cleanly; reconciling with the factory', { run: run.id, message: String(err.message).slice(0, 200) });
    const settled = await settle({ ...run, brief_path: briefPath }, { jobId: job?.job_id || null, ageMs: 0, note: err.message, extra: { delivery: chosen.delivery, pipe, briefPath, by } });
    if (settled.verdict !== 'adopt') {
      // The staged files stay: a submit still running there may yet read them.
      return {
        id: run.id, route: 'factory', mode: runMode, jobId: null, submitUnknown: true, app, delivery: chosen.delivery,
        deliveryRequested: chosen.delivery, deliverySource: chosen.source, deliveryPhrase: chosen.phrase, pipeline: pipe,
        machine: where, repoPath: target.repoPath || null, briefPath, briefBy: by, sessionId: null, url: null, routeReason, warnings: [],
        note: `the submit went out but its answer was lost (${F.clip(err.message, 160)}); the worker matches run #${run.id} to its job by external id — \`pa review ${run.id}\``,
      };
    }
    job = settled.job;
  }
  if (!job) throw new Error(`run #${run.id}: the factory answered without a job`);

  await unstage(where, stagedDir);
  const warnings: string[] = Array.isArray(job.warnings) ? job.warnings.map((w: unknown) => F.clip(w, 300)).slice(0, 20) : [];
  if (warnings.length) log.warn('factory accepted the job with warnings', { run: run.id, job: job.job_id, warnings });
  if (commitmentId) {
    // After the job is recorded: a ledger hiccup must not orphan it.
    await ledger
      .transition({ commitmentId, to: 'dispatched', actor: 'dispatch', reason: `run #${run.id}: factory job ${job.job_id}`, from: ['open'] })
      .catch((err: Error) => log.warn('job recorded, but its commitment did not move to dispatched', { run: run.id, message: err.message }));
  }
  const jobId: string = job.job_id;
  lap('submit');

  // Walk-in: a termhub session on the factory's machine following the job,
  // so "Open in termhub" on the card lands on it. Not fatal: the job runs
  // whether or not anyone watches.
  // Opening one takes seconds on some machines (~9 s termhub on Windows), so
  // the answer waits only config.factory.followWaitMs for it; a slower one
  // finishes in the background and is recorded on the run when it opens.
  let sessionId: string | null = null;
  let url: string | null = null;
  const opening = (async () => {
    const s = await openFollow(jobId, `pa#${run.id} factory · ${label.slice(0, 40)}`, { card: commitmentId, run: run.id, job: jobId });
    await repository.runs.setSession(run.id, s.sessionId);
    return s;
  })();
  opening.catch((err: Error) => log.warn('factory job started, but its follow session did not open', { run: run.id, job: jobId, message: err.message }));
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([opening.catch(() => null), new Promise<undefined>((resolve) => { waitTimer = setTimeout(() => resolve(undefined), config.factory.followWaitMs); })]);
  clearTimeout(waitTimer);
  if (early) ({ sessionId, url } = early);
  else if (early === undefined) log.info('the follow session is still opening; answering without it', { run: run.id, job: job.job_id, waitedMs: config.factory.followWaitMs });
  lap('follow');

  log.info('dispatched to the factory', { run: run.id, job: job.job_id, app, kind, runtime: rt, delivery: job.delivery || chosen.delivery, pipeline: job.pipeline || pipe, brief: by, ms });
  return {
    id: run.id,
    route: 'factory',
    mode: runMode,
    jobId: job.job_id,
    jobKind: job.kind || kind,
    runtime: job.runtime || rt,
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
    // v1.3: what a --branch/--pr job continues ({branch, pr, into}); null otherwise.
    base: job.base && typeof job.base === 'object' ? job.base : null,
    // v1.6: false = nothing ticks the app, so the job stays queued until a human acts.
    ticked: typeof job.ticked === 'boolean' ? job.ticked : null,
    timings: ms,
  };
}

/**
 * A termhub session on the factory's machine running `factory job follow`,
 * so a human can walk into the job. Used at submit and by the factory page's
 * "Open in termhub" (any job, not only the PA's).
 * @returns {Promise<{sessionId: string, url: string|null}>}
 */
async function openFollow(jobId: string, title: string | null = null, links: Json | null = null): Promise<{ sessionId: string; url: string | null }> {
  const command = F.followCommand(jobId, config.factory.uv);
  const hub = termhub.forMachine(machine());
  const session: { id: string } = await hub.createSession({
    cwd: config.factory.path, command, title: String(title || `factory · ${jobId}`).slice(0, 80),
    // Plan E1: the session names its job (and the card and run, when a PA run started it).
    links: { ...(links || {}), job: jobId },
  });
  const url: string | null = await hub.sessionUrl(session.id).catch(() => null);
  return { sessionId: session.id, url };
}

// The job, written onto its run — only while the run is still live. A run
// dropped (or failed) while its submit was in flight is not brought back to
// `running`: the job it turns out to have is cancelled in the factory, and its
// id kept on the row as evidence. Returns whether the run is live.
async function recordJob(run: Run, job: Job, { delivery, pipe, briefPath, by }: RecordExtra): Promise<boolean> {
  const warnings: string[] = Array.isArray(job.warnings) ? job.warnings.map((w: unknown) => F.clip(w, 300)).slice(0, 20) : [];
  const recorded = await repository.runs.recordJob(run.id, {
    jobId: job.job_id,
    delivery: job.delivery || delivery || null,
    pipeline: job.pipeline || pipe || null,
    briefPath: briefPath || null,
    warnings,
    exitNote: warnings.length ? F.clip(`factory warned: ${warnings.join('; ')}`, 500) : null,
    by: by || null,
  });
  if (!recorded) {
    log.warn('a job turned up for a run that already ended; cancelling it', { run: run.id, job: job.job_id });
    await call(['job', 'cancel', job.job_id, '--json']).catch((err: Error) => log.error('could not cancel the late job', { run: run.id, job: job.job_id, message: err.message }));
    await repository.runs.markLateJobCancelled(run.id, job.job_id).catch(() => {});
    return false;
  }
  return true;
}

/**
 * A run whose submit went out but did not come back cleanly, settled against
 * what the factory says now (factoryCore.submitVerdict): adopted (recorded,
 * then followed like any other), failed, or left `waiting` as
 * `submit_unknown`. Never left `starting`.
 */
async function settle(run: Run, { jobId = null, ageMs = 0, note = null, extra = {} }: { jobId?: string | null; ageMs?: number; note?: string | null; extra?: RecordExtra } = {}): Promise<Settled> {
  let job: Job | null = null;
  let asked = false;
  try {
    if (jobId && F.JOB_ID.test(String(jobId))) {
      const j = await call(['job', 'status', jobId, '--json']);
      asked = true;
      job = F.jobForRun([j], run.external_id || run.id);
    } else {
      const l = await call(['job', 'list', '--json', '--source', 'pa']);
      asked = true;
      job = F.jobForRun(l.jobs, run.external_id || run.id);
    }
  } catch (err) {
    log.warn('could not ask the factory about an unsettled submit', { run: run.id, message: String((err as Error).message).slice(0, 200) });
  }
  const verdict: Verdict = F.submitVerdict({ job, asked, ageMs });
  try {
    if (verdict === 'adopt') {
      // submitVerdict adopts only a job it was given.
      job = job as Job;
      const live = await recordJob(run, job, { delivery: extra.delivery ?? null, pipe: extra.pipe ?? null, briefPath: extra.briefPath ?? null, by: extra.by ?? null });
      if (!live) return { verdict: 'cancelled', job, asked };
      log.info('adopted the factory job for an unsettled submit', { run: run.id, job: job.job_id });
    } else if (verdict === 'fail') {
      await repository.runs.markSubmitFailed(run.id, F.clip(`the factory has no job for run #${run.id}${note ? ` (${note})` : ''}`, 500));
    } else {
      await repository.runs.markSubmitUnknown(run.id, F.clip(`submit sent; the factory's answer was lost${note ? ` (${note})` : ''} — the worker matches it by external id`, 500), extra.briefPath || null);
    }
  } catch (err) {
    log.error('could not record an unsettled submit; the worker will retry it', { run: run.id, message: (err as Error).message });
  }
  return { verdict, job, asked };
}

async function status(run: Run): Promise<Job> {
  return call(['job', 'status', run.factory_job_id, '--json']);
}

async function cancel(run: Run): Promise<Json> {
  return call(['job', 'cancel', run.factory_job_id, '--json']);
}

const LIVE = ['starting', 'running', 'waiting'];

/**
 * Writes one job's status onto its run, and — the first time the job is seen
 * terminal — moves the commitment through the ledger and says so. The poll
 * and a pushed end (settlePushed) can hold the same run at once; a live run is
 * written only while it still has the status it was read with, so only one
 * of them ends it.
 */
async function apply(run: Run, job: Job): Promise<{ changed: boolean; ended: boolean }> {
  const u = F.runUpdate(job);
  const wasLive = LIVE.includes(run.status);
  // A run already ended (dropped by hand, or a delivered one watched for its
  // merge) keeps its status; only the measurements and the factory's state
  // move. Its own outcome stays, except that a delivered one may become merged.
  const nextStatus = wasLive ? u.status : run.status;
  const keepsOutcome = !wasLive && run.outcome && run.outcome !== 'delivered';
  const nextOutcome = keepsOutcome ? run.outcome : u.outcome || run.outcome || null;
  const changed =
    nextStatus !== run.status ||
    nextOutcome !== (run.outcome || null) ||
    u.factory_state !== run.factory_state ||
    (u.cost_usd !== null && Number(run.cost_usd) !== u.cost_usd) ||
    (u.subscription_equiv_usd !== null && run.subscription_equiv_usd !== undefined && Number(run.subscription_equiv_usd) !== u.subscription_equiv_usd) ||
    (u.mr_url && u.mr_url !== run.mr_url);
  let wrote = true;
  if (changed) {
    wrote = await repository.runs.applyFactoryState(run.id, {
      status: nextStatus,
      outcome: nextOutcome,
      factoryState: u.factory_state,
      costUsd: u.cost_usd,
      mrUrl: u.mr_url,
      exitNote: u.exit_note,
      delivery: u.delivery,
      ended: u.terminal && wasLive,
      whileStatus: wasLive ? run.status : null,
    }) !== false;
    // sql/031: a separate statement, so a store not yet migrated still records the rest.
    if (wrote && u.subscription_equiv_usd !== null) {
      await repository.runs.setSubscriptionEquiv(run.id, u.subscription_equiv_usd).catch(() => {});
    }
  }
  // Plan E1: every PR (number, state, CI) and every step with its session, on
  // every pass — a step's session or a PR's CI can change while nothing above does.
  await recordChain(run.id, job).catch((err: Error) => log.debug('run links not recorded', { run: run.id, message: err.message }));
  const ended = Boolean(u.terminal && wasLive && wrote);
  if (ended) {
    const move = F.commitmentMove(job);
    if (move && run.commitment_id) {
      await ledger.transition({ commitmentId: run.commitment_id, to: move.to, actor: 'factory', reason: move.reason, from: move.from });
    }
    // The card's context paragraph was written while the run went on (8.4.23).
    if (run.commitment_id) await repository.commitments.clearContext(run.commitment_id).catch(() => {});
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
  } else if (wrote && wasLive && u.status === 'waiting' && run.status !== 'waiting') {
    await require('../notify')
      .notify({
        kind: 'info',
        title: `Factory run #${run.id} needs you`,
        body: `${String(run.task).slice(0, 160)}\n${job.why ? F.clip(job.why, 200) : job.state} — open its session or \`pa review ${run.id}\`.`,
        dedupeKey: `factory-wait:${run.id}:${job.updated_at || ''}`,
      })
      .catch(() => {});
  }
  return { changed: Boolean(changed && wrote), ended };
}

/**
 * Plan E1: a job's PRs and steps (factoryCore.chainOf) onto run_pr / run_step
 * (sql/033), upserted, only rows that changed rewritten. Rows are never deleted:
 * a step or PR the factory stops listing keeps its last known state.
 */
async function recordChain(runId: number | string, job: Job): Promise<{ prs: number; steps: number }> {
  const { prs, steps }: Chain = F.chainOf(job);
  for (const p of prs) {
    await repository.runs.upsertPr(runId, p);
  }
  for (const s of steps) {
    await repository.runs.upsertStep(runId, s);
  }
  return { prs: prs.length, steps: steps.length };
}

/**
 * Plan E1: the stored chain of some runs, keyed by run id — their PRs and their
 * steps with sessions. Empty before sql/033 is applied.
 */
async function chains(runIds: Array<number | string> | null | undefined): Promise<Map<string, Chain>> {
  const ids = [...new Set((runIds || []).map(Number).filter(Number.isFinite))];
  const out = new Map<string, Chain>(ids.map((id) => [String(id), { prs: [], steps: [] }]));
  if (!ids.length) return out;
  const [prs, steps]: [Json[], Json[]] = await Promise.all([
    repository.runs.prsOf(ids).catch(() => []),
    repository.runs.stepsOf(ids).catch(() => []),
  ]);
  let front: string | null = null;
  try { front = termhub.forMachine(machine()).base; } catch { /* PA_FACTORY_MACHINE misnamed: links as stored */ }
  for (const p of prs) out.get(String(p.run_id))?.prs.push(p);
  for (const s of steps) out.get(String(s.run_id))?.steps.push({ ...s, url: F.frontUrl(s.url, front) });
  return out;
}

/**
 * The worker pass. One `job list --source pa --active` for everything still
 * going, plus `job status` for runs it no longer lists (they ended since the
 * last pass), for delivered runs watched a fortnight for their merge, and for
 * runs the PA ended first (a drop) until their job's last state is on them.
 */
async function poll(): Promise<{ checked: number; changed?: number; ended?: number; unsettled?: number }> {
  if (!enabled()) return { checked: 0 };
  const unsettled = await sweepUnsettled();
  const watched: Run[] = await repository.runs.watchedFactoryRuns();
  if (!watched.length) return unsettled ? { checked: 0, unsettled } : { checked: 0 };
  const listed = await call(['job', 'list', '--json', '--source', 'pa', '--active']);
  const byId = new Map<string, Job>((Array.isArray(listed.jobs) ? listed.jobs : []).map((j: Job) => [j.job_id, j]));
  let changed = 0;
  let ended = 0;
  for (const run of watched) {
    const job =
      byId.get(run.factory_job_id) ||
      (await status(run).catch((err: Error) => {
        log.debug('job status failed', { run: run.id, job: run.factory_job_id, message: err.message });
        return null;
      }));
    if (!job || !belongs(run, job)) continue;
    const r = await apply(run, job);
    if (r.changed) changed++;
    if (r.ended) ended++;
  }
  if (changed) log.info('factory runs updated', { checked: watched.length, changed, ended });
  return unsettled ? { checked: watched.length, changed, ended, unsettled } : { checked: watched.length, changed, ended };
}

/** Our job, or nobody's business: the external id is this run's id. */
function belongs(run: Run, job: Job): boolean {
  if ((job.source && job.source !== 'pa') || (job.external_id != null && String(job.external_id) !== String(run.external_id || run.id))) {
    log.warn('factory job does not belong to this run; left alone', { run: run.id, job: run.factory_job_id });
    return false;
  }
  return true;
}

// ------------------------------------------------- the factory page's data ----
// `job list` can be long (every job, every story): room for it.
const LIST_BYTES = 8 * 1024 * 1024;

/**
 * The worker pass behind the factory page (src/dashboard/factory.ts) and
 * `pa factory jobs`: the whole `factory job list --json` into factory_board
 * (sql/031), so no page load calls the factory. Then it tells the user what
 * changed since the last snapshot (factoryCore.notices): a job done, needing
 * them, failed, or with a PR whose CI turned red. A job a PA run submitted has
 * its end and its waits announced by the run pass (apply); only its CI is
 * announced here.
 */
async function refreshBoard(): Promise<{ jobs: number; notices: number } | null> {
  if (!enabled()) return null;
  const before: Json | null = await repository.factoryBoard.row().catch(() => null);
  let listed: Json;
  try {
    listed = await call(['job', 'list', '--json'], { maxOutputBytes: LIST_BYTES });
  } catch (err) {
    await repository.factoryBoard.recordError(F.clip((err as Error).message, 500)).catch(() => {});
    throw err;
  }
  const jobs: Job[] = (Array.isArray(listed.jobs) ? listed.jobs : []).filter((j: Job | null) => F.JOB_ID.test(String(j?.job_id || '')));
  await repository.factoryBoard.store(jobs);
  const prev = before?.polled_at ? F.noticeState(before.jobs) : null;
  const ours: Json[] = await repository.runs.distinctFactoryJobIds().catch(() => []);
  const covered = new Set(ours.map((r) => r.factory_job_id));
  const said: Notice[] = F.notices(prev, jobs, { covered });
  for (const n of said) {
    await require('../notify')
      .notify({ kind: 'info', title: n.title, body: n.body, url: n.url, dedupeKey: n.key })
      .catch((err: Error) => log.warn('factory notice not sent', { key: n.key, message: err.message }));
  }
  return { jobs: jobs.length, notices: said.length };
}

// What a pushed status may change on a stored job (POST /api/factory/events).
const PUSHED_FIELDS = ['state', 'why', 'updated_at'];

/**
 * Pure. A factory's pushed job statuses (one, or {jobs: [...]}) as clean
 * patches: a valid job id, a known state, and only PUSHED_FIELDS. At most 50.
 */
function pushedPatches(body: unknown): Patch[] {
  const b = body as Json | null | undefined;
  const list: Json[] = Array.isArray(b?.jobs) ? b.jobs : b && typeof b === 'object' ? [b] : [];
  const out: Patch[] = [];
  for (const j of list.slice(0, 50)) {
    const id = String(j?.job_id || '');
    if (!F.JOB_ID.test(id) || !F.STATES.includes(j?.state)) continue;
    const patch: Json = { state: j.state };
    if (typeof j.why === 'string') patch.why = j.why.slice(0, 1000);
    if (typeof j.updated_at === 'string' && !Number.isNaN(Date.parse(j.updated_at))) patch.updated_at = j.updated_at;
    out.push({ jobId: id, patch: Object.fromEntries(Object.entries(patch).filter(([k]) => PUSHED_FIELDS.includes(k))) });
  }
  return out;
}

/**
 * A factory pushed job status changes (plan item 0.4). Each one is merged
 * into the stored job list at once, so Build shows the new stage within a
 * second instead of after the next `job list` (seconds of Python start-up
 * per call); the factory_board trigger puts it on the live feed, and the
 * worker's pacer takes the full list soon after, which overwrites the patch
 * with the truth. A job the list does not hold yet waits for that pass.
 * A pushed end also settles its run (settlePushed), after the answer: the
 * factory's pusher waits on it (2 s) and the notification can take longer.
 */
async function pushed(body: unknown): Promise<{ ok: true; received: number; patched: number }> {
  const patches = pushedPatches(body);
  let patched = 0;
  for (const p of patches) {
    patched += await repository.factoryBoard.patchJob(p.jobId, p.patch, p.patch.state);
  }
  // Wake the pacer even when nothing was patched (a new job, or only its why).
  if (patches.length) await repository.factoryBoard.notifyPush(patches.map((p) => p.jobId));
  if (patches.some((p) => ENDS.has(p.patch.state))) {
    // One at a time, in the order pushed: an end and the correction GitHub sends after it.
    settling = settling.then(() => settlePushed(patches)).catch((err: Error) => {
      log.warn('a pushed job end did not settle its run; the poll will', { message: err.message });
      return 0;
    });
  }
  return { ok: true, received: patches.length, patched };
}

const ENDS = new Set(['done', 'failed', 'cancelled']);
let settling: Promise<number> = Promise.resolve(0);

/**
 * A pushed end (done, failed, cancelled) settles the run that holds the job
 * at once (8.4.44), through the poll's own apply: the stored job (the last
 * `job list`, with the push merged in) under the pushed state and why. The
 * run is closed, its card's context cleared and "Factory run #N: …" raised
 * here, so a job's end reaches Plan and Build with the push, not a poll
 * later; the next poll finds the run ended and only refreshes what its list
 * adds (a merge, the cost). A job the stored list does not hold yet, or no
 * run of ours holds, waits for the poll. Resolves how many runs it ended.
 */
async function settlePushed(patches: Patch[]): Promise<number> {
  const ends = patches.filter((p) => ENDS.has(p.patch.state));
  if (!ends.length) return 0;
  const [watched, { jobs }]: [Run[], { jobs: Job[] }] = await Promise.all([repository.runs.watchedFactoryRuns(), snapshot()]);
  let ended = 0;
  for (const p of ends) {
    const run = watched.find((r) => r.factory_job_id === p.jobId);
    const stored = jobs.find((j) => j.job_id === p.jobId);
    if (!run || !stored) continue;
    const job: Job = { ...stored, ...p.patch, terminal: true };
    if (!belongs(run, job)) continue;
    if ((await apply(run, job)).ended) ended++;
  }
  if (ended) log.info('factory runs settled from a push', { ended });
  return ended;
}

/** Tests only: resolves once every pushed end so far has been settled. */
function _settled(): Promise<number> {
  return settling;
}

/** The last stored `job list` and when it was taken (never calls the factory). */
async function snapshot(): Promise<{ jobs: Job[]; polledAt: unknown; error: string | null; errorAt: unknown }> {
  const r: Json | null = await repository.factoryBoard.row().catch(() => null);
  return { jobs: Array.isArray(r?.jobs) ? r.jobs : [], polledAt: r?.polled_at || null, error: r?.error || null, errorAt: r?.error_at || null };
}

/** One job from the snapshot, or null. */
async function snapshotJob(jobId: string): Promise<Job | null> {
  return (await snapshot()).jobs.find((j) => j.job_id === jobId) || null;
}

/**
 * A research/report job's report (JOBS-API v1.2 `job report --json`):
 * {job_id, title, markdown, path}. A v1 factory has no such command.
 */
async function report(jobId: string): Promise<{ jobId: string; title: string; markdown: string; path: string | null; none?: true }> {
  try {
    const r = await call(F.reportArgv(jobId), { maxOutputBytes: LIST_BYTES });
    return { jobId: String(r.job_id || jobId), title: String(r.title || ''), markdown: String(r.markdown || ''), path: r.path ? String(r.path) : null };
  } catch (e) {
    const err = e as ErrorWithCode;
    if (err instanceof F.FactoryError && err.code === 'no_report') return { jobId, title: '', markdown: '', path: null, none: true };
    if (err instanceof F.FactoryError && err.code === 'unsupported_command') {
      throw Object.assign(new Error('this factory has no reports yet (it predates JOBS-API v1.2)'), { status: 409 });
    }
    throw err;
  }
}

/**
 * Carries on a job that stopped (`factory job resume <id> --json`). A factory
 * without the command says so plainly rather than as a parse error.
 */
async function resume(jobId: string): Promise<{ jobId: string; state: string | null; why: string | null; raw: Json }> {
  let r: Json;
  try {
    r = await call(F.resumeArgv(jobId));
  } catch (e) {
    const err = e as ErrorWithCode;
    if (err instanceof F.FactoryError && err.code === 'unsupported_command') {
      throw Object.assign(new Error('this factory cannot resume jobs yet (`job resume`) — update the factory'), { status: 409 });
    }
    throw err;
  }
  await refreshBoard().catch(() => {});
  return { jobId: String(r.job_id || jobId), state: r.state || null, why: r.why || null, raw: r };
}

/**
 * Cancels a job. One a live PA run holds is dropped through the dispatcher
 * (`pa drop`: it cancels the job and settles the run and its commitment);
 * any other is `factory job cancel`.
 */
async function cancelJob(jobId: string): Promise<Json> {
  const argv = F.cancelArgv(jobId);
  const run: Run | null = await repository.runs.liveRunOfJob(jobId).catch(() => null);
  if (run) {
    const r: Json | null = await require('./index.ts').drop(Number(run.id));
    await refreshBoard().catch(() => {});
    return { jobId, run: Number(run.id), state: r?.cancelled ? 'cancelled' : 'ended', storiesParked: r?.storiesParked ?? null };
  }
  const r = await call(argv);
  await refreshBoard().catch(() => {});
  return { jobId, state: r.state || null, storiesParked: Array.isArray(r.stories_parked) ? r.stories_parked.length : null, why: r.why || null };
}

/**
 * Approves a needs_human job's direction — only the approval the factory
 * itself named for this job (factoryCore.approveArgv), read from the
 * snapshot, never an id from the request. `approve-direction` prints text,
 * not JSON: exit 0 is the answer.
 */
async function approve(jobId: string, { channel = 'cli' }: { channel?: string } = {}): Promise<{ jobId: string; approved: true; output: string }> {
  if (!F.JOB_ID.test(String(jobId || ''))) throw Object.assign(new Error(`not a factory job id: "${jobId}"`), { status: 400 });
  const job = await snapshotJob(jobId);
  // Policy (plan 4.3): audited with the job's delivery, and refused for a channel the policy bars (voice never approves a merge).
  // A passkey step-up (7.1) applies here for a click or the CLI; from the chat the permission prompt
  // was answered (and step-up checked) by the page, so it is not asked again for the job id.
  const policy = require('../policy');
  const preq = { tool: 'factory_approve', action: 'approve', channel, subject: jobId, args: { job: jobId, delivery: job?.delivery || undefined, delivery_unknown: !job } };
  const verdict = await policy.enforce(preq, { stepUp: channel !== 'chat' });
  if (channel !== 'chat') await policy.consumeStepUp(preq, verdict);
  const argv = job ? F.approveArgv(job) : null;
  if (!argv) throw Object.assign(new Error(`job ${jobId} is not waiting on an approval the factory named`), { status: 409 });
  const res = await runCommand(machine(), F.factoryArgv(argv, config.factory.uv), { cwd: config.factory.path, timeoutMs: config.factory.timeoutMs });
  if (res.code !== 0) throw new Error(`approve-direction failed (exit ${res.code}): ${F.clip(String(res.stderr || res.stdout || '').trim(), 300)}`);
  await refreshBoard().catch(() => {});
  return { jobId, approved: true, output: F.clip(String(res.stdout || '').trim(), 500) };
}

/**
 * Runs with no job recorded that are not known to have failed: a submit whose
 * answer was lost (`submit_unknown`), or a process that died between the run
 * row and the submit (`starting` for more than two minutes). Each is settled
 * against `job list` by its external id; adopted ones then poll like any
 * other. Returns how many were looked at (0: no factory call at all).
 */
async function sweepUnsettled(): Promise<number> {
  const stuck: Run[] = await repository.runs.unsettledFactory().catch(() => []);
  for (const run of stuck) {
    const r = await settle(run, { ageMs: Number(run.age_ms) || 0, extra: { by: run.brief_by } });
    if (r.verdict === 'fail') {
      await require('../notify')
        .notify({
          kind: 'info',
          title: `Factory run #${run.id}: submit never confirmed — marked failed`,
          body: `${String(run.task || '').slice(0, 160)}\n${r.asked ? 'The factory has no job for it.' : 'The factory could not be asked for a day.'} If a job turns up anyway: \`uv run factory job list --source pa\`.`,
          dedupeKey: `factory-unsettled:${run.id}`,
        })
        .catch(() => {});
    }
    if (r.verdict === 'adopt' && run.commitment_id) {
      await ledger
        .transition({ commitmentId: run.commitment_id, to: 'dispatched', actor: 'factory', reason: `run #${run.id}: factory job ${(r.job as Job).job_id} (answer recovered)`, from: ['open'] })
        .catch(() => {});
    }
  }
  return stuck.length;
}

module.exports = {
  enabled, machine, factoryMachine, call, apps, forgetApps, addApp, installId, start, settle, sweepUnsettled, status, cancel, apply, poll, runCommand, modelsFor, _setRunner,
  submit, withoutV12, openFollow, refreshBoard, snapshot, snapshotJob, report, cancelJob, approve, resume, recordChain, chains,
  pushed, pushedPatches, settlePushed, _settled, viaServe,
};
