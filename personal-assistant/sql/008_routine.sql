-- Routines: recurring actions you define in plain words ("every weekday at 8
-- pull main on all repos"), and ones the assistant suggests from how you work.
--
-- A routine runs a *typed* action from src/routines/actions — never a shell
-- string — on a 5-field cron schedule read in local time. "Work to do" is a
-- query (`status = 'active' and next_run_at <= now()`), as everywhere else in
-- this tool: no queue, nothing to drain after a crash.
--
-- Suggestions are rows with status 'proposed'; only a human moves them to
-- 'active'. A 'rejected' row is kept so the same idea is never proposed again.

create table if not exists routine (
  id           bigserial primary key,
  title        text not null,
  description  text not null default '',        -- the user's words, or the suggestion's
  schedule     text not null,                   -- 5-field cron, local time
  action       text not null,                   -- a name in the action registry
  params       jsonb not null default '{}'::jsonb,
  enabled      boolean not null default false,
  origin       text not null default 'user' check (origin in ('user','suggested')),
  status       text not null default 'active'
               check (status in ('active','proposed','rejected','paused')),
  why          text,                            -- suggestions: one line, citing evidence
  evidence     jsonb not null default '[]'::jsonb, -- suggestions: ["claim:12","item:345"]
  last_run_at  timestamptz,
  next_run_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists routine_due_idx on routine (next_run_at) where status = 'active';

create table if not exists routine_run (
  id          bigserial primary key,
  routine_id  bigint not null references routine(id) on delete cascade,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  ok          boolean,
  dry_run     boolean not null default false,
  summary     text,
  detail      jsonb not null default '{}'::jsonb
);

create index if not exists routine_run_idx on routine_run (routine_id, started_at desc);
