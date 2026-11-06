-- The repo registry: `project` becomes the source of truth for every repo you
-- work in, not only the ones cloned under the repos root.
--
-- Extended in place rather than a parallel `repo` table: commitments, runs,
-- memory claims and aliases already point at project.id, and the resolver
-- (src/projects/resolve.js) already resolves against project + project_alias.
-- A second table would need a join key kept in step with this one forever.
--
-- What the columns hold (src/repos/ writes them; `pa repos` reads them):
--
--   forge          github | gitlab | null (local-only, or seen only in sessions)
--   remote_urls    every remote URL seen for it (origin of each clone)
--   local_paths    {"<machine>": ["<dir>", ...]} — this machine's clones and
--                  the dirs Claude sessions ran in on PA_MACHINES
--   default_branch the remote's HEAD, when a clone says so
--   description    one or two sentences: what the repo is
--   profile        {kind, stack[], owner, related[], ravenDoc} — the rest of
--                  "what it is", from raven, the README and manifests
--   profile_source raven | model | manual — where the description came from
--   profile_hash   hash of the material the profile was made from; a model
--                  pass runs again only when it changes (a new README)
--   manual         your edits (`pa repos set`): description, owner, stack,
--                  related, kind, pinned. Sync never writes here, and every
--                  reader lays it over the synced values — manual wins.
--   hidden         `pa repos hide`: left off the Repos tab (still a project
--                  the resolver can link to)
--   origin         what first put it here: local | github | session | manual
--   branches       recent branches: [{name, at, mine, current, machine, source}]
--   last_pr_at / last_commit_at / last_session_at, pr_count, session_count:
--                  your activity in it, from PRs, commits and Claude sessions
--
-- repo_pr: your pull requests, one row per PR, refreshed by `pa repos sync`.
-- `summary` is read from the PR body (no model call); null when it has none.
--
-- Additive only: every statement is `if not exists`, every new column has a
-- default or is nullable, so the running worker's queries are unaffected.

alter table project add column if not exists forge           text;
alter table project add column if not exists remote_urls     text[] not null default '{}';
alter table project add column if not exists local_paths     jsonb  not null default '{}';
alter table project add column if not exists default_branch  text;
alter table project add column if not exists description     text;
alter table project add column if not exists profile         jsonb  not null default '{}';
alter table project add column if not exists profile_source  text;
alter table project add column if not exists profile_hash    text;
alter table project add column if not exists profiled_at     timestamptz;
alter table project add column if not exists manual          jsonb  not null default '{}';
alter table project add column if not exists hidden          boolean not null default false;
alter table project add column if not exists origin          text;
alter table project add column if not exists branches        jsonb  not null default '[]';
alter table project add column if not exists last_pr_at      timestamptz;
alter table project add column if not exists last_commit_at  timestamptz;
alter table project add column if not exists last_session_at timestamptz;
alter table project add column if not exists pr_count        integer not null default 0;
alter table project add column if not exists session_count   integer not null default 0;
alter table project add column if not exists synced_at       timestamptz;

create table if not exists repo_pr (
  id          bigserial primary key,
  project_id  bigint references project(id) on delete set null,
  forge       text   not null default 'github',
  repo        text   not null,              -- owner/name as the forge spells it
  number      integer not null,
  title       text   not null,
  state       text   not null,              -- open | merged | closed
  draft       boolean not null default false,
  head_ref    text,
  base_ref    text,
  url         text,
  author      text,
  created_at  timestamptz,
  updated_at  timestamptz,
  merged_at   timestamptz,
  closed_at   timestamptz,
  summary     text,
  body        text,
  synced_at   timestamptz not null default now(),
  unique (forge, repo, number)
);

create index if not exists repo_pr_project_idx on repo_pr (project_id, updated_at desc);
