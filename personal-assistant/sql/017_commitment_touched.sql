-- When a person last acted on a commitment.
--
-- Notes the distiller reads from my own work — my Claude sessions, my own
-- PRs and their notifications — are kept apart from what people ask of me
-- and expire after a week nobody touched them (src/commitments/selfNotes.js).
-- "Touched" is this column: reopening, correcting the project, or any status
-- change by a person sets it; age alone is measured from the source item.

alter table commitment add column if not exists touched_at timestamptz;
