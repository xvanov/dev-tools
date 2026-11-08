-- The live feed's outbox (plan 1.4 on SQLite; Postgres: sql/034-036) and the
-- leases that replace advisory locks.
--
-- event_outbox: the triggers below write one row per change to a row a view
-- shows, in the writer's own transaction, under the next number of
-- pa_event_seq (a one-row counter: SQLite has no sequences). The payload is
-- what sql/036 stores: {table, op, id, seq, <the topic's columns>} (the topic
-- is a column); commitment_block has no id column, so its id is null, as in
-- Postgres. Every 1000th event deletes rows older than 3 days. Unlike a pg
-- sequence, a rolled-back change does not use up a number.
--
-- There is no NOTIFY: after a commit, src/db/sqlite.js reads the new outbox
-- rows and hands them to the sessions that LISTENed (in this process).
--
-- lease: an advisory lock as a row (src/repo/sqlite/leases.js). `space` is
-- 'lock' for pg_advisory_lock(key) and 'pass:<space>' for
-- pg_advisory_lock(space, hashtext(name)); `holder` is the session
-- (pid:nonce) that took it, `depth` how many times (re-entrant, as pg). A
-- lock whose holder is gone (session released, process dead) is free.

create table pa_event_seq (
  id          integer primary key check (id = 1),
  last_value  integer not null
);
insert into pa_event_seq (id, last_value) values (1, 0);

create table lease (
  space       text not null,
  name        text not null,
  holder      text not null,
  depth       integer not null default 1,
  taken_at    timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (space, name)
);
create index lease_holder_idx on lease (holder);

-- Topics and columns as sql/034:
--   board    commitment (status), proposal (status, kind, commitment_id, run_id),
--            draft (status, commitment_id), ledger_evidence, commitment_block,
--            secret_request (status), notification (insert and update only)
--   run      run (status, factory_job_id, factory_state, termhub_session_id, commitment_id)
--   factory  factory_board: inserts, and updates that change jobs or error
--   routine  routine (status), routine_run
create trigger pa_events_commitment_insert after insert on commitment
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'commitment', 'op', 'insert', 'id', new.id, 'seq', last_value, 'status', new.status) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_commitment_update after update on commitment
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'commitment', 'op', 'update', 'id', new.id, 'seq', last_value, 'status', new.status) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_commitment_delete after delete on commitment
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'commitment', 'op', 'delete', 'id', old.id, 'seq', last_value, 'status', old.status) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;

create trigger pa_events_proposal_insert after insert on proposal
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'proposal', 'op', 'insert', 'id', new.id, 'seq', last_value, 'status', new.status, 'kind', new.kind, 'commitment_id', new.commitment_id, 'run_id', new.run_id) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_proposal_update after update on proposal
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'proposal', 'op', 'update', 'id', new.id, 'seq', last_value, 'status', new.status, 'kind', new.kind, 'commitment_id', new.commitment_id, 'run_id', new.run_id) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_proposal_delete after delete on proposal
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'proposal', 'op', 'delete', 'id', old.id, 'seq', last_value, 'status', old.status, 'kind', old.kind, 'commitment_id', old.commitment_id, 'run_id', old.run_id) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;

create trigger pa_events_draft_insert after insert on draft
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'draft', 'op', 'insert', 'id', new.id, 'seq', last_value, 'status', new.status, 'commitment_id', new.commitment_id) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_draft_update after update on draft
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'draft', 'op', 'update', 'id', new.id, 'seq', last_value, 'status', new.status, 'commitment_id', new.commitment_id) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_draft_delete after delete on draft
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'draft', 'op', 'delete', 'id', old.id, 'seq', last_value, 'status', old.status, 'commitment_id', old.commitment_id) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;

