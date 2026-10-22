-- Memory: claims with evidence, consolidated into pages.
--
-- Shape notes that are decisions, not incidental:
--
--  * A claim is one sentence about a subject (a person, a project, me, a
--    topic) with the exact words it was read from. `quote` is copied out of the
--    source item on purpose: retention deletes mail and chat after 180 days,
--    and a belief that cannot show its evidence is a belief nobody should act
--    on. The provenance link is `on delete set null`, so retention removes the
--    pointer and never the memory.
--  * Bitemporal. `valid_at`/`invalid_at` are when the claim was true in the
--    world; `recorded_at`/`expired_at` are when this store believed it. A newer
--    claim that contradicts an older one supersedes it — the old row stays,
--    with both clocks closed — so "what did we think in June" is a query.
--  * Nothing here is ever hard-deleted by the memory code. `forget` retracts.
--  * `consolidation` is a marker, like `distillation`: a claim with no row is
--    work to do. `claim_extraction` marks items the claims pass has read.

create table if not exists claim (
  id              bigserial primary key,
  subject_kind    text   not null check (subject_kind in ('person','project','me','topic')),
  subject_id      bigint,                         -- person.id / project.id; null for topic
  subject_label   text   not null,
  kind            text   not null check (kind in ('role','expertise','ownership','preference','decision',
                                                  'status','relationship','blocker','reference','workflow')),
  text            text   not null,
  quote           text,
  source_item_id  bigint references source_item(id) on delete set null,
  source_kind     text,                           -- source_item.source at extraction time
  confidence      real   not null default 0.5,
  valid_at        timestamptz not null default now(),
  invalid_at      timestamptz,
  recorded_at     timestamptz not null default now(),
  expired_at      timestamptz,
  supersedes_id   bigint references claim(id) on delete set null,
  duplicate_of    bigint references claim(id) on delete set null, -- corroborates, adds nothing new
  status          text   not null default 'active'
                  check (status in ('active','superseded','retracted','pending_review')),
  origin          text   not null check (origin in ('distill','consolidate','explicit','dream')),
  extracted_by    text,
  embedding       vector(1536),
  tsv             tsvector generated always as
                    (to_tsvector('english', coalesce(subject_label,'') || ' ' || text || ' ' || coalesce(quote,''))) stored,
  last_used_at    timestamptz,
  use_count       int    not null default 0
);

create index if not exists claim_subject_active_idx
  on claim (subject_kind, subject_id) where status = 'active';
create index if not exists claim_source_item_idx on claim (source_item_id);
create index if not exists claim_tsv_idx on claim using gin (tsv);
create index if not exists claim_embedding_idx on claim using hnsw (embedding vector_cosine_ops);

create table if not exists claim_extraction (
  source_item_id bigint primary key references source_item(id) on delete cascade,
  extracted_by   text not null,
  extracted_at   timestamptz not null default now(),
  claims         int  not null default 0,
  dropped        int  not null default 0,          -- quotes that were not in the body
  error          text
);

create table if not exists consolidation (
  claim_id    bigint primary key references claim(id) on delete cascade,
  decision    text not null,                       -- add | supersede | duplicate | noop | error
  target_id   bigint references claim(id) on delete set null,
  decided_by  text not null,
  decided_at  timestamptz not null default now(),
  error       text
);

create table if not exists memory_page (
  id            bigserial primary key,
  kind          text not null check (kind in ('person','project','me','index')),
  subject_id    bigint not null default 0,          -- 0 for me/index: unique needs a value
  title         text not null,
  body          text not null,
  facts_hash    text not null,
  generated_at  timestamptz not null default now(),
  generated_by  text,
  embedding     vector(1536),
  tsv           tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored,
  unique (kind, subject_id)
);

create index if not exists memory_page_tsv_idx on memory_page using gin (tsv);

-- Commitments: a later one that restates an open one (a deadline moved) closes
-- the loop through `superseded_by`, which existed from 001 and was never set.
create index if not exists commitment_superseded_idx on commitment (superseded_by) where superseded_by is not null;

create table if not exists commitment_review (
  commitment_id  bigint primary key references commitment(id) on delete cascade,
  reviewed_by    text not null,
  reviewed_at    timestamptz not null default now(),
  supersedes     bigint references commitment(id) on delete set null
);
