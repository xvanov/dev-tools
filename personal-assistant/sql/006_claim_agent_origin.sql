-- Claims an agent proposes through the MCP `remember` tool. They land as
-- pending_review and are believed only after a human approves them in the
-- dashboard: an agent's notes may come from content it read in an email.

alter table claim drop constraint if exists claim_origin_check;
alter table claim add constraint claim_origin_check
  check (origin in ('distill','consolidate','explicit','dream','agent'));
