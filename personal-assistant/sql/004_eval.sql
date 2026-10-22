-- Retrieval and memory eval harness.
--
-- Every later change to search or memory is judged against these rows, so the
-- shape is deliberately boring:
--
--  * eval_case holds questions, never copies of what answers them. The gold is
--    a set of source_item ids, so a case keeps pointing at the evidence after a
--    re-chunk, a re-embed or a new retriever. Real questions live here and
--    nowhere else — not in fixtures, not in the repo.
--  * Abstention cases are the ones with no gold ids and no gold answer: the
--    right behaviour is to find nothing confident.
--  * eval_run stores per-case results as well as the rollup, so two runs can be
--    compared on the cases they share after the case set has been pruned.

create table if not exists eval_case (
  id             bigserial primary key,
  question       text        not null,
  qtype          text        not null,   -- single_session | multi_session | temporal
                                         -- knowledge_update | abstention
  gold_item_ids  bigint[]    not null default '{}',
  gold_answer    text,
  as_of          timestamptz,            -- when the question is asked; "latest" is relative to this
  origin         text        not null default 'manual',  -- generated | manual | miss
  active         boolean     not null default true,
  created_at     timestamptz not null default now(),
  notes          text
);

create index if not exists eval_case_active_idx on eval_case (active, qtype);

create table if not exists eval_run (
  id         bigserial primary key,
  ran_at     timestamptz not null default now(),
  retriever  text        not null,
  config     jsonb       not null default '{}'::jsonb,
  metrics    jsonb       not null default '{}'::jsonb,
  per_case   jsonb       not null default '[]'::jsonb
);

create index if not exists eval_run_retriever_idx on eval_run (retriever, ran_at desc);
