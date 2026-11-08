# Picking up work: `--branch`, `--pr`, `factory job resume`

JOBS-API v1.3 (contract: `docs/JOBS-API.md` § v1.3). Two things the factory used to lack:

1. A job that died or did not finish restarted only by resubmitting it, which rebuilt everything
   on a new branch with a new PR.
2. Work a human started on their own branch or PR could not be handed to the factory.

## Hand the factory an existing PR

```bash
uv run factory job submit --json --source pa --app demo \
  --title "Make the login PR mergeable" \
  --ask "Finish the login page and get CI green." \
  --done "A wrong password shows an error" \
  --pr 42 --delivery pr
```

- Submit reads PR #42 from GitHub. It refuses a PR that is merged or closed (`pr_not_open`) or
  comes from a fork (`pr_from_fork`).
- The job's one story checks out the PR's head branch (`origin/<branch>`) in its worktree and
  works there. The dev loop, review loop (`chain`), and in-conversation gates (`solo`,
  `claude_session`) run as for any job.
- Delivery pushes to that branch, which updates PR #42. No second PR is opened. The CI watch and
  the CI-fix loop run on PR #42. At `auto_merge` the factory merges it when the gates and
  required CI pass, and keeps the branch.
- The PR's unresolved review threads (for example from a review bot) are copied into the ask at
  submit, so the dev addresses them.

## Hand the factory an existing branch

```bash
uv run factory job submit --json --source pa --app demo --title "..." --ask "..." \
  --branch feature/login --delivery draft_pr
```

If an open PR has `feature/login` as its head, it is used exactly as with `--pr`. Otherwise the
factory commits onto the branch, pushes it, and at `draft_pr`/`pr`/`auto_merge` opens a PR from
it into the default branch.

## What the factory never does to a picked-up branch

- force-push (pushes are fast-forward; it first merges whatever a human pushed meanwhile);
- push a CI fix over commits it did not write;
- delete the branch, close the PR, or rebuild it from scratch on a conflict (the story parks for a
  human instead);
- change the PR's title, body, draft state or base.

Only one unfinished job may work on a branch at a time (`branch_busy`).

## Resume a job

```bash
uv run factory job resume demo:014 --json
```

Works on a job that is `failed`, `cancelled`, `needs_human` (a story parked for a human), or
**stalled**. Stalled means `in_progress`/`blocked` with no change to any story, audit entry or
agent run for 3 h (`factory job status` reports `"stalled": true`; tune with
`FACTORY_JOB_STALL_S`). A running job is refused with `job_running`; a done job with `job_done`.

Per story:

| story | what resume does |
|---|---|
| merged, `delivered_*`, dual-draft loser | kept as it is |
| has a PR | back to the merge gates / CI watch on that PR (no persona re-runs) |
| dev or SM already ran | back to dev, on its existing branch and worktree |
| docs chain, its SM ran | back to the docs onboarder; output a failed commit left in the worktree is committed, not re-generated |
| never started | rebuilt from the SM |

Each story keeps its branch, PR, issue, history and spend. Only the counters that would re-park
it at once are reset. A cancelled job is un-cancelled first, and its direction re-opened. If no
story can be resumed (for example a story is over its spend cap), nothing changes and the
command answers `resume_refused` with the reasons.

A research/report job that failed or was cancelled goes back to the queue and runs again from a
fresh workspace.

## Limits

- Review threads are read once, at submit. Comments posted later are not read, and threads are
  never answered or resolved.
- A PR into a branch other than the default is refreshed and pushed against its own base, but the
  local gates still diff against the default branch.
- If the operator's source checkout has the picked-up branch checked out, git refuses to create
  the story worktree. Switch that checkout to another branch.
- Resume re-opens the GitHub issues of resumed stories best-effort. If that fails and the issue
  stays closed, the issue hygiene can settle the story to `closed_by_operator` when it next waits
  on a human.
