'use strict';

// repo_sync: fetch every repo under the repos root, and fast-forward the
// default branch where — and only where — that cannot touch work in progress.
//
// You are working in some of these repos while it runs. So the shape is:
// gather facts about each repo (I/O), hand them to `decide` (pure, and tested
// case by case in test/routines.test.js), and act only on an explicit 'ff'.
//
// What this action never does, whatever `decide` says: switch branches, stash,
// reset, delete or move a local branch, or touch a repo that is not on its
// default branch. The only writes are `git fetch --prune` (remote-tracking refs)
// and `git merge --ff-only` on the branch you are already on.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { config } = require('../../config');
const { logger } = require('../../log');
const { register } = require('./index');

const log = logger('repo-sync');

const QUIET_MINUTES = 60;
const FETCH_TIMEOUT_MS = 120_000;
const PARALLEL = 4;

// ------------------------------------------------------------ the rules ----

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function minutesAgo(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 1 ? 'just now' : `${m} min ago`;
}

// True when an untracked file sits where the incoming commits write: the same
// path, or the same directory. `git merge --ff-only` already refuses to
// overwrite an untracked file; this stops it from dropping new files beside
// one you are halfway through creating, which git would happily do.
function untrackedInTheWay(untracked = [], incoming = []) {
  if (!untracked.length || !incoming.length) return null;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const dirs = new Set(incoming.map((p) => dirOf(norm(p))));
  const files = new Set(incoming.map(norm));
  for (const raw of untracked) {
    const u = norm(raw);
    const isDir = String(raw).endsWith('/');
    if (files.has(u)) return raw;
    if (isDir && [...files].some((f) => f === u || f.startsWith(`${u}/`))) return raw;
    if (!isDir && dirs.has(dirOf(u))) return raw;
  }
  return null;
}

/**
 * The safety rules, as one pure function.
 *
 * @param {object} s                repo facts gathered by `inspect`
 * @returns {{action: 'ff'|'none'|'skip', reason: string}}
 *   'ff'   — fast-forward the default branch by s.behind commits
 *   'none' — nothing to do (already current)
 *   'skip' — leave the working tree alone, and say why
 */
function decide(s) {
  if (s.error) return { action: 'skip', reason: s.error };
  if (!s.hasOrigin) return { action: 'skip', reason: 'no origin remote' };
  if (s.fetchError) return { action: 'skip', reason: `fetch failed: ${s.fetchError}` };
  if (!s.defaultBranch) return { action: 'skip', reason: 'no default branch on origin (origin/HEAD, main, master)' };
  if (s.operation) return { action: 'skip', reason: `${s.operation} in progress` };
  if (!s.branch) return { action: 'skip', reason: 'detached HEAD — left alone' };
  if (s.branch !== s.defaultBranch) {
    const behind = Number(s.behind) || 0;
    return {
      action: 'skip',
      reason: `on ${s.branch}${behind ? `, ${behind} behind ${s.defaultBranch}` : ''} — left alone`,
    };
  }
  const behind = Number(s.behind) || 0;
  const ahead = Number(s.ahead) || 0;
  if (behind === 0) {
    return { action: 'none', reason: ahead ? `already current (${plural(ahead, 'local commit')} not pushed)` : 'already current' };
  }
  if (ahead > 0) return { action: 'skip', reason: `diverged: ${ahead} local, ${behind} incoming — not a fast-forward` };
  if (s.indexLocked) return { action: 'skip', reason: 'another git command is running (index.lock)' };
  if (s.dirty > 0) return { action: 'skip', reason: `${plural(s.dirty, 'uncommitted change')}` };
  const clash = untrackedInTheWay(s.untracked, s.incoming);
  if (clash) return { action: 'skip', reason: `untracked ${clash} sits where the update writes` };
  const quiet = (s.quietMinutes ?? QUIET_MINUTES) * 60000;
  if (s.lastActivityMs && s.nowMs - s.lastActivityMs < quiet) {
    return { action: 'skip', reason: `touched ${minutesAgo(s.nowMs - s.lastActivityMs)} — waiting for ${s.quietMinutes ?? QUIET_MINUTES} quiet minutes` };
  }
  if (!s.sessionsKnown) return { action: 'skip', reason: 'cannot tell whether a session is open in it (termhub unreachable)' };
  if (s.sessions && s.sessions.length) return { action: 'skip', reason: `in use by ${s.sessions.join(', ')}` };
  return { action: 'ff', reason: `fast-forward ${plural(behind, 'commit')}` };
}

