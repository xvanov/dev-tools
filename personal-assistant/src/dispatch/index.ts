'use strict';

// Dispatch: a commitment becomes a software-factory job (start; decision D28:
// every agent session the PA starts is a factory job, so it shows on Build and
// is metered, on the credit pool or the API keys). Runs from before that are
// Claude Code sessions in a git worktree, and the land / drop / review /
// reconcile verbs below still manage them.
//
// The worktree is not an optimisation. The root CLAUDE.md is explicit that a
// dirty tree breaks termhub's own updater, and a dispatched agent working
// directly in `C:\repos\<x>` would put your main checkout into whatever state
// it reached when you stopped watching. One worktree per run, removed by
// `pa drop`, and your checkout is never a dispatched agent's problem.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).
// dispatch/index.js is the shim `require('../dispatch')` lands on.

type Json = import('../types.ts').Json;
type ErrorWithCode = import('../types.ts').ErrorWithCode;
/** A run row (repo/runs), read column by column. */
type Run = Json;
/** What a run is about: store rows (commitment, source item, project, person), read column by column. */
type Target = { commitment: Json | null; item: Json | null; project: Json | null; person: Json | null; repoPath: string | null };
type Chosen = { delivery: string | null; source: string | null; phrase?: string | null };
type SessionChoice = { mode: string; delivery: string | null; source: string | null; phrase: string | null };
type StartOptions = {
  commitmentId?: number | string | null;
  task?: string | null;
  mode?: string | null | undefined;
  repoPath?: string | null;
  machine?: string | null;
  again?: boolean;
  /** gone (D28): every dispatch is a factory job; anything but `factory` is refused */
  via?: string | null;
  pipeline?: string | null;
  models?: string[] | string | Record<string, string> | null;
  done?: string[] | null;
  app?: string | null;
  routeReason?: string | null;
  agent?: string | null;
  model?: string | null;
  delivery?: string | null;
  deliverySource?: string | null;
  deliveryPhrase?: string | null;
  brief?: string | null;
  briefBy?: string | null;
  /** an accepted proposal: its values are used exactly as the card showed them */
  frozen?: boolean;
  register?: boolean;
  confirmedUnattended?: boolean;
  repoVerified?: boolean;
  jobKind?: string | null;
  runtime?: string | null;
  title?: string | null;
  branch?: string | null;
  pr?: number | string | null;
};
type DeliveryAsk = { commitmentId?: number | string | null; task?: string | null; mode?: string | null | undefined; delivery?: string | null; repoPath?: string | null };

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { config } = require('../config.ts');
const repository = require('../repo');
const { mode: resolveMode } = require('./modes.ts');
const { buildBrief, openingPrompt } = require('./brief.ts');
const D = require('./deliveryCore.ts');
const termhub = require('./termhub.ts');
const ledger = require('../ledger');
const { logger } = require('../log.ts');

const exec = promisify(execFile);
const log = logger('dispatch');

// A URL that is syntactically valid and resolves to nothing. Set as the
// worktree's pushurl for modes that may not push, so `git push` fails fast and
// legibly instead of reaching the remote.
const BLOCKED_PUSH_URL = 'https://pa-push-blocked.invalid/this-run-may-not-push.git';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    // A fetch or push that waits on a network or a prompt must not hang a start.
    timeout: 300_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

