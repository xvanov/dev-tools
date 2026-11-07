-- What people owe you, read as "does it block me?" (src/commitments/blocks.js).
--
-- The board is a to-do list: your tasks, nothing else. Something another
-- person owes you only matters when you need it to do your own work, so each
-- open owed_to_me commitment gets one row here:
--
--   verdict   'blocks'    you need it: it shows as "Blocked on <them>" on the
--                         task it holds up (task_id), or, with no task of
--                         yours to hang it on, as its own card on On me
--             'not_mine'  their work, not yours: not on the board
--   task_id   the owed_by_me commitment it holds up, when there is one
--   why       one line: what you need from them, and for what
--   manual    you set it on the card; the pass never changes a manual row
--   judged_at when the pass (or you) last decided; a task added after it
--             makes the pass look again, since the new task may be the one
--             it blocks
--
-- Unblocked is not stored: the blocker closing (they delivered, or the
-- reconciler saw it done) is the signal, and the board shows the task as
-- unblocked for a few days after.

create table if not exists commitment_block (
  blocker_id bigint primary key references commitment(id) on delete cascade,
  task_id    bigint references commitment(id) on delete set null,
  verdict    text not null check (verdict in ('blocks', 'not_mine')),
  why        text,
  manual     boolean not null default false,
  judged_at  timestamptz not null default now()
);

create index if not exists commitment_block_task_idx on commitment_block (task_id) where task_id is not null;
