-- Build profiles (docs/native/BUILD-ENRICHMENT.md, A): a saved, named, specialised Build agent
-- (src/build/profiles.ts). The SQLite twin is sql-sqlite/019.
--
--   build_profile  name (the key), description; model (haiku|sonnet|opus|fable), effort
--                  (low|medium|high|xhigh|max), permission_mode (null = Build's default, bypass;
--                  `dontAsk` = read-only); prompt appended to src/build/agent-prompt.md; tools, subagents
--                  as JSON text (MCP servers / tool rules; subagent definitions written into the run's
--                  worktree as .claude/agents/*.md); subagent_model; the caps and a default repo. A
--                  null column falls through to the next layer (src/build/profiles.ts `resolve`).
--
-- build_run records which profile a run launched with, and the effort and permission mode it used.
-- Times are ISO-8601 text written by the app.

create table if not exists build_profile (
  name            text primary key,
  description     text not null default '',
  model           text,
  effort          text,
  permission_mode text,
  prompt          text not null default '',
  tools           text,
  subagents       text,
  subagent_model  text,
  cost_cap_usd    double precision,
  wall_cap_min    integer,
  idle_after_s    integer,
  repo_path       text,
  created_at      text not null,
  updated_at      text not null
);

alter table build_run add column if not exists profile text;
alter table build_run add column if not exists effort text;
alter table build_run add column if not exists permission_mode text;
