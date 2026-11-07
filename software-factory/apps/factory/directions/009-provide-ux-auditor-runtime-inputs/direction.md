---
title: Provide UX auditor runtime inputs
type: ux
priority: p2
explore: true
created_at: '2026-07-21T06:12:46.752148+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Provide UX auditor runtime inputs

## Why

The auditor cannot validate user flows without the actual flow definitions and target app runtime.

## Acceptance Criteria

- [ ] Scheduled UX audit input includes at least one flow.md plus app URL/runtime context.
- [ ] UX auditor can reference concrete flow filenames and step numbers from supplied artifacts.
