'use strict';

// Build, the step after Plan (PLAN.md D30): ONE interactive Claude Code agent
// per task, in a termhub session, on the claude.ai subscription. `start`
// composes the brief, makes a git worktree on a new branch when the card names
// a repo, opens the session and types a short prompt that points at the agent
// prompt (src/build/agent-prompt.md, the one file to edit). The agent talks to
// Jarvis with `pa run note|ask|done` (src/build/messages.ts); the transcript
// tailer (src/build/track.ts) fills in cost, tool calls and subagents.
//
//   start({commitmentId?, task?, model?, repoPath?, costCapUsd?, wallCapMin?}) → the run
//   stop(id) · get(id) · list() · forCard(id) / setForCard(id, patch) · reconcile()
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
type Row = import('../repo/types.ts').Row;

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { config } = require('../config.ts');
const { logger } = require('../log.ts');
const termhub = require('../dispatch/termhub.ts');

const log = logger('build');
const repo = () => require('../repo').buildRuns;

const MODELS = ['haiku', 'sonnet', 'opus'];
const DEFAULT_MODEL = 'sonnet';
const LIVE = ['starting', 'running', 'waiting', 'idle'];
const num = (v: unknown, d: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const DEFAULTS = () => ({
  model: DEFAULT_MODEL,
  costCapUsd: num(process.env.PA_BUILD_COST_CAP_USD, 5),
  wallCapMin: num(process.env.PA_BUILD_WALL_CAP_MIN, 120),
  idleAfterS: num(process.env.PA_BUILD_IDLE_AFTER_S, 240),
});

const sh = (cwd: string, cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 120_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err: Error | null, out: string, errOut: string) =>
      err ? reject(new Error(`${cmd} ${args.join(' ')}: ${(errOut || err.message).trim().slice(0, 300)}`)) : resolve(String(out)));
  });

/** Pure: a model name checked against haiku|sonnet|opus. */
function checkModel(m: unknown): string {
  const v = String(m ?? '').trim().toLowerCase();
  if (!MODELS.includes(v)) throw Object.assign(new Error(`model must be ${MODELS.join(', ')}`), { status: 400 });
  return v;
}

const KEY = (id: number | string): string => `build.card.${id}`;

/** A card's stored build settings: only what was set. */
async function stored(commitmentId: number | string | null | undefined): Promise<Json> {
  if (!commitmentId) return {};
  const row = await require('../repo').system.setting(KEY(commitmentId)).catch(() => null);
  const v = row?.value;
  return v && typeof v === 'object' ? v : {};
}

/** GET: a card's effective settings, what it overrides, and the options. */
async function forCard(commitmentId: number | string): Promise<Json> {
  const o = await stored(commitmentId);
  const d = DEFAULTS();
  return {
    card: Number(commitmentId),
    settings: { model: o.model || d.model, costCapUsd: o.costCapUsd || d.costCapUsd, wallCapMin: o.wallCapMin || d.wallCapMin, idleAfterS: o.idleAfterS || d.idleAfterS },
    overrides: o,
    options: { models: MODELS, defaults: d },
  };
}

/** POST: store a card's model and caps (null or '' clears one), then answer as GET. */
async function setForCard(commitmentId: number | string, patch: Json): Promise<Json> {
  await require('../dispatch').resolveTarget({ commitmentId }).catch((e: Error) => { throw Object.assign(e, { status: 404 }); });
  const merged: Json = { ...(await stored(commitmentId)) };
  if ('model' in patch) {
    if (patch.model == null || patch.model === '') delete merged.model;
    else merged.model = checkModel(patch.model);
  }
  for (const k of ['costCapUsd', 'wallCapMin', 'idleAfterS']) {
    if (!(k in patch)) continue;
    if (patch[k] == null || patch[k] === '') delete merged[k];
    else if (!(Number(patch[k]) > 0)) throw Object.assign(new Error(`${k} must be a positive number`), { status: 400 });
    else merged[k] = Number(patch[k]);
  }
  await require('../repo').system.setSetting(KEY(commitmentId), merged);
  return forCard(commitmentId);
}

/** Pure: the agent prompt with its {{placeholders}} filled. */
function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => (k in vars ? String(vars[k]) : ''));
}

