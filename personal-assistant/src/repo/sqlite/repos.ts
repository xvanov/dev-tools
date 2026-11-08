'use strict';

// SQLite twin of src/repo/repos.js (repo_pr, and the repo registry's view of
// project and project_alias).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const { ROW_COLUMNS } = require('../repos.ts');
const { NOW } = require('./_sql');

const toDate = (v: unknown) => (v == null || v instanceof Date ? v : new Date(v as string | number));
const json = (v: unknown) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

function create(db: Db) {
  return {
    // ---- projects as repos -------------------------------------------------------

    /** Every project row (ROW_COLUMNS), by id. */
    async allRows() {
      return db.rows(`select ${ROW_COLUMNS} from project order by id`);
    },

    /** Active project rows (ROW_COLUMNS), by name. */
    async activeRows() {
      return db.rows(`select ${ROW_COLUMNS} from project where active order by name`);
    },

    /** One project row (ROW_COLUMNS), or null. */
    async rowById(id: number | string) {
      return db.one(`select ${ROW_COLUMNS} from project where id = $1`, [id]);
    },

    /** Every alias: {project_id, alias}. */
    async allAliases() {
      return db.rows('select project_id, alias from project_alias');
    },

    /** A project's aliases with where each came from, by origin then alias. */
    async aliasesOf(id: number | string) {
      return db.rows('select alias, origin from project_alias where project_id = $1 order by origin, alias', [id]);
    },

    /** Adds an active project (or touches the one with that name); resolves its id. */
    async insert({ name, gitlabPath, forge, origin }: { name?: string | null; gitlabPath?: string | null; forge?: string | null; origin?: string | null }) {
      const r = await db.one(
        `insert into project (name, gitlab_path, forge, origin, active) values ($1, $2, $3, $4, 1)
     on conflict (name) do update set name = excluded.name
     returning id`,
        [name, gitlabPath, forge, origin]
      );
      return r?.id;
    },

    /** A repo that moved forge: the new path and forge, active again, its folder kept or cleared. */
    async takeOver(id: number | string, fullName: string, forge: string, repoPath: string) {
      await db.query(
        `update project set gitlab_path = $2, forge = $3, active = 1, retired_at = null, retired_reason = null, repo_path = $4
      where id = $1`,
        [id, fullName, forge, repoPath]
      );
    },

    /**
     * Writes what one sync pass gathered for a project. `profileAdd` (JSON) is
     * merged into the profile key by key, as pg's jsonb `||` does: read and
     * written in one transaction, since SQLite's json_patch merges deeply and
     * drops keys set to null.
     */
    async saveSynced(id: number | string, { forge, remoteUrls, localPaths, defaultBranch, branches, lastCommitAt, lastSessionAt, sessionCount, profileAdd }: { forge?: string | null; remoteUrls?: unknown; localPaths?: unknown; defaultBranch?: unknown; branches?: unknown; lastCommitAt?: unknown; lastSessionAt?: unknown; sessionCount?: unknown; profileAdd?: unknown }) {
      await db.withTx(async (c) => {
        const cur = (await c.query('select profile from project where id = $1', [id])).rows[0];
        const profile = { ...(json(cur && cur.profile) || {}), ...(json(profileAdd) || {}) };
        await c.query(
          `update project set forge = $2, remote_urls = $3, local_paths = $4, default_branch = $5, branches = $6,
              last_commit_at = coalesce($7, last_commit_at), last_session_at = coalesce($8, last_session_at),
              session_count = case when $9 > 0 then $9 else session_count end,
              profile = $10, synced_at = ${NOW}
        where id = $1`,
          [id, forge, remoteUrls, localPaths, defaultBranch, branches, lastCommitAt, lastSessionAt, sessionCount, JSON.stringify(profile)]
        );
      });
    },

    /** A project with a folder and no origin is a local one. */
    async markLocalOrigins() {
      await db.query(`update project set origin = 'local' where origin is null and repo_path is not null`);
    },

    /** Recounts each project's PRs and its newest PR activity from repo_pr. */
    async refreshPrStats() {
      await db.query(
        `update project set pr_count = s.n, last_pr_at = s.last
       from (select project_id, count(*) as n, max(coalesce(merged_at, updated_at)) as last
               from repo_pr where project_id is not null group by project_id) as s
      where s.project_id = project.id`
      );
    },

    /** Saves a profile: description, profile (JSON text), where it came from, the material's hash. */
    async saveProfile(id: number | string, description: string, profile: string, source: string, hash: string) {
      await db.query(
        `update project set description = $2, profile = $3, profile_source = $4, profile_hash = $5, profiled_at = ${NOW} where id = $1`,
        [id, description, profile, source, hash]
      );
    },

    /** Counts for the sync report: {active, worked (PRs, commits, sessions or pinned), prs}. */
    async syncCounts() {
      return db.one(
        `select count(*) filter (where active) as active,
            count(*) filter (where active and (pr_count > 0 or last_commit_at is not null or session_count > 0
                                               or coalesce(json_extract(manual, '$.pinned'), 0) = 1)) as worked,
            (select count(*) from repo_pr) as prs
       from project`
      );
    },

    /** A repo's id by name, forge path, alias or folder (any case), active first; null when none. */
    async findId(ref: unknown) {
      const r = await db.one(
        `select id from project
      where lower(name) = lower($1) or lower(gitlab_path) = lower($1)
         or id = (select project_id from project_alias where lower(alias) = lower($1) limit 1)
         or lower(repo_path) = lower($1)
      order by active desc, (lower(name) = lower($1)) desc limit 1`,
        [ref]
      );
      return r ? r.id : null;
    },

    /** A project's name ({name}), or null. */
    async nameOf(id: number | string) {
      return db.one('select name from project where id = $1', [id]);
    },

    /** Sets a project's folder. */
    async setRepoPath(id: number | string, repoPath: string) {
      await db.query('update project set repo_path = $2 where id = $1', [id, repoPath]);
    },

    /** Brings a project back: active, shown, not retired. */
    async revive(id: number | string) {
      await db.query('update project set active = 1, hidden = 0, retired_at = null, retired_reason = null where id = $1', [id]);
    },

    /** A project's manual corrections ({manual}), or null. */
    async manualOf(id: number | string) {
      return db.one('select manual from project where id = $1', [id]);
    },

    /** Replaces a project's manual corrections (JSON text). */
    async setManual(id: number | string, manual: string) {
      await db.query('update project set manual = $2 where id = $1', [id, manual]);
    },

    /** Hides a project from the Repos tab, or shows it again. */
    async setHidden(id: number | string, hidden: boolean) {
      await db.query('update project set hidden = $2 where id = $1', [id, hidden]);
    },

    /** A project's open, unfolded commitments, newest first, at most 20: {id, summary, status}. */
    async openCommitments(id: number | string) {
      return db.rows(
        `select id, summary, status from commitment where project_id = $1 and status in ('open','dispatched') and superseded_by is null order by id desc limit 20`,
        [id]
      );
    },

    // ---- PRs ---------------------------------------------------------------------

    /** The newest PR update the sync has seen ({at}). */
    async lastPrUpdate() {
      const r = await db.one('select max(updated_at) as at from repo_pr');
      return r ? { ...r, at: toDate(r.at) } : r;
    },

    /** Inserts or refreshes a GitHub PR. */
    async upsertPr(projectId: number | string, p: Row) {
      await db.query(
        `insert into repo_pr (project_id, forge, repo, number, title, state, draft, head_ref, base_ref, url, author,
                            created_at, updated_at, merged_at, closed_at, summary, body, synced_at)
       values ($1,'github',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, ${NOW})
       on conflict (forge, repo, number) do update set
         project_id = excluded.project_id, title = excluded.title, state = excluded.state, draft = excluded.draft,
         head_ref = excluded.head_ref, base_ref = excluded.base_ref, url = excluded.url,
         updated_at = excluded.updated_at, merged_at = excluded.merged_at, closed_at = excluded.closed_at,
         summary = excluded.summary, body = excluded.body, synced_at = ${NOW}`,
        [projectId, p.repo, p.number, p.title, p.state, p.draft, p.headRef, p.baseRef, p.url, p.author,
          p.createdAt, p.updatedAt, p.mergedAt, p.closedAt, p.summary, p.body]
      );
    },

    /** A project's open PRs with a head branch: {number, head_ref, updated_at}. */
    async openPrBranches(projectId: number | string) {
      return db.rows(
        `select number, head_ref, updated_at from repo_pr where project_id = $1 and state = 'open' and head_ref is not null`,
        [projectId]
      );
    },

    /** Each project's newest `perProject` PRs, newest first overall. */
    async recentPrs(projectIds: unknown[], perProject: number) {
      const rows = await db.rows(
        `select * from (
           select project_id, repo, number, title, state, draft, head_ref, url, summary, created_at, updated_at, merged_at, closed_at,
                  row_number() over (partition by project_id order by updated_at desc nulls last) as rn
             from repo_pr where project_id in (select value from json_each($1))) x
          where rn <= $2 order by updated_at desc`,
        [(projectIds || []).map(Number), perProject]
      );
      for (const r of rows) {
        for (const k of ['created_at', 'updated_at', 'merged_at', 'closed_at']) r[k] = toDate(r[k]);
        if (typeof r.draft === 'number') r.draft = Boolean(r.draft);
      }
      return rows;
    },

    /** A project's PRs, newest first, at most 200. */
    async prsOf(projectId: number | string) {
      return db.rows(
        `select project_id, repo, number, title, state, draft, head_ref, url, summary, created_at, updated_at, merged_at, closed_at
       from repo_pr where project_id = $1 order by updated_at desc nulls last limit 200`,
        [projectId]
      );
    },
    /** A repo's default delivery level: {delivery}, or null. */
    async deliveryOf(repo: unknown) {
      return db.one('select delivery from repo_delivery where repo = $1', [repo]);
    },

    /** Sets a repo's default delivery level. */
    async setDelivery(repo: unknown, delivery: string) {
      await db.query(
        `insert into repo_delivery (repo, delivery) values ($1, $2)
     on conflict (repo) do update set delivery = excluded.delivery, updated_at = ${NOW}`,
        [repo, delivery]
      );
    },

    /** Clears a repo's default. Resolves whether it had one. */
    async clearDelivery(repo: unknown) {
      const r = await db.query('delete from repo_delivery where repo = $1', [repo]);
      return (r.rowCount || 0) > 0;
    },

    /** Every repo's default: {repo, delivery, updated_at}, by repo. */
    async deliveries() {
      return db.rows('select repo, delivery, updated_at from repo_delivery order by repo');
    },
  };
}

module.exports = { create, ROW_COLUMNS };
