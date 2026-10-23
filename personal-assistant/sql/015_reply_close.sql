-- Commitments closed by my own reply (src/commitments/replyClose.js).
--
-- One row per judgement: an open owed_by_me commitment from Teams or mail,
-- read beside the messages I wrote in the same thread after it, at one prompt
-- version (`extracted_by`). `last_message_id` is the newest of my messages
-- the judgement saw, so "work to do" is a query — commitments whose newest
-- reply of mine has no row here at the current version — and a newer reply
-- earns a fresh look while the same reply is never judged twice. That is also
-- why `pa done --reopen` sticks: the row says this reply was already read.
--
-- A "discharged" verdict closes the commitment; `applied` holds the columns
-- it wrote (`set`) and what they replaced (`before`), so `undo` can put them
-- back. The quote is copied, not referenced, and the message ids are
-- `on delete set null`, because retention deletes chat and mail.
--
-- A failed judgement is a row too (`error`, `attempts`), so a thread the
-- model cannot handle is tried three times, not every five minutes forever.

create table if not exists reply_close (
  id               bigserial primary key,
  commitment_id    bigint not null references commitment(id) on delete cascade,
  extracted_by     text not null,
  last_message_id  bigint not null,                  -- newest of my replies the judgement saw
  verdict          text,                             -- discharged | partial | promise | unrelated
  quote            text,                             -- verbatim, from message_id
  message_id       bigint references source_item(id) on delete set null,
  confidence       real,
  applied          jsonb,                            -- {set, before} when it closed the commitment
  undone_at        timestamptz,
  undo             text,
  error            text,
  attempts         int not null default 0,
  judged_at        timestamptz not null default now(),
  unique (commitment_id, extracted_by, last_message_id)
);

create index if not exists reply_close_judged_idx on reply_close (judged_at desc);
