-- The live feed's outbox (plan item 1.4; src/events, src/repo/events.js).
--
-- 034 sends one NOTIFY per change to a row a view shows, and 035 numbers them
-- from one sequence so every worker generation calls an event g<seq>. But a
-- NOTIFY is gone once sent: a page that reconnects to a worker that restarted
-- (or to a new generation that has not seen that id), or a listener that was
-- disconnected, could only resync. Now the same trigger also writes the event
-- to event_outbox under the same seq, in the writer's own transaction, so it
-- exists exactly when the change does. GET /api/events replays from it by
-- Last-Event-ID (g<seq>), and a listener that reconnects backfills from it.
-- NOTIFY stays the wake-up: the live path does not read the table.
--
-- Rows are ids and states, never content (as the NOTIFY payloads). Retention:
-- every 1000th event deletes rows older than 3 days, in the same trigger, so
-- no pass is needed. A client further behind than that resyncs.
--
-- Additive (expand): a new table, and the function replaced in place with the
-- same NOTIFY body; older code ignores the table.

create table if not exists event_outbox (
  seq      bigint      primary key,
  topic    text        not null,
  payload  jsonb       not null,
  at       timestamptz not null default now()
);

create index if not exists event_outbox_at on event_outbox (at);

create or replace function pa_notify_event() returns trigger
language plpgsql as $$
declare
  r     jsonb;
  body  jsonb;
  i     int;
  n     bigint;
begin
  r := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  n := nextval('pa_event_seq');
  body := jsonb_build_object('topic', tg_argv[0], 'table', tg_table_name, 'op', lower(tg_op), 'id', r -> 'id',
                             'seq', n);
  if tg_nargs > 1 then
    for i in 1 .. tg_nargs - 1 loop
      body := body || jsonb_build_object(tg_argv[i], r -> tg_argv[i]);
    end loop;
  end if;
  insert into event_outbox (seq, topic, payload) values (n, tg_argv[0], body - 'topic');
  if n % 1000 = 0 then
    delete from event_outbox where at < now() - interval '3 days';
  end if;
  perform pg_notify('pa_events', body::text);
  return null;
end
$$;
