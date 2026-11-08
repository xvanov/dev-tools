-- Passkey (WebAuthn) sessions and step-up grants (plan item 7.1; src/auth,
-- src/repo/passkeys.js). Behind PA_PASSKEYS=on; with the flag off nothing reads
-- or writes these tables.
--
-- passkey_credential  one row per registered authenticator: the credential id
--                     and its COSE public key (both base64url), the signature
--                     counter, and where it was last used. Never a secret.
-- passkey_session     a browser session, keyed by the SHA-256 of the cookie
--                     value (the cookie itself is never stored). Short idle
--                     expiry that slides on use, and a hard ceiling.
-- passkey_stepup      a fresh passkey assertion bound to ONE approval id (a
--                     merge, a push to main, a secret reveal). Expires in
--                     minutes and is burned by the first call that uses it.
--
-- Additive (expand): new tables only.

create table if not exists passkey_credential (
  id            text        primary key,
  public_key    text        not null,
  counter       bigint      not null default 0,
  transports    jsonb       not null default '[]',
  label         text        not null default '',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create table if not exists passkey_session (
  token_hash      text        primary key,
  credential_id   text        not null,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  hard_expires_at timestamptz not null
);

create index if not exists passkey_session_expires on passkey_session (expires_at);

create table if not exists passkey_stepup (
  approval_id   text        primary key,
  credential_id text        not null,
  granted_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz
);
