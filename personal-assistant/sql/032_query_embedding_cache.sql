-- Query-embedding cache (docs/native/PLAN.md item 0.2, Embeddings policy D5).
--
-- A search embeds its query text on every call (0.3-1 s, and money). The same
-- question asked again must cost nothing, so the vector is kept under the
-- normalized query text (trimmed, whitespace collapsed, lower-cased) plus the
-- model and dimensions that made it: change either and the old row is simply
-- never matched. Query-time only; ingest embeddings live on chunk/claim/page.
--
-- `embedding` is an unconstrained `vector` so a dimension change needs no
-- migration. Additive: nothing existing is altered. src/search/embedCache.js
-- keeps the table to PA_EMBED_CACHE_ROWS rows by last use.

create table if not exists query_embedding_cache (
  model         text        not null,
  dims          integer     not null,
  query_norm    text        not null,
  embedding     vector      not null,
  hits          integer     not null default 0,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  primary key (model, dims, query_norm)
);

create index if not exists query_embedding_cache_used_idx on query_embedding_cache (last_used_at desc);
