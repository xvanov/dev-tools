---
title: Add a factory apps CLI command listing configured apps and key config
type: feature
priority: p2
explore: true
created_at: '2026-07-21T01:54:35.456383+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Add a factory apps CLI command listing configured apps and key config

## Why

Operators (and loop-3) have no single command to see which apps the factory is configured for and their key safety-relevant flags. Today you must open each apps/<name>/config.yaml by hand to check repo, self_tick_enabled, and deploy.enabled. A `factory apps` command that lists every configured app with those fields gives fast, auditable visibility (e.g. confirming self_tick_enabled is off on the factory app, or which apps have deploy enabled). Small, read-only, isolated to the CLI + a tiny loader over apps/*/config.yaml.

## Acceptance Criteria

- [ ] A new `factory apps` CLI command lists every app under apps/ that has a config.yaml, one row per app.
- [ ] Each row shows at least: app name, repo, self_tick_enabled, and deploy.enabled (reading the effective values from the app's config.yaml).
- [ ] The command is read-only — it never mutates any config or state — and exits 0 when at least one app is found.
- [ ] A unit test invokes the command (or its underlying pure list function) against a temp apps/ tree with two app configs and asserts both apps and their self_tick_enabled / deploy.enabled values appear in the output.
