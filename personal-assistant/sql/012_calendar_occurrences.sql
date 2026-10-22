-- Calendar rows keyed by the bare event id were one row per *series*: every
-- occurrence of a recurring meeting overwrote the previous one, so the row
-- carried whichever occurrence was read last. They are wrong rather than old,
-- and the calendar pass re-reads the whole window with per-occurrence ids
-- (`<id>@<start>`), so they are removed here instead of being left to sit
-- beside the correct rows. Audio episodes keep their own timestamps and are
-- re-linked by time.

delete from source_item where source = 'graph_event' and external_id not like '%@%';
