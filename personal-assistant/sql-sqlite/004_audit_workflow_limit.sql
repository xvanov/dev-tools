-- Twins of sql/037_audit_log.sql (plan 4.3, the policy engine's hash-chained
-- audit log) and sql/037_workflow_limit.sql (plan 8.1, edited per-workflow
-- cost ceilings). Same columns; see those files for what they hold.

create table audit_log (
  seq        integer primary key autoincrement,
  at         timestamptz not null,
  channel    text not null,
  actor      text not null default '',
  action     text not null,
  tool       text not null,
  decision   text not null check (decision in ('allow', 'deny', 'ask')),
  rule       text not null default '',
  reason     text not null default '',
  subject    text not null default '',
  args_hash  text not null default '',
  prev_hash  text not null,
  hash       text not null
);
create index audit_log_at on audit_log (at);

create table workflow_limit (
  workflow    text primary key,
  max_usd     numeric not null check (max_usd >= 0),
  updated_at  timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
