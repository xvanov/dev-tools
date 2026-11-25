-- The reconciler's full re-judge (src/ledger/reconcile.ts rejudge). The Postgres twin is sql/051.
--
--   commitment.ledger_full_at   when the reconciler last judged this commitment against every related
--                               item in its window, not only the ones fetched since ledger_checked_at.
--
-- Times are ISO-8601 text written by the app.

alter table commitment add column ledger_full_at text;
