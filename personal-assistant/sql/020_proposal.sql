-- What the assistant asks of me (DURABLE.md §2.4): one inbox for every decision
-- it cannot make alone.
--
-- A proposal is an action the assistant has prepared and wants a yes or no on
-- — open the draft PR for a finished run, start a run on an ask, which repo an
-- ask belongs to — or a question only I can answer. Accepting one either wakes
-- the durable task waiting on it (absurd event `proposal:<id>`) or runs the
-- typed handler for its kind (src/proposals); nothing outward happens without
-- the accept. `options` turns a question into buttons; `answer` is what I
-- picked or typed. `dedupe_key` keeps a pass that runs every few minutes from
-- asking the same thing twice; a rejected proposal stays, so it is not asked
-- again.
--
-- "Looks done?" closes stay in ledger_evidence (src/ledger/reconcile.js), and
-- reply drafts stay in `draft`: the dashboard shows all three together.

create table if not exists proposal (
  id             bigserial primary key,
  kind           text not null,                    -- land | dispatch | question
  commitment_id  bigint references commitment(id) on delete cascade,
  run_id         bigint references run(id) on delete set null,
  title          text not null,
  body           text not null default '',
  options        jsonb,                            -- [{value, label}] for a question
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'pending',  -- pending | accepted | rejected | expired
  answer         text,
  dedupe_key     text unique,
  created_at     timestamptz not null default now(),
  decided_at     timestamptz,
  expires_at     timestamptz
);

create index if not exists proposal_pending_idx on proposal (created_at desc) where status = 'pending';

-- What kind of work a commitment is and what the planner (src/agent/planner.js)
-- decided to do about it ahead of me. `planned_at` null: not planned yet.
alter table commitment add column if not exists kind       text;
alter table commitment add column if not exists planned_at timestamptz;
alter table commitment add column if not exists plan       jsonb;