create trigger pa_events_ledger_evidence_insert after insert on ledger_evidence
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'ledger_evidence', 'op', 'insert', 'id', new.id, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_ledger_evidence_update after update on ledger_evidence
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'ledger_evidence', 'op', 'update', 'id', new.id, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_ledger_evidence_delete after delete on ledger_evidence
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'ledger_evidence', 'op', 'delete', 'id', old.id, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;

create trigger pa_events_commitment_block_insert after insert on commitment_block
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'commitment_block', 'op', 'insert', 'id', null, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_commitment_block_update after update on commitment_block
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'commitment_block', 'op', 'update', 'id', null, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_commitment_block_delete after delete on commitment_block
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'commitment_block', 'op', 'delete', 'id', null, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;

create trigger pa_events_secret_request_insert after insert on secret_request
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'secret_request', 'op', 'insert', 'id', new.id, 'seq', last_value, 'status', new.status) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_secret_request_update after update on secret_request
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'secret_request', 'op', 'update', 'id', new.id, 'seq', last_value, 'status', new.status) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_secret_request_delete after delete on secret_request
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'secret_request', 'op', 'delete', 'id', old.id, 'seq', last_value, 'status', old.status) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;

create trigger pa_events_notification_insert after insert on notification
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'notification', 'op', 'insert', 'id', new.id, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_notification_update after update on notification
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'board', json_object('table', 'notification', 'op', 'update', 'id', new.id, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;

create trigger pa_events_run_insert after insert on run
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'run', json_object('table', 'run', 'op', 'insert', 'id', new.id, 'seq', last_value, 'status', new.status, 'factory_job_id', new.factory_job_id, 'factory_state', new.factory_state, 'termhub_session_id', new.termhub_session_id, 'commitment_id', new.commitment_id) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_run_update after update on run
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'run', json_object('table', 'run', 'op', 'update', 'id', new.id, 'seq', last_value, 'status', new.status, 'factory_job_id', new.factory_job_id, 'factory_state', new.factory_state, 'termhub_session_id', new.termhub_session_id, 'commitment_id', new.commitment_id) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_run_delete after delete on run
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'run', json_object('table', 'run', 'op', 'delete', 'id', old.id, 'seq', last_value, 'status', old.status, 'factory_job_id', old.factory_job_id, 'factory_state', old.factory_state, 'termhub_session_id', old.termhub_session_id, 'commitment_id', old.commitment_id) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;

create trigger pa_events_factory_board_insert after insert on factory_board
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'factory', json_object('table', 'factory_board', 'op', 'insert', 'id', new.id, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_factory_board_update after update on factory_board
  when old.jobs is not new.jobs or old.error is not new.error
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'factory', json_object('table', 'factory_board', 'op', 'update', 'id', new.id, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;

create trigger pa_events_routine_insert after insert on routine
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'routine', json_object('table', 'routine', 'op', 'insert', 'id', new.id, 'seq', last_value, 'status', new.status) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_routine_update after update on routine
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'routine', json_object('table', 'routine', 'op', 'update', 'id', new.id, 'seq', last_value, 'status', new.status) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_routine_delete after delete on routine
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'routine', json_object('table', 'routine', 'op', 'delete', 'id', old.id, 'seq', last_value, 'status', old.status) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;

create trigger pa_events_routine_run_insert after insert on routine_run
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'routine', json_object('table', 'routine_run', 'op', 'insert', 'id', new.id, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_routine_run_update after update on routine_run
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'routine', json_object('table', 'routine_run', 'op', 'update', 'id', new.id, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
create trigger pa_events_routine_run_delete after delete on routine_run
begin
  update pa_event_seq set last_value = last_value + 1 where id = 1;
  insert into event_outbox (seq, topic, payload)
    select last_value, 'routine', json_object('table', 'routine_run', 'op', 'delete', 'id', old.id, 'seq', last_value) from pa_event_seq where id = 1;
  delete from event_outbox where (select last_value % 1000 from pa_event_seq where id = 1) = 0
    and at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days');
end;
