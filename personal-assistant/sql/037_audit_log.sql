-- The policy engine's audit log (plan 4.3; src/policy, src/repo/audit.js).
--
-- One row per decision (allow | deny | ask) of the policy function, for every
-- tool call, approval and factory action. Hash-chained: each row stores the
-- hash of the row before it (prev_hash) and its own hash over its fields plus
-- prev_hash, so editing or deleting a row in the middle breaks every hash after
-- it and `pa audit verify` says where. (Dropping the newest rows leaves a valid
-- shorter chain: the head hash `pa audit verify` prints is what to keep elsewhere.)
-- Rows are ids and short subjects, never message content or secret values;
-- args_hash is a digest of the call's arguments, not the arguments.
--
-- Additive (expand): a new table; older code ignores it.

create table if not exists audit_log (
  seq        bigserial   primary key,
  at         timestamptz not null,
  channel    text        not null,
  actor      text        not null default '',
  action     text        not null,
  tool       text        not null,
  decision   text        not null check (decision in ('allow', 'deny', 'ask')),
  rule       text        not null default '',
  reason     text        not null default '',
  subject    text        not null default '',
  args_hash  text        not null default '',
  prev_hash  text        not null,
  hash       text        not null
);

create index if not exists audit_log_at on audit_log (at);
