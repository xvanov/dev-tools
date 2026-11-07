-- Who a blocker waits on, when the commitment has no counterparty: your own
-- message "Hi Shawn, could you…" names them in the text, not in a person row.
-- Read by the blocks pass (src/commitments/blocks.js) from the message.
alter table commitment_block add column if not exists who text;
