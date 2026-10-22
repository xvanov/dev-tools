-- Pre-meeting briefs (src/meetings).
--
-- `meeting_series` is what the assistant has learned about a recurring
-- meeting, keyed by its normalised subject: the calendar connector does not
-- return a series id, and a weekly stand-up is recognisable by name. `kind` is
-- cached here so the model is asked to classify a series once, not every
-- occurrence; `kind_source = 'manual'` is a human correction and wins.
--
-- `profile` is derived from transcripts of past occurrences (format, what is
-- usually asked, what you said last time), each entry carrying the verbatim
-- quote it was read from. It may be rebuilt at will; the claims mirrored into
-- memory are the durable copy.
--
-- `meeting_brief` holds one brief per occurrence (`dedupe_key` = event id +
-- start, so a moved meeting is briefed again). `refs` maps the brief's E1…En
-- labels back to items, commitments and claims for the dashboard view.

create table if not exists meeting_series (
  series_key   text primary key,
  label        text not null,
  kind         text,
  kind_source  text,                          -- keyword | structure | model | manual
  profile      jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

create table if not exists meeting_brief (
  id                bigserial primary key,
  dedupe_key        text not null unique,
  event_external_id text not null,
  source_item_id    bigint references source_item(id) on delete set null,
  starts_at         timestamptz not null,
  series_key        text,
  kind              text,
  title             text not null,
  headline          text not null default '',
  body              text not null default '',
  points            jsonb not null default '[]'::jsonb,
  refs              jsonb not null default '{}'::jsonb,
  join_url          text,
  error             text,
  attempts          int not null default 0,
  notification_id   bigint references notification(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists meeting_brief_starts_idx on meeting_brief (starts_at desc);
