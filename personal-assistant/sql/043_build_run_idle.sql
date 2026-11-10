-- Build run heartbeat (src/build/heartbeat.ts): when the run last showed life,
-- what the sampler concluded (JSON {state, since, last_tool, last_line}) and
-- how long a silence makes it `idle` (per run, set when it starts).
alter table build_run add column if not exists last_activity_at text;
alter table build_run add column if not exists activity text;
alter table build_run add column if not exists idle_after_s integer not null default 240;
