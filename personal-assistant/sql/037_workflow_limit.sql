-- Per-workflow cost ceilings the user has edited (plan item 8.1;
-- src/repo/workflowLimits.js, GET/POST /api/workflow-limits).
--
-- architecture.json's acceptance.cost.max_usd is the default; a row here
-- overrides it, and deleting the row resets to the default. One reader (the
-- API) hands the effective ceiling to the dashboard, the 8.2 e2e runner, the
-- 8.3 reviewers and Meter.
--
-- Additive (expand): a new table; nothing existing changes.

create table if not exists workflow_limit (
  workflow    text          primary key,
  max_usd     numeric(12,4) not null check (max_usd >= 0),
  updated_at  timestamptz   not null default now()
);
