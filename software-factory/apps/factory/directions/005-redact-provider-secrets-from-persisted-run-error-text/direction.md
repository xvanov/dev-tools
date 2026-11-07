---
title: Redact provider secrets from persisted run error text
type: security
priority: p2
explore: true
created_at: '2026-07-20T23:33:56.892357+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Redact provider secrets from persisted run error text

## Why

Every chain-persona run persists its `error` string into the runs table (state/factory.db) via `factory.runner._record_run`. When a provider SDK raises on an auth/rate-limit failure, the exception message can embed the API key or Authorization header verbatim (e.g. an OpenAI/Anthropic `sk-...` token or a Bearer token). That secret is then written to the DB in cleartext and re-surfaces in `factory spend`/audit output and in any copy of the DB. Secrets must never be persisted. The fix is small, isolated to the runner, and has an obvious pure-function core.

## Acceptance Criteria

- [ ] A pure helper redacts common provider-secret patterns from an arbitrary string — OpenAI/Anthropic `sk-...` and `sk-ant-...` tokens, `Bearer <token>` and `Authorization: ...` headers, and long key-like hex/base64 runs — replacing each occurrence with the literal `[REDACTED]`.
- [ ] `factory.runner._record_run` applies the redactor to the `error` value before the run row is written, so no persisted run row can contain a raw secret.
- [ ] The redactor is idempotent (re-redacting already-redacted text is a no-op) and leaves text that contains no secret pattern byte-for-byte unchanged.
- [ ] Unit tests cover: a string containing an `sk-...` token is redacted; a `Bearer`/`Authorization` header value is redacted; a plain error message is unchanged; and the redaction is actually applied on the `_record_run` persistence path (a run recorded with a secret-bearing error stores `[REDACTED]`).
