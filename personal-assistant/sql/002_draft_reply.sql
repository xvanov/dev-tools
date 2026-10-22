-- Drafts for replies to an ask, not only reports on a finished run.
--
-- A draft now belongs to a commitment (the ask it answers) or to a run (the
-- work it reports), and remembers where the ask came from — `target` holds
-- what delivery needs: the Teams chat or channel, or the mail recipients.
-- One open draft per commitment, so the auto-draft pass cannot pile up
-- duplicates of the same reply.

alter table draft add column if not exists commitment_id  bigint references commitment(id) on delete cascade;
alter table draft add column if not exists source_item_id bigint references source_item(id) on delete set null;
alter table draft add column if not exists target         jsonb not null default '{}'::jsonb;
alter table draft add column if not exists origin         text  not null default 'manual'; -- manual | auto | run

create unique index if not exists draft_one_open_per_commitment
  on draft (commitment_id) where status in ('pending', 'edited') and commitment_id is not null;
