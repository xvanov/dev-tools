'use strict';

// Dispatch: a commitment becomes a git worktree, a brief, and a Claude Code
// session you can walk into.
//
// The worktree is not an optimisation. The root CLAUDE.md is explicit that a
// dirty tree breaks termhub's own updater, and a dispatched agent working
// directly in `C:\repos\<x>` would put your main checkout into whatever state
// it reached when you stopped watching. One worktree per run, removed by
// `pa drop`, and your checkout is never a dispatched agent's problem.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { config } = require('../config');
const { one, rows, query } = require('../db');
const { mode: resolveMode } = require('./modes');
const { buildBrief, openingPrompt } = require('./brief');
const termhub = require('./termhub');
const { logger } = require('../log');

const exec = promisify(execFile);
const log = logger('dispatch');

// A URL that is syntactically valid and resolves to nothing. Set as the
// worktree's pushurl for modes that may not push, so `git push` fails fast and
// legibly instead of reaching the remote.
const BLOCKED_PUSH_URL = 'https://pa-push-blocked.invalid/this-run-may-not-push.git';

async function git(cwd, args) {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

function slug(text) {
  return String(text || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
}

async function defaultBranch(repoPath) {
  try {
    const out = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return out.trim().replace(/^origin\//, '');
  } catch {
    for (const candidate of ['main', 'master', 'develop']) {
      try {
        await git(repoPath, ['rev-parse', '--verify', candidate]);
        return candidate;
      } catch {
        /* try the next one */
      }
    }
    return 'main';
  }
}

async function resolveTarget({ commitmentId, repoPath }) {
  if (!commitmentId) return { commitment: null, item: null, project: null, person: null, repoPath };

  const commitment = await one('select * from commitment where id = $1', [commitmentId]);
  if (!commitment) throw new Error(`no commitment #${commitmentId}`);

  const item = await one('select * from source_item where id = $1', [commitment.source_item_id]);
  const project = commitment.project_id
    ? await one('select * from project where id = $1', [commitment.project_id])
    : null;
  const person = commitment.counterparty_person_id
    ? await one('select * from person where id = $1', [commitment.counterparty_person_id])
    : null;

  const resolved = repoPath || commitment.repo_path || project?.repo_path || null;
  return { commitment, item, project, person, repoPath: resolved };
}

async function relatedContext(item) {
  if (!item?.thread_external_id) return [];
  return rows(
    `select id, source, subject, occurred_at from source_item
      where thread_external_id = $1 and id <> $2
      order by occurred_at desc limit 6`,
    [item.thread_external_id, item.id]
  );
}

// The memory's contribution to a brief. Never blocks a dispatch: any piece
// that fails is simply absent.
async function memoryContext({ commitment, item, project, person }, task) {
  const memory = require('../memory');
  const question = [task || commitment?.summary, commitment?.detail, item?.subject].filter(Boolean).join(' — ');
  const [recalled, personPage, projectPage] = await Promise.all([
    question ? require('../recall').recall(question, { limit: 6 }).catch(() => null) : null,
    person ? memory.getPage({ kind: 'person', id: person.id }).catch(() => null) : null,
    project ? memory.getPage({ kind: 'project', id: project.id }).catch(() => null) : null,
  ]);
  return {
    facts: recalled && !recalled.abstain ? recalled.claims : [],
    person: personPage?.body || null,
    project: projectPage?.body || null,
  };
}

async function start({ commitmentId = null, task = null, mode: modeName, repoPath = null, machine = null, again = false }) {
  // One live run per commitment. A second Do while the first is still setting
  // up (a remote one takes a minute) started a second agent on the same ask.
  if (commitmentId && !again) {
    const live = await one(
      `select id, machine from run where commitment_id = $1 and status in ('starting','running','waiting')
        order by started_at desc limit 1`,
      [commitmentId]
    );
    if (live) {
      const where = termhub.isLocal(live.machine) ? '' : ` on ${live.machine}`;
      throw new Error(`#${commitmentId} already has run #${live.id}${where} — attach to it (pa attach ${live.id}), or drop it first`);
    }
  }
  if (machine && !termhub.isLocal(machine)) {
    return startRemote({ commitmentId, task, modeName, repoPath, machineName: machine });
  }
  const m = resolveMode(modeName);
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

  const run = await one(
    `insert into run (commitment_id, mode, task, repo_path, status, machine)
     values ($1,$2,$3,$4,'starting',$5) returning *`,
    [commitmentId, m.name, label, repo, os.hostname()]
  );

  let worktreePath = null;
  let branch = null;

  if (repo) {
    branch = `pa/${run.id}-${slug(label)}`;
    worktreePath = path.join(config.worktreesRoot, `run-${run.id}`);
    fs.mkdirSync(config.worktreesRoot, { recursive: true });

    const base = await defaultBranch(repo);
    await git(repo, ['worktree', 'add', '-b', branch, worktreePath, base]);

    if (!m.mayPush) {
      // Enforcement, not persuasion.
      await git(worktreePath, ['config', 'remote.origin.pushurl', BLOCKED_PUSH_URL]);
    }

    await query('update run set worktree_path = $2, branch = $3 where id = $1', [
      run.id,
      worktreePath,
      branch,
    ]);
  }

  const briefText = buildBrief({
    commitment: target.commitment,
    item: target.item,
    project: target.project,
    person: target.person,
    modeName: m.name,
    run: { ...run, worktree_path: worktreePath, branch },
    related: await relatedContext(target.item),
    memory: await memoryContext(target, task),
  });

  const briefPath = worktreePath
    ? path.join(worktreePath, 'BRIEF.md')
    : path.join(config.worktreesRoot, `run-${run.id}-BRIEF.md`);
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, briefText, 'utf8');

  const session = await termhub.createSession({
    cwd: worktreePath || repo || config.reposRoot,
    command: config.termhub.claudeCommand,
    title: `pa#${run.id} ${label.slice(0, 40)}`,
  });

  await query(
    `update run set termhub_session_id = $2, brief_path = $3, status = 'running' where id = $1`,
    [run.id, session.id, briefPath]
  );

  if (commitmentId) {
    await query(`update commitment set status = 'dispatched' where id = $1`, [commitmentId]);
  }

  // Claude Code needs a moment after spawn before it will accept typed input.
  await new Promise((r) => setTimeout(r, 2500));
  await termhub.say(session.id, openingPrompt(run)).catch((err) => {
    log.warn('could not type the opening prompt', { run: run.id, message: err.message });
  });

  const url = await termhub.sessionUrl(session.id);
  log.info('dispatched', { run: run.id, mode: m.name, repo, branch });

  return { id: run.id, mode: m.name, repoPath: repo, worktreePath, branch, briefPath, sessionId: session.id, url };
}

// The same run, on another machine's termhub (src/dispatch/remote.js). The
// repo is the local one's namesake under that machine's repos root; the
// worktree, the pushurl block and BRIEF.md are made there, by the session.
async function startRemote({ commitmentId, task, modeName, repoPath, machineName }) {
  const remote = require('./remote');
  const machine = remote.machineNamed(machineName);
  const hub = termhub.forMachine(machine.name);
  const m = resolveMode(modeName);
  const target = await resolveTarget({ commitmentId, repoPath });

  const label = task || target.commitment?.summary;
  if (!label) throw new Error('nothing to do — give a commitment id or a --task');
  if (!target.repoPath) {
    throw new Error('no repo for this commitment — set one with `pa show <id> --project <name>`, or pass --repo');
  }
  const repo = remote.remoteRepoPath(machine, target.repoPath);

  const run = await one(
    `insert into run (commitment_id, mode, task, repo_path, status, machine)
     values ($1,$2,$3,$4,'starting',$5) returning *`,
    [commitmentId, m.name, label, repo, machine.name]
  );
  const branch = `pa/${run.id}-${slug(label)}`;
  const worktreePath = remote.remoteWorktreePath(machine, run.id);
  const briefText = buildBrief({
    commitment: target.commitment,
    item: target.item,
    project: target.project,
    person: target.person,
    modeName: m.name,
    run: { ...run, worktree_path: worktreePath, branch },
    related: await relatedContext(target.item),
    memory: await memoryContext(target, task),
  });

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
  } catch (err) {
    await query(
      `update run set status = 'failed', termhub_session_id = $2, exit_note = $3, ended_at = now() where id = $1`,
      [run.id, err.sessionId || null, err.message.slice(0, 500)]
    );
    throw err;
  }

  await query(
    `update run set termhub_session_id = $2, brief_path = $3, worktree_path = $4, branch = $5, status = 'running'
      where id = $1`,
    [run.id, started.sessionId, started.briefPath, started.worktreePath, branch]
  );
  if (commitmentId) {
    await query(`update commitment set status = 'dispatched' where id = $1`, [commitmentId]);
  }
  await hub.say(started.sessionId, openingPrompt(run)).catch((err) => {
    log.warn('could not type the opening prompt', { run: run.id, message: err.message });
  });
  log.info('dispatched', { run: run.id, mode: m.name, repo, branch, machine: machine.name });

  return {
    id: run.id,
    mode: m.name,
    machine: machine.name,
    repoPath: repo,
    worktreePath: started.worktreePath,
    branch,
    briefPath: started.briefPath,
    sessionId: started.sessionId,
    url: started.url,
  };
}

// git on a remote run's worktree happens on that machine, not here.
function localOnly(run, verb) {
  if (!termhub.isLocal(run.machine)) {
    throw new Error(
      `run #${run.id} is on ${run.machine}: ${verb} it in its session (pa attach ${run.id}), ` +
        `or ask it — pa say ${run.id} "show me git diff --stat"`
    );
  }
}

async function get(runId) {
  return one('select * from run where id = $1', [runId]);
}

async function list({ all = false, limit = 20 } = {}) {
  return rows(
    all
      ? 'select * from run order by started_at desc limit $1'
      : `select * from run where status in ('starting','running','waiting','done') order by started_at desc limit $1`,
    [limit]
  );
}

async function steer(runId, text) {
  const run = await get(runId);
  if (!run) throw new Error(`no run #${runId}`);
  if (!run.termhub_session_id) throw new Error(`run #${runId} has no session`);
  await termhub.forMachine(run.machine).say(run.termhub_session_id, text);
  return true;
}

async function review(runId) {
  const run = await get(runId);
  if (!run) throw new Error(`no run #${runId}`);
  localOnly(run, 'review');
  if (!run.worktree_path) return { run, diff: null, stat: null, status: null };

  const base = await defaultBranch(run.repo_path);
  const [stat, status, logOut] = await Promise.all([
    git(run.worktree_path, ['diff', '--stat', `${base}...HEAD`]).catch(() => ''),
    git(run.worktree_path, ['status', '--porcelain']).catch(() => ''),
    git(run.worktree_path, ['log', '--oneline', `${base}..HEAD`]).catch(() => ''),
  ]);

  const uncommitted = status.trim().split('\n').filter(Boolean).length;
  await query('update run set diff_stat = $2 where id = $1', [
    runId,
    { stat: stat.trim(), commits: logOut.trim().split('\n').filter(Boolean).length, uncommitted },
  ]);

  return { run, stat: stat.trim(), commits: logOut.trim(), uncommitted, status: status.trim() };
}

async function diff(runId) {
  const run = await get(runId);
  if (!run?.worktree_path) return '';
  localOnly(run, 'diff');
  const base = await defaultBranch(run.repo_path);
  return git(run.worktree_path, ['diff', `${base}...HEAD`]).catch(() => '');
}

// Executes the run's mode: restores the real push URL, pushes, and opens a
// draft pull request if the mode allows. Nothing here happens implicitly — `pa land` is
// something a human typed after reading a diff.
async function land(runId, { openMr = null } = {}) {
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

  await git(run.worktree_path, ['config', '--unset-all', 'remote.origin.pushurl']).catch(() => {});
  await git(run.worktree_path, ['push', '-u', 'origin', run.branch]);

  let mrUrl = null;
  const wantMr = openMr === null ? m.mayOpenMr : openMr;
  if (wantMr) {
    mrUrl = await openMergeRequest(run).catch((err) => {
      log.warn('branch pushed but pull request not opened', { run: runId, message: err.message });
      return null;
    });
  }

  await query(`update run set status = 'landed', mr_url = $2, ended_at = now() where id = $1`, [
    runId,
    mrUrl,
  ]);
  if (run.commitment_id) {
    await query(`update commitment set status = 'done' where id = $1`, [run.commitment_id]);
  }

  return { pushed: true, branch: run.branch, mrUrl };
}

// A draft pull request through the signed-in `gh` CLI — the same login GitHub
// ingest uses, so there is no token here either. `--draft` is the whole point:
// nothing a dispatched run opens may ask anyone for review on its own.
async function openMergeRequest(run) {
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
        'Reviewed by a human before this was pushed.',
    ],
    { cwd: run.worktree_path, windowsHide: true }
  );
  const url = stdout.trim().split(/\r?\n/).pop();
  if (!/^https:\/\//.test(url)) throw new Error(`gh pr create printed no URL: ${stdout.slice(0, 200)}`);
  return url;
}

