-- Decision queue (src/build/messages.ts): time a run spent `waiting` on a human is
-- not charged to its wall-clock cap. waiting_ms is what earlier asks added up to,
-- waiting_since the start of the ask in progress (null when none).
alter table build_run add column if not exists waiting_ms bigint not null default 0;
alter table build_run add column if not exists waiting_since text;
