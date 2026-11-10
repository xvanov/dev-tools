-- A newer debrief of the same episode replaces the older ones (src/meetings/
-- debrief.ts supersedeOlder): they stop showing in lists, what they applied is
-- adopted by the newer one or undone. Kept, not deleted, so the history stays.
alter table meeting_debrief add column superseded_by integer references meeting_debrief(id) on delete set null;
