-- Profile eval (docs/native/BUILD-ENRICHMENT.md, F; src/eval/buildEval.ts). The SQLite twin is sql-sqlite/022.
--
--   build_run.base_sha   the commit a run's worktree started from (set when the worktree is made, kept in
--                        summary.json), so `pa eval build` can replay the task from the same tree later.
--   build_eval_trial     one replay: a finished Build run (run_id) re-run headless on a profile (or a
--                        model:effort pair) in a throwaway worktree at base_sha, and what it scored: the repo's
--                        tests, the diff against the base, cost/tokens/turns from claude's JSON result, wall
--                        time, and the original run's outcome and human verdict when known. `eval_id` groups the
--                        trials of one `pa eval build` launch. `passed` is 1/0 (null for a trial that could not
--                        be scored: a code task with no test command); `status` is ok|capped|failed|timeout, with
--                        `reason` for the last three.
--
-- Times are ISO-8601 text written by the app.

alter table build_run add column if not exists base_sha text;

create table if not exists build_eval_trial (
  id               serial primary key,
  eval_id          text not null,
  run_id           integer not null,
  profile          text not null,
  model            text,
  effort           text,
  kind             text,
  status           text not null,
  reason           text,
  passed           integer,
  tests            text,
  tests_note       text,
  files_changed    integer,
  lines_added      integer,
  lines_removed    integer,
  cost_usd         double precision,
  tokens_in        bigint,
  tokens_out       bigint,
  turns            integer,
  wall_s           double precision,
  original_state   text,
  original_verdict text,
  repo_path        text,
  base_sha         text,
  created_at       text not null
);
create index if not exists build_eval_trial_eval_idx on build_eval_trial (eval_id, id);
