---
title: Seed recoverable blocked-story fixtures for UX audit
type: ux
priority: p2
explore: true
created_at: '2026-07-30T12:29:08.318526+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Seed recoverable blocked-story fixtures for UX audit

## Why

Without executable blocked-story and merged-PR fixtures, the audit cannot verify whether recovery is observable or confusing for operators.

## Acceptance Criteria

- [ ] UX audit can load a seeded blocked story, advance one tick, and capture before/after status evidence for the revival step.