function slug(text: string | null | undefined): string {
  return String(text || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
}

async function defaultBranch(repoPath: string): Promise<string> {
  try {
    const out = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return out.trim().replace(/^origin\//, '');
  } catch {
    // The remote's branches first: a local `main` may be stale or never pushed.
    for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/remotes/origin/develop', 'main', 'master', 'develop']) {
      try {
        await git(repoPath, ['rev-parse', '--verify', '--quiet', ref]);
        return ref.split('/').pop() as string;
      } catch {
        /* try the next one */
      }
    }
    return 'main';
  }
}

/**
 * What a new run's worktree starts from: origin's default branch, fetched now
 * (as a remote run does), so the work is on top of what is really there — not
 * a local `main` that may be days behind (which makes push_to_main's
 * fast-forward fail and a PR conflict). A fetch that fails falls back to the
 * origin/<base> ref already here (said in the log), never to the local branch;
 * without either the start is refused. A repo with no `origin` at all is
 * local-only work and starts from its local branch.
 */
async function worktreeBase(repoPath: string): Promise<string> {
  const base = await defaultBranch(repoPath);
  const remotes = (await git(repoPath, ['remote']).catch(() => '')).split(/\r?\n/).map((r) => r.trim());
  if (!remotes.includes('origin')) return base;
  try {
    await git(repoPath, ['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    return `origin/${base}`;
  } catch (e) {
    const err = e as Error;
    const have = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).then(() => true, () => false);
    if (have) {
      log.warn('could not fetch origin; starting from the origin ref already here', { repo: repoPath, base, message: String(err.message).slice(0, 200) });
      return `origin/${base}`;
    }
    throw new Error(`could not fetch origin/${base} in ${repoPath}, and there is no copy of it here — not starting from a local branch that may be stale (${(String(err.message).split('\n')[0] as string).slice(0, 160)})`);
  }
}

/**
 * `--repo` must name a known project (its checkout, or its owner/name): a run
 * is never started in an arbitrary directory a message or a typo pointed at.
 */
async function knownRepo(repoPath: string): Promise<Json> {
  const p: Json | null = await repository.projects.activeByRepo(String(repoPath)).catch(() => null);
  if (!p) throw new Error(`${repoPath} is not a known project's repo — \`pa projects\` lists them (\`pa projects sync\` adds new checkouts)`);
  return p;
}

async function resolveTarget({ commitmentId, repoPath }: { commitmentId?: number | string | null; repoPath?: string | null }): Promise<Target> {
  if (!commitmentId) return { commitment: null, item: null, project: null, person: null, repoPath: repoPath ?? null };

  const commitment: Json | null = await repository.commitments.byId(commitmentId);
  if (!commitment) throw new Error(`no commitment #${commitmentId}`);

  const item: Json | null = await repository.sources.rowById(commitment.source_item_id);
  const project: Json | null = commitment.project_id ? await repository.projects.rowById(commitment.project_id) : null;
  const person: Json | null = commitment.counterparty_person_id ? await repository.people.rowById(commitment.counterparty_person_id) : null;

  const resolved: string | null = repoPath || commitment.repo_path || project?.repo_path || null;
  return { commitment, item, project, person, repoPath: resolved };
}

async function relatedContext(item: Json | null): Promise<Json[]> {
  if (!item?.thread_external_id) return [];
  return repository.sources.relatedInThread(item.thread_external_id, item.id);
}

// The memory's contribution to a brief. Never blocks a dispatch: any piece
// that fails is simply absent.
async function memoryContext({ commitment, item, project, person }: Target, task?: string | null): Promise<{ facts: Json[]; person: string | null; project: string | null }> {
  const memory = require('../memory');
  const question = [task || commitment?.summary, commitment?.detail, item?.subject].filter(Boolean).join(' — ');
  const [recalled, personPage, projectPage]: Array<Json | null> = await Promise.all([
    // Only the claims are read below, so only the claims are recalled.
    question ? require('../recall').recallClaims(question).catch(() => null) : null,
    person ? memory.getPage({ kind: 'person', id: person.id }).catch(() => null) : null,
    project ? memory.getPage({ kind: 'project', id: project.id }).catch(() => null) : null,
  ]);
  return {
    facts: scopeFacts(recalled && !recalled.abstain ? recalled.claims : [], { personId: person?.id, projectId: project?.id }),
    person: personPage?.body || null,
    project: projectPage?.body || null,
  };
}

/**
 * Pure. Remembered facts a dispatched run may see: about the task's own
 * requester or project, or a topic — never about another person or project
 * (recall searches everything the operator knows; a run needs only its own).
 */
function scopeFacts(facts: Json[] | null | undefined, { personId = null, projectId = null }: { personId?: number | string | null | undefined; projectId?: number | string | null | undefined } = {}): Json[] {
  return (facts || []).filter((f) => {
    if (f.subjectKind === 'topic') return true;
    if (f.subjectKind === 'person') return personId != null && String(f.subjectId) === String(personId);
    if (f.subjectKind === 'project') return projectId != null && String(f.subjectId) === String(projectId);
    return false; // 'me' (the operator), or unknown
  });
}

// The BRIEF for a target — the Claude route's BRIEF.md, and the factory
// route's ask (src/dispatch/factory.ts), from one implementation.
async function briefFor(
  target: Target,
  { modeName, run, task = null, factory = null, delivery = null }: { modeName: string; run: Run; task?: string | null; factory?: Json | null; delivery?: string | null }
): Promise<string> {
  return buildBrief({
    delivery,
    commitment: target.commitment,
    item: target.item,
    project: target.project,
    person: target.person,
    modeName,
    run,
    related: await relatedContext(target.item),
    memory: await memoryContext(target, task),
    factory,
  });
}

/**
 * Starts a run: always a software-factory job (src/dispatch/factory.ts;
 * decision D28). Nothing here starts a Claude Code session of its own: plan
 * mode is a read-only `plan` job, research and reports are `research`/`report`
 * jobs, and code is a `code` job in the repo's factory app (registered first
 * when the factory does not know the repo yet, unless `register` is false).
 *
 * Whatever the caller does not choose comes from the card's dispatch settings
 * (src/dispatch/settings.ts): its stored overrides, else the defaults —
 * runtime claude_session, mode full, the job kind read from the ask, the end
 * state from the factory app's delivery.default.
 *
 * `frozen` (an accepted proposal, src/proposals): app, done-criteria, brief,
 * delivery, pipeline and models are used exactly as the card showed them —
 * nothing is re-chosen or re-derived at accept time; a card from before job
 * kinds is a code job.
 */
async function start(o: StartOptions): Promise<Json> {
  const calledAt = Date.now();
  const {
    commitmentId = null, task = null, repoPath = null, machine = null, again = false, via = null,
    pipeline = null, models = null, done = null, routeReason: givenReason = null,
    deliverySource = null, deliveryPhrase = null, brief = null, briefBy = null, frozen = false, register = true,
    confirmedUnattended = false, repoVerified = false, title = null, branch: onBranch = null, pr: onPr = null,
    agent = null, model = null,
  } = o;
  const F = require('./factoryCore.ts');
  const factory = require('./factory.ts');
  if (via && !['factory', 'auto'].includes(String(via).toLowerCase())) {
    throw new Error(`there is no route to pick: every dispatch is a software-factory job — drop --via ${via}`);
  }
  if (!factory.enabled()) throw new Error('every dispatch is a software-factory job and the factory is not configured — set PA_FACTORY_PATH (see `pa doctor`)');
  if (machine && !termhub.isLocal(machine)) {
    throw new Error(`--machine is gone: every run is a factory job and runs on the factory's machine (PA_FACTORY_MACHINE) — drop --machine ${machine}`);
  }
  if (agent && agent !== 'claude') throw new Error(`--agent ${agent}: every run is a factory job — its agent is the runtime (claude_session or api)`);
  const continues = onBranch != null || onPr != null;
  const given = {
    jobKind: o.jobKind ? F.jobKind(o.jobKind) : frozen || continues ? 'code' : null,
    runtime: o.runtime ? F.runtime(o.runtime) : null,
    mode: o.mode ? resolveMode(o.mode).name : null,
    delivery: o.delivery ? D.delivery(o.delivery) : null,
    app: o.app || null,
    repo: repoPath || null,
  };
  const eff = await require('./settings.ts').effective({ commitmentId, task, given });
  const s = eff.settings;
  const kind: string = s.jobKind;
  // `--repo` must be a known project. A card's repo was checked when the card
  // was made (offer.ts `repoVerifiedAt`) and is not re-judged at accept. A
  // research/report/plan job only reads: an owner/name it names need not be a
  // checkout here (the factory reads its own, or the ask just names it).
  const repo: string | null = repoPath || eff.overrides.repo || null;
  const readOnlySlug = kind !== 'code' && require('./routeCore.ts').normSlug(repo);
  if (repo && !repoVerified && !readOnlySlug) await knownRepo(repo);
  // One live run per commitment. A second Do while the first is still setting
  // up started a second agent on the same ask.
  if (commitmentId && !again) {
    const live: Run | null = await repository.runs.liveForCommitment(commitmentId);
    if (live) {
      const where = termhub.isLocal(live.machine) ? '' : ` on ${live.machine}`;
      throw new Error(`#${commitmentId} already has run #${live.id}${where} — attach to it (pa attach ${live.id}), or drop it first`);
    }
  }
  const target = await resolveTarget({ commitmentId, repoPath: repo });
  const choice: Json = await require('./route.ts').forced({
    target, mode: s.mode, done, app: s.app, register, exactDone: frozen, jobKind: kind,
  });
  const delivery: string = s.delivery;
  const source: string = eff.source.delivery === 'given' ? deliverySource || 'explicit' : eff.source.delivery;
  const extraModels = model && s.runtime === 'claude_session' ? [`claude_session=${String(model).replace(/^(anthropic|cli)\//, '')}`] : null;
  if (model && !extraModels) throw new Error('a bare --model names the Claude model of a claude_session job — on api, give --model persona=provider/model');
  return factory.start({
    target, app: choice.app, slug: choice.slug, task, mode: s.mode, pipeline,
    models: extraModels ? [...modelList(models), ...extraModels] : models,
    modelsExact: frozen, done: choice.done,
    routeReason: givenReason || `${choice.reason} (${kind}: ${eff.why.jobKind})`,
    delivery, deliverySource: source, deliveryPhrase: source === 'explicit' ? deliveryPhrase : eff.phrase,
    brief, briefBy, confirmedUnattended, again,
    jobKind: kind, runtime: s.runtime, title, branch: onBranch, pr: onPr, timings: { route: Date.now() - calledAt },
  });
}

// `persona=model` entries from a list, a comma list, or a {persona: model} object.
function modelList(m: StartOptions['models']): string[] {
  if (!m) return [];
  if (Array.isArray(m)) return m;
  if (typeof m === 'string') return m.split(',').map((x) => x.trim()).filter(Boolean);
  return Object.entries(m).map(([k, v]) => `${k}=${v}`);
}

/**
 * LEGACY (no production caller since D28): a Claude Code session in its own
 * worktree, on this machine or another one's termhub. Kept only while the
 * land / drop / remote tests seed their runs through it (docs/native/PLAN.md
 * 8.6.3, "delete startSession"); every dispatch goes through start() above.
 */
async function startSession({
  commitmentId = null, task = null, mode: modeName, repoPath = null, machine = null, again = false,
  via = null, pipeline = null, models = null, done = null, app = null, routeReason: givenReason = null,
  agent = null, model = null, delivery = null, deliverySource = null, deliveryPhrase = null,
  brief = null, briefBy = null, frozen = false, register = false, confirmedUnattended = false, repoVerified = false,
  jobKind = null, runtime = null, title = null, branch: onBranch = null, pr: onPr = null,
}: StartOptions): Promise<Json> {
  // Not metered: a raw Claude Code session outside the factory. Said loudly
  // and put on the Meter as a call of unknown cost, never silent.
  log.warn('a Claude Code session outside the factory (legacy startSession): metered-unknown', { commitmentId, task: task ? String(task).slice(0, 80) : null });
  await require('../budget.ts').record({ purpose: 'dispatch-session-unmetered', model: model || null, backend: 'claude_session_unmetered', costUsd: null, ok: true }).catch(() => {});
  if (repoPath && !repoVerified) await knownRepo(repoPath);
  if (commitmentId && !again) {
    const live: Run | null = await repository.runs.liveForCommitment(commitmentId);
    if (live) {
      const where = termhub.isLocal(live.machine) ? '' : ` on ${live.machine}`;
      throw new Error(`#${commitmentId} already has run #${live.id}${where} — attach to it (pa attach ${live.id}), or drop it first`);
    }
  }
  if (delivery) delivery = D.delivery(delivery);
  let routeReason: string | null = givenReason || 'a Claude session (legacy)';
  if (onBranch != null || onPr != null) throw new Error('continuing an existing branch or PR is a factory job — send it --via factory');
  // The end state, for a Claude session: what the PA does when it ends
  // (src/durable/tasks/runReview.ts), and the session's own mode, enforced in
  // its worktree. Plan mode delivers nothing.
  const chosen = await sessionDelivery({ modeName, delivery, deliverySource, deliveryPhrase, task, commitmentId, repoPath });
  requireConfirmed(chosen.delivery, confirmedUnattended);
  if (machine && !termhub.isLocal(machine) && ['pr', 'auto_merge', 'push_to_main'].includes(chosen.delivery as string)) {
    throw new Error(`delivery \`${chosen.delivery}\` is carried out by the assistant when the session ends, which it can only do for runs on this machine — use none, branch or draft_pr on ${machine}, or run it here`);
  }
  modeName = chosen.mode;
  // Which agent and model (src/dispatch/agent.ts), resolved before anything
  // is created so a bad choice leaves no run row or worktree behind.
  if (machine && !termhub.isLocal(machine)) {
    // src/dispatch/remote.ts types that machine's own claude. A choice made
    // for this run is refused rather than dropped; the defaults
    // (PA_DISPATCH_AGENT/MODEL) are for local runs and do not apply.
    if ((agent && agent !== 'claude') || model) {
      throw new Error('a run on another machine starts that machine\'s claude — --agent/--model apply to local runs only');
    }
    return startRemote({ commitmentId, task, modeName, repoPath, machineName: machine, routeReason, chosen, again });
  }
  // Which agent and model (src/dispatch/agent.ts), resolved before anything
  // is created so a bad choice leaves no run row or worktree behind.
  const launch = require('./agent.ts').dispatchCommand({ agent, model, prompt: openingPrompt({}) });
  const m = resolveMode(modeName);
  // PA_SANDBOX=on (src/dispatch/sandbox.ts): refused up front for a mode it
  // cannot cover yet, so nothing runs unsandboxed and nothing is left behind.
  const sandbox = require('./sandbox.ts');
  const sandboxed = sandbox.enabled();
  if (sandboxed) sandbox.requireSandboxable(m.name);
  const target = await resolveTarget({ commitmentId, repoPath });

  const label = task || target.commitment?.summary;
  if (!label) throw new Error('nothing to do — give a commitment id or a --task');

  const repo = target.repoPath;
  if (!repo && m.name !== 'plan') {
    throw new Error(
      'no repo for this commitment — set one with `pa show <id> --project <name>`, or pass --repo'
    );
  }
  if (repo && !fs.existsSync(path.join(repo, '.git'))) {
    throw new Error(`${repo} is not a git repository`);
  }

  const localRun = (argv: string[]) => require('./exec.ts').runCommand(null, argv, { timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: '0' } });
  // The push block older code put on the SHARED config (it blocked the main
  // checkout, and every new no-push run then failed its leak check). Before
  // anything is created, so a failure here leaves nothing behind.
  if (repo) {
    const cleared = await require('./remote.ts').clearLegacyBlock({ machine: { name: 'this machine' }, repo, blockedPushUrl: BLOCKED_PUSH_URL, run: localRun });
    if (cleared.length) log.info('removed an old shared push block', { repo, remotes: cleared });
  }

  const run = await require('../repo').runs.insertClaude(
    {
      commitmentId, mode: m.name, task: label, repoPath: repo, machine: os.hostname(), routeReason,
      kind: target.commitment?.kind || null, delivery: chosen.delivery, deliverySource: chosen.source,
    },
    { commitmentId, again }
  );

  let worktreePath = null;
  let branch = null;
  let briefPath = null;
  let session = null;
  let worktreeMade = false;
  let sandboxHost = null;

  // Everything from here to 'running' is undone on any error: the row is
  // marked failed with the reason, the session killed, the worktree and its
  // branch removed — never a `starting` row and a worktree left lying there.
  try {
    if (repo) {
      branch = `pa/${run.id}-${slug(label)}`;
      worktreePath = path.join(config.worktreesRoot, `run-${run.id}`);
      fs.mkdirSync(config.worktreesRoot, { recursive: true });

      const base = await worktreeBase(repo);
      await git(repo, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, base]);
      worktreeMade = true;

      if (!m.mayPush) {
        // Enforcement, not persuasion — and verified. The one implementation a
        // remote run uses too: every remote blocked in the worktree's OWN config
        // (a plain `git config` there writes the shared one, blocking the main
        // checkout and every other run), then read back. Throws if it didn't take.
        await require('./remote.ts').blockPush({
          machine: { name: 'this machine' },
          repo,
          worktree: worktreePath,
          blockedPushUrl: BLOCKED_PUSH_URL,
          run: localRun,
        });
      }

      await repository.runs.setWorktree(run.id, worktreePath, branch);
    }

    let briefText = await briefFor(target, { modeName: m.name, run: { ...run, worktree_path: worktreePath, branch }, task, delivery: chosen.delivery });
    let command = launch.command;
    if (sandboxed) {
      const workdir = worktreePath || path.join(config.worktreesRoot, `run-${run.id}-plan`);
      fs.mkdirSync(workdir, { recursive: true });
      const stateDir = path.join(config.worktreesRoot, `run-${run.id}.sbx`);
      const host = sandboxHost = await sandbox.start({
        factoryPath: config.factory.path,
        stateDir,
        spec: sandbox.hostSpec({
          runId: run.id, workdir, stateDir, mode: m.name, repoPath: repo, branch,
          claudeBin: launch.agent === 'claude' ? process.env.PA_SANDBOX_CLAUDE_BIN || null : null,
          passEnv: process.env.PA_SANDBOX_PASS_ENV || null,
        }),
      });
      command = sandbox.wrapCommand(host.wrap, launch.command, require('../platform').id === 'windows' ? 'windows' : 'posix');
      briefText = `${briefText.trimEnd()}\n\n${sandbox.BRIEF_NOTE}`;
    }

    briefPath = worktreePath
      ? path.join(worktreePath, 'BRIEF.md')
      : path.join(config.worktreesRoot, `run-${run.id}-BRIEF.md`);
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(briefPath, briefText, 'utf8');

    // Every worktree is a folder Claude has never seen; trusted ahead of time
    // so its session does not stop at the trust question (src/dispatch/trust.ts).
    try {
      // The run's own folder too: a folder once refused (an earlier attempt)
      // carries its own "not trusted" entry, which outranks the root's.
      require('./trust.ts').ensureTrusted(config.worktreesRoot);
      if (worktreePath) require('./trust.ts').ensureTrusted(worktreePath);
    } catch (err) {
      log.warn('could not mark the worktrees trusted', { message: (err as Error).message });
    }
    const spec = {
      cwd: worktreePath || repo || config.reposRoot,
      command,
      title: `pa#${run.id} ${label.slice(0, 40)}`,
      // Marks everything the agent runs: `pa do` / `pa answer` refuse an
      // unattended end state from inside a dispatched run.
      env: { PA_DISPATCHED_RUN: String(run.id) },
      // Plan E1: the session names its card and run, so Run links back to them.
      links: { card: commitmentId, run: run.id },
    };
    // A run that may not push also starts without push credentials
    // (src/dispatch/remote.ts noPushEnv); refused if termhub cannot do that.
    session = m.mayPush
      ? await termhub.createSession(spec)
      : await require('./remote.ts').createNoPushSession(termhub, spec, null, { fam: require('../platform').id === 'windows' ? 'windows' : 'posix', runId: run.id });

    await repository.runs.markRunning(run.id, session.id, briefPath);
  } catch (err) {
    if (sandboxHost) {
      try { process.kill(sandboxHost.pid); } catch { /* already gone */ }
    }
    await rollbackStart({ run, repo, worktreePath, branch, worktreeMade, session, err });
    throw err;
  }

  if (commitmentId) {
    await ledger.transition({ commitmentId, to: 'dispatched', actor: 'dispatch', reason: `run #${run.id}`, from: ['open'] });
  }
  // When the session ends, a durable task offers to land it (src/durable/tasks/runReview.ts).
  await require('../durable')
    .spawn('run_review', { runId: Number(run.id) }, { key: `run:${run.id}` })
    .catch((err: Error) => log.warn('run review not scheduled', { run: run.id, message: err.message }));

  // Waits for Claude's prompt (answering the folder-trust question a new
  // worktree always gets), types the brief prompt and checks it was taken.
  // opencode got the prompt on its command line; nothing is typed at it.
  if (launch.typesPrompt) {
    await termhub.briefClaude(termhub, session.id, openingPrompt(run)).catch((err: Error) => {
      log.warn('could not type the opening prompt', { run: run.id, message: err.message });
    });
  }

  const url = await termhub.sessionUrl(session.id);
  log.info('dispatched', { run: run.id, mode: m.name, repo, branch, agent: launch.agent, model: launch.model, delivery: chosen.delivery });

  return {
    id: run.id, route: 'claude', routeReason, mode: m.name, repoPath: repo, worktreePath, branch, briefPath, sessionId: session.id, url,
    delivery: chosen.delivery, deliverySource: chosen.source, deliveryPhrase: chosen.phrase,
  };
}

