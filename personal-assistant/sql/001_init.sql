-- Initial schema.
--
-- Shape notes that are decisions, not incidental:
--
--  * source_item keeps `raw` forever-ish and is never updated in place. Every
--    derived row points back at it and carries the prompt version that produced
--    it, so improving the distiller means re-running over history rather than
--    re-reading a year of email.
--  * person_identity exists from the first migration on purpose. The same
--    colleague is a display name in Teams, an SMTP address in Outlook and a git
--    author in GitLab; retrofitting that after ten thousand rows is misery.
--  * There is no job queue table. Work to do is expressed as a query ("items
--    with no distilled rows at the current prompt version"), which cannot get
--    stuck, cannot leak, and self-heals after any crash.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- capture ---

create table if not exists source_item (
  id                  bigserial primary key,
  source              text        not null,          -- graph_mail | graph_event | graph_chat
                                                     -- gitlab_issue | gitlab_mr | gitlab_note
                                                     -- audio | claude_session | openclaw_session
  external_id         text        not null,
  thread_external_id  text,
  occurred_at         timestamptz not null,
  author_identity     text,                          -- raw identity string, resolved later
  subject             text,
  body_text           text        not null default '',
  raw                 jsonb       not null default '{}'::jsonb,
  content_hash        text        not null,
  fetched_at          timestamptz not null default now(),
  unique (source, external_id)
);

create index if not exists source_item_occurred_idx on source_item (occurred_at desc);
create index if not exists source_item_thread_idx   on source_item (source, thread_external_id);
create index if not exists source_item_author_idx   on source_item (author_identity);

create table if not exists sync_cursor (
  source       text primary key,
  delta_token  text,
  last_run_at  timestamptz,
  last_error   text,
  state        jsonb not null default '{}'::jsonb
);

-- --------------------------------------------------------------- identity ---

create table if not exists person (
  id             bigserial primary key,
  display_name   text not null,
  primary_email  text,
  is_me          boolean not null default false,
  created_at     timestamptz not null default now()
);

create unique index if not exists person_primary_email_idx
  on person (lower(primary_email)) where primary_email is not null;

create table if not exists person_identity (
  id         bigserial primary key,
  person_id  bigint not null references person(id) on delete cascade,
  kind       text   not null,   -- aad_oid | smtp | teams_id | git_author | gitlab_username
  value      text   not null,
  unique (kind, value)
);

-- --------------------------------------------------------------- projects ---

create table if not exists project (
  id              bigserial primary key,
  name            text not null unique,
  gitlab_path     text,
  repo_path       text,
  active          boolean not null default true,
  last_touched_at timestamptz
);

create table if not exists project_alias (
  id           bigserial primary key,
  project_id   bigint not null references project(id) on delete cascade,
  alias        text   not null,
  origin       text   not null default 'seeded',  -- seeded | corrected | observed
  weight       real   not null default 1.0,
  learned_from bigint,
  created_at   timestamptz not null default now()
);

create unique index if not exists project_alias_alias_idx on project_alias (lower(alias));

-- ------------------------------------------------------------------ audio ---

create table if not exists audio_episode (
  id                bigserial primary key,
  started_at        timestamptz not null,
  ended_at          timestamptz not null,
  stream            text not null,           -- mic | loopback
  speech_seconds    real not null default 0,
  kind              text not null default 'unknown', -- meeting | call | dictation | ambient | unknown
  calendar_event_id text,
  audio_path        text,
  transcript_path   text,
  state             text not null default 'raw',     -- raw | trimmed | transcribed | distilled | purged
  source_item_id    bigint references source_item(id) on delete set null,
  unique (stream, started_at)
);

-- -------------------------------------------------------------- distilled ---

create table if not exists commitment (
  id                     bigserial primary key,
  source_item_id         bigint not null references source_item(id) on delete cascade,
  direction              text   not null,             -- owed_by_me | owed_to_me
  summary                text   not null,
  detail                 text,
  counterparty_person_id bigint references person(id) on delete set null,
  due_at                 timestamptz,
  status                 text   not null default 'open', -- open | dispatched | done | dropped
  project_id             bigint references project(id) on delete set null,
  repo_path              text,
  project_confidence     real,
  project_rationale      text,
  confidence             real,
  extracted_by           text   not null,
  extracted_at           timestamptz not null default now(),
  superseded_by          bigint references commitment(id) on delete set null
);

create index if not exists commitment_open_idx on commitment (status, due_at nulls last);
create index if not exists commitment_item_idx on commitment (source_item_id);

create table if not exists fact (
  id             bigserial primary key,
  source_item_id bigint not null references source_item(id) on delete cascade,
  kind           text   not null,   -- decision | blocker | preference | reference
  summary        text   not null,
  payload        jsonb  not null default '{}'::jsonb,
  occurred_at    timestamptz not null,
  extracted_by   text   not null,
  extracted_at   timestamptz not null default now()
);

create index if not exists fact_kind_idx on fact (kind, occurred_at desc);

-- Marks an item as processed even when it yielded nothing, so the "work to do"
-- query stays a simple anti-join instead of re-distilling chatter forever.
create table if not exists distillation (
  source_item_id bigint primary key references source_item(id) on delete cascade,
  extracted_by   text not null,
  extracted_at   timestamptz not null default now(),
  commitments    int not null default 0,
  facts          int not null default 0,
  error          text
);

-- ------------------------------------------------------------- retrieval ----

create table if not exists chunk (
  id             bigserial primary key,
  source_item_id bigint not null references source_item(id) on delete cascade,
  ord            int    not null,
  content        text   not null,
  embedding      vector(1536),
  tsv            tsvector generated always as (to_tsvector('english', content)) stored,
  unique (source_item_id, ord)
);

create index if not exists chunk_tsv_idx on chunk using gin (tsv);
create index if not exists chunk_embedding_idx
  on chunk using hnsw (embedding vector_cosine_ops);

-- ------------------------------------------------------------- execution ----

create table if not exists run (
  id                 bigserial primary key,
  commitment_id      bigint references commitment(id) on delete set null,
  mode               text not null,            -- plan | local | branch | mr | full
  task               text not null,
  repo_path          text,
  worktree_path      text,
  branch             text,
  termhub_session_id text,
  brief_path         text,
  status             text not null default 'starting', -- starting | running | waiting | done | landed | dropped | failed
  machine            text,
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  diff_stat          jsonb,
  mr_url             text,
  exit_note          text
);

create index if not exists run_status_idx on run (status, started_at desc);

create table if not exists draft (
  id           bigserial primary key,
  run_id       bigint references run(id) on delete cascade,
  channel      text not null,             -- teams | email
  to_identity  text,
  subject      text,
  body         text not null,
  status       text not null default 'pending',  -- pending | edited | sent | discarded
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

-- ---------------------------------------------------------------- settings --

create table if not exists setting (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
