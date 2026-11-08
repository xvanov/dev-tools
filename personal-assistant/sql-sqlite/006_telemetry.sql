-- Twin of sql/039_telemetry.sql (plan 7.5, trace spans for Meter). Same
-- columns; see that file for what they hold.

create table trace_span (
  id              integer primary key autoincrement,
  trace_id        text        not null,
  span_id         text        not null,
  parent_span_id  text,
  hop             text        not null,
  name            text        not null,
  source          text        not null default 'pa',
  started_at      timestamptz not null,
  duration_ms     integer     not null,
  ok              boolean     not null,
  attrs           jsonb
);

create index trace_span_hop_idx on trace_span (hop, started_at desc);
create index trace_span_started_idx on trace_span (started_at desc);
