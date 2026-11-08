-- The SQLite schema (docs/native/PLAN.md 3.1, D2): one file per stack, the
-- same tables and columns as Postgres after sql/001-036, so the SQLite
-- repositories (src/repo/sqlite) answer what the Postgres ones do and phase
-- 3.3 can copy rows across column for column.
--
-- Applied by src/db/sqlite.js migrate(), in order, each file in one
-- transaction, recorded in schema_migration (as sql/ is for Postgres). A new
-- Postgres migration that adds a table or column gets its twin here.
--
-- Type mapping. The declared type is also how src/db/sqlite.js decodes a
-- column it reads, so rows come back shaped as pg returns them:
--   bigserial id       integer primary key autoincrement (ids never reused)
--   bigint, integer    integer                          (a JS number, not pg's string)
--   timestamptz        timestamptz: UTC ISO-8601 text with milliseconds,
--                      '2026-11-07T10:00:00.000Z' (sorts as text; a Date in JS)
--   now()              strftime('%Y-%m-%dT%H:%M:%fZ','now'): the same format
--   jsonb              jsonb: JSON text (json_* functions; parsed in JS)
--   text[], bigint[]   text[], bigint[]: a JSON array (json_each to unnest)
--   boolean            boolean: 0/1 (true/false in JS)
--   vector(1536)       vector: a BLOB of 1536 little-endian float32 (sql-sqlite/002)
--   tsvector columns   dropped: FTS5 tables over the same text (sql-sqlite/002)
-- Checks, foreign keys (PRAGMA foreign_keys = on) and partial and expression
-- indexes carry over; gin and hnsw indexes have no twin (002 covers search).
create table attention_weight (
  kind                   text primary key,
  weight                 real not null default 1,
  updated_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table audio_episode (
  id                     integer primary key autoincrement,
  started_at             timestamptz not null,
  ended_at               timestamptz not null,
  stream                 text not null,
  speech_seconds         real not null default 0,
  kind                   text not null default 'unknown',
  calendar_event_id      text,
  audio_path             text,
  transcript_path        text,
  state                  text not null default 'raw',
  source_item_id         integer,
  foreign key (source_item_id) references source_item(id) on delete set null,
  unique (stream, started_at)
);

create table chunk (
  id                     integer primary key autoincrement,
  source_item_id         integer not null,
  ord                    integer not null,
  content                text not null,
  embedding              vector,
  context                text not null default '',
  context_v              integer not null default 0,
  foreign key (source_item_id) references source_item(id) on delete cascade,
  unique (source_item_id, ord)
);
create index chunk_context_v_idx on chunk (context_v);
-- (pg only) CREATE INDEX chunk_embedding_idx ON chunk USING hnsw (embedding vector_cosine_ops)
-- (pg only) CREATE INDEX chunk_tsv_exact_idx ON chunk USING gin (tsv_exact)
-- (pg only) CREATE INDEX chunk_tsv_idx ON chunk USING gin (tsv)

create table claim (
  id                     integer primary key autoincrement,
  subject_kind           text not null,
  subject_id             integer,
  subject_label          text not null,
  kind                   text not null,
  text                   text not null,
  quote                  text,
  source_item_id         integer,
  source_kind            text,
  confidence             real not null default 0.5,
  valid_at               timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  invalid_at             timestamptz,
  recorded_at            timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expired_at             timestamptz,
  supersedes_id          integer,
  duplicate_of           integer,
  status                 text not null default 'active',
  origin                 text not null,
  extracted_by           text,
  embedding              vector,
  last_used_at           timestamptz,
  use_count              integer not null default 0,
  check (kind in ('role', 'expertise', 'ownership', 'preference', 'decision', 'status', 'relationship', 'blocker', 'reference', 'workflow')),
  check (origin in ('distill', 'consolidate', 'explicit', 'dream', 'agent')),
  check (status in ('active', 'superseded', 'retracted', 'pending_review')),
  check (subject_kind in ('person', 'project', 'me', 'topic')),
  foreign key (duplicate_of) references claim(id) on delete set null,
  foreign key (source_item_id) references source_item(id) on delete set null,
  foreign key (supersedes_id) references claim(id) on delete set null
);
-- (pg only) CREATE INDEX claim_embedding_idx ON claim USING hnsw (embedding vector_cosine_ops)
create index claim_source_item_idx on claim (source_item_id);
create index claim_subject_active_idx on claim (subject_kind, subject_id) where (status = 'active');
-- (pg only) CREATE INDEX claim_tsv_idx ON claim USING gin (tsv)

create table claim_extraction (
  source_item_id         integer primary key,
  extracted_by           text not null,
  extracted_at           timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claims                 integer not null default 0,
  dropped                integer not null default 0,
  error                  text,
  foreign key (source_item_id) references source_item(id) on delete cascade
);

create table commitment (
  id                     integer primary key autoincrement,
  source_item_id         integer not null,
  direction              text not null,
  summary                text not null,
  detail                 text,
  counterparty_person_id integer,
  due_at                 timestamptz,
  status                 text not null default 'open',
  project_id             integer,
  repo_path              text,
  project_confidence     real,
  project_rationale      text,
  confidence             real,
  extracted_by           text not null,
  extracted_at           timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  superseded_by          integer,
  closed_reason          text,
  closed_at              timestamptz,
  touched_at             timestamptz,
  ledger_checked_at      timestamptz,
  kind                   text,
  planned_at             timestamptz,
  plan                   jsonb,
  context                text,
  context_at             timestamptz,
  context_by             text,
  foreign key (counterparty_person_id) references person(id) on delete set null,
  foreign key (project_id) references project(id) on delete set null,
  foreign key (source_item_id) references source_item(id) on delete cascade,
  foreign key (superseded_by) references commitment(id) on delete set null
);
create index commitment_item_idx on commitment (source_item_id);
create index commitment_open_idx on commitment (status, due_at);
create index commitment_superseded_idx on commitment (superseded_by) where superseded_by is not null;

create table commitment_block (
  blocker_id             integer primary key,
  task_id                integer,
  verdict                text not null,
  why                    text,
  manual                 boolean not null default 0,
  judged_at              timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  who                    text,
  check (verdict in ('blocks', 'not_mine')),
  foreign key (blocker_id) references commitment(id) on delete cascade,
  foreign key (task_id) references commitment(id) on delete set null
);
create index commitment_block_task_idx on commitment_block (task_id) where task_id is not null;

create table commitment_review (
  commitment_id          integer primary key,
  reviewed_by            text not null,
  reviewed_at            timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  supersedes             integer,
  foreign key (commitment_id) references commitment(id) on delete cascade,
  foreign key (supersedes) references commitment(id) on delete set null
);

create table commitment_vector (
  commitment_id          integer primary key,
  embedding              vector not null,
  anchors                text[] not null default '[]',
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  checked_at             timestamptz,
  verdict                jsonb,
  foreign key (commitment_id) references commitment(id) on delete cascade
);
-- (pg only) CREATE INDEX commitment_vector_anchors_idx ON commitment_vector USING gin (anchors)
-- (pg only) CREATE INDEX commitment_vector_embedding_idx ON commitment_vector USING hnsw (embedding vector_cosine_ops)
create index commitment_vector_unchecked_idx on commitment_vector (commitment_id) where (checked_at is null);

create table consolidation (
  claim_id               integer primary key,
  decision               text not null,
  target_id              integer,
  decided_by             text not null,
  decided_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  error                  text,
  foreign key (claim_id) references claim(id) on delete cascade,
  foreign key (target_id) references claim(id) on delete set null
);

create table digest (
  id                     integer primary key autoincrement,
  slot                   text not null,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  body                   text not null default '',
  items                  jsonb not null default '{}',
  unique (slot)
);

create table distillation (
  source_item_id         integer primary key,
  extracted_by           text not null,
  extracted_at           timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  commitments            integer not null default 0,
  facts                  integer not null default 0,
  error                  text,
  foreign key (source_item_id) references source_item(id) on delete cascade
);

create table draft (
  id                     integer primary key autoincrement,
  run_id                 integer,
  channel                text not null,
  to_identity            text,
  subject                text,
  body                   text not null,
  status                 text not null default 'pending',
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at                timestamptz,
  commitment_id          integer,
  source_item_id         integer,
  target                 jsonb not null default '{}',
  origin                 text not null default 'manual',
  closed_reason          text,
  closed_at              timestamptz,
  foreign key (commitment_id) references commitment(id) on delete cascade,
  foreign key (run_id) references run(id) on delete cascade,
  foreign key (source_item_id) references source_item(id) on delete set null
);
create unique index draft_one_open_per_commitment on draft (commitment_id) where (status in ('pending', 'edited') and commitment_id is not null);

create table eval_case (
  id                     integer primary key autoincrement,
  question               text not null,
  qtype                  text not null,
  gold_item_ids          bigint[] not null default '[]',
  gold_answer            text,
  as_of                  timestamptz,
  origin                 text not null default 'manual',
  active                 boolean not null default 1,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  notes                  text
);
create index eval_case_active_idx on eval_case (active, qtype);

create table eval_run (
  id                     integer primary key autoincrement,
  ran_at                 timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  retriever              text not null,
  config                 jsonb not null default '{}',
  metrics                jsonb not null default '{}',
  per_case               jsonb not null default '[]'
);
create index eval_run_retriever_idx on eval_run (retriever, ran_at DESC);

create table event_outbox (
  seq                    integer primary key,
  topic                  text not null,
  payload                jsonb not null,
  at                     timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index event_outbox_at on event_outbox (at);

create table fact (
  id                     integer primary key autoincrement,
  source_item_id         integer not null,
  kind                   text not null,
  summary                text not null,
  payload                jsonb not null default '{}',
  occurred_at            timestamptz not null,
  extracted_by           text not null,
  extracted_at           timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  foreign key (source_item_id) references source_item(id) on delete cascade
);
create index fact_kind_idx on fact (kind, occurred_at DESC);

create table factory_board (
  id                     integer primary key default 1,
  jobs                   jsonb not null default '[]',
  polled_at              timestamptz,
  error                  text,
  error_at               timestamptz,
  check (id = 1)
);

create table ledger_evidence (
  id                     integer primary key autoincrement,
  commitment_id          integer not null,
  source_item_id         integer,
  effect                 text not null,
  quote                  text,
  confidence             real,
  method                 text not null,
  extracted_by           text not null,
  applied                boolean not null default 0,
  decision               text,
  decided_at             timestamptz,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  foreign key (commitment_id) references commitment(id) on delete cascade,
  foreign key (source_item_id) references source_item(id) on delete set null,
  unique (commitment_id, source_item_id, extracted_by)
);
create index ledger_evidence_open_idx on ledger_evidence (created_at DESC) where ((effect = 'closes') and (applied = 0) and (decision is null));

create table ledger_transition (
  id                     integer primary key autoincrement,
  commitment_id          integer not null,
  from_status            text not null,
  to_status              text not null,
  actor                  text not null,
  reason                 text,
  evidence_id            integer,
  before                 jsonb not null,
  at                     timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  undone_at              timestamptz,
  undo                   text,
  foreign key (commitment_id) references commitment(id) on delete cascade,
  foreign key (evidence_id) references ledger_evidence(id) on delete set null
);
create index ledger_transition_at_idx on ledger_transition (at DESC);
create index ledger_transition_commitment_idx on ledger_transition (commitment_id, at DESC);

create table llm_spend (
  id                     integer primary key autoincrement,
  at                     timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  purpose                text not null,
  model                  text,
  backend                text not null,
  cost_usd               numeric,
  input_tokens           integer,
  output_tokens          integer,
  duration_ms            integer,
  ok                     boolean not null
);
create index llm_spend_at_idx on llm_spend (at DESC);

create table meeting_brief (
  id                     integer primary key autoincrement,
  dedupe_key             text not null,
  event_external_id      text not null,
  source_item_id         integer,
  starts_at              timestamptz not null,
  series_key             text,
  kind                   text,
  title                  text not null,
  headline               text not null default '',
  body                   text not null default '',
  points                 jsonb not null default '[]',
  refs                   jsonb not null default '{}',
  join_url               text,
  error                  text,
  attempts               integer not null default 0,
  notification_id        integer,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  foreign key (notification_id) references notification(id) on delete set null,
  foreign key (source_item_id) references source_item(id) on delete set null,
  unique (dedupe_key)
);
create index meeting_brief_starts_idx on meeting_brief (starts_at DESC);

create table meeting_debrief (
  id                     integer primary key autoincrement,
  episode_id             integer not null,
  event_external_id      text,
  source_item_id         integer,
  title                  text not null,
  started_at             timestamptz not null,
  ended_at               timestamptz not null,
  content_hash           text not null,
  transcript_chars       integer not null default 0,
  applied                jsonb not null default '{"items": []}',
  dropped                integer not null default 0,
  error                  text,
  attempts               integer not null default 0,
  extracted_by           text not null,
  notification_id        integer,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  foreign key (episode_id) references audio_episode(id) on delete cascade,
  foreign key (notification_id) references notification(id) on delete set null,
  foreign key (source_item_id) references source_item(id) on delete set null,
  unique (episode_id, content_hash)
);
create index meeting_debrief_created_idx on meeting_debrief (created_at DESC);

create table meeting_series (
  series_key             text primary key,
  label                  text not null,
  kind                   text,
  kind_source            text,
  profile                jsonb not null default '{}',
  updated_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table memory_page (
  id                     integer primary key autoincrement,
  kind                   text not null,
  subject_id             integer not null default 0,
  title                  text not null,
  body                   text not null,
  facts_hash             text not null,
  generated_at           timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  generated_by           text,
  embedding              vector,
  check (kind in ('person', 'project', 'me', 'index')),
  unique (kind, subject_id)
);
-- (pg only) CREATE INDEX memory_page_tsv_idx ON memory_page USING gin (tsv)

create table notification (
  id                     integer primary key autoincrement,
  kind                   text not null,
  title                  text not null,
  body                   text not null default '',
  url                    text,
  dedupe_key             text,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  toasted_at             timestamptz,
  read_at                timestamptz,
  priority               text not null default 'normal',
  delivery               text not null default 'push',
  channel_sent           text[] not null default '[]',
  digest_id              integer,
  feedback               text,
  feedback_at            timestamptz,
  unique (dedupe_key)
);
create index notification_digest_wait_idx on notification (created_at) where ((delivery = 'digest') and (digest_id is null));
create index notification_push_idx on notification (created_at DESC) where (delivery = 'push');
create index notification_unread_idx on notification (created_at DESC) where (read_at is null);

create table pa_install (
  id                     text primary key,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table person (
  id                     integer primary key autoincrement,
  display_name           text not null,
  primary_email          text,
  is_me                  boolean not null default 0,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create unique index person_primary_email_idx on person (lower(primary_email)) where primary_email is not null;

create table person_identity (
  id                     integer primary key autoincrement,
  person_id              integer not null,
  kind                   text not null,
  value                  text not null,
  foreign key (person_id) references person(id) on delete cascade,
  unique (kind, value)
);

create table project (
  id                     integer primary key autoincrement,
  name                   text not null,
  gitlab_path            text,
  repo_path              text,
  active                 boolean not null default 1,
  last_touched_at        timestamptz,
  retired_at             timestamptz,
  retired_reason         text,
  forge                  text,
  remote_urls            text[] not null default '[]',
  local_paths            jsonb not null default '{}',
  default_branch         text,
  description            text,
  profile                jsonb not null default '{}',
  profile_source         text,
  profile_hash           text,
  profiled_at            timestamptz,
  manual                 jsonb not null default '{}',
  hidden                 boolean not null default 0,
  origin                 text,
  branches               jsonb not null default '[]',
  last_pr_at             timestamptz,
  last_commit_at         timestamptz,
  last_session_at        timestamptz,
  pr_count               integer not null default 0,
  session_count          integer not null default 0,
  synced_at              timestamptz,
  unique (name)
);

create table project_alias (
  id                     integer primary key autoincrement,
  project_id             integer not null,
  alias                  text not null,
  origin                 text not null default 'seeded',
  weight                 real not null default 1.0,
  learned_from           integer,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  foreign key (project_id) references project(id) on delete cascade
);
create unique index project_alias_alias_idx on project_alias (lower(alias));

create table proposal (
  id                     integer primary key autoincrement,
  kind                   text not null,
  commitment_id          integer,
  run_id                 integer,
  title                  text not null,
  body                   text not null default '',
  options                jsonb,
  payload                jsonb not null default '{}',
  status                 text not null default 'pending',
  answer                 text,
  dedupe_key             text,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at             timestamptz,
  expires_at             timestamptz,
  foreign key (commitment_id) references commitment(id) on delete cascade,
  foreign key (run_id) references run(id) on delete set null,
  unique (dedupe_key)
);
create index proposal_pending_idx on proposal (created_at DESC) where (status = 'pending');

create table query_embedding_cache (
  model                  text not null,
  dims                   integer not null,
  query_norm             text not null,
  embedding              vector not null,
  hits                   integer not null default 0,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at           timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (model, dims, query_norm)
);
create index query_embedding_cache_used_idx on query_embedding_cache (last_used_at DESC);

create table reply_close (
  id                     integer primary key autoincrement,
  commitment_id          integer not null,
  extracted_by           text not null,
  last_message_id        integer not null,
  verdict                text,
  quote                  text,
  message_id             integer,
  confidence             real,
  applied                jsonb,
  undone_at              timestamptz,
  undo                   text,
  error                  text,
  attempts               integer not null default 0,
  judged_at              timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  foreign key (commitment_id) references commitment(id) on delete cascade,
  foreign key (message_id) references source_item(id) on delete set null,
  unique (commitment_id, extracted_by, last_message_id)
);
create index reply_close_judged_idx on reply_close (judged_at DESC);

create table repo_delivery (
  repo                   text primary key,
  delivery               text not null,
  updated_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table repo_pr (
  id                     integer primary key autoincrement,
  project_id             integer,
  forge                  text not null default 'github',
  repo                   text not null,
  number                 integer not null,
  title                  text not null,
  state                  text not null,
  draft                  boolean not null default 0,
  head_ref               text,
  base_ref               text,
  url                    text,
  author                 text,
  created_at             timestamptz,
  updated_at             timestamptz,
  merged_at              timestamptz,
  closed_at              timestamptz,
  summary                text,
  body                   text,
  synced_at              timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  foreign key (project_id) references project(id) on delete set null,
  unique (forge, repo, number)
);
create index repo_pr_project_idx on repo_pr (project_id, updated_at DESC);

create table routine (
  id                     integer primary key autoincrement,
  title                  text not null,
  description            text not null default '',
  schedule               text not null,
  action                 text not null,
  params                 jsonb not null default '{}',
  enabled                boolean not null default 0,
  origin                 text not null default 'user',
  status                 text not null default 'active',
  why                    text,
  evidence               jsonb not null default '[]',
  last_run_at            timestamptz,
  next_run_at            timestamptz,
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  check (origin in ('user', 'suggested')),
  check (status in ('active', 'proposed', 'rejected', 'paused'))
);
create index routine_due_idx on routine (next_run_at) where (status = 'active');

create table routine_run (
  id                     integer primary key autoincrement,
  routine_id             integer not null,
  started_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at               timestamptz,
  ok                     boolean,
  dry_run                boolean not null default 0,
  summary                text,
  detail                 jsonb not null default '{}',
  foreign key (routine_id) references routine(id) on delete cascade
);
create index routine_run_idx on routine_run (routine_id, started_at DESC);

create table run (
  id                     integer primary key autoincrement,
  commitment_id          integer,
  mode                   text not null,
  task                   text not null,
  repo_path              text,
  worktree_path          text,
  branch                 text,
  termhub_session_id     text,
  brief_path             text,
  status                 text not null default 'starting',
  machine                text,
  started_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at               timestamptz,
  diff_stat              jsonb,
  mr_url                 text,
  exit_note              text,
  route                  text not null default 'claude',
  route_reason           text,
  kind                   text,
  pipeline               text,
  delivery               text,
  delivery_requested     text,
  models                 jsonb,
  factory_job_id         text,
  factory_state          text,
  factory_warnings       jsonb,
  cost_usd               numeric,
  outcome                text,
  outcome_at             timestamptz,
  delivery_source        text,
  brief_by               text,
  external_id            text,
  job_kind               text,
  runtime                text,
  subscription_equiv_usd numeric,
  foreign key (commitment_id) references commitment(id) on delete set null
);
create unique index run_external_id_idx on run (external_id) where external_id is not null;
create unique index run_factory_job_idx on run (factory_job_id) where factory_job_id is not null;
create index run_route_idx on run (route, started_at DESC);
create index run_status_idx on run (status, started_at DESC);

create table run_pr (
  run_id                 integer not null,
  url                    text not null,
  number                 integer,
  story_id               integer,
  state                  text,
  ci_state               text,
  ci_failing             jsonb,
  updated_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (run_id, url),
  foreign key (run_id) references run(id) on delete cascade
);

create table run_step (
  run_id                 integer not null,
  step_id                text not null,
  job_id                 text,
  story_id               integer,
  persona                text,
  runtime                text,
  model                  text,
  state                  text,
  started_at             timestamptz,
  ended_at               timestamptz,
  machine                text,
  termhub_session_id     text,
  url                    text,
  updated_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (run_id, step_id),
  foreign key (run_id) references run(id) on delete cascade
);
create index run_step_session_idx on run_step (termhub_session_id) where termhub_session_id is not null;

create table secret_request (
  id                     integer primary key autoincrement,
  kind                   text not null default 'secret',
  name                   text not null,
  purpose                text not null,
  hint                   text,
  url                    text,
  command                text,
  requested_by           text not null default 'user',
  target                 text not null default 'credential-manager',
  status                 text not null default 'pending',
  created_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fulfilled_at           timestamptz,
  stored_in              text,
  check (kind in ('secret', 'login')),
  check (status in ('pending', 'fulfilled', 'declined', 'expired')),
  check (target in ('credential-manager', 'env-file', 'action'))
);
create index secret_request_name_idx on secret_request (name, fulfilled_at DESC);
create unique index secret_request_pending_name on secret_request (name) where (status = 'pending');

create table setting (
  key                    text primary key,
  value                  jsonb not null,
  updated_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

create table source_item (
  id                     integer primary key autoincrement,
  source                 text not null,
  external_id            text not null,
  thread_external_id     text,
  occurred_at            timestamptz not null,
  author_identity        text,
  subject                text,
  body_text              text not null default '',
  raw                    jsonb not null default '{}',
  content_hash           text not null,
  fetched_at             timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (source, external_id)
);
create index source_item_author_idx on source_item (author_identity);
create index source_item_occurred_idx on source_item (occurred_at DESC);
create index source_item_thread_idx on source_item (source, thread_external_id);

create table sync_cursor (
  source                 text primary key,
  delta_token            text,
  last_run_at            timestamptz,
  last_error             text,
  state                  jsonb not null default '{}'
);
