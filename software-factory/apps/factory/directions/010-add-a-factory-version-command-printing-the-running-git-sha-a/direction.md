---
title: Add a factory version command printing the running git SHA and branch
type: feature
priority: p2
explore: true
created_at: '2026-07-21T06:16:58.470410+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Add a factory version command printing the running git SHA and branch

## Why

There's no quick way to see which factory commit/branch is actually running (the live checkout deploys via surgical `git checkout origin/main -- factory/`, so HEAD is not the source of truth). A `factory version` command that prints the current git commit SHA, branch, and whether the working tree is dirty gives operators an at-a-glance answer for 'what code is live?'. Small, read-only, isolated to the CLI plus a tiny git-inspection helper.

## Acceptance Criteria

- [ ] A new `factory version` CLI command prints the factory repo's current git commit SHA (short) and branch name to stdout.
- [ ] It also indicates whether the working tree is dirty (has uncommitted changes).
- [ ] The command is read-only (no writes, no network) and exits 0 in a valid git repo.
- [ ] A unit test invokes the underlying pure helper against a temp git repo and asserts the reported SHA/branch/dirty flag match the repo state.
