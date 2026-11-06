-- A vector per commitment, for the cross-thread duplicate pass
-- (src/commitments/semantic.js, src/commitments/dedupe.js).
--
-- The same ask turns up in a Teams chat, the draft of the reply, a PR thread
-- and a meeting chat; the review pass in memory/consolidate.js only compares
-- commitments from the same item, thread or person, so those stayed separate
-- cards. This pass compares every new open commitment with every open one of
-- the last ~60 days by meaning (embedding of summary + detail) and by shared
-- anchors (a PR/issue ref, a URL, a ticket key), and lets a cheap model
-- confirm the fold.
--
--   embedding   text-embedding-3-large of "summary\ndetail" (PA_EMBED_DIMENSIONS)
--   anchors     normalised refs found in it: "argocdstate#153", "url:host/path",
--               "jira:ABC-12" — lower-case
--   checked_at  when the duplicate pass judged it; null = still to do
--   verdict     what it decided, for `pa` and for undo: {keep, relation, by}
--
-- Its own table rather than columns on commitment: a commitment row is read
-- by every board query, and 1536 floats on each would be carried for nothing.

create table if not exists commitment_vector (
  commitment_id bigint primary key references commitment(id) on delete cascade,
  embedding     vector(1536) not null,
  anchors       text[] not null default '{}',
  created_at    timestamptz not null default now(),
  checked_at    timestamptz,
  verdict       jsonb
);

create index if not exists commitment_vector_embedding_idx
  on commitment_vector using hnsw (embedding vector_cosine_ops);
create index if not exists commitment_vector_anchors_idx
  on commitment_vector using gin (anchors);
create index if not exists commitment_vector_unchecked_idx
  on commitment_vector (commitment_id) where checked_at is null;
