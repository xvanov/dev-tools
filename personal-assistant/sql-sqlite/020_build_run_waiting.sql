-- Decision queue (src/build/messages.ts): time a run spent `waiting` on a human is
-- not charged to its wall-clock cap. waiting_ms is what earlier asks added up to,
-- waiting_since the start of the ask in progress (null when none).
alter table build_run add column waiting_ms integer not null default 0;
alter table build_run add column waiting_since text;