/** Pure: Claude Code's project folder for a working directory (every non-alphanumeric becomes -). */
function projectDirName(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/** Where Claude Code writes a session's transcript. */
function transcriptPathFor(cwd: string, claudeSession: string): string {
  return path.join(os.homedir(), '.claude', 'projects', projectDirName(cwd), `${claudeSession}.jsonl`);
}

/** The `pa` command an agent runs: this install's bin/pa.js, absolute. */
function paCommand(): string {
  return `node "${path.join(config.toolDir, 'bin', 'pa.js')}"`;
}

async function briefContext(target: Json, task: string): Promise<string> {
  try {
    const c = await require('../dispatch/compose.ts').compose({ target, task, delivery: null, route: 'claude' });
    return String(c.brief || '').trim().slice(0, 2500);
  } catch (err) {
    log.warn('compose failed, using the plain ask', { message: (err as Error).message });
    const c = target.commitment;
    return [c?.summary, c?.detail].filter(Boolean).join('\n\n');
  }
}

/** Startup-context cuts for a build agent: no MCP servers, no skill listing, no user-level hooks/plugins
 *  (the owner's SessionStart hooks, plugin skills and claude.ai connectors were ~45k tokens of the first
 *  turn, re-read from cache on every turn). Project CLAUDE.md and subagents are untouched. Auth is OAuth, not a setting. */
function leanFlags(line: string): string {
  const want: Array<[string, string]> = [['--strict-mcp-config', ''], ['--disable-slash-commands', ''], ['--setting-sources', ' project,local']];
  return want.filter(([f]) => !line.includes(f)).map(([f, v]) => ` ${f}${v}`).join('');
}

/** Starts a run. What it made is undone when the session does not open. */
async function start(o: { commitmentId?: number | string | null; task?: string | null; model?: string | null; repoPath?: string | null; costCapUsd?: number | null; wallCapMin?: number | null; idleAfterS?: number | null }): Promise<Row> {
  const dispatch = require('../dispatch');
  const commitmentId = o.commitmentId || null;
  const card = await stored(commitmentId);
  const d = DEFAULTS();
  const model = checkModel(o.model || card.model || d.model);
  const costCapUsd = num(o.costCapUsd ?? card.costCapUsd, d.costCapUsd);
  const wallCapMin = num(o.wallCapMin ?? card.wallCapMin, d.wallCapMin);
  const idleAfterS = Math.min(21600, Math.max(30, num(o.idleAfterS ?? card.idleAfterS, d.idleAfterS)));
  if (commitmentId) {
    const live = await repo().liveForCommitment(commitmentId);
    if (live) throw new Error(`#${commitmentId} already has run #${live.id} (${live.state}) — open it, or stop it first`);
  }
  const target = await dispatch.resolveTarget({ commitmentId, repoPath: o.repoPath || null });
  const task: string | null = o.task || target.commitment?.summary || null;
  if (!task) throw new Error('nothing to do — give a card or a task');
  const wanted: string | null = target.repoPath || null;
  const isRepo = Boolean(wanted && fs.existsSync(path.join(wanted, '.git')));

  const run = await repo().insert({ commitmentId, task, model, repoPath: isRepo ? wanted : null, machine: os.hostname(), costCapUsd, wallCapMin, idleAfterS });
  const cwd = path.join(config.worktreesRoot, `build-${run.id}`);
  let branch: string | null = null;
  let sessionId: string | null = null;
  try {
    fs.mkdirSync(config.worktreesRoot, { recursive: true });
    if (isRepo) {
      branch = `jarvis/${run.id}-${dispatch.slug(task)}`;
      await sh(wanted as string, 'git', ['worktree', 'add', '--no-track', '-b', branch, cwd, await dispatch.worktreeBase(wanted)]);
    } else {
      fs.mkdirSync(cwd, { recursive: true });
    }
    const where = isRepo
      ? `A fresh git worktree of \`${wanted}\` on the new branch \`${branch}\`. Your current directory is that worktree.`
      : `An empty scratch folder (${cwd}). ${wanted ? `The card names the repo \`${wanted}\`, which is not a checkout here.` : 'No repository is involved unless the task says otherwise.'}`;
    const reportsDir = path.join(config.dataDir, 'build-reports', `run-${run.id}`).replace(/\\/g, '/');
    const prompt = renderPrompt(fs.readFileSync(path.join(config.toolDir, 'src', 'build', 'agent-prompt.md'), 'utf8'), {
      run_id: String(run.id), task, context: await briefContext(target, task), where, pa: paCommand(), reports_dir: reportsDir,
    });
    const promptPath = path.join(config.worktreesRoot, `build-${run.id}.PROMPT.md`);
    fs.writeFileSync(promptPath, prompt, 'utf8');
    try {
      require('../dispatch/trust.ts').ensureTrusted(config.worktreesRoot);
      require('../dispatch/trust.ts').ensureTrusted(cwd);
    } catch (err) {
      log.warn('could not mark the folders trusted', { message: (err as Error).message });
    }
    const claudeSession = crypto.randomUUID();
    const launch = require('../dispatch/agent.ts').dispatchCommand({ agent: 'claude', model, prompt: null });
    const session = await termhub.createSession({
      cwd,
      command: `${launch.command}${leanFlags(launch.command)} --session-id ${claudeSession}`,
      title: `jarvis#${run.id} ${task.slice(0, 40)}`,
      env: { JARVIS_RUN_ID: String(run.id), PA_DISPATCHED_RUN: `build-${run.id}` },
      links: { card: commitmentId, external: `build-${run.id}` },
    });
    sessionId = session.id;
    await repo().update(run.id, {
      state: 'running', session_id: session.id, claude_session: claudeSession, cwd, worktree_path: isRepo ? cwd : null, branch,
      transcript_path: transcriptPathFor(cwd, claudeSession),
    });
    if (commitmentId) {
      await require('../ledger').transition({ commitmentId, to: 'dispatched', actor: 'dispatch', reason: `build run #${run.id}`, from: ['open'] })
        .catch((err: Error) => log.warn('card not moved to dispatched', { message: err.message }));
    }
    await termhub.briefClaude(termhub, session.id, `Read ${promptPath} for your full instructions, then do the task it describes.`)
      .catch((err: Error) => log.warn('could not type the opening prompt', { run: run.id, message: err.message }));
  } catch (err) {
    await repo().update(run.id, { state: 'failed', error: (err as Error).message, ended_at: new Date().toISOString() }).catch(() => {});
    if (sessionId) await termhub.killSession(sessionId).catch(() => {});
    if (isRepo && wanted) {
      await sh(wanted, 'git', ['worktree', 'remove', '--force', cwd]).catch(() => {});
      if (branch) await sh(wanted, 'git', ['branch', '-D', branch]).catch(() => {});
    }
    throw err;
  }
  log.info('build run started', { run: run.id, model, repo: isRepo ? wanted : null, branch });
  return withUrl(await repo().byId(run.id));
}

