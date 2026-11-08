-- E1 (docs/native/PLAN.md): one id chain, card -> run -> job -> step -> session -> PR,
-- stored as links rather than read off titles. Additive only (Track Z3): no
-- existing column changes meaning; run.mr_url stays the first PR.
--
--   run_pr     every PR a run's factory job opened, with its last known state and
--              CI (JOBS-API stories[].pr_number/pr_url/pr_state/ci), one row per
--              PR. Written by the worker's factory pass (src/dispatch/factory.js
--              recordChain) on every `job list/status` it reads.
--   run_step   every agent step of a run's job (JOBS-API runs[]: the factory's
--              runs.id) and the live session that shows it, when it has one:
--              machine, termhub session id and URL. An API-runtime step has no
--              session until plan E2 gives it one; the columns are the same then.
--              termhub_session_id is indexed: Run -> step -> job -> card goes
--              through it.

create table if not exists run_pr (
  run_id      bigint not null references run(id) on delete cascade,
  url         text not null,
  number      int,
  story_id    bigint,
  state       text,          -- open | merged | closed | null (not known)
  ci_state    text,          -- passing | failing | pending | none | null
  ci_failing  jsonb,
  updated_at  timestamptz not null default now(),
  primary key (run_id, url)
);

create table if not exists run_step (
  run_id              bigint not null references run(id) on delete cascade,
  step_id             text not null,
  job_id              text,
  story_id            bigint,
  persona             text,
  runtime             text,
  model               text,
  state               text,  -- running | ok | failed
  started_at          timestamptz,
  ended_at            timestamptz,
  machine             text,
  termhub_session_id  text,
  url                 text,
  updated_at          timestamptz not null default now(),
  primary key (run_id, step_id)
);

create index if not exists run_step_session_idx on run_step (termhub_session_id) where termhub_session_id is not null;