async function drop(runId, { force = false } = {}) {
  const run = await get(runId);
  if (!run) throw new Error(`no run #${runId}`);

  // A remote run's worktree is on that machine, where this cannot see whether
  // it holds unpushed work: a plain drop ends the session and keeps the
  // worktree; --force removes it there too.
  if (!termhub.isLocal(run.machine)) {
    const hub = termhub.forMachine(run.machine);
    if (run.termhub_session_id) await hub.killSession(run.termhub_session_id).catch(() => {});
    let removed = false;
    if (force && run.worktree_path) {
      const remote = require('./remote');
      removed = await remote.removeOnMachine({
        machine: remote.machineNamed(run.machine),
        hub,
        repo: run.repo_path,
        worktree: run.worktree_path,
        branch: run.branch,
      });
    }
    await query(`update run set status = 'dropped', ended_at = now() where id = $1`, [runId]);
    if (run.commitment_id) {
      await query(`update commitment set status = 'open' where id = $1 and status = 'dispatched'`, [run.commitment_id]);
    }
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

  await query(`update run set status = 'dropped', ended_at = now() where id = $1`, [runId]);
  if (run.commitment_id) {
    await query(`update commitment set status = 'open' where id = $1 and status = 'dispatched'`, [
      run.commitment_id,
    ]);
  }
  return true;
}

// Marks a run as finished-and-awaiting-review. Called by `pa review --done` and
// by the worker when a session disappears.
async function markDone(runId, note) {
  await query(`update run set status = 'done', ended_at = now(), exit_note = $2 where id = $1`, [
    runId,
    note || null,
  ]);
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

async function reconcile() {
  const active = await rows(
    `select id, task, status, termhub_session_id, machine from run where status in ('starting','running','waiting')`
  );
  // Each run is checked against its own machine's termhub. A machine that
  // cannot be reached says nothing about its runs, so they are left alone
  // rather than closed as "session ended".
  const hubs = new Map();
  for (const run of active) {
    const key = termhub.isLocal(run.machine) ? '' : run.machine;
    if (!hubs.has(key)) {
      const hub = termhub.forMachine(key || null);
      const sessions = await hub.listSessions().catch(() => null);
      hubs.set(key, { hub, byId: sessions ? new Map(sessions.map((s) => [s.id, s])) : null });
    }
  }
  let closed = 0;
  let notified = 0;
  for (const run of active) {
    const { hub, byId } = hubs.get(termhub.isLocal(run.machine) ? '' : run.machine);
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
    if (next !== run.status) await query('update run set status = $2 where id = $1', [run.id, next]);
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

module.exports = { start, get, list, steer, review, diff, land, drop, markDone, reconcile, slug, BLOCKED_PUSH_URL };
