-- What the assistant tells you without being asked: pre-meeting briefs,
-- routine results, suggestions, requests for a secret or a login.
--
-- One table, one feed in the dashboard, one Windows toast per row. `kind`
-- says which part of the assistant spoke; `dedupe_key` stops a pass that runs
-- every few minutes from announcing the same thing twice.

create table if not exists notification (
  id          bigserial primary key,
  kind        text not null,           -- meeting_brief | routine | suggestion | secret_request | info
  title       text not null,
  body        text not null default '',
  url         text,                    -- where clicking it goes (dashboard anchor or external)
  dedupe_key  text unique,
  created_at  timestamptz not null default now(),
  toasted_at  timestamptz,
  read_at     timestamptz
);

create index if not exists notification_unread_idx on notification (created_at desc) where read_at is null;
