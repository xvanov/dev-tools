---
title: Attach gate findings to UX audit inputs
type: ux
priority: p2
explore: true
created_at: '2026-07-30T12:29:08.352116+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Attach gate findings to UX audit inputs

## Why

The operator-facing quality of test-gate messages cannot be assessed unless the audit receives the actual finding text and location evidence.

## Acceptance Criteria

- [ ] Scheduled UX audit input includes reproducible `tests-meaningful` finding artifacts showing rule id, file, line, and remediation text.
