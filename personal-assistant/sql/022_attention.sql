-- Attention: how much of the assistant's voice reaches you, and when
-- (DURABLE.md §2.4, src/notify/budget.js).
--
-- Every notification still gets its feed row; what changes is whether it
-- also interrupts you. `priority` is what the caller asked for (urgent |
-- normal | digest); `delivery` is what the interrupt budget decided (push |
-- digest | feed); `channel_sent` is where it actually went ('toast', 'chat').
-- A row delivered as 'digest' waits with `digest_id` null until the next
-- digest (09:00 and 14:00 by default) picks it up.
--
-- `feedback` is your thumbs up/down on one notification. It moves
-- `attention_weight` for that kind of notification (bounded 0.2–2): a kind
-- you keep thumbing down is demoted from push to digest, and at the floor to
-- the feed alone. Weights are keyed by attention kind, not notification id,
-- so they outlive the rows that taught them.
--
-- `digest.slot` is unique: two processes reaching the same slot write one
-- digest, and a slot missed during downtime is run once, never as a backlog.

alter table notification add column if not exists priority     text not null default 'normal';
alter table notification add column if not exists delivery     text not null default 'push';
alter table notification add column if not exists channel_sent text[] not null default '{}';
alter table notification add column if not exists digest_id    bigint;
alter table notification add column if not exists feedback     text;
alter table notification add column if not exists feedback_at  timestamptz;

create table if not exists digest (
  id          bigserial primary key,
  slot        text not null unique,        -- local 'YYYY-MM-DD HH:MM' it was due at
  created_at  timestamptz not null default now(),
  body        text not null default '',
  items       jsonb not null default '{}'::jsonb
);

-- The digest's waiting list, and today's push count, are both queries.
create index if not exists notification_digest_wait_idx
  on notification (created_at) where delivery = 'digest' and digest_id is null;
create index if not exists notification_push_idx
  on notification (created_at desc) where delivery = 'push';

create table if not exists attention_weight (
  kind        text primary key,
  weight      real not null default 1,
  updated_at  timestamptz not null default now()
);
