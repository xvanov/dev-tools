-- The live feed (plan item 0.4; src/events): every change to a row a view
-- shows sends one NOTIFY on `pa_events` at commit, whichever process made it
-- (the worker, `pa`, the MCP server, the previous worker generation during a
-- roll). The worker's dashboard LISTENs and streams it as GET /api/events.
--
-- The payload is {topic, table, op, id, <the columns named after the topic>}:
-- ids and states only, never content (NOTIFY payloads are capped at 8000
-- bytes, and a page reads what changed through its own API). Item 1.4 turns
-- this into an outbox table the same triggers insert into.
--
--   topic board    commitment (status), proposal (status, kind), draft
--                  (status), ledger_evidence, commitment_block,
--                  secret_request (status), notification
--   topic run      run (status, factory_job_id, factory_state,
--                  termhub_session_id, commitment_id)
--   topic factory  factory_board, only when the job list or its error changed
--                  (the worker rewrites polled_at on every pass)
--   topic routine  routine (status), routine_run

create or replace function pa_notify_event() returns trigger
language plpgsql as $$
declare
  r     jsonb;
  body  jsonb;
  i     int;
begin
  r := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  body := jsonb_build_object('topic', tg_argv[0], 'table', tg_table_name, 'op', lower(tg_op), 'id', r -> 'id');
  if tg_nargs > 1 then
    for i in 1 .. tg_nargs - 1 loop
      body := body || jsonb_build_object(tg_argv[i], r -> tg_argv[i]);
    end loop;
  end if;
  perform pg_notify('pa_events', body::text);
  return null;
end
$$;

create or replace trigger pa_events after insert or update or delete on commitment
  for each row execute function pa_notify_event('board', 'status');

create or replace trigger pa_events after insert or update or delete on proposal
  for each row execute function pa_notify_event('board', 'status', 'kind', 'commitment_id', 'run_id');

create or replace trigger pa_events after insert or update or delete on draft
  for each row execute function pa_notify_event('board', 'status', 'commitment_id');

create or replace trigger pa_events after insert or update or delete on ledger_evidence
  for each row execute function pa_notify_event('board');

create or replace trigger pa_events after insert or update or delete on commitment_block
  for each row execute function pa_notify_event('board');

create or replace trigger pa_events after insert or update or delete on secret_request
  for each row execute function pa_notify_event('board', 'status');

create or replace trigger pa_events after insert or update on notification
  for each row execute function pa_notify_event('board');

create or replace trigger pa_events after insert or update or delete on run
  for each row execute function pa_notify_event('run', 'status', 'factory_job_id', 'factory_state', 'termhub_session_id', 'commitment_id');

create or replace trigger pa_events after update on factory_board
  for each row when (old.jobs is distinct from new.jobs or old.error is distinct from new.error)
  execute function pa_notify_event('factory');
create or replace trigger pa_events_insert after insert on factory_board
  for each row execute function pa_notify_event('factory');

create or replace trigger pa_events after insert or update or delete on routine
  for each row execute function pa_notify_event('routine', 'status');

create or replace trigger pa_events after insert or update or delete on routine_run
  for each row execute function pa_notify_event('routine');
