-- The turn log: what was said to Jarvis and what it answered (src/chat/turnLog.ts).
-- The Postgres twin is sql/046.
--
--   turn_log   one row per thing said to Jarvis: the words (text), where they
--              came from (channel voice|typed|doorbell), how the fast lane
--              routed them (the snapshot and last turns it saw as context and
--              history, router, route, p and signals as JSON text, reason,
--              overridden, fell_back, decision_ms), what it said itself
--              (fast_say, fast_model, first_token_ms, fast_ms), whether it went
--              to the PA chat (handed_off, handoff_error), and the PA chat's
--              answer (reply, tools as a JSON array of tool names, reply_ms,
--              chat_turns, chat_cost_usd). status open|done|error; error.
--
-- Times are ISO-8601 text written by the app and flags are 0/1, so both
-- dialects store alike. Rows older than PA_TURN_LOG_DAYS are deleted
-- (src/chat/turnLog.ts).

create table if not exists turn_log (
  id              integer primary key autoincrement,
  at              text not null,
  channel         text not null,
  text            text not null,
  context         text,
  history         text,
  router          text,
  route           text,
  p               text,
  signals         text,
  reason          text,
  overridden      integer not null default 0,
  fell_back       integer not null default 0,
  decision_ms     integer,
  fast_say        text,
  fast_model      text,
  first_token_ms  integer,
  fast_ms         integer,
  handed_off      integer not null default 0,
  handoff_error   text,
  reply           text,
  tools           text,
  reply_ms        integer,
  chat_turns      integer,
  chat_cost_usd   numeric,
  status          text not null default 'open',
  error           text,
  ended_at        text
);
create index if not exists turn_log_at_idx on turn_log (at);
