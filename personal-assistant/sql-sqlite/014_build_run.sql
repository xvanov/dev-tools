-- Build is one Claude Code agent per task (PLAN.md D30), tracked here.
--
--   build_run   one agent run: the task, the model, where it works (worktree,
--               branch), its termhub session and Claude session id, its state
--               (starting|running|waiting|done|failed|stopped), the result
--               line it ended with, its caps and what it has spent. `track` is
--               the transcript tailer's latest view (agents, subagents, tool
--               calls) as JSON text, replaced whole on every tick.
--   build_msg   what the agent and Jarvis say to each other: note, ask, done
--               from the agent; reply, send from Jarvis. An ask carries its
--               answer, so `pa run ask` can poll one row.
--
-- Times are ISO-8601 text written by the app, so both dialects store alike.

create table if not exists build_run (
  id              integer primary key autoincrement,
  commitment_id   integer,
  task            text not null,
  model           text not null default 'sonnet',
  repo_path       text,
  worktree_path   text,
  branch          text,
  cwd             text,
  machine         text,
  session_id      text,
  claude_session  text,
  transcript_path text,
  state           text not null default 'starting',
  result          text,
  error           text,
  cost_cap_usd    real not null default 5,
  wall_cap_min    integer not null default 120,
  cost_usd        real not null default 0,
  tokens_in       integer not null default 0,
  tokens_out      integer not null default 0,
  tokens_cache_read  integer not null default 0,
  tokens_cache_write integer not null default 0,
  track           text,
  started_at      text not null,
  ended_at        text,
  updated_at      text not null
);
create index if not exists build_run_state_idx on build_run (state, id);

create table if not exists build_msg (
  id          integer primary key autoincrement,
  run_id      integer not null,
  dir         text not null,
  kind        text not null,
  body        text not null,
  answer      text,
  answered_at text,
  created_at  text not null
);
create index if not exists build_msg_run_idx on build_msg (run_id, id);
