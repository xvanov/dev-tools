-- The Memory tab's counts (repo.memory.stats, on every /api/memory/overview)
-- and its review queue filter claim by status. With no index on it each
-- count read every claim row, 1536-float vector included: 1.2 s on the work
-- stack's 14k claims, all of it blocking the dashboard's event loop. From
-- this index the same five counts take about 2 ms.
create index claim_status_idx on claim (status, recorded_at);
