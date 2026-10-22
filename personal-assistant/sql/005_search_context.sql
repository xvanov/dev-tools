-- Contextual chunks and an exact-match index.
--
--  * `context` is a one-line header (where · when · who — subject) built by
--    src/search/context.js. Both tsvectors and the embedding cover it, so a
--    chunk is findable by its sender and topic, not only its own words.
--    `context_v` records the header format; a mismatch re-heads and re-embeds.
--  * `tsv_exact` uses the `simple` config: no stemming, no stop words. The
--    english config mangles exactly the tokens this corpus is searched by —
--    ticket keys, branch names, identifiers.

alter table chunk add column if not exists context   text not null default '';
alter table chunk add column if not exists context_v int  not null default 0;

alter table chunk drop column if exists tsv;
alter table chunk add column tsv tsvector
  generated always as (to_tsvector('english', context || ' ' || content)) stored;
alter table chunk add column if not exists tsv_exact tsvector
  generated always as (to_tsvector('simple', context || ' ' || content)) stored;

create index if not exists chunk_tsv_idx       on chunk using gin (tsv);
create index if not exists chunk_tsv_exact_idx on chunk using gin (tsv_exact);
create index if not exists chunk_context_v_idx on chunk (context_v);
