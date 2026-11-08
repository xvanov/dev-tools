-- Indexes for the reads the passes make every few minutes. A chunk or claim
-- row carries its 1536-float vector (6 KB, mostly on overflow pages) and a
-- source_item row its body and raw JSON, so a scan that only tests one column
-- still reads, and decrypts, the whole store: on the work stack (31k chunks,
-- 10k claims, 7k items) each such scan took 0.2-0.9 s, and 12-60 s while the
-- hourly snapshot read the file, all of it on the event loop. With these the
-- same reads touch the index alone (docs/native/CUTOVER-SQLITE.md, "The
-- cutover on 2026-11-08").

-- staleChunks: `context_v <> v` as two ranges, with the item id, from the
-- index alone (chunk_context_v_idx would need each row for its item).
create index chunk_stale_idx on chunk (context_v, source_item_id);

-- chunksMissingEmbedding, claimsMissingEmbedding: the rows still to embed.
create index chunk_unembedded_idx on chunk (id) where embedding is null;
create index claim_unembedded_idx on claim (id) where embedding is null;

-- The badge counts (pendingCounts, waitingCounts, pendingReviewCount). Partial,
-- as an index on status alone outbids claim_subject_active_idx in the planner
-- (no ANALYZE here) for every `subject_kind = ? and status = 'active'` read.
create index claim_review_idx on claim (id) where status = 'pending_review';

-- The reconciler's window (ledger dirty): items in a time range fetched since
-- a commitment was last checked, without reading each item.
create index source_item_window_idx on source_item (occurred_at, fetched_at);

-- The items that list members (eligiblePeople, personItems).
create index source_item_members_idx on source_item (id) where json_type(raw, '$.memberEmails') is not null;
