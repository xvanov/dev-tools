-- Why a draft stopped waiting. The worker now retires drafts on its own —
-- you already answered in the thread — and a draft that silently vanishes
-- reads as a bug, so the reason is kept.

alter table draft add column if not exists closed_reason text;
alter table draft add column if not exists closed_at     timestamptz;
