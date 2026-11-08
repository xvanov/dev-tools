-- The spend per local day (dailyBreakdown for the Meter page, dailyByPurpose
-- for `pa spend` and the budget) reads a week of llm_spend: 60k rows on the
-- work stack. From llm_spend_at_idx each row was read from the table; this
-- index holds every column those reads use, so they touch it alone.
create index llm_spend_day_cover_idx on llm_spend (at, model, purpose, cost_usd, ok);
