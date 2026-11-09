-- The Memory tab's counts and review queue filter claim by status
-- (repo.memory.stats, reviewQueue). The SQLite twin is sql-sqlite/013.
create index if not exists claim_status_idx on claim (status, recorded_at);
