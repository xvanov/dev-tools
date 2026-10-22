-- Why and when a commitment stopped being open. The assistant now closes
-- some on its own (a PR merged, a review given, a review requested only from
-- a team), and a card that silently vanishes looks like a bug — the reason is
-- what the dashboard shows instead.

alter table commitment add column if not exists closed_reason text;
alter table commitment add column if not exists closed_at     timestamptz;
