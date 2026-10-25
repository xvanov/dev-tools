-- Durable tasks: Absurd (https://github.com/earendil-works/absurd, Apache-2.0),
-- pinned at 0.5.0 to match absurd-sdk 0.5.0 in package.json (DURABLE.md §2.3).
--
-- The schema is vendored unchanged in vendor/absurd/absurd.sql with its
-- licence; this migration applies it and creates the one queue the assistant
-- uses. Absurd keeps everything in the `absurd` schema: tasks, runs,
-- checkpoints, events and waits — nothing of ours lives there, and nothing of
-- theirs is edited. Upgrading Absurd is a new migration applying its
-- upstream migration file, never an edit to this one.
--
-- Why a runtime at all, when PLAN.md chose "no queue — work to do is a query":
-- an anti-join finds unprocessed rows, but it cannot wait. "Chase them in two
-- days unless they reply" and "open the PR once the run ends and you approve"
-- need a durable timer and an event a task can sleep on across restarts.

-- include: ../vendor/absurd/absurd.sql

select absurd.create_queue('pa');
