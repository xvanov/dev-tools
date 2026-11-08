-- Twin of sql/038_passkeys.sql (plan 7.1): passkey credentials, sessions
-- (keyed by the SHA-256 of the cookie) and one-approval step-up grants. Same
-- columns; see that file for what they hold.

create table passkey_credential (
  id            text primary key,
  public_key    text not null,
  counter       integer not null default 0,
  transports    jsonb not null default '[]',
  label         text not null default '',
  created_at    timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at  timestamptz
);

create table passkey_session (
  token_hash      text primary key,
  credential_id   text not null,
  created_at      timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at    timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at      timestamptz not null,
  hard_expires_at timestamptz not null
);
create index passkey_session_expires on passkey_session (expires_at);

create table passkey_stepup (
  approval_id   text primary key,
  credential_id text not null,
  granted_at    timestamptz not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at    timestamptz not null,
  consumed_at   timestamptz
);
