'use strict';

// The project table: seeding it, reading it, and learning from corrections.
//
// You never author this mapping. It is seeded from what already exists — the
// git remotes under your repos root — and thereafter maintained by *using* it: correcting one guess writes the
// phrase that was used as an alias, so the next message phrased the same way
// resolves silently.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { config } = require('../config');
const { query, rows, one } = require('../db');
const { scoreCandidates } = require('./resolve');
const { logger } = require('../log');

const log = logger('projects');

function gitRemote(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// git@host:group/name.git and https://host/group/name.git both reduce to
// group/name, which is the only part that matches anything else we hold.
function pathFromRemote(remote) {
  if (!remote) return null;
  // Strip the suffix before matching: a lazy group with an optional `.git`
  // after it happily swallows the `.git` instead of leaving it for the suffix.
  const trimmed = String(remote).trim().replace(/\/+$/, '').replace(/\.git$/i, '');

  // scp-like: git@host:group/name — everything after the colon. The user is
  // optional: an ssh-config alias (`github-work:group/name`) has none. A
  // one-letter "host" is a Windows drive, not a remote.
  const scp = trimmed.match(/^(?:[^/@]+@)?([^/:@]+):(?!\/\/)(.+)$/);
  if (scp && scp[1].length > 1) return scp[2] || null;

  // URL-like: strip the scheme, then the host, and keep the rest. Nested
  // GitLab subgroups mean "the rest" can be three or four segments deep.
  const url = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i);
  if (url) return url[1] || null;

  return trimmed.includes('/') ? trimmed : null;
}

// A repo's human name, best effort: the first heading of its README beats the
// directory name, which beats nothing.
function readmeTitle(dir) {
  for (const name of ['README.md', 'readme.md', 'README.MD']) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const first = fs.readFileSync(p, 'utf8').split(/\r?\n/).find((l) => /^#\s+\S/.test(l));
      if (first) return first.replace(/^#\s+/, '').trim();
    } catch {
      /* unreadable README is not an error */
    }
  }
  return null;
}

