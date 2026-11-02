-- Factory job idempotency that survives a second PA install, and one live
-- run per commitment.
--
--   pa_install       one row: this install's id (a UUID), made on first use
--                    by src/dispatch/factory.js installId(). A factory job's
--                    external id is `<install id>-<run id>`: two PA stores (a
--                    restore next to a live one, a second machine) can never
--                    collide on a bare run id and be handed each other's jobs.
--   run.external_id  the key a run's job was submitted with; null on runs
--                    from before this file (they matched on the bare run id).
--
-- One live run per commitment is enforced in code under a transaction-scoped
-- advisory lock (dispatch/runRow.js insertRun), not by a unique index:
-- `pa do --again` deliberately starts a second one.

create table if not exists pa_install (
  id          text primary key,
  created_at  timestamptz not null default now()
);

alter table run add column if not exists external_id text;
create unique index if not exists run_external_id_idx on run (external_id) where external_id is not null;
