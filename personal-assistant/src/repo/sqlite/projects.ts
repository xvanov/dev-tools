'use strict';

// SQLite twin of src/repo/projects.js (project, project_alias). lower() is
// ASCII-only here; counts come back as numbers (pg gives bigint strings).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const { NOW } = require('./_sql');

function create(db: Db) {
  return {
    /** A project by its forge path. */
    async byGitlabPath(gitlabPath: string) {
      return db.one('select * from project where gitlab_path = $1', [gitlabPath]);
    },

    /** A project by its clone path. */
    async byRepoPath(repoPath: string) {
      return db.one('select * from project where repo_path = $1', [repoPath]);
    },

    /** A project by name, case-insensitive. */
    async byNameCaseless(name: string) {
      return db.one('select * from project where lower(name) = lower($1)', [name]);
    },

    /** Refreshes a project seen again: renamed to `name` when free, paths filled in, reactivated. */
    async refresh(id: number | string, gitlabPath: string, repoPath: string, name: string) {
      await db.query(
        `update project set
         name        = case when $4 is not null and lower(name) <> lower($4)
                             and not exists (select 1 from project o where lower(o.name) = lower($4) and o.id <> $1)
                            then $4 else name end,
         gitlab_path = coalesce($2, gitlab_path),
         repo_path   = coalesce($3, repo_path),
         active      = 1,
         retired_at  = null,
         retired_reason = null
       where id = $1`,
        [id, gitlabPath, repoPath, name]
      );
    },

    /** Inserts a project and returns its id. */
    async insert(name: string, gitlabPath: string, repoPath: string) {
      return db.one('insert into project (name, gitlab_path, repo_path) values ($1,$2,$3) returning id', [name, gitlabPath, repoPath]);
    },

    /** Files an alias for a project (a corrected alias outranks a seeded one). Whether a row was written. */
    async upsertAlias(projectId: number | string, alias: string, origin: string, weight: number, learnedFrom: unknown) {
      const res = await db.query(
        `insert into project_alias (project_id, alias, origin, weight, learned_from)
     values ($1,$2,$3,$4,$5)
     on conflict (lower(alias)) do update set
       project_id   = case when project_alias.origin = 'corrected' and excluded.origin <> 'corrected'
                           then project_alias.project_id else excluded.project_id end,
       origin       = case when project_alias.origin = 'corrected' and excluded.origin <> 'corrected'
                           then project_alias.origin else excluded.origin end,
       weight       = max(project_alias.weight, excluded.weight),
       learned_from = coalesce(excluded.learned_from, project_alias.learned_from)
     returning id`,
        [projectId, alias, origin, weight, learnedFrom]
      );
      return res.rows.length > 0;
    },

    /** Every project (active or not): id, name, repo_path, active. */
    async allForRetire() {
      return db.rows('select id, name, repo_path, active from project');
    },

    /** Retires an active project. */
    async retire(id: number | string, reason: string) {
      await db.query(`update project set active = 0, retired_at = ${NOW}, retired_reason = $2 where id = $1 and active`, [id, reason]);
    },

    /** Active projects with the columns the resolver needs, by name. */
    async activeForCandidates() {
      // local_paths and remote_urls are not null (default '{}' / '[]'): read the columns so they decode.
      return db.rows(
        `select id, name, gitlab_path, repo_path, last_touched_at, local_paths, remote_urls
       from project where active order by name`
      );
    },

    /** Every alias. */
    async allAliases() {
      return db.rows('select project_id, alias, origin, weight from project_alias');
    },

    /** An active project by name, forge path or alias, the exact name match first. */
    async byNameOrAlias(name: string) {
      return db.one(
        `select * from project
      where active
        and (lower(name) = lower($1)
         or lower(gitlab_path) = lower($1)
         or id = (select project_id from project_alias where lower(alias) = lower($1) limit 1))
      order by (lower(name) = lower($1)) desc
      limit 1`,
        [name]
      );
    },

    /** Active projects with their alias and commitment counts. */
    async listWithCounts() {
      return db.rows(
        `select p.*, (select count(*) from project_alias a where a.project_id = p.id) as aliases,
            (select count(*) from commitment c where c.project_id = p.id) as commitments
       from project p where p.active order by p.name`
      );
    },

    /** Active projects' names and folders, for `pa doctor`. */
    async activeNamePaths() {
      return db.rows('select name, repo_path from project where active');
    },
    /** The active project whose folder or forge path is repoPath (forge path caseless), or null. */
    async activeByRepo(repoPath: string) {
      return db.one(
        `select id, repo_path, gitlab_path from project
      where active and (repo_path = $1 or lower(gitlab_path) = lower($1)) limit 1`,
        [repoPath]
      );
    },

    /** One project row by id, or null. */
    async rowById(id: number | string) {
      return db.one('select * from project where id = $1', [id]);
    },

    /** A project by name or forge path (caseless), or by an alias; null when none. */
    async findLoose(name: string) {
      return db.one(
        `select * from project
          where lower(name) = lower($1) or lower(gitlab_path) = lower($1)
             or id = (select project_id from project_alias where lower(alias) = lower($1) limit 1)
          limit 1`,
        [name]
      );
    },
  };
}

module.exports = { create };