// Undoes a local start that failed before its run reached 'running'. Best
// effort, each step on its own: the original error is what the caller sees.
async function rollbackStart({ run, repo, worktreePath, branch, worktreeMade, session, err }: {
  run: Run; repo: string | null; worktreePath: string | null; branch: string | null; worktreeMade: boolean; session: Json | null; err: unknown;
}): Promise<void> {
  if (session?.id) await termhub.killSession(session.id).catch(() => {});
  require('./remote.ts').removeNoGhDirs(run.id);
  if (worktreeMade && repo && worktreePath) {
    await git(repo, ['worktree', 'remove', '--force', worktreePath]).catch(() => {});
    await git(repo, ['worktree', 'prune']).catch(() => {});
    if (branch) await git(repo, ['branch', '-D', branch]).catch(() => {});
  }
  const why = String((err as Error | null)?.message || err);
  await repository.runs.markStartFailed(run.id, `start failed: ${why}`.slice(0, 500)).catch((e: Error) => log.warn('could not mark the failed run', { run: run.id, message: e.message }));
  log.warn('run failed to start; rolled back', { run: run.id, message: why.slice(0, 300) });
}

// The same run, on another machine's termhub (src/dispatch/remote.ts). The
// repo is the local one's namesake under that machine's repos root; the
// worktree, the pushurl block and BRIEF.md are made there, by the session.
async function startRemote({ commitmentId, task, modeName, repoPath, machineName, routeReason = null, chosen = { delivery: null, source: null }, again = false }: {
  commitmentId: number | string | null; task: string | null; modeName: string; repoPath: string | null; machineName: string;
  routeReason?: string | null; chosen?: Chosen; again?: boolean;
}): Promise<Json> {
  const remote = require('./remote.ts');
  const machine: Json = remote.machineNamed(machineName);
  const hub = termhub.forMachine(machine.name);
  const m = resolveMode(modeName);
  const target = await resolveTarget({ commitmentId, repoPath });

  const label = task || target.commitment?.summary;
  if (!label) throw new Error('nothing to do — give a commitment id or a --task');
  if (!target.repoPath) {
    throw new Error('no repo for this commitment — set one with `pa show <id> --project <name>`, or pass --repo');
  }
  const repo = remote.remoteRepoPath(machine, target.repoPath);

  const run = await require('../repo').runs.insertClaude(
    {
      commitmentId, mode: m.name, task: label, repoPath: repo, machine: machine.name, routeReason,
      kind: target.commitment?.kind || null, delivery: chosen.delivery, deliverySource: chosen.source,
    },
    { commitmentId, again }
  );
  const branch = `pa/${run.id}-${slug(label)}`;
  const worktreePath = remote.remoteWorktreePath(machine, run.id);
  const briefText = await briefFor(target, { modeName: m.name, run: { ...run, worktree_path: worktreePath, branch }, task, delivery: chosen.delivery });

  let started;
  try {
    started = await remote.startOnMachine({
      machine,
      hub,
      run,
      repo,
      branch,
      mode: m,
      brief: briefText,
      title: `pa#${run.id} ${label.slice(0, 40)}`,
      blockedPushUrl: BLOCKED_PUSH_URL,
    });
  } catch (e) {
    const err = e as Error & { sessionId?: string };
    await repository.runs.markRemoteStartFailed(run.id, err.sessionId || null, err.message.slice(0, 500));
    throw err;
  }

  await repository.runs.markRemoteRunning(run.id, { sessionId: started.sessionId, briefPath: started.briefPath, worktreePath: started.worktreePath, branch });
  if (commitmentId) {
    await ledger.transition({ commitmentId, to: 'dispatched', actor: 'dispatch', reason: `run #${run.id}`, from: ['open'] });
  }
  await termhub.briefClaude(hub, started.sessionId, openingPrompt(run)).catch((err: Error) => {
    log.warn('could not type the opening prompt', { run: run.id, message: err.message });
  });
  log.info('dispatched', { run: run.id, mode: m.name, repo, branch, machine: machine.name });

  return {
    id: run.id,
    route: 'claude',
    routeReason,
    mode: m.name,
    machine: machine.name,
    repoPath: repo,
    worktreePath: started.worktreePath,
    branch,
    briefPath: started.briefPath,
    sessionId: started.sessionId,
    url: started.url,
    delivery: chosen.delivery,
    deliverySource: chosen.source,
  };
}

