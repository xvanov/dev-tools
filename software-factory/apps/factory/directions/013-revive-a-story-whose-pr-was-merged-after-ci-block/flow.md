# Operator flow — recovering a CI-blocked story

1. **Find the blocked story.** The operator runs `factory queue --app factory`
   and sees a story at `blocked_ci_unresolved`, with its dependents at
   `blocked_dependency`.

2. **Read why it gave up.** `factory why <id>` shows the `ci_fix_redispatch`
   attempts and the exhaustion reason (e.g. `identical_failure_signature`), and
   the auto-close comment on the PR says the same.

3. **Fix the branch.** The operator pushes a fix to the story's branch, reopens
   the PR if the factory closed it, and watches CI go green.

4. **Merge it.** The operator squash-merges the PR. The code is now on the
   default branch.

5. **Observe the story revive.** On the next tick the operator sees the story
   move from `blocked_ci_unresolved` to `deploy_pending`, and then `deployed` —
   without hand-editing the database. Today this step never happens.

6. **Observe the dependents release.** The stories that were
   `blocked_dependency` on it become dispatchable, and the direction continues
   on its own.

7. **Confirm nothing revived spuriously.** A different story whose PR was closed
   without merging is still `blocked_ci_unresolved` after the same tick.
