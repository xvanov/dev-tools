-- ledger.dirty for a commitment already checked used to walk that commitment's
-- whole 30-day window (source_item_window_idx leads with occurred_at). On the
-- work stack that was 120-230 ms with nothing new and 250-480 ms with new
-- items, every minute, on the serving loop. This index leads with fetched_at,
-- so the pass reads only items fetched since the oldest open commitment was
-- checked: an empty range when nothing has arrived (plan 8.4.38).
create index source_item_fresh_idx on source_item (fetched_at, occurred_at, id);
