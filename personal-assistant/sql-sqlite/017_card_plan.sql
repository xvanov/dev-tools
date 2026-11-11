-- A card plan: a set of card changes (edit, close, create) proposed together and
-- approved once (src/cardplans.ts). The Postgres twin is sql/045.
--
--   card_plan       the proposal: a title, the analysis summary (rationale), the
--                   links it came from (sources, JSON text), and its status
--                   (pending|applied|partly|discarded).
--   card_plan_item  one change: op edit|close|create; commitment_id for edit and
--                   close; fields (JSON text: title/details/due/project/note for
--                   an edit, title/details/due/project for a create); reason;
--                   enabled (the user can untick it); status
--                   pending|running|applied|skipped|failed with its error and result.
--
-- Times are ISO-8601 text written by the app, so both dialects store alike.

create table if not exists card_plan (
  id          integer primary key autoincrement,
  title       text not null,
  rationale   text,
  sources     text,
  status      text not null default 'pending',
  via         text,
  created_at  text not null,
  updated_at  text not null,
  applied_at  text
);
create index if not exists card_plan_status_idx on card_plan (status, id);

create table if not exists card_plan_item (
  id            integer primary key autoincrement,
  plan_id       integer not null,
  idx           integer not null,
  op            text not null,
  commitment_id integer,
  fields        text,
  reason        text,
  enabled       integer not null default 1,
  status        text not null default 'pending',
  error         text,
  result        text,
  applied_at    text
);
create index if not exists card_plan_item_plan_idx on card_plan_item (plan_id, idx);
