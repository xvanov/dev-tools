---
title: Add a --json output flag to the factory apps command
type: feature
priority: p2
explore: true
created_at: '2026-07-21T05:10:16.271060+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Add a --json output flag to the factory apps command

## Why

The `factory apps` command (D006) prints a human-readable table of configured apps and their key flags. Monitoring/automation (and loop-3 tooling) can't easily consume a Rich table. A `--json` flag that emits the same per-app data as a JSON array to stdout makes the command scriptable — e.g. `factory apps --json | jq` to check self_tick_enabled or deploy.enabled across apps. Small, additive, isolated to the CLI command plus its underlying list function; no behavior change to the default table output.

## Acceptance Criteria

- [ ] `factory apps --json` prints a JSON array to stdout, one object per configured app, with at least the keys: name, repo, self_tick_enabled, deploy_enabled.
- [ ] The default `factory apps` (no --json) still prints the existing human-readable table unchanged.
- [ ] The JSON output is valid, parseable JSON (e.g. json.loads succeeds) and is the only thing written to stdout in --json mode (no table).
- [ ] A unit test asserts that --json emits parseable JSON containing both apps and their self_tick_enabled / deploy_enabled values, and that the non-json path still renders a table.
