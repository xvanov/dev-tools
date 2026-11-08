-- The board's source health (cursorHealth, on every /api/state): the newest
-- fetched_at of each source. From source_item_thread_idx each row of a source
-- was read for its fetched_at (its body and raw JSON on overflow pages, each
-- decrypted): 40-90 ms a refresh on the work stack's 7k items. This index
-- answers each max() from its last entry (plan 8.4.33).
create index source_item_fetched_idx on source_item (source, fetched_at);
