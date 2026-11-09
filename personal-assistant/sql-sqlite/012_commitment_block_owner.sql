-- Who actually owes a blocker: person | me | system (null reads as person).
-- The twin of sql/040_commitment_block_owner.sql, which says why.
alter table commitment_block add column owner text;
