---
title: Monitor main-branch CI health post-merge and auto-file a fix on red
type: infra
priority: p1
explore: true
created_at: '2026-07-19T14:36:29.872653+00:00'
---

<!-- Optional sibling files: flow.md (user flow), api_spec.md (API contract), artifacts/ (binaries) -->

# Monitor main-branch CI health post-merge and auto-file a fix on red

## Why

The factory gates PRE-merge required checks (branch protection: a PR only merges when its required checks pass on the branch — verified working). But there is NO monitor for CI health on main AFTER merge. A required check that goes red on main post-merge (flaky test, merge-interaction failure not seen on the isolated branch, an infra/runner change, or a check that became red for any reason) sits UNNOTICED — observed 2026-07-19: sacrifice main showed a red typecheck check for ~8h with nothing reacting. The desired flow (operator): CI runs in the PR and only a green branch merges to main (already enforced); then on merge to main CI runs again, and IF it fails there, the factory should automatically file an issue so it gets fixed via the normal chain. WHAT TO BUILD: a tick/scheduled check per app that polls the latest completed main CI run for the app's repo (gh run list --branch main / gh api commits/{sha}/check-runs); if a REQUIRED check is red/failing on main, auto-file a direction (source: ci-health) capturing the failing job + its `gh run view --log-failed` digest, so the factory dispatches a fix through dev->review->CI->merge. Advisory-only red checks (not in the required set) should emit at most a warning, NOT an issue (avoid noise). Dedup: do not re-file the same main-CI failure (same check + same failure signature) while an open ci-health direction/issue for it exists. This closes the 'red on main goes unnoticed' gap while keeping the pre-merge gate as the primary defense.

## Acceptance Criteria

- [ ] A required check failing on an app's main branch results in an auto-filed ci-health direction/issue within one monitor cycle, carrying the failing job name + log digest.
- [ ] Advisory-only (non-required) red checks do NOT file an issue (warning at most).
- [ ] Dedup: the same main-CI failure is not re-filed while an open ci-health item for it exists.
- [ ] The pre-merge required-check gate remains the primary defense (unchanged); this is the post-merge safety net.
