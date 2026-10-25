-- Card context: a short plain-language "cause and effect" for a commitment on
-- the dashboard — who asked what, what led to it, what has happened since, and
-- what is expected now and from whom (src/commitments/context.js).
--
-- Derived, so it carries what wrote it (`context_by`: prompt version and
-- model) and when (`context_at`). It is written lazily by the worker, only for
-- cards on the board, and written again when the thread has new items fetched
-- after `context_at` or the prompt version changes. Never read by any pass that
-- decides anything: it is for the human reading the card.

alter table commitment add column if not exists context    text;
alter table commitment add column if not exists context_at timestamptz;
alter table commitment add column if not exists context_by text;