// ------------------------------------------------------ who is in a repo ----

function samePathKey(p) {
  const r = path.resolve(String(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function under(child, parent) {
  const c = samePathKey(child);
  const p = samePathKey(parent);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Which of `busy` ({path, label}) touch `repo`: a session inside the repo, or
 * one in a directory between the repos root and the repo (a nested repo's
 * parent). A session at the root itself, or above it, is not "in" every repo.
 */
function sessionsTouching(repo, busy, root) {
  const out = [];
  for (const b of busy || []) {
    if (!b?.path) continue;
    const inside = under(b.path, repo);
    const between = under(repo, b.path) && under(b.path, root) && samePathKey(b.path) !== samePathKey(root);
    if (inside || between) out.push(b.label);
  }
  return [...new Set(out)];
}

// termhub sessions and pa's own runs, as {path, label}. `known: false` when
// termhub cannot be asked — `decide` then refuses to fast-forward.
async function busyPaths() {
  const busy = [];
  let known = true;
  try {
    const termhub = require('../../dispatch/termhub');
    for (const s of await termhub.listSessions()) {
      if (s.alive === false || !s.cwd) continue;
      busy.push({ path: s.cwd, label: `termhub session "${s.title || s.id}"` });
    }
  } catch (err) {
    known = false;
    log.warn('termhub not reachable', { message: err.message });
  }
  try {
    const { rows } = require('../../db');
    const runs = await rows(
      `select id, repo_path, worktree_path from run where status in ('starting','running','waiting')`
    );
    for (const r of runs) {
      for (const p of [r.repo_path, r.worktree_path]) if (p) busy.push({ path: p, label: `pa run #${r.id}` });
    }
  } catch (err) {
    known = false;
    log.warn('runs not readable', { message: err.message });
  }
  return { busy, known };
}

// ------------------------------------------------------------- git I/O ----

function git(cwd, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        // Never wait on a credential prompt nobody will see.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (err.killed ? 'timeout' : err.code) : 0,
          out: String(stdout || ''),
          err: String(stderr || (err && err.message) || ''),
        });
      }
    );
  });
}

// The line of git's stderr that says what went wrong: "ssh: connect … timed
// out" rather than the closing "…and the repository exists."
function firstLine(s) {
  const lines = String(s || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const best = lines.find((l) => /^ssh:/i.test(l)) || lines.find((l) => /^(fatal|error):/i.test(l)) || lines[lines.length - 1];
  return best ? best.slice(0, 160) : 'unknown error';
}

function isRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

/** Repos one level under `root`, plus repos one level inside non-repo folders. */
function scan(root, { nested = true } = {}) {
  const skip = (name) => name.startsWith('.') || name === 'node_modules';
  const children = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !skip(e.name));
    } catch {
      return [];
    }
  };
  const out = [];
  for (const e of children(root)) {
    const dir = path.join(root, e.name);
    if (isRepo(dir)) out.push(dir);
    else if (nested) for (const n of children(dir)) if (isRepo(path.join(dir, n.name))) out.push(path.join(dir, n.name));
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// `git status --porcelain=v1 -z`: entries are NUL-separated, renames carry a
// second path. Ignored files are not listed.
function parseStatus(z) {
  const parts = String(z).split('\0');
  let dirty = 0;
  const untracked = [];
  const changed = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const code = e.slice(0, 2);
    const file = e.slice(3);
    if (code === '??') untracked.push(file);
    else {
      dirty++;
      changed.push(file);
      if (code[0] === 'R' || code[0] === 'C') i++;
    }
  }
  return { dirty, untracked, changed };
}