const requireConfirmed = D.requireConfirmed;

/**
 * The end state a start would get, before anything is created — so the CLI
 * and the page can show it, and ask, first. The same resolution as start
 * (src/dispatch/settings.ts): the caller's choice, the card's, else the
 * factory app's default. A research/report/plan job delivers `none`.
 */
async function previewDelivery({ commitmentId = null, task = null, mode = undefined, delivery = null, repoPath = null, jobKind = null, app = null }: DeliveryAsk & { jobKind?: string | null; app?: string | null }): Promise<Chosen & { jobKind: string }> {
  const F = require('./factoryCore.ts');
  const eff = await require('./settings.ts').effective({
    commitmentId, task,
    given: { mode: mode ? resolveMode(mode).name : null, delivery: delivery ? D.delivery(delivery) : null, jobKind: jobKind ? F.jobKind(jobKind) : null, app, repo: repoPath },
  });
  const source = eff.source.delivery === 'given' ? 'explicit' : eff.source.delivery;
  return { delivery: eff.settings.delivery, source, phrase: eff.phrase, jobKind: eff.settings.jobKind };
}

/**
 * A Claude session's delivery and the mode its worktree is held to.
 * Pure rules in deliveryCore; this reads the repo default when it needs it.
 *   - plan mode: read-only, delivers nothing (delivery null)
 *   - an explicit mode with no delivery: the mode's own level
 *   - a delivery: the session runs in D.modeFor(delivery) unless a mode was
 *     given too, and a mode that may push cannot carry delivery `none`
 */
