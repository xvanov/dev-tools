'use strict';

// Remote dispatch: a run on another machine's termhub (PA_MACHINES).
//
// Some work belongs on a particular machine — the VM that runs the service,
// holds the OneDrive sync, has the credentials — and you watch it from the
// same termhub hub as everything else. The dispatcher cannot touch that
// machine's disk, so it does there what it does here by *typing* it into a
// fresh shell in that termhub, then checking the result through termhub's own
// API before Claude is started:
//
//   1. `git fetch` and `git worktree add -b pa/<run>-<slug>` under
//      `<reposRoot>\.pa-worktrees\run-<id>` — the main checkout on that machine
//      is never the agent's working tree, exactly as here.
//   2. For a mode that may not push, the worktree's pushurl is pointed at the
//      dead address. Same enforcement as a local run, applied on that machine.
//   3. BRIEF.md written into the worktree from base64 chunks (a brief is too
//      long, and too full of quotes, to type as one line).
//   4. The worktree must exist (`/api/dirs`) before `claude` is typed; if it
//      never appears the run is marked failed and the session is left open so
//      you can read why.
//
// What does not cross the wire: `pa review/diff/land` run git on this
// machine's disk, so for a remote run they say so and point at the session.

const { config } = require('../config');

const CHUNK = 1800;

// PowerShell single-quoted literal: '' is the only escape.
function psq(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function joinWin(root, ...parts) {
  return [String(root).replace(/[\\/]+$/, ''), ...parts].join('\\');
}

/** Where a repo lives on that machine: same folder name, under its repos root. */
function remoteRepoPath(machine, localRepoPath) {
  const name = String(localRepoPath).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return joinWin(machine.reposRoot, name);
}

function remoteWorktreePath(machine, runId) {
  return joinWin(machine.reposRoot, '.pa-worktrees', `run-${runId}`);
}

/**
 * Pure: the shell lines that set a remote run up, in order. Typed one per line
 * into a PowerShell session on that machine.
 */
function setupLines({ repo, worktree, branch, mayPush, brief, blockedPushUrl }) {
  const lines = [
    `git -C ${psq(repo)} fetch origin --prune`,
    `$paBase = git -C ${psq(repo)} symbolic-ref --short refs/remotes/origin/HEAD 2>$null; if (-not $paBase) { $paBase = 'origin/main' }`,
    `git -C ${psq(repo)} worktree add -b ${psq(branch)} ${psq(worktree)} $paBase`,
  ];
  if (!mayPush) lines.push(`git -C ${psq(worktree)} config remote.origin.pushurl ${psq(blockedPushUrl)}`);
  const b64 = Buffer.from(brief, 'utf8').toString('base64');
  lines.push(`$paBrief = ''`);
  for (let i = 0; i < b64.length; i += CHUNK) lines.push(`$paBrief += '${b64.slice(i, i + CHUNK)}'`);
  lines.push(
    `[IO.File]::WriteAllText((Join-Path ${psq(worktree)} 'BRIEF.md'), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($paBrief)))`,
    `Set-Location ${psq(worktree)}`
  );
  return lines;
}

function machineNamed(name) {
  const machine = config.termhub.machines[name];
  if (!machine) {
    const known = Object.keys(config.termhub.machines);
    throw new Error(
      `unknown machine "${name}" — ${known.length ? `one of: ${known.join(', ')}` : 'none configured; set PA_MACHINES in .env'}`
    );
  }
  return machine;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, { timeoutMs, everyMs = 2000 }) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return true;
    if (Date.now() > until) return false;
    await sleep(everyMs);
  }
}

/**
 * Sets up a run's worktree and session on `machine` and starts Claude in it.
 * Returns {sessionId, worktreePath, briefPath, url}; throws with the session
 * id attached (err.sessionId) when setup failed, so the caller can record it.
 */
async function startOnMachine({ machine, hub, run, repo, branch, mode, brief, title, blockedPushUrl }) {
  const name = repo.split('\\').pop();
  const present = await hub.dirs(joinWin(machine.reposRoot, ''));
  if (!present.some((d) => d.toLowerCase() === repo.toLowerCase())) {
    throw new Error(`${name} is not cloned on ${machine.name} (looked for ${repo})`);
  }

  const worktree = remoteWorktreePath(machine, run.id);
  const session = await hub.createSession({ cwd: machine.reposRoot, command: '', title });
  const fail = (message) => Object.assign(new Error(message), { sessionId: session.id });

  // The shell needs a moment to draw its first prompt before it reads input.
  await sleep(2500);
  for (const line of setupLines({ repo, worktree, branch, mayPush: mode.mayPush, brief, blockedPushUrl })) {
    await hub.say(session.id, line);
  }

  const parent = joinWin(machine.reposRoot, '.pa-worktrees');
  const made = await waitFor(
    async () => (await hub.dirs(joinWin(parent, ''))).some((d) => d.toLowerCase() === worktree.toLowerCase()),
    { timeoutMs: 120_000 }
  );
  if (!made) throw fail(`the worktree never appeared on ${machine.name} — open the session to see why`);

  await hub.say(session.id, config.termhub.claudeCommand);
  // Ready when termhub sees a Claude session sitting at its prompt. A session
  // that started as a shell may never be classed as Claude by termhub, so this
  // waits a bounded while rather than for that.
  const ready = await waitFor(
    async () => {
      const s = (await hub.listSessions()).find((x) => x.id === session.id);
      return s && s.kind === 'claude' && s.idleState && s.idleState !== 'working';
    },
    { timeoutMs: 15_000 }
  );
  if (!ready) await sleep(5000);

  return {
    sessionId: session.id,
    worktreePath: worktree,
    briefPath: joinWin(worktree, 'BRIEF.md'),
    url: await hub.sessionUrl(session.id),
  };
}

/**
 * `pa drop --force` for a remote run: removes its worktree and branch on that
 * machine through a short-lived shell, then checks the worktree is gone.
 */
async function removeOnMachine({ machine, hub, repo, worktree, branch }) {
  const session = await hub.createSession({ cwd: machine.reposRoot, command: '', title: `pa cleanup ${worktree.split('\\').pop()}` });
  try {
    await sleep(2500);
    await hub.say(session.id, `git -C ${psq(repo)} worktree remove --force ${psq(worktree)}`);
    if (branch) await hub.say(session.id, `git -C ${psq(repo)} branch -D ${psq(branch)}`);
    const parent = joinWin(machine.reposRoot, '.pa-worktrees', '');
    return await waitFor(
      async () => !(await hub.dirs(parent)).some((d) => d.toLowerCase() === worktree.toLowerCase()),
      { timeoutMs: 60_000 }
    );
  } finally {
    await hub.killSession(session.id).catch(() => {});
  }
}

module.exports = { setupLines, remoteRepoPath, remoteWorktreePath, machineNamed, startOnMachine, removeOnMachine, psq };
