---
name: Direction
about: A high-level direction for the factory to plan and implement.
title: "[DIRECTION] "
labels: ["direction"]
---

<!--
HOW THIS WORKS

When you label this issue `direction`, the factory ingests it and creates a
local direction directory. The PM persona validates that it carries enough
backpressure (a user flow OR an API spec OR an `(explore)` tag) and then opens
or annotates a Direction Tracker issue.

If your direction is missing backpressure, the PM will label this issue
`needs-direction` and comment with what's needed. Edit the issue and the PM
re-runs on the next sync.

Sections below MIRROR the on-disk `direction.md` schema. Fill in what
applies; omit what doesn't. Use the `## User flow` and `## API spec` headings
EXACTLY if you want the factory to pull those sections into separate
`flow.md` / `api_spec.md` files.
-->

## Why

<!-- Why does this matter? One paragraph. -->

## Acceptance Criteria

- [ ]
- [ ]

## User flow

<!-- Optional. If present, will be extracted to flow.md. -->

## API spec

<!-- Optional. If present, will be extracted to api_spec.md. -->

## Tags

<!-- Optional. Examples: `(explore)`, `(security)`, `(ux)`. -->
