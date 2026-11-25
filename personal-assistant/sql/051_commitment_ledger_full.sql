-- The reconciler's full re-judge (src/ledger/reconcile.ts rejudge). The SQLite twin is sql-sqlite/023.
--
--   commitment.ledger_full_at   when the reconciler last judged this commitment against every related
--                               item in its window, not only the ones fetched since ledger_checked_at.
--                               A verdict on one item was final: Jon's "Done." judged as no more than
--                               progress stayed that way, and the card stayed open for good. Open
--                               commitments are judged whole again every few days.

alter table commitment add column if not exists ledger_full_at timestamptz;
