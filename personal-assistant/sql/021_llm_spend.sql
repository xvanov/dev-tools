-- Model spend, one row per model call (DURABLE.md §2.4, "Cost cap").
--
-- Until now the only record of what a model call cost was an in-memory sum in
-- src/llm.js, gone with the process. A proactive agent that does speculative
-- work ahead of me needs a ceiling, and a ceiling needs a durable count: the
-- worker restarts, `pa` runs in its own process, and both spend the same money.
--
-- `purpose` is the pass that made the call ('distill', 'reconcile', 'draft',
-- 'memory-extract', 'connector', ...): it is what src/budget.js caps and what
-- `pa spend` groups by. `cost_usd` is what `claude -p` reported, an estimate
-- from token usage for the API backend, or null when neither is known — a null
-- is "unknown", not "free". No prompt or reply text is stored here, ever.

create table if not exists llm_spend (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  purpose         text not null,
  model           text,
  backend         text not null,                    -- cli | api
  cost_usd        numeric(12, 6),
  input_tokens    integer,
  output_tokens   integer,
  duration_ms     integer,
  ok              boolean not null
);

create index if not exists llm_spend_at_idx on llm_spend (at desc);
