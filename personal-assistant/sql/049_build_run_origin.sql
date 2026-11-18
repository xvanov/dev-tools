-- Scheduled Build runs (src/routines/actions/buildRun.ts): where a run came from.
-- null for a run somebody started; 'routine:<id>:<name>' for one a routine fired
-- (src/build/origin.ts). The routine's next fire looks for a live run with its
-- prefix, so a slow run is never piled on.
alter table build_run add column if not exists origin text;