function scanRepos(root) {
  const found = [];
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
function groupRepos(repos) {
  const groups = new Map();
  for (const r of repos) {
    const key = r.gitlabPath ? r.gitlabPath.toLowerCase() : `dir:${r.dirName.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    const repoName = (list[0].gitlabPath || '').split('/').pop().toLowerCase();
    const rank = (r) => [r.dirName.toLowerCase() === repoName ? 0 : 1, r.worktree ? 1 : 0, r.dirName.length, r.dirName];
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
function staleProjects(projects, exists) {
  return projects.filter((p) => p.active && p.repo_path && !exists(p.repo_path));
}

async function upsertProject({ name, gitlabPath, repoPath }) {
  const existing =
    (gitlabPath && (await one('select * from project where gitlab_path = $1', [gitlabPath]))) ||
    (repoPath && (await one('select * from project where repo_path = $1', [repoPath]))) ||
    (await one('select * from project where lower(name) = lower($1)', [name]));

  if (existing) {
    // Renamed to the canonical folder's name when that name is free, so the
    // distiller is shown `optimizer`, not the worktree it was first seen as.
    await query(
      `update project set
         name        = case when $4::text is not null and lower(name) <> lower($4::text)
                             and not exists (select 1 from project o where lower(o.name) = lower($4::text) and o.id <> $1)
                            then $4::text else name end,
         gitlab_path = coalesce($2, gitlab_path),
         repo_path   = coalesce($3, repo_path),
         active      = true,
         retired_at  = null,
         retired_reason = null
       where id = $1`,
      [existing.id, gitlabPath, repoPath, name]
    );
    return existing.id;
  }

  const created = await one(
    'insert into project (name, gitlab_path, repo_path) values ($1,$2,$3) returning id',
    [name, gitlabPath, repoPath]
  );
  return created.id;
}

async function addAlias(projectId, alias, origin = 'seeded', learnedFrom = null) {
  const clean = String(alias || '').trim();
  if (clean.length < 3) return false;
  // A corrected alias outranks a seeded one and is allowed to take an alias
  // over from a seed — that is the whole point of correcting it.
  const weight = origin === 'corrected' ? 2.0 : origin === 'observed' ? 1.2 : 1.0;
  const res = await query(
    `insert into project_alias (project_id, alias, origin, weight, learned_from)
     values ($1,$2,$3,$4,$5)
     on conflict (lower(alias)) do update set
       project_id   = case when project_alias.origin = 'corrected' and excluded.origin <> 'corrected'
                           then project_alias.project_id else excluded.project_id end,
       origin       = case when project_alias.origin = 'corrected' and excluded.origin <> 'corrected'
                           then project_alias.origin else excluded.origin end,
       weight       = greatest(project_alias.weight, excluded.weight),
       learned_from = coalesce(excluded.learned_from, project_alias.learned_from)
     returning id`,
    [projectId, clean, origin, weight, learnedFrom]
  );
  return res.rows.length > 0;
}

// Seeds from the git repos under your repos root.
async function sync() {
  const seen = [];

  for (const repo of groupRepos(scanRepos(config.reposRoot))) {
    const name = repo.dirName;
    const id = await upsertProject({
      name,
      gitlabPath: repo.gitlabPath,
      repoPath: repo.repoPath,
    });
    await addAlias(id, repo.dirName);
    for (const other of repo.others) await addAlias(id, other);
    if (repo.gitlabPath) {
      await addAlias(id, repo.gitlabPath.split('/').pop());
      await addAlias(id, repo.gitlabPath);
    }
    if (repo.title) await addAlias(id, repo.title);
    seen.push({ id, name, source: 'local' });
  }

  const retired = await retireMissing();
  log.info('projects synced', { count: seen.length, retired: retired.length });
  seen.retired = retired;
  return seen;
}

// A project whose folder is gone stops being a candidate. The row stays —
// commitments and runs point at it — and a folder that comes back is
// reactivated by upsertProject on the next sync.
async function retireMissing({ exists = fs.existsSync } = {}) {
  const all = await rows('select id, name, repo_path, active from project');
  const stale = staleProjects(all, exists);
  for (const p of stale) {
    await query(
      `update project set active = false, retired_at = now(), retired_reason = $2 where id = $1 and active`,
      [p.id, `repo folder gone: ${p.repo_path}`]
    );
  }
  if (stale.length) log.info('projects retired', { ids: stale.map((p) => p.id) });
  return stale.map((p) => ({ id: p.id, name: p.name, repoPath: p.repo_path }));
}

async function candidates() {
  const projects = await rows(
    'select id, name, gitlab_path, repo_path, last_touched_at from project where active order by name'
  );
  const aliases = await rows('select project_id, alias, origin, weight from project_alias');
  const byProject = new Map();
  for (const a of aliases) {
    if (!byProject.has(a.project_id)) byProject.set(a.project_id, []);
    byProject.get(a.project_id).push({ alias: a.alias, origin: a.origin, weight: a.weight });
  }
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    gitlabPath: p.gitlab_path,
    repoPath: p.repo_path,
    lastTouchedAt: p.last_touched_at,
    aliases: byProject.get(p.id) || [],
  }));
}

// Context that makes the scorer better than string matching: what you touched
// lately, and what the person asking usually works on.
async function scoringContext({ authorPersonId, threadExternalId } = {}) {
  const recent = await rows(
    `select distinct project_id from commitment
      where project_id is not null and extracted_at > now() - interval '14 days'
      order by project_id limit 20`
  );
  const authored = authorPersonId
    ? await rows(
        `select project_id, count(*) as n from commitment
          where counterparty_person_id = $1 and project_id is not null
          group by project_id order by n desc limit 5`,
        [authorPersonId]
      )
    : [];
  const thread = threadExternalId
    ? await one(
        `select c.project_id from commitment c
           join source_item si on si.id = c.source_item_id
          where si.thread_external_id = $1 and c.project_id is not null
          order by c.extracted_at desc limit 1`,
        [threadExternalId]
      )
    : null;

  return {
    recentProjectIds: recent.map((r) => r.project_id),
    authorProjectIds: authored.map((r) => r.project_id),
    threadProjectId: thread?.project_id ?? null,
  };
}

async function guess(text, ctx) {
  const list = await candidates();
  if (!list.length) return null;
  const context = { ...(await scoringContext(ctx || {})), workdirProjectId: ctx?.workdirProjectId ?? null };
  const ranked = scoreCandidates(text, list, context);
  return ranked[0] || null;
}

// Retired projects are not answers: correcting an ask to a repo that is gone
// from disk would hand a dispatched run a folder that does not exist.
async function byName(name) {
  return one(
    `select * from project
      where active
        and (lower(name) = lower($1)
         or lower(gitlab_path) = lower($1)
         or id = (select project_id from project_alias where lower(alias) = lower($1) limit 1))
      order by (lower(name) = lower($1)) desc
      limit 1`,
    [name]
  );
}

// Learns the phrases a corrected commitment was actually described with. Short
// noun phrases from the summary and subject, not the whole sentence — an alias
// that only matches one exact message is not an alias.
async function learnAliases(projectId, commitment, item, commitmentId) {
  const { normalise } = require('./resolve');
  const learned = [];
  const sources = [commitment.summary, item?.subject].filter(Boolean);

  for (const source of sources) {
    const words = normalise(source).split(' ').filter((w) => w.length > 3);
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
async function correct(commitmentId, projectName, { learn = true, rationale = 'corrected by hand' } = {}) {
  const commitment = await one('select * from commitment where id = $1', [commitmentId]);
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
  await query(
    `update commitment set project_id = $2, repo_path = $3, project_confidence = $4,
                           project_rationale = $5 where id = $1`,
    [commitmentId, project?.id ?? null, project?.repo_path ?? null, project ? 1.0 : null, rationale]
  );
  let learned = [];
  if (project && learn) {
    const item = await one('select subject, body_text from source_item where id = $1', [commitment.source_item_id]);
    learned = await learnAliases(project.id, commitment, item, commitmentId);
  }
  return { project, learned, before };
}

async function list() {
  return rows(
    `select p.*, (select count(*) from project_alias a where a.project_id = p.id) as aliases,
            (select count(*) from commitment c where c.project_id = p.id) as commitments
       from project p where p.active order by p.name`
  );
}

module.exports = {
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
