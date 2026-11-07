---
title: Gate UX audits on available flow artifacts
type: ux
priority: p2
explore: true
created_at: '2026-07-21T12:05:20.823485+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Gate UX audits on available flow artifacts

## Why

The auditor cannot empirically replay user flows when no flow narratives are present in the invocation context.

## Acceptance Criteria

- [ ] UX auditor run is skipped or marked not-applicable when zero flow.md files are available.
- [ ] Invocation payload includes at least one flow.md path and contents before replay-based auditing runs.
