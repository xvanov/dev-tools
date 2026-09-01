'use strict';

// The project table: seeding it, reading it, and learning from corrections.
//
// You never author this mapping. It is seeded from what already exists — the
// git remotes under your repos root and the GitLab projects you belong to —
// and thereafter maintained by *using* it: correcting one guess writes the
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

  // scp-like: git@host:group/name — everything after the colon.
  const scp = trimmed.match(/^[^/]+@[^/:]+:(.+)$/);
  if (scp) return scp[1] || null;

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
    found.push({
      dirName: entry.name,
      repoPath: dir,
      gitlabPath: pathFromRemote(remote),
      title: readmeTitle(dir),
    });
  }
  return found;
}

async function upsertProject({ name, gitlabPath, repoPath }) {
  const existing =
    (gitlabPath && (await one('select * from project where gitlab_path = $1', [gitlabPath]))) ||
    (repoPath && (await one('select * from project where repo_path = $1', [repoPath]))) ||
    (await one('select * from project where lower(name) = lower($1)', [name]));

  if (existing) {
    await query(
      `update project set
         gitlab_path = coalesce($2, gitlab_path),
         repo_path   = coalesce($3, repo_path),
         active      = true
       where id = $1`,
      [existing.id, gitlabPath, repoPath]
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

// Seeds from local repos and, when configured, GitLab membership.
async function sync({ includeGitlab = true } = {}) {
  const seen = [];

  for (const repo of scanRepos(config.reposRoot)) {
    const name = repo.dirName;
    const id = await upsertProject({
      name,
      gitlabPath: repo.gitlabPath,
      repoPath: repo.repoPath,
    });
    await addAlias(id, repo.dirName);
    if (repo.gitlabPath) {
      await addAlias(id, repo.gitlabPath.split('/').pop());
      await addAlias(id, repo.gitlabPath);
    }
    if (repo.title) await addAlias(id, repo.title);
    seen.push({ id, name, source: 'local' });
  }

  if (includeGitlab) {
    const gitlab = require('../ingest/gitlab');
    if (gitlab.configured()) {
      try {
        const projects = await gitlab.api('/projects?membership=true&per_page=100&order_by=last_activity_at');
        for (const p of projects) {
          const id = await upsertProject({
            name: p.path,
            gitlabPath: p.path_with_namespace,
            repoPath: null,
          });
          await addAlias(id, p.name);
          await addAlias(id, p.path);
          await addAlias(id, p.path_with_namespace);
          if (p.last_activity_at) {
            await query('update project set last_touched_at = greatest(coalesce(last_touched_at, $2), $2) where id = $1', [
              id,
              p.last_activity_at,
            ]);
          }
          seen.push({ id, name: p.path, source: 'gitlab' });
        }
      } catch (err) {
        log.warn('gitlab project sync failed', { message: err.message });
      }
    }
  }

  log.info('projects synced', { count: seen.length });
  return seen;
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
  const context = await scoringContext(ctx || {});
  const ranked = scoreCandidates(text, list, context);
  return ranked[0] || null;
}

async function byName(name) {
  return one(
    `select * from project
      where lower(name) = lower($1)
         or lower(gitlab_path) = lower($1)
         or id = (select project_id from project_alias where lower(alias) = lower($1) limit 1)
      limit 1`,
    [name]
  );
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
  upsertProject,
  scanRepos,
  pathFromRemote,
};
