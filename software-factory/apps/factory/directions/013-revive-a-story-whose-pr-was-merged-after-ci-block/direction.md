---
title: Revive a story whose PR was merged after a CI block
type: bug
priority: p1
explore: false
created_at: '2026-07-30T02:28:11.043462+00:00'
---

<!-- Sibling: flow.md carries the operator flow. -->

# Revive a story whose PR was merged after a CI block

## Why

When the CI-fix loop exhausts, `auto_merge` sinks the story to
`blocked_ci_unresolved` and auto-closes its PR. That is correct: the dev kept
producing an identical failure signature, so continuing would burn budget. The
state exists to hand the problem to a human.

But there is no way back. `blocked_ci_unresolved` is terminal, and
`reconcile_from_github` only considers stories in `auto_merge._MERGEABLE_STATES`
(`pr_open` / `ci_green` / `ready_for_merge`). So when the operator does exactly
what the state is asking for — fix the branch, get CI green, merge the PR — the
story stays blocked forever and every story depending on it stays
`blocked_dependency` forever.

Observed 2026-07-30 on direction 012: story 148's PR (#130) was fixed, went green
on all four checks, and was squash-merged to `main`. The code is live and
verified working. Story 148 is still `blocked_ci_unresolved`, and its five
dependent stories (149–153) are still `blocked_dependency`. A whole direction is
dead on disk while its first commit is in production.

This is the `detect-without-remediate` class one step further along: the factory
detects, escalates correctly, and then cannot accept the remediation.

## What

Make an operator-merged PR revive its story, so fixing the branch is a complete
recovery rather than a dead end.

## Acceptance Criteria

- `reconcile_from_github` considers stories in `blocked_ci_unresolved` that carry
  a positive `github_pr_number`, in addition to the current mergeable states.
- A story in `blocked_ci_unresolved` whose PR is MERGED on GitHub advances to
  `deploy_pending`, records a `merged=True` merge-action row, and enqueues the
  deploy — the same outcome as the normal reconciled-merge path.
- A story in `blocked_ci_unresolved` whose PR is still CLOSED-unmerged stays
  blocked, so reviving is driven by the real artifact and never by the mere
  passage of time.
- Reviving a story re-evaluates its dependents: a story in
  `blocked_dependency` whose blocker reached `deployed` becomes dispatchable
  again.
- The revival is logged as a `state_drift_reconciled` anomaly, like every other
  reconciliation, so it is never silent.
- A test asserts the full path: block a story on CI, merge its PR out of band,
  run reconcile, and observe `deploy_pending` plus an unblocked dependent.

## Out of scope

- Changing when the CI-fix loop gives up, or its cap. The give-up behaviour is
  correct.
- Auto-reopening PRs the factory closed. The operator reopens or re-pushes; this
  direction only makes the factory notice the result.
- Any change to `blocked_deploy_failed` or the other blocked sinks. One state,
  one fix, so the state-machine change stays reviewable.

## Open questions

- Whether reviving should require the merge commit to be an ancestor of the
  default branch, to avoid reviving on a merge into some other branch. Prefer
  yes if it is cheap — gate on the real artifact.
