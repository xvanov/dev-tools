-- The ledger: every change of a commitment's status, and the evidence behind
-- the ones the assistant makes on its own (DURABLE.md §2.1).
--
-- Status used to be a column that four closers overwrote, each its own way,
-- with nothing left behind but the last `closed_reason`. Now every change goes
-- through src/ledger (one function) and leaves a `transition` row: who made
-- it, why, from what to what, and the exact columns it replaced (`before`), so
-- any one of them can be undone — unless someone has changed the row since.
--
-- `evidence` is what the reconciler (src/ledger/reconcile.js) read in a newer
-- source item about an open commitment: the effect it judged (closes |
-- progresses | none), a verbatim quote checked against that item, and whether
-- it was applied. A close it was not sure enough to apply on its own is a
-- proposal: `decision` is null until I accept or reject it on the dashboard.
-- The quote is copied and the item id is `on delete set null`, because
-- retention deletes chat and mail and the history must survive it.

create table if not exists ledger_evidence (
  id              bigserial primary key,
  commitment_id   bigint not null references commitment(id) on delete cascade,
  source_item_id  bigint references source_item(id) on delete set null,
  effect          text not null,                    -- closes | progresses | none
  quote           text,
  confidence      real,
  method          text not null,                    -- rule | llm
  extracted_by    text not null,
  applied         boolean not null default false,
  decision        text,                             -- accepted | rejected (proposals only)
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (commitment_id, source_item_id, extracted_by)
);

create index if not exists ledger_evidence_open_idx
  on ledger_evidence (created_at desc) where effect = 'closes' and not applied and decision is null;

create table if not exists ledger_transition (
  id              bigserial primary key,
  commitment_id   bigint not null references commitment(id) on delete cascade,
  from_status     text not null,
  to_status       text not null,
  actor           text not null,                    -- you | reconciler | reply-close | github | self-notes | dispatch
  reason          text,
  evidence_id     bigint references ledger_evidence(id) on delete set null,
  before          jsonb not null,                   -- the columns this change overwrote
  at              timestamptz not null default now(),
  undone_at       timestamptz,
  undo            text
);

create index if not exists ledger_transition_commitment_idx on ledger_transition (commitment_id, at desc);
create index if not exists ledger_transition_at_idx on ledger_transition (at desc);

-- When the reconciler last judged this commitment against newer items; items
-- fetched after it are "new evidence". Null: never judged.
alter table commitment add column if not exists ledger_checked_at timestamptz;