async function sessionDelivery({ modeName, delivery, deliverySource, deliveryPhrase, task, commitmentId, repoPath }: {
  modeName: string | null | undefined; delivery: string | null; deliverySource: string | null; deliveryPhrase: string | null;
  task: string | null; commitmentId: number | string | null; repoPath: string | null;
}): Promise<SessionChoice> {
  const explicitMode: string | null = modeName ? resolveMode(modeName).name : null;
  if (explicitMode === 'plan') {
    if (delivery && delivery !== 'none') throw new Error(`plan mode is read-only; it cannot deliver \`${delivery}\``);
    return { mode: 'plan', delivery: null, source: null, phrase: null };
  }
  let chosen: Chosen;
  if (delivery) {
    chosen = { delivery, source: deliverySource || 'explicit', phrase: deliveryPhrase || null };
  } else {
    let slugName: string | null = null;
    if (!explicitMode && !D.infer(task)) {
      const target = await resolveTarget({ commitmentId, repoPath }).catch(() => null);
      slugName = target ? await require('./route.ts').slugFor(target).catch(() => null) : null;
    }
    chosen = await require('./delivery.ts').resolve({ mode: explicitMode, operatorText: task, slug: slugName });
  }
  const sessionMode: string = explicitMode || D.modeFor(chosen.delivery);
  if (chosen.delivery === 'none' && resolveMode(sessionMode).mayPush) {
    throw new Error(`mode \`${sessionMode}\` pushes, but the delivery is \`none\` — drop --mode, or pick a delivery past none`);
  }
  return { mode: sessionMode, delivery: chosen.delivery, source: chosen.source, phrase: chosen.phrase || null };
}

