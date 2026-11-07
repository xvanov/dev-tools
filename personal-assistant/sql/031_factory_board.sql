-- The factory as the dispatcher of every kind of work (JOBS-API v1.2).
--
--   run.job_kind        code | research | report — what the factory job was
--                       asked to deliver. Not run.kind, which is the planner's
--                       kind for the commitment ('coding', …).
--   run.runtime         api | claude_session — who did the agent work: the
--                       factory's metered model routing, or Claude Code on the
--                       operator's subscription.
--   run.subscription_equiv_usd  what a claude_session job would have cost at
--                       API prices (run.cost_usd stays metered spend only).
--
--   factory_board       one row: the worker's latest `factory job list --json`
--                       (src/dispatch/factory.js refreshBoard), so the
--                       dashboard's /factory page and `pa factory jobs` read
--                       it instead of calling the factory on every request.

alter table run add column if not exists job_kind text;
alter table run add column if not exists runtime text;
alter table run add column if not exists subscription_equiv_usd numeric;

create table if not exists factory_board (
  id          int primary key default 1 check (id = 1),
  jobs        jsonb not null default '[]'::jsonb,
  polled_at   timestamptz,
  error       text,
  error_at    timestamptz
);
