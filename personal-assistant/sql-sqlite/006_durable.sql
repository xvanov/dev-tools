-- Durable tasks on SQLite (plan 3.1, D19). Postgres runs them on Absurd
-- (sql/019, a vendored schema); SQLite has a small queue of our own with the
-- same contract, driven by src/durable/sqliteQueue.js through
-- src/repo/sqlite/durable.js:
--
-- durable_task        one task: its handler name, params and idempotency key
--                     (unique per queue: a second spawn with the key is the
--                     same task), where it is (pending, running, sleeping,
--                     completed, failed, cancelled), when it may run next,
--                     the event it waits for, its attempts and result.
-- durable_checkpoint  a step's saved result (ctx.step), a sleep's wake time
--                     and an event wait's deadline, so a task that resumes
--                     after a sleep, a crash or a retry skips what it did.
-- durable_event       an emitted event: the first emit wins and is kept, so a
--                     task that starts waiting after it still gets it.
--
-- Who is running a task right now is a row in `lease` (space 'durable:<queue>',
-- name = task id), held by the worker's session: a worker that dies frees its
-- tasks, and the next poll resumes them from their checkpoints.

create table durable_task (
  id               integer primary key autoincrement,
  queue            text not null,
  task_name        text not null,
  params           jsonb not null default '{}',
  idempotency_key  text,
  state            text not null default 'pending'
                   check (state in ('pending', 'running', 'sleeping', 'completed', 'failed', 'cancelled')),
  run_at           timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  wait_event       text,
  attempts         integer not null default 0,
  max_attempts     integer not null default 5,
  result           jsonb,
  error            text,
  created_at       timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (queue, idempotency_key)
);
create index durable_task_due on durable_task (queue, state, run_at);
create index durable_task_waiting on durable_task (queue, wait_event) where wait_event is not null;

create table durable_checkpoint (
  task_id     integer not null references durable_task(id) on delete cascade,
  name        text not null,
  value       jsonb,
  saved_at    timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (task_id, name)
);

create table durable_event (
  queue       text not null,
  name        text not null,
  payload     jsonb,
  emitted_at  timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (queue, name)
);