// git on a remote run's worktree happens on that machine, not here.
function localOnly(run: Run, verb: string): void {
  if (run.route === 'factory') {
    throw new Error(`run #${run.id} is a factory job (${run.factory_job_id || 'not submitted'}): the factory ${verb === 'land' ? 'delivers it itself' : 'has its diff'} — \`pa review ${run.id}\` shows the job, its PRs and why`);
  }
  if (!termhub.isLocal(run.machine)) {
    throw new Error(
      `run #${run.id} is on ${run.machine}: ${verb} it in its session (pa attach ${run.id}), ` +
        `or ask it — pa say ${run.id} "show me git diff --stat"`
    );
  }
}

type RunId = number | string;

async function get(runId: RunId): Promise<Run | null> {
  return repository.runs.byId(runId);
}

// The card's context paragraph names its runs' status and is rewritten only
// when its thread moves, so a run that ends forgets it (8.4.23).
async function forgetContext(run: Run | null): Promise<void> {
  if (run?.commitment_id) await repository.commitments.clearContext(run.commitment_id).catch(() => {});
}

async function list({ all = false, limit = 20 }: { all?: boolean; limit?: number } = {}): Promise<Run[]> {
  return repository.runs.recent(all, limit);
}

async function steer(runId: RunId, text: string): Promise<true> {
  const run = await get(runId);
  if (!run) throw new Error(`no run #${runId}`);
  if (run.route === 'factory') {
    throw new Error(`run #${runId} is a factory job: its session only follows the job — answer it in the factory (\`pa review ${runId}\` says why it waits)`);
  }
  if (!run.termhub_session_id) throw new Error(`run #${runId} has no session`);
  await termhub.forMachine(run.machine).say(run.termhub_session_id, text);
  return true;
}

// The chat's read-only `pa` tool runs verbs with PA_READ_ONLY=1 (src/mcp/server.js):
// a review then reads and reports, and writes nothing.
function readOnly(): boolean {
  return process.env.PA_READ_ONLY === '1';
}

async function review(runId: RunId): Promise<Json> {
  const run = await get(runId);
  if (!run) throw new Error(`no run #${runId}`);
  if (run.route === 'factory') {
    if (!run.factory_job_id) {
      // A submit whose answer was lost: ask the factory now rather than wait for the worker.
      if (['starting', 'waiting'].includes(run.status) && !readOnly()) {
        const ageMs = Date.now() - new Date(run.started_at || Date.now()).getTime();
        await require('./factory.ts').settle(run, { ageMs, extra: { by: run.brief_by } });
        const now = (await get(runId)) as Run;
        if (now.factory_job_id) return review(runId);
        return { run: now, factory: null };
      }
      return { run, factory: null };
    }
    const job = await require('./factory.ts').status(run);
    if (readOnly()) return { run, factory: job };
    await require('./factory.ts').apply(run, job);
    return { run: await get(runId), factory: job };
  }
  localOnly(run, 'review');
  if (!run.worktree_path) return { run, diff: null, stat: null, status: null };

  const base = await defaultBranch(run.repo_path);
  const [stat, status, logOut] = await Promise.all([
    git(run.worktree_path, ['diff', '--stat', `${base}...HEAD`]).catch(() => ''),
    git(run.worktree_path, ['status', '--porcelain']).catch(() => ''),
    git(run.worktree_path, ['log', '--oneline', `${base}..HEAD`]).catch(() => ''),
  ]);

  const uncommitted = status.trim().split('\n').filter(Boolean).length;
  if (!readOnly()) await repository.runs.setDiffStat(runId, { stat: stat.trim(), commits: logOut.trim().split('\n').filter(Boolean).length, uncommitted });

  return { run, stat: stat.trim(), commits: logOut.trim(), uncommitted, status: status.trim() };
}

async function diff(runId: RunId): Promise<string> {
  const run = await get(runId);
  if (!run?.worktree_path) return '';
  localOnly(run, 'diff');
  const base = await defaultBranch(run.repo_path);
  return git(run.worktree_path, ['diff', `${base}...HEAD`]).catch(() => '');
}

// Executes the run's mode: restores the real push URL, pushes, and opens a
// draft pull request if the mode allows. Nothing here happens implicitly — `pa land` is
// something a human typed after reading a diff.
async function land(runId: RunId, { openMr = null }: { openMr?: boolean | null } = {}): Promise<{ pushed: true; branch: string; mrUrl: string | null }> {
  const run = await get(runId);
  if (!run) throw new Error(`no run #${runId}`);
  localOnly(run, 'land');
  const m = resolveMode(run.mode);
  if (!m.mayPush) {
    throw new Error(
      `run #${runId} was dispatched in \`${m.name}\` mode, which may not push. Re-dispatch it as \`branch\` or \`mr\` if that is what you want.`
    );
  }
  if (!run.worktree_path) throw new Error(`run #${runId} has no worktree`);

  const dirty = (await git(run.worktree_path, ['status', '--porcelain'])).trim();
  if (dirty) {
    throw new Error(`worktree for run #${runId} is dirty — commit or discard first:\n${dirty}`);
  }

  // A worktree that started in a no-push mode and is delivered by run review
  // still carries its block, in the worktree's OWN config: lifted there only.
  // (This once ran a plain `git config --unset-all remote.origin.pushurl`,
  // which edits the repo's SHARED config and wiped the user's own pushurl.)
  await liftPushBlock(run.worktree_path);
  await git(run.worktree_path, ['push', '-u', 'origin', run.branch]);

  let mrUrl: string | null = null;
  const wantMr = openMr === null ? m.mayOpenMr : openMr;
  if (wantMr) {
    mrUrl = await openMergeRequest(run).catch((err: Error) => {
      log.warn('branch pushed but pull request not opened', { run: runId, message: err.message });
      return null;
    });
  }

  await repository.runs.markLanded(runId, mrUrl);
  if (run.commitment_id) {
    await ledger.transition({ commitmentId: run.commitment_id, to: 'done', actor: 'dispatch', reason: `run #${runId} landed${mrUrl ? `: ${mrUrl}` : ''}` });
  }
  await forgetContext(run);

  return { pushed: true, branch: run.branch, mrUrl };
}

