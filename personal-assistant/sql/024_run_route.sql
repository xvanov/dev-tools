-- A run's route, and what came of it.
--
-- A commitment can now go two ways (src/dispatch/routeCore.js): a Claude Code
-- session in its own worktree (`claude`, everything before this), or a job in
-- the software factory (`factory`, src/dispatch/factory.js — contract:
-- software-factory docs/JOBS-API.md). These columns make "which route works
-- for which task" a query rather than an impression (`pa runs stats`):
--
--   route          claude | factory
--   route_reason   why that route: the routing rule's sentence, or "you chose it"
--   kind           the commitment's kind (the planner's) when it was dispatched
--   pipeline       factory: chain | solo | auto
--   delivery       factory: the EFFECTIVE delivery level the factory reported
--                  (requested, clamped to the app's ceiling)
--   delivery_requested  factory: what the PA mode mapped to
--   models         factory: per-persona model overrides sent with the job
--   factory_job_id factory: `<app>:<direction_id>`
--   factory_state  factory: the job's last reported state
--   factory_warnings factory: the `warnings` list `job submit` returned
--   cost_usd       factory: the job's reported spend (Claude sessions: unknown)
--   outcome        delivered | merged | failed | dropped; null while going
--   outcome_at     when outcome was last set
--
-- The ledger actor `factory` (a factory job finishing or failing moves its
-- commitment through src/ledger like every other closer) is new with this
-- file; the column is free text, so there is nothing to alter for it.

alter table run add column if not exists route              text not null default 'claude';
alter table run add column if not exists route_reason       text;
alter table run add column if not exists kind               text;
alter table run add column if not exists pipeline           text;
alter table run add column if not exists delivery           text;
alter table run add column if not exists delivery_requested text;
alter table run add column if not exists models             jsonb;
alter table run add column if not exists factory_job_id     text;
alter table run add column if not exists factory_state      text;
alter table run add column if not exists factory_warnings   jsonb;
alter table run add column if not exists cost_usd           numeric(12,4);
alter table run add column if not exists outcome            text;
alter table run add column if not exists outcome_at         timestamptz;

-- One run per job: a job is submitted with the run id as its external id.
create unique index if not exists run_factory_job_idx on run (factory_job_id) where factory_job_id is not null;
create index if not exists run_route_idx on run (route, started_at desc);

-- What the old rows already say.
update run set outcome = case status when 'landed' then 'delivered' when 'dropped' then 'dropped' when 'failed' then 'failed' end,
               outcome_at = coalesce(ended_at, started_at)
 where outcome is null and status in ('landed', 'dropped', 'failed');
update run r set kind = c.kind from commitment c where r.kind is null and c.id = r.commitment_id and c.kind is not null;
