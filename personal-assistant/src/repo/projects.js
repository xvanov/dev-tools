'use strict';

// Aggregate: projects. Tables: project, project_alias.
// Callers: src/projects/index.js.

function create(db) {
  return {
    /** A project by its forge path. @returns {Promise<object|null>} */
    async byGitlabPath(gitlabPath) {
      return db.one('select * from project where gitlab_path = $1', [gitlabPath]);
    },

    /** A project by its clone path. @returns {Promise<object|null>} */
    async byRepoPath(repoPath) {
      return db.one('select * from project where repo_path = $1', [repoPath]);
    },

    /** A project by name, case-insensitive. @returns {Promise<object|null>} */
    async byNameCaseless(name) {
      return db.one('select * from project where lower(name) = lower($1)', [name]);
    },

    /**
     * Refreshes a project seen again: renamed to `name` when that name is
     * free, paths filled in, reactivated.
     */
    async refresh(id, gitlabPath, repoPath, name) {
      await db.query(
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
        [id, gitlabPath, repoPath, name]
      );
    },

    /** Inserts a project and returns its id. @returns {Promise<{id}>} */
    async insert(name, gitlabPath, repoPath) {
      return db.one('insert into project (name, gitlab_path, repo_path) values ($1,$2,$3) returning id', [name, gitlabPath, repoPath]);
    },

    /**
     * Files an alias for a project. A corrected alias outranks a seeded one
     * and may take an alias over from it; the reverse never.
     * @returns {Promise<boolean>} whether a row was written
     */
    async upsertAlias(projectId, alias, origin, weight, learnedFrom) {
      const res = await db.query(
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
        [projectId, alias, origin, weight, learnedFrom]
      );
      return res.rows.length > 0;
    },

    /** Every project (active or not): id, name, repo_path, active. */
    async allForRetire() {
      return db.rows('select id, name, repo_path, active from project');
    },

    /** Retires an active project (the row stays: commitments and runs point at it). */
    async retire(id, reason) {
      await db.query(`update project set active = false, retired_at = now(), retired_reason = $2 where id = $1 and active`, [id, reason]);
    },

    /** Active projects with the columns the resolver needs, by name. */
    async activeForCandidates() {
      return db.rows(
        `select id, name, gitlab_path, repo_path, last_touched_at,
            coalesce(local_paths, '{}'::jsonb) as local_paths, coalesce(remote_urls, '{}') as remote_urls
       from project where active order by name`
      );
    },

    /** Every alias. @returns {Promise<Array<{project_id, alias, origin, weight}>>} */
    async allAliases() {
      return db.rows('select project_id, alias, origin, weight from project_alias');
    },

    /**
     * An active project by name, forge path or alias (retired ones are not
     * answers), the exact name match first.
     * @returns {Promise<object|null>}
     */
    async byNameOrAlias(name) {
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

    /**
     * Active projects with their alias and commitment counts.
     * @returns {Promise<object[]>} project rows plus `aliases` and `commitments`
     */
    async listWithCounts() {
      return db.rows(
        `select p.*, (select count(*) from project_alias a where a.project_id = p.id) as aliases,
            (select count(*) from commitment c where c.project_id = p.id) as commitments
       from project p where p.active order by p.name`
      );
    },
  };
}

module.exports = { create };