// The push block lives in the worktree's OWN config (remote.blockPush writes
// it with `git config --worktree`), so it is lifted there: a plain
// `git config --unset-all` edits the shared config and leaves the block in
// place. Read back, like the block itself.
async function liftPushBlock(worktree: string): Promise<void> {
  const remotes = (await git(worktree, ['remote']).catch(() => '')).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  for (const name of remotes) {
    // --worktree only: the shared config holds the user's own pushurl, if any.
    await git(worktree, ['config', '--worktree', '--unset-all', `remote.${name}.pushurl`]).catch(() => {});
    const got = (await git(worktree, ['remote', 'get-url', '--push', name]).catch(() => '')).trim();
    if (got === BLOCKED_PUSH_URL) throw new Error(`could not lift the push block on ${name} in ${worktree}`);
  }
}

/**
 * Delivery `push_to_main`, step one: the run's branch is pushed (never main),
 * so CI runs on the exact commit that may later reach main. Returns that
 * commit. The agent itself ran with pushing blocked and without credentials;
 * this, after the session, is the PA's own push. Authorised by the run's
 * recorded delivery, which only the operator sets.
 */
async function pushBranch(runId: RunId): Promise<{ sha: string; base: string; branch: string }> {
  const run = await get(runId);
  if (!run) throw new Error(`no run #${runId}`);
  localOnly(run, 'land');
  if (run.delivery !== 'push_to_main') throw new Error(`run #${runId} has delivery \`${run.delivery || 'unset'}\`, not push_to_main`);
  if (!run.worktree_path) throw new Error(`run #${runId} has no worktree`);
  const dirty = (await git(run.worktree_path, ['status', '--porcelain'])).trim();
  if (dirty) throw new Error(`worktree for run #${runId} is dirty — commit or discard first:\n${dirty}`);
  const base = await defaultBranch(run.repo_path);
  const sha = (await git(run.worktree_path, ['rev-parse', 'HEAD'])).trim();
  await liftPushBlock(run.worktree_path);
  await git(run.worktree_path, ['push', '-u', 'origin', run.branch]);
  return { sha, base, branch: run.branch };
}

/**
 * Delivery `push_to_main`, step two, once CI passed on `sha`: that commit —
 * not whatever the worktree holds now — is pushed onto the default branch,
 * fast-forward only (no --force: a main that moved on refuses, and the run
 * says so).
 */
async function pushToMain(runId: RunId, { sha, note = null }: { sha?: string; note?: string | null } = {}): Promise<{ pushed: true; base: string }> {
  const run = await get(runId);
  if (!run) throw new Error(`no run #${runId}`);
  localOnly(run, 'land');
  if (run.delivery !== 'push_to_main') throw new Error(`run #${runId} has delivery \`${run.delivery || 'unset'}\`, not push_to_main`);
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha || ''))) throw new Error('pushToMain needs the commit CI passed');
  const base = await defaultBranch(run.repo_path);
  await git(run.worktree_path, ['push', 'origin', `${sha}:refs/heads/${base}`]);
  await repository.runs.markPushedToMain(runId, note);
  if (run.commitment_id) {
    await ledger.transition({ commitmentId: run.commitment_id, to: 'done', actor: 'dispatch', reason: `run #${runId} pushed to ${base}`, from: ['open', 'dispatched'] });
  }
  await forgetContext(run);
  return { pushed: true, base };
}

/** The commit a run's worktree is at. */
async function headOf(runId: RunId): Promise<string> {
  const run = await get(runId);
  if (!run?.worktree_path) throw new Error(`run #${runId} has no worktree`);
  return (await git(run.worktree_path, ['rev-parse', 'HEAD'])).trim();
}

/**
 * A finished run whose end state could not be reached (CI red, CI too slow,
 * main moved on): its branch / PR are left as they are, and the run waits
 * for me as `blocked` with the reason.
 */
async function blockRun(runId: RunId, reason: string): Promise<void> {
  await repository.runs.block(runId, String(reason).slice(0, 500));
}

