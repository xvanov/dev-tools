-- Trace spans for Meter (plan item 7.5; src/telemetry, src/repo/telemetry.js).
--
-- One row per finished span of a main hop: a voice turn, a chat tool call, a
-- factory job hop, a deploy. OpenTelemetry's API is the instrument in the PA's
-- own processes; a local exporter (src/telemetry/exporter.js) writes the spans
-- here, and the Python factory posts its own to POST /api/telemetry. No cloud
-- collector. The Meter page reads p50/p95 per `hop` from this table.
--
-- `hop` is the bounded vocabulary (voice.turn, tool.call, factory.<persona>,
-- deploy, ...) that Meter groups by; `name` is the specific span (the tool's
-- name). `attrs` holds small scalar attributes only: ids, counts, states. No
-- prompt, reply or tool-argument text is stored here, ever.
--
-- Rows older than PA_TELEMETRY_RETENTION_DAYS (default 30) are deleted by the
-- worker's retention pass.
--
-- Additive (expand): a new table; older code ignores it.

create table if not exists trace_span (
  id              bigserial primary key,
  trace_id        text        not null,
  span_id         text        not null,
  parent_span_id  text,
  hop             text        not null,
  name            text        not null,
  source          text        not null default 'pa',   -- pa | factory
  started_at      timestamptz not null,
  duration_ms     integer     not null,
  ok              boolean     not null,
  attrs           jsonb
);

create index if not exists trace_span_hop_idx on trace_span (hop, started_at desc);
create index if not exists trace_span_started_idx on trace_span (started_at desc);
