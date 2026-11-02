-- The end state the operator chose for a piece of work, and the per-repo
-- default used when they did not say (src/dispatch/deliveryCore.js).
--
-- Delivery levels are the factory's vocabulary (software-factory
-- docs/JOBS-API.md): none < branch < draft_pr < pr < auto_merge < push_to_main.
-- There is no ceiling (operator decision 2026-11-02): the operator's choice is
-- what is sent, on every factory job, and what the PA itself does when a
-- Claude session ends.
--
--   repo_delivery      one row per repo (owner/name, lowercased): the level a
--                      job or run in that repo gets when the operator said
--                      nothing about it. `pa delivery set|list|clear`.
--   run.delivery_source  where the run's level came from: explicit | mode |
--                      inferred (the operator's own words) | repo_default | fallback
--   run.brief_by       who wrote the factory ask: compose:<model> (a model
--                      selected what the task needs, src/dispatch/compose.js)
--                      or compose:fallback (deterministic, no private material)
--
-- run.delivery (sql/024) now also holds a Claude session's chosen level;
-- null on a run from before this file keeps the old end-of-run behaviour.

create table if not exists repo_delivery (
  repo        text primary key,
  delivery    text not null,
  updated_at  timestamptz not null default now()
);

alter table run add column if not exists delivery_source text;
alter table run add column if not exists brief_by        text;