const OPERATIONS = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];

async function defaultBranchOf(dir) {
  const head = await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const named = head.ok && head.out.trim().startsWith('origin/') ? head.out.trim().slice('origin/'.length) : null;
  // origin/HEAD can dangle (its branch was pruned); then fall back.
  for (const b of [named, 'main', 'master'].filter(Boolean)) {
    const r = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]);
    if (r.ok) return b;
  }
  return null;
}

/**
 * Gathers the facts `decide` needs. Activity times are read first, before any
 * git command of ours can touch the index; every read uses
 * --no-optional-locks so `status` does not rewrite it either.
 */
async function inspect(dir, { fetch = true, fetchOnce = null, now = Date.now(), quietMinutes = QUIET_MINUTES } = {}) {
  const s = { path: dir, name: path.basename(dir), nowMs: now, quietMinutes };
  const gd = await git(dir, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
  if (!gd.ok) return { ...s, error: `not readable: ${firstLine(gd.err)}` };
  const [gitDir, commonRaw] = gd.out.trim().split(/\r?\n/);
  const commonDir = path.resolve(dir, commonRaw || gitDir);

  s.lastActivityMs = Math.max(
    mtime(path.join(gitDir, 'index')),
    mtime(path.join(gitDir, 'HEAD')),
    mtime(path.join(gitDir, 'logs', 'HEAD'))
  );
  s.operation = (OPERATIONS.find(([f]) => fs.existsSync(path.join(gitDir, f))) || [])[1] || null;
  s.indexLocked = fs.existsSync(path.join(gitDir, 'index.lock'));

  const remotes = await git(dir, ['remote']);
  s.hasOrigin = remotes.ok && remotes.out.split(/\r?\n/).map((x) => x.trim()).includes('origin');
  if (!s.hasOrigin) return s;

  if (fetch) {
    // Worktrees of one repo share refs: fetch the common dir once.
    const doFetch = () => git(dir, ['fetch', '--prune', '--quiet', 'origin'], { timeout: FETCH_TIMEOUT_MS });
    const r = fetchOnce ? await fetchOnce(commonDir, doFetch) : await doFetch();
    if (!r.ok) s.fetchError = r.code === 'timeout' ? 'timed out' : firstLine(r.err);
  }

  s.defaultBranch = await defaultBranchOf(dir);
  const br = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  s.branch = br.ok ? br.out.trim() : null;
  if (!s.defaultBranch) return s;

  const counts = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${s.defaultBranch}`]);
  if (!counts.ok) return { ...s, error: `cannot compare with origin/${s.defaultBranch}: ${firstLine(counts.err)}` };
  const [a, b] = counts.out.trim().split(/\s+/).map(Number);
  s.ahead = a;
  s.behind = b;

  const st = await git(dir, ['status', '--porcelain=v1', '-z']);
  if (!st.ok) return { ...s, error: `status failed: ${firstLine(st.err)}` };
  const parsed = parseStatus(st.out);
  s.dirty = parsed.dirty;
  s.untracked = parsed.untracked;
  // Edited-but-unsaved work shows as dirty; this catches files touched and
  // then saved back to their committed content, and new untracked files.
  for (const f of [...parsed.changed, ...parsed.untracked]) {
    s.lastActivityMs = Math.max(s.lastActivityMs, mtime(path.join(dir, f)));
  }

  if (s.untracked.length && s.behind > 0) {
    const inc = await git(dir, ['diff', '--name-only', 'HEAD', `refs/remotes/origin/${s.defaultBranch}`]);
    s.incoming = inc.ok ? inc.out.split(/\r?\n/).filter(Boolean) : ['?'];
  }
  return s;
}

async function fastForward(s) {
  const target = `refs/remotes/origin/${s.defaultBranch}`;
  // merge.autoStash off: this action never stashes, even if your config would.
  const r = await git(s.path, ['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--quiet', target], { timeout: 120_000 });
  if (!r.ok) return { ok: false, error: firstLine(r.err) };
  return { ok: true };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- run ----

async function run(params, { dryRun = false, fetch = true } = {}) {
  const root = params.root || config.reposRoot;
  if (!fs.existsSync(root)) throw new Error(`repos root ${root} does not exist`);
  const repos = scan(root, { nested: params.nested !== false });
  const { busy, known } = await busyPaths();
  const fetches = new Map();
  const fetchOnce = (key, fn) => {
    const k = samePathKey(key);
    if (!fetches.has(k)) fetches.set(k, fn());
    return fetches.get(k);
  };

  const t0 = Date.now();
  const results = await pool(repos, PARALLEL, async (dir) => {
    const state = await inspect(dir, { fetch, fetchOnce, now: Date.now(), quietMinutes: params.quietMinutes });
    state.sessionsKnown = known;
    state.sessions = sessionsTouching(dir, busy, root);
    const d = decide(state);
    const rel = path.relative(root, dir) || state.name;
    const row = { repo: rel, branch: state.branch, behind: state.behind ?? null, decision: d.action, reason: d.reason };
    if (d.action === 'ff') {
      if (dryRun) return { ...row, outcome: 'would_update', commits: state.behind };
      const r = await fastForward(state);
      if (!r.ok) return { ...row, outcome: 'skipped', reason: `fast-forward refused: ${r.error}` };
      return { ...row, outcome: 'updated', commits: state.behind };
    }
    if (d.action === 'none') return { ...row, outcome: 'current' };
    return { ...row, outcome: 'skipped' };
  });

  const by = (o) => results.filter((r) => r.outcome === o);
  const updated = by(dryRun ? 'would_update' : 'updated');
  const current = by('current');
  const skipped = by('skipped');
  const failed = skipped.filter((r) => /^fetch failed|^not readable|^status failed|^cannot compare|refused/.test(r.reason));

  const verb = dryRun ? 'would update' : 'updated';
  const summary = `${verb} ${updated.length} · current ${current.length} · skipped ${skipped.length}` +
    (failed.length ? ` (${failed.length} could not be fetched or read)` : '');
  const lines = [
    ...updated.map((r) => `${r.repo}: ${verb} (${plural(r.commits, 'commit')})`),
    ...skipped.map((r) => `${r.repo}: skipped — ${r.reason}`),
  ];
  log.info('repo sync', { dryRun, repos: repos.length, updated: updated.length, skipped: skipped.length, ms: Date.now() - t0 });
  return {
    // A run fails only when it could reach nothing; a few unreachable remotes
    // are reported in the summary, not as a failed run.
    ok: !repos.length || failed.length < repos.length,
    summary,
    lines,
    // Toast when something changed or nothing could be reached. Remotes that
    // are routinely unreachable (VPN off) would otherwise toast every morning;
    // they are still listed in the feed and the run history.
    notable: updated.length > 0 || (repos.length > 0 && failed.length === repos.length),
    detail: { root, dryRun, fetched: fetch, sessionsKnown: known, repos: results },
  };
}

const action = register({
  name: 'repo_sync',
  summary:
    'Fetch every git repo under the repos root and fast-forward its default branch (main/master) when it is ' +
    'checked out, clean, idle and not in use; any other repo is only fetched and reported.',
  changes: `runs git fetch in every repo, and git merge --ff-only on clean default branches under ${config.reposRoot}`,
  params: {
    root: { type: 'string', doc: `folder holding the repos (default ${config.reposRoot})` },
    nested: { type: 'boolean', default: true, doc: 'also look one level inside folders that are not repos' },
    quietMinutes: { type: 'number', default: QUIET_MINUTES, min: 5, max: 1440, doc: 'skip repos touched more recently than this' },
  },
  describe: (p) =>
    `Pull main on every repo under ${p.root || config.reposRoot} that is clean, on its default branch, ` +
    `untouched for ${p.quietMinutes ?? QUIET_MINUTES} min and not in use; others are fetched and reported`,
  run,
});

module.exports = { action, decide, sessionsTouching, untrackedInTheWay, parseStatus, scan, inspect, run };
