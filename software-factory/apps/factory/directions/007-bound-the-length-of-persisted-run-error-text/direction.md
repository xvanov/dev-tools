---
title: Bound the length of persisted run error text
type: infra
priority: p2
explore: true
created_at: '2026-07-21T02:18:56.197105+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Bound the length of persisted run error text

## Why

`factory.runner._record_run` persists the full `error` string (after secret redaction) into the runs table. A stack-trace flood or a multi-megabyte provider error can bloat state/factory.db and slow `factory spend`/audit queries. Bound the persisted error to a sane maximum with a clear truncation marker so accounting stays lean. Small, pure, one call site.

## Acceptance Criteria

- [ ] A pure helper truncates a string to a bounded max length (default 4000 chars), appending a clear marker like '...[truncated N chars]' when it cuts.
- [ ] `_record_run` applies the bound to the (already-redacted) error before persisting, so no runs row stores an error longer than the bound.
- [ ] Text at or under the bound is returned unchanged; the helper is idempotent.
- [ ] A unit test covers: an over-long error is truncated with the marker on the persistence path, and a short error is stored verbatim.