// A draft pull request through the signed-in `gh` CLI — the same login GitHub
// ingest uses, so there is no token here either. `--draft` is the whole point:
// nothing a dispatched run opens may ask anyone for review on its own.
async function openMergeRequest(run: Run): Promise<string> {
  const base = await defaultBranch(run.repo_path);
  const { stdout } = await exec(
    config.github.bin,
    [
      'pr', 'create', '--draft',
      '--head', run.branch,
      '--base', base,
      '--title', run.task.slice(0, 250),
      '--body',
      `Dispatched by the personal assistant (run #${run.id}, mode \`${run.mode}\`).\n\n` +
        `End state chosen: \`${run.delivery || 'draft_pr'}\`.`,
    ],
    { cwd: run.worktree_path, windowsHide: true }
  ).catch(async (err: Error & { stderr?: string }) => {
    // In `mr` mode the agent opens the draft itself; that one is the run's PR.
    if (!/already exists/i.test(String(err.stderr || err.message))) throw err;
    return exec(config.github.bin, ['pr', 'view', run.branch, '--json', 'url', '--jq', '.url'], { cwd: run.worktree_path, windowsHide: true });
  });
  const url = stdout.trim().split(/\r?\n/).pop();
  if (!/^https:\/\//.test(url)) throw new Error(`gh pr create printed no URL: ${stdout.slice(0, 200)}`);
  return url;
}

async function drop(runId: RunId, { force = false }: { force?: boolean } = {}): Promise<Json | true> {
  const run = await get(runId);
  if (!run) throw new Error(`no run #${runId}`);
  require('./remote.ts').removeNoGhDirs(runId);

  // A factory job is cancelled in the factory (it parks or closes its
  // stories and keeps the evidence); its follow session goes too.
  if (run.route === 'factory') {
    let cancelled = false;
    let storiesParked = null;
    // A submit whose answer was lost may have made a job: find it before
    // dropping, or the job runs on with nobody watching it.
    if (!run.factory_job_id && ['starting', 'waiting'].includes(run.status)) {
      const ageMs = Date.now() - new Date(run.started_at || Date.now()).getTime();
      const settled = await require('./factory.ts').settle(run, { ageMs, extra: { by: run.brief_by } });
      if (settled.verdict === 'adopt') Object.assign(run, { factory_job_id: settled.job.job_id, status: 'running' });
      else if (settled.verdict === 'unknown') {
        // Not asked, or asked too soon to believe "no job": a drop now could orphan one.
        throw new Error(
          settled.asked
            ? `run #${runId}'s submit is still unconfirmed (the factory may yet show its job) — try again in a few minutes`
            : `run #${runId}'s submit is unconfirmed and the factory cannot be asked now — dropping it could orphan a job; try again when the factory answers`
        );
      }
    }
    if (run.factory_job_id && ['starting', 'running', 'waiting'].includes(run.status)) {
      const c = await require('./factory.ts').cancel(run);
      cancelled = true;
      storiesParked = Array.isArray(c?.stories_parked) ? c.stories_parked.length : Number.isFinite(c?.stories_parked) ? c.stories_parked : null;
    }
    if (run.termhub_session_id) await termhub.forMachine(run.machine).killSession(run.termhub_session_id).catch(() => {});
    await repository.runs.markFactoryDropped(runId);
    if (run.commitment_id) {
      await ledger.transition({ commitmentId: run.commitment_id, to: 'open', actor: 'dispatch', reason: `run #${runId} dropped`, from: ['dispatched'] });
    }
    await forgetContext(run);
    return { factory: true, cancelled, storiesParked, jobId: run.factory_job_id };
  }

  // A remote run's worktree is on that machine, where this cannot see whether
  // it holds unpushed work: a plain drop ends the session and keeps the
  // worktree; --force removes it there too.
  if (!termhub.isLocal(run.machine)) {
    const hub = termhub.forMachine(run.machine);
    if (run.termhub_session_id) await hub.killSession(run.termhub_session_id).catch(() => {});
    let removed = false;
    if (force && run.worktree_path) {
      const remote = require('./remote.ts');
      removed = await remote.removeOnMachine({
        machine: remote.machineNamed(run.machine),
        hub,
        repo: run.repo_path,
        worktree: run.worktree_path,
        branch: run.branch,
      });
    }
    await repository.runs.markDropped(runId);
    if (run.commitment_id) {
      await ledger.transition({ commitmentId: run.commitment_id, to: 'open', actor: 'dispatch', reason: `run #${runId} dropped`, from: ['dispatched'] });
    }
    await forgetContext(run);
    return { remote: true, removed, worktree: run.worktree_path, machine: run.machine };
  }

  if (run.worktree_path && !force) {
    const dirty = (await git(run.worktree_path, ['status', '--porcelain']).catch(() => '')).trim();
    const base = await defaultBranch(run.repo_path).catch(() => 'main');
    const unpushed = (
      await git(run.worktree_path, ['log', '--oneline', `${base}..HEAD`]).catch(() => '')
    ).trim();
    if (dirty || unpushed) {
      throw new Error(
        `run #${runId} still has work that exists nowhere else` +
          `${unpushed ? ` (${unpushed.split('\n').length} unpushed commits)` : ''}` +
          `${dirty ? ' and uncommitted changes' : ''}.\nPass --force to discard it.`
      );
    }
  }

  if (run.termhub_session_id) await termhub.killSession(run.termhub_session_id).catch(() => {});
  if (run.worktree_path) {
    await git(run.repo_path, ['worktree', 'remove', '--force', run.worktree_path]).catch(() => {});
    await git(run.repo_path, ['worktree', 'prune']).catch(() => {});
  }

  await repository.runs.markDropped(runId);
  if (run.commitment_id) {
    await ledger.transition({ commitmentId: run.commitment_id, to: 'open', actor: 'dispatch', reason: `run #${runId} dropped`, from: ['dispatched'] });
  }
  await forgetContext(run);
  return true;
}

// Marks a run as finished-and-awaiting-review. Called by `pa review --done` and
// by the worker when a session disappears.
async function markDone(runId: RunId, note?: string | null): Promise<void> {
  require('./remote.ts').removeNoGhDirs(runId);
  await repository.runs.markDone(runId, note || null);
  await forgetContext(await get(runId).catch(() => null));
  // Wakes its run_review task (src/durable/tasks/runReview.ts).
  await require('../durable').emit(`run-ended:${runId}`, { note: note || null }).catch(() => {});
}

// A run whose termhub session has gone (machine rebooted, session killed) is
// not "running" any more, whatever the table says.
// Keeps run status in step with termhub, and tells the user when a run needs
// them. termhub's idle tracking says whether an agent session is working or
// sitting at its prompt; a run that has been at its prompt for a minute has
// either finished or stopped to ask something — either way it is the user's
// turn, and they should not have to go looking. One notification per wait
// (keyed by when it started waiting), not one per pass.
const WAIT_NOTIFY_MS = 60_000;

async function reconcile(): Promise<{ closed: number; notified: number }> {
  const active: Run[] = await repository.runs.activeForReconcile();
  // Each run is checked against its own machine's termhub. A machine that
  // cannot be reached says nothing about its runs, so they are left alone
  // rather than closed as "session ended".
  const hubs = new Map<string, { hub: Json; byId: Map<string, Json> | null }>();
  for (const run of active) {
    const key: string = termhub.isLocal(run.machine) ? '' : run.machine;
    if (!hubs.has(key)) {
      const hub = termhub.forMachine(key || null);
      const sessions: Json[] | null = await hub.listSessions().catch(() => null);
      hubs.set(key, { hub, byId: sessions ? new Map(sessions.map((s) => [s.id, s])) : null });
    }
  }
  let closed = 0;
  let notified = 0;
  for (const run of active) {
    const { hub, byId } = hubs.get(termhub.isLocal(run.machine) ? '' : run.machine) as { hub: Json; byId: Map<string, Json> | null };
    if (!byId) continue;
    const s = run.termhub_session_id ? byId.get(run.termhub_session_id) : null;
    if (run.termhub_session_id && (!s || s.alive === false)) {
      await markDone(run.id, 'session ended');
      require('../notify')
        .notify({
          kind: 'info',
          title: `Run #${run.id} ended`,
          body: `${String(run.task).slice(0, 160)}\nReview it: pa review ${run.id}`,
          dedupeKey: `run-ended:${run.id}`,
        })
        .catch(() => {});
      closed++;
      continue;
    }
    if (!s) continue;
    const waiting = s.idleState && s.idleState !== 'working' && (s.idleMs ?? 0) >= WAIT_NOTIFY_MS;
    const next = waiting ? 'waiting' : 'running';
    if (next !== run.status) await repository.runs.setStatus(run.id, next);
    if (waiting) {
      const row = await require('../notify')
        .notify({
          kind: 'info',
          title: `Run #${run.id} is waiting for you`,
          body: `${String(run.task).slice(0, 160)}\nIt finished or has a question — open its session.`,
          url: `${hub.base}/#session=${s.id}`,
          dedupeKey: `run-wait:${run.id}:${s.idleSince || ''}`,
        })
        .catch(() => null);
      if (row) notified++;
    }
  }
  return { closed, notified };
}

module.exports = {
  start, startSession, knownRepo, get, list, steer, review, diff, land, pushBranch, pushToMain, headOf, blockRun, defaultBranch, drop, markDone, reconcile, slug, resolveTarget, briefFor,
  worktreeBase, scopeFacts, relatedContext, memoryContext, sessionDelivery, previewDelivery, requireConfirmed, BLOCKED_PUSH_URL,
};
