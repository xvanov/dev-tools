-- Requests for a credential or a login, answered by the human in the
-- dashboard or with `pa secret set`.
--
-- **The value is never stored here.** A row says what is needed, why, and
-- where the answer will go; the answer itself goes from the browser (or the
-- terminal) straight into Windows Credential Manager or the gitignored
-- `.env`. Nothing in this table is secret: `hint` and `url` are guidance
-- such as where to create a token.
--
-- kind = 'secret' asks for a value under `name` (an env-style name such as
-- PA_JIRA_API_TOKEN). kind = 'login' asks the human to do something this
-- tool cannot do for them — re-authenticate a connector in /mcp, widen a
-- `gh` scope — and `name` is a stable key for it (login:github-projects).

create table if not exists secret_request (
  id            bigserial primary key,
  kind          text not null default 'secret' check (kind in ('secret', 'login')),
  name          text not null,
  purpose       text not null,
  hint          text,
  url           text,
  command       text,                        -- for a login: what to run, shown with a copy button
  requested_by  text not null default 'user', -- agent | routine | cli | user | doctor | ingest:<source>
  target        text not null default 'credential-manager'
                check (target in ('credential-manager', 'env-file', 'action')),
  status        text not null default 'pending'
                check (status in ('pending', 'fulfilled', 'declined', 'expired')),
  created_at    timestamptz not null default now(),
  fulfilled_at  timestamptz,
  stored_in     text                          -- where the value went: credential-manager | env-file
);

-- One open request per name: every pass that finds the token missing asks
-- again, and the second ask must find the first.
create unique index if not exists secret_request_pending_name
  on secret_request (name) where status = 'pending';

create index if not exists secret_request_name_idx on secret_request (name, fulfilled_at desc);
