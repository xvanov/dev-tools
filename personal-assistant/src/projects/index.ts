'use strict';

// The project table: seeding it, reading it, and learning from corrections.
//
// You never author this mapping. It is seeded from what already exists — the
// git remotes under your repos root — and thereafter maintained by *using* it: correcting one guess writes the
// phrase that was used as an alias, so the next message phrased the same way
// resolves silently.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = Record<string, any>;
type Db = import('../repo/types.ts').Db;

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { config } = require('../config.ts');
const repo = require('../repo');
const { scoreCandidates } = require('./resolve.ts');
const { logger } = require('../log.ts');

const log = logger('projects');

// origin's URL, read from the repo's git config — not `git remote get-url`:
// one synchronous git process per folder (~0.2 s each on Windows, 50 folders)
// blocked the worker's event loop for ~10 s every repos sync, long enough for
// a deploy's health watch to roll a healthy generation back. A linked
// worktree's `.git` is a file naming its gitdir, whose `commondir` leads to
// the shared config. Anything unexpected falls back to the git process.
function readOriginUrl(dir: any) {
  const dotGit = path.join(dir, '.git');
  let gitDir = dotGit;
  if (fs.statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8')) as any;
    if (!m) return undefined;
    gitDir = path.resolve(dir, m[1].trim());
    const common = path.join(gitDir, 'commondir');
    if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim());
  }
  const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
  let inOrigin = false;
  for (const raw of cfg.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      if (/^\[include/i.test(line)) return undefined; // includes: let git resolve them
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    const kv: any = inOrigin && /^url\s*=\s*(.*)$/i.exec(line);
    if (kv) return kv[1].trim().replace(/^"(.*)"$/, '$1');
  }
  return null;
}

function gitRemote(dir: any) {
  try {
    const url = readOriginUrl(dir);
    if (url !== undefined) return url;
  } catch {
    /* fall through to git */
  }
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

// git@host:group/name.git and https://host/group/name.git both reduce to
// group/name, which is the only part that matches anything else we hold.
function pathFromRemote(remote: any) {
  if (!remote) return null;
  // Strip the suffix before matching: a lazy group with an optional `.git`
  // after it happily swallows the `.git` instead of leaving it for the suffix.
  const trimmed = String(remote).trim().replace(/\/+$/, '').replace(/\.git$/i, '');

  // scp-like: git@host:group/name — everything after the colon. The user is
  // optional: an ssh-config alias (`github-work:group/name`) has none. A
  // one-letter "host" is a Windows drive, not a remote.
  const scp = trimmed.match(/^(?:[^/@]+@)?([^/:@]+):(?!\/\/)(.+)$/) as any;
  if (scp && scp[1].length > 1) return scp[2] || null;

  // URL-like: strip the scheme, then the host, and keep the rest. Nested
  // GitLab subgroups mean "the rest" can be three or four segments deep.
  const url = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i) as any;
  if (url) return url[1] || null;

  return trimmed.includes('/') ? trimmed : null;
}

// A repo's human name, best effort: the first heading of its README beats the
// directory name, which beats nothing.
function readmeTitle(dir: any) {
  for (const name of ['README.md', 'readme.md', 'README.MD']) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const first = fs.readFileSync(p, 'utf8').split(/\r?\n/).find((l: any) => /^#\s+\S/.test(l));
      if (first) return first.replace(/^#\s+/, '').trim();
    } catch {
      /* unreadable README is not an error */
    }
  }
  return null;
}

function scanRepos(root: any) {
  const found: any[] = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const remote = gitRemote(dir);
    let worktree = false;
    try {
      // A linked worktree's `.git` is a file pointing at the main clone.
      worktree = fs.statSync(path.join(dir, '.git')).isFile();
    } catch {
      /* raced a delete: treat as a clone */
    }
    found.push({
      dirName: entry.name,
      repoPath: dir,
      gitlabPath: pathFromRemote(remote),
      title: readmeTitle(dir),
      worktree,
    });
  }
  return found;
}

/**
 * One project per remote. Several folders often share one — the clone plus
 * worktrees and copies (`optimizer`, `optimizer-pr442`, `opt-dl`) — and
 * whichever was scanned last used to win, so the project was named after a
 * throwaway worktree and its repo_path pointed into it. The canonical folder
 * is the one named like the remote's repo, else a real clone over a worktree,
 * else the shortest name. The others become aliases of it.
 * @param {Array} repos  scanRepos() output
 * @returns {Array} [{...canonical, others: [dirName]}]
 */
