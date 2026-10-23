-- Projects whose folder is gone.
--
-- `pa projects sync` used to only add: a repo deleted from disk stayed an
-- active candidate, and the resolver kept routing new asks to a repo_path that
-- no longer exists (the old GitLab clones under C:\repos\gitlab were the case
-- that found it). Sync now sets `active = false` on a project whose repo_path
-- is missing and says why here; the row stays, so commitments, runs and
-- aliases that reference it keep their foreign keys. A folder that comes back
-- is reactivated by the next sync.

alter table project add column if not exists retired_at     timestamptz;
alter table project add column if not exists retired_reason text;