/** The run, with the termhub URL of its session. */
async function withUrl(r: Row | null): Promise<Row> {
  if (!r) throw new Error('no such run');
  const url = r.session_id ? await termhub.sessionUrl(r.session_id).catch(() => null) : null;
  return { ...r, url };
}

async function get(id: number | string): Promise<Row | null> {
  const r = await repo().byId(id);
  return r ? withUrl(r) : null;
}

/** Ends a run in `state` (once): stamps the end, keeps the first result. */
async function finish(id: number | string, state: 'done' | 'failed' | 'stopped', { result = null, error = null }: { result?: string | null; error?: string | null } = {}): Promise<Row | null> {
  const r = await repo().byId(id);
  if (!r) return null;
  if (!LIVE.includes(r.state)) return r;
  await repo().update(id, { state, result: result ?? r.result, error, ended_at: new Date().toISOString() });
  return repo().byId(id);
}

/** The agent's last word: the result line (a PR url, a report path, one line) and the run is done. */
async function done(id: number | string, result: string | null): Promise<Row> {
  const r = await repo().byId(id);
  if (!r) throw Object.assign(new Error(`no run #${id}`), { status: 404 });
  if (!LIVE.includes(r.state)) throw new Error(`run #${id} is already ${r.state}`);
  const text = String(result || '').trim() || 'done';
  await repo().addMsg({ runId: id, dir: 'agent', kind: 'done', body: text });
  await finish(id, 'done', { result: text });
  return repo().byId(id);
}