function groupRepos(repos: any) {
  const groups = new Map<any, any>();
  for (const r of repos) {
    const key = r.gitlabPath ? r.gitlabPath.toLowerCase() : `dir:${r.dirName.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out: any[] = [];
  for (const list of groups.values()) {
    const repoName = (list[0].gitlabPath || '').split('/').pop().toLowerCase();
    const rank = (r: any) => [r.dirName.toLowerCase() === repoName ? 0 : 1, r.worktree ? 1 : 0, r.dirName.length, r.dirName];
    const sorted = [...list].sort((a, b) => {
      const x = rank(a);
      const y = rank(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return 0;
    });
    out.push({ ...sorted[0], others: sorted.slice(1).map((r) => r.dirName) });
  }
  return out;
}

/**
 * Which projects to retire: active ones whose repo_path is gone from disk.
 * @param {Array} projects  [{id, name, repo_path, active}]
 * @param {(p:string)=>boolean} exists
 */
function staleProjects(projects: any, exists: any) {
  return projects.filter((p: any) => p.active && p.repo_path && !exists(p.repo_path));
}

async function upsertProject({ name, gitlabPath, repoPath }: { name?: any | null; gitlabPath?: any | null; repoPath?: any | null }) {
  const existing =
    (gitlabPath && (await repo.projects.byGitlabPath(gitlabPath))) ||
    (repoPath && (await repo.projects.byRepoPath(repoPath))) ||
    (await repo.projects.byNameCaseless(name));

  if (existing) {
    // Renamed to the canonical folder's name when that name is free, so the
    // distiller is shown `optimizer`, not the worktree it was first seen as.
    await repo.projects.refresh(existing.id, gitlabPath, repoPath, name);
    return existing.id;
  }

  const created = await repo.projects.insert(name, gitlabPath, repoPath);
  return created.id;
}

async function addAlias(projectId: any, alias: any, origin: string = 'seeded', learnedFrom: any | null = null) {
  const clean = String(alias || '').trim();
  if (clean.length < 3) return false;
  // A corrected alias outranks a seeded one and is allowed to take an alias
  // over from a seed — that is the whole point of correcting it.
  const weight = origin === 'corrected' ? 2.0 : origin === 'observed' ? 1.2 : 1.0;
  return repo.projects.upsertAlias(projectId, clean, origin, weight, learnedFrom);
}

// Seeds from the git repos under your repos root.
async function sync() {
  const seen: any[] = [];

  for (const found of groupRepos(scanRepos(config.reposRoot))) {
    const name = found.dirName;
    const id = await upsertProject({
      name,
      gitlabPath: found.gitlabPath,
      repoPath: found.repoPath,
    });
    await addAlias(id, found.dirName);
    for (const other of found.others) await addAlias(id, other);
    if (found.gitlabPath) {
      await addAlias(id, found.gitlabPath.split('/').pop());
      await addAlias(id, found.gitlabPath);
    }
    if (found.title) await addAlias(id, found.title);
    seen.push({ id, name, source: 'local' });
  }

  const retired = await retireMissing();
  log.info('projects synced', { count: seen.length, retired: retired.length });
  (seen as any).retired = retired;
  return seen;
}

// A project whose folder is gone stops being a candidate. The row stays —
// commitments and runs point at it — and a folder that comes back is
// reactivated by upsertProject on the next sync.
async function retireMissing({ exists = fs.existsSync }: { exists?: any } = {}) {
  const all = await repo.projects.allForRetire();
  const stale = staleProjects(all, exists);
  for (const p of stale) {
    await repo.projects.retire(p.id, `repo folder gone: ${p.repo_path}`);
  }
  if (stale.length) log.info('projects retired', { ids: stale.map((p: any) => p.id) });
  return stale.map((p: any) => ({ id: p.id, name: p.name, repoPath: p.repo_path }));
}

// The resolver's vocabulary is the repo registry (src/repos): besides the
// name, forge path and clone, every folder the repo is known by on any
// machine (`paths`) and every forge path it has had (`remotePaths` — the
// archived GitLab original of a repo that moved to GitHub, a second remote).
async function candidates() {
  const projects = await repo.projects.activeForCandidates();
  const aliases = await repo.projects.allAliases();
  const byProject = new Map<any, any>();
  for (const a of aliases) {
    if (!byProject.has(a.project_id)) byProject.set(a.project_id, []);
    byProject.get(a.project_id).push({ alias: a.alias, origin: a.origin, weight: a.weight });
  }
  return projects.map((p: any) => {
    const aliasList = byProject.get(p.id) || [];
    const remotePaths = new Set(
      [...(p.remote_urls || []).map(pathFromRemote), ...aliasList.map((a: any) => a.alias).filter((a: any) => /^[^/\s]+\/[^/\s]+$/.test(a))]
        .filter(Boolean)
        .filter((x) => !p.gitlab_path || x.toLowerCase() !== p.gitlab_path.toLowerCase())
    );
    return {
      id: p.id,
      name: p.name,
      gitlabPath: p.gitlab_path,
      repoPath: p.repo_path,
      paths: Object.values(p.local_paths || {}).flat().filter((x) => typeof x === 'string'),
      remotePaths: [...remotePaths],
      lastTouchedAt: p.last_touched_at,
      aliases: aliasList,
    };
  });
}

// Context that makes the scorer better than string matching: what you touched
// lately, and what the person asking usually works on.
async function scoringContext({ authorPersonId, threadExternalId }: { authorPersonId?: any | null; threadExternalId?: any | null } = {}) {
  const recent = await repo.commitments.recentProjectIds();
  const authored = authorPersonId ? await repo.commitments.projectsOfPerson(authorPersonId) : [];
  const thread = threadExternalId ? await repo.commitments.projectOfThread(threadExternalId) : null;

  return {
    recentProjectIds: recent.map((r: any) => r.project_id),
    authorProjectIds: authored.map((r: any) => r.project_id),
    threadProjectId: thread?.project_id ?? null,
  };
}

async function guess(text: any, ctx: any) {
  const list = await candidates();
  if (!list.length) return null;
  const context = { ...(await scoringContext(ctx || {})), workdirProjectId: ctx?.workdirProjectId ?? null };
  const ranked = scoreCandidates(text, list, context);
  return ranked[0] || null;
}

// Retired projects are not answers: correcting an ask to a repo that is gone
// from disk would hand a dispatched run a folder that does not exist.
async function byName(name: any) {
  return repo.projects.byNameOrAlias(name);
}

// Learns the phrases a corrected commitment was actually described with. Short
// noun phrases from the summary and subject, not the whole sentence — an alias
// that only matches one exact message is not an alias.
async function learnAliases(projectId: any, commitment: any, item: any, commitmentId: any) {
  const { normalise } = require('./resolve.ts');
  const learned: any[] = [];
  const sources = [commitment.summary, item?.subject].filter(Boolean);

  for (const source of sources) {
    const words = normalise(source).split(' ').filter((w: any) => w.length > 3);
    for (let n = 3; n >= 2; n--) {
      for (let i = 0; i + n <= words.length; i++) {
        const phrase = words.slice(i, i + n).join(' ');
        if (phrase.length < 8 || phrase.length > 40) continue;
        if (await addAlias(projectId, phrase, 'corrected', commitmentId)) {
          learned.push(phrase);
        }
        if (learned.length >= 2) return learned;
      }
    }
  }
  return learned;
}

/**
 * Points one commitment at a project — the correction path. One
 * implementation for `pa show <id> --project` and anything else that re-routes
 * an ask. `project` null clears the guess. `learn` (default true) learns the
 * phrasing as an alias; a bulk re-route on evidence other than the wording
 * (a repo name in the item) passes false, since the phrase taught nothing.
 * @returns {{project, learned: string[], before: {project_id, repo_path, project_confidence, project_rationale}}}
 */
async function correct(commitmentId: any, projectName: any, { learn = true, rationale = 'corrected by hand' }: { learn?: boolean; rationale?: string } = {}) {
  const commitment = await repo.commitments.byId(commitmentId);
  if (!commitment) throw new Error(`no commitment #${commitmentId}`);
  let project = null;
  if (projectName != null) {
    project = await byName(String(projectName));
    if (!project) throw new Error(`no project "${projectName}" — try \`pa projects\``);
  }
  const before = {
    project_id: commitment.project_id,
    repo_path: commitment.repo_path,
    project_confidence: commitment.project_confidence,
    project_rationale: commitment.project_rationale,
  };
  await repo.commitments.setProject(commitmentId, project?.id ?? null, project?.repo_path ?? null, project ? 1.0 : null, rationale);
  let learned: any[] = [];
  if (project && learn) {
    const item = await repo.sources.subjectAndBody(commitment.source_item_id);
    learned = await learnAliases(project.id, commitment, item, commitmentId);
  }
  return { project, learned, before };
}

async function list() {
  return repo.projects.listWithCounts();
}

module.exports = {
  gitRemote,
  sync,
  candidates,
  scoringContext,
  guess,
  byName,
  list,
  addAlias,
  correct,
  learnAliases,
  upsertProject,
  scanRepos,
  groupRepos,
  staleProjects,
  retireMissing,
  pathFromRemote,
};
