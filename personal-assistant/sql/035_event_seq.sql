-- A global number on every live-feed event (plan item Z6; src/events/bus.js).
--
-- Each worker generation LISTENs to `pa_events` on its own connection and
-- numbered what it heard by itself, so a page reconnecting after a roll (the
-- supervisor closes its stream on drain) sent the previous generation's
-- Last-Event-ID and the next one could not place it: a resync, and anything
-- published in between was gone. With `seq` from one sequence in the payload,
-- both generations call the same event `g<seq>` and the next one replays from
-- it. Additive (expand): older code ignores the extra key.

create sequence if not exists pa_event_seq;

create or replace function pa_notify_event() returns trigger
language plpgsql as $$
declare
  r     jsonb;
  body  jsonb;
  i     int;
begin
  r := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  body := jsonb_build_object('topic', tg_argv[0], 'table', tg_table_name, 'op', lower(tg_op), 'id', r -> 'id',
                             'seq', nextval('pa_event_seq'));
  if tg_nargs > 1 then
    for i in 1 .. tg_nargs - 1 loop
      body := body || jsonb_build_object(tg_argv[i], r -> tg_argv[i]);
    end loop;
  end if;
  perform pg_notify('pa_events', body::text);
  return null;
end
$$;
