---
title: Stop committing machine-written direction and story state
type: refactor
priority: p1
explore: false
created_at: '2026-07-30T14:13:55.952045+00:00'
---

<!-- Sibling: flow.md carries the operator flow. -->

# Stop committing machine-written direction and story state

## Why

Direction 012 made the `directions` table authoritative for a direction's status
and demoted `state.yaml` to a regenerable projection. Verified: deleting a
direction's `state.yaml` leaves its status intact in the database and does NOT
cause `pm-sync` to re-triage it.

The prerequisite is done. The payoff was never taken. `state.yaml` is still
tracked, so the machine still rewrites files that land in git — 9 touches across
the last 12 commits — and `apps/<app>/stories/*.md` still arrive as untracked
files after every tick (6 sitting in the tree right now). The original complaint
that started direction 012 — machine state committed as source, so `git status`
is never clean and real edits are lost in the churn — is unchanged.

Nothing reads the committed copies. Story markdown is rendered from
`stories.sm_result_json`, which is already in the database, and the only code that
ever read `apps/<app>/stories/` was a path that never resolved (removed
2026-07-29). `state.yaml` is now a projection of the `directions` row.

## What

Stop tracking the machine-written artifacts, keep writing them on disk for human
inspection, and make a fresh clone able to reconstruct them.

## Acceptance Criteria

- `apps/*/directions/*/state.yaml` is gitignored, and `git status` is clean
  immediately after a tick that changes a direction's status.
- `apps/*/stories/*.md` is gitignored, and `git status` is clean immediately after
  a tick that spawns or advances a story.
- Both are still WRITTEN to disk, so an operator can read them without querying
  the database.
- `factory directions-backfill` continues to import an on-disk direction that has
  no database row, so a direction hand-written between clones is not lost.
- A command regenerates a missing `state.yaml` for every direction from the
  database, and running it on a clean tree produces no git diff.
- The already-committed copies are removed from tracking in the same change, so
  the working tree stops showing them as modified.
- A test asserts that after simulating a status transition, `git status
  --porcelain` for `apps/` is empty.

## Out of scope

- Rewriting git history to purge the previously-committed copies. They are small
  text files; history rewriting invalidates open branches and PRs.
- `direction.md`, `flow.md`, `api_spec.md` and `artifacts/`. Those are
  human-authored source and MUST stay tracked — this direction is only about
  machine-written state.
- `apps/<app>/context/*.md`. Generated, but small, human-read, and diff-visible
  drift there is useful.
- Moving story markdown INTO the database. It is already derivable from
  `stories.sm_result_json`; this direction only stops tracking the rendered copy.

## Open questions

- Whether the regenerate command should be its own verb or a flag on
  `directions-backfill`. Prefer a flag if the semantics stay obvious.