/** Kills the session and marks the run stopped (the Stop button, a cap, `pa run stop`). */
async function stop(id: number | string, reason = 'stopped by you'): Promise<Row> {
  const r = await repo().byId(id);
  if (!r) throw Object.assign(new Error(`no run #${id}`), { status: 404 });
  if (r.session_id) await termhub.killSession(r.session_id).catch((err: Error) => log.warn('kill failed', { run: id, message: err.message }));
  await finish(id, 'stopped', { error: reason });
  return withUrl(await repo().byId(id));
}

/** The same urgent notice `pa run ask` raises, for a run that cannot go on without you. */
async function alarm(run: Row, title: string, why: string, key: string): Promise<void> {
  const N = require('../notify/notify.ts');
  await N.notify({
    kind: 'info', priority: 'urgent', title, body: `${String(run.task).slice(0, 100)}

${why}

Look: pa run status ${run.id}; nudge: pa run send ${run.id} "…"; stop: pa run stop ${run.id} (or ask Jarvis)`,
    url: N.dashboardUrl('') + 'factory', dedupeKey: key,
  }).catch((err: Error) => log.warn('could not raise the notice', { run: run.id, message: err.message }));
}

/** The heartbeat found a running agent silent past its threshold: `idle`, what Jarvis needs to decide (JSON in `activity`), and the notice. It goes back to running by itself when life returns. */
async function markIdle(id: number | string, info: { since: string; idle_s: number; last_tool: string | null; last_line: string | null }): Promise<void> {
  const r = await repo().byId(id);
  if (!r || r.state !== 'running') return;
  await repo().update(id, { state: 'idle', activity: JSON.stringify({ state: 'idle', ...info }) });
  log.warn('build run idle', { run: id, idle_s: info.idle_s });
  const mins = Math.round(info.idle_s / 60);
  await alarm(r, `Build agent #${id} has gone quiet`,
    `Idle for ${mins >= 1 ? `${mins} min` : `${info.idle_s} s`} (limit ${r.idle_after_s} s).
Last tool call: ${info.last_tool || 'none yet'}
Last output: ${info.last_line || '(blank)'}`, `build-idle:${id}:${info.since}`);
}

async function unidle(id: number | string): Promise<void> {
  const r = await repo().byId(id);
  if (r && r.state === 'idle') await repo().update(id, { state: 'running' });
}

/** Change how long a silence makes the run idle (seconds, 30 to 6 h). */
async function setIdle(id: number | string, seconds: unknown): Promise<Row> {
  const n = Math.round(Number(seconds));
  if (!(n >= 30 && n <= 21600)) throw Object.assign(new Error('idle_after_s must be 30 to 21600'), { status: 400 });
  const r = await repo().byId(id);
  if (!r) throw Object.assign(new Error(`no run #${id}`), { status: 404 });
  await repo().update(id, { idle_after_s: n });
  return repo().byId(id);
}

/** A live run whose termhub session has gone ended without `pa run done`: failed. */
async function reconcile(known: Json[] | null = null): Promise<{ failed: number }> {
  const live: Row[] = await repo().list({ live: true, limit: 50 });
  if (!live.length) return { failed: 0 };
  let sessions: Json[];
  try {
    sessions = known || (await termhub.listSessions());
  } catch {
    return { failed: 0 };
  }
  const ids = new Set(sessions.map((s) => String(s.id)));
  let failed = 0;
  for (const r of live) {
    if (r.state === 'starting' || !r.session_id || ids.has(String(r.session_id))) continue;
    const why = 'the session ended without `pa run done`';
    await finish(r.id as number, 'failed', { error: why });
    await alarm(r, `Build agent #${r.id} failed`, why, `build-fail:${r.id}`);
    failed++;
  }
  return { failed };
}

async function list(o: { live?: boolean; limit?: number; offset?: number } = {}): Promise<Row[]> {
  return repo().list(o);
}

module.exports = { start, stop, markIdle, unidle, setIdle, get, list, finish, done, reconcile, forCard, setForCard, stored, checkModel, renderPrompt, projectDirName, transcriptPathFor, paCommand, MODELS, DEFAULT_MODEL, LIVE, DEFAULTS };
