# Jobs — `factory job …`, the interface a personal assistant drives

## Overview

`factory job submit | status | list | follow | cancel` is how an outside
caller (the personal assistant, "PA") hands the factory work and tracks it.
The contract is `docs/JOBS-API.md`; the code is `factory/jobs/` plus the
Typer sub-app `factory/cli_jobs.py` (registered in `factory/cli.py` as
`job`).

**A job is a direction.** `submit` writes an ordinary
`apps/<app>/directions/<id>-<slug>/` directory. Everything downstream —
pm-sync, the backpressure gate, the chain, the merge gates — sees a normal
direction. The job id is `<app>:<direction_id>` (e.g. `sacrifice:021`).

## Modules

| Module | Role |
|---|---|
| `factory/jobs/common.py` | `JobError(code, message)`, job-id parse/format, discovery (`iter_jobs`, `find_job`). |
| `factory/jobs/submit.py` | validation, `--repo` → app, idempotency, atomic write, approval record, `directions` row. |
| `factory/jobs/github.py` | cached, fail-soft `gh` reads (one `gh pr list` per repo per call). |
| `factory/jobs/status.py` | state mapping, `list`, `cancel`. Read-only DB access (`mode=ro`). |
| `factory/jobs/follow.py` | plain-line live stream for a TermHub terminal. |
| `factory/cli_jobs.py` | the CLI; one JSON object on stdout with `--json`; everything else goes to stderr. |

## What a submit writes

- `direction.md` — built by `creator._build_direction_md`. The frontmatter also
  carries `source`, `external_id`, `pipeline` (as requested: `chain|solo|auto`),
  `delivery` (as requested, or null) and `models` (persona → model id).
  **The frontmatter `source` key is what marks a direction as a job.** The
  classic creators record `source` only in `state.yaml`.
- The ask goes under `## Why` with markdown headings demoted to bold lines, so
  they cannot end the section early or open a fake `## Acceptance Criteria`.
  The verbatim ask is kept in `artifacts/ask.md`.
- `--done` → `## Acceptance Criteria` bullets.
- Optional `flow.md` / `api_spec.md` from `--flow-file` / `--api-spec-file`.
- `state.yaml` — `status: created`, `source`, and a signed `operator_approval`
  record (`approved_by: "factory job submit:<source>"`).
- A `directions` row with `status=created` and `source`. This row is the
  approval gate's first source of truth. Writing it is best-effort, because
  `state.yaml` carries the same facts.

The directory is staged under `.job-staging-<hex>` and `rename`d into place.
A concurrent tick's pm-sync only lists `NNN-…` directories, so it can never
triage a half-written job. Submits are serialised by an `fcntl` lock on
`state/jobs-submit.lock`, so the id allocation, the idempotency scan and the
write happen as one step.

## Approval: why a job auto-builds

`factory.directions.approval` parks machine-filed directions until an
operator approves them. That gate exists to stop the factory filing work for
itself. A job is different: a human files it through an operator CLI, or the
PA files it after its human approved that exact plan. So:

- `pa` is in `approval._DELEGATED_HUMAN_SOURCES` (exact match). The PA's filing
  is operator intent, relayed. This keeps a PA job buildable even if
  `state.yaml` is lost (it is gitignored, D018) and only the row's `source`
  survives.
- Only `pa` and `human` jobs get the signed `operator_approval` record
  (`submit.AUTO_APPROVED_SOURCES`). Any other `--source` is not operator
  intent just because it reached this CLI: its job is written without the
  record, waits under the normal approval policy, and submit returns a
  `warnings` entry naming `factory approve-direction`.

## Validation

- `--delivery` goes through `factory.delivery.parse_level`. Every level is
  accepted, `push_to_main` included: there is no per-app ceiling. Garbage is
  an `invalid_delivery` error. The reported `delivery` is
  `effective_level(app.delivery, requested)` = the request, else the app's
  `delivery.default`.
- `--pipeline` and `--model persona=<provider>/<model>` are validated by
  `factory.job_routing.resolve_job_routing` (the same resolver spawn uses),
  via `submit.resolve_routing`; its `JobRoutingError` codes pass through
  (`bad_pipeline`, `pipeline_unavailable`, `bad_model_flag`,
  `unknown_persona`, `bad_model_id` for a bare id, `review_independence`).
  `auto` resolves to `AppConfig.pipeline_default` (whose `auto` = `chain`).
  The frontmatter keeps the request (`pipeline:`) and the job's own
  `models:` map; the JSON reports the resolved pipeline.
- Backpressure is checked at submit time (`validate_direction`). A job with no
  flow, no api spec and no explore tag deterministically lands in
  `needs-direction` at pm-sync. Submit still creates the job, but returns a
  `warnings` entry saying so.

Other modules decide how to honour `pipeline` / `delivery` / `models`. This
module only records, validates and reports them.

## Status mapping

First match wins (`status.py` docstring):

1. `cancelled`: a `job_cancelled` marker is present AND no story is live.
2. No stories: the direction status decides. `created` → `queued` (or
   `needs_human` if the approval gate parks it); `pm-validated` → `triaging`;
   `needs-direction` → `needs_human` (the `why` lists what is missing);
   `closed` → `failed`.
3. Every counted story is delivered → `done`. This holds only when GitHub
   CONFIRMED each delivery. A delivery that only the local view claims stays
   `in_progress`, with a `why` saying GitHub could not confirm it.
4. Any story is in a pending-human sink (`HUMAN_STATES` =
   `orchestrator._PENDING_HUMAN_STATES` minus `DELIVERED_UNMERGED_STATES`,
   derived, not copied) or is dependency-cap parked → `needs_human`.
5. Any story is live → `in_progress`. It is `blocked` instead when the factory
   is halted or in `paused` mode, or when every live story is
   still in `story_created` with a dependency deferral recorded.
6. Otherwise → `failed`.

`superseded_by_sibling` (the dual-draft loser) is ignored.

"Delivered" is read from the story itself — its stamped
`StoryRecord.delivery_level` and the chain's end state — never recomputed
from today's app config:

- any story whose PR GitHub reports MERGED (reconcile may lag).
- `delivered_pr`: GitHub says the PR is open or merged (closed → `failed`).
  Reached only after the chain watched the PR's CI; a red/unreported CI at
  delivery is the story's `delivery_note` (the `delivered` event's `ci_note`).
- `delivered_branch`: the branch exists on GitHub.
- `delivered_local`: nothing to confirm remotely (level `none`).
- `deploy_pending` / `deployed` with a PR: GitHub says the PR is merged.
- `deploy_pending` / `deployed` without a PR (`push_to_main`): the default
  branch on GitHub contains the fast-forwarded commit (`merge_actions` row
  under `-(story.id)`, checked with `GitHubView.branch_contains` — the
  compare API's `identical`/`behind`). The local row alone is never `done`.
- A `push_to_main` story that fell back to an auto-merge PR (protected base)
  is stamped `auto_merge`, so its merged PR is success. `stories[].delivery_note`
  carries the fallback reason, read from the story's
  `push_to_main_fell_back_to_pr` event (`status._delivery_note`).

**Merge reality comes from GitHub, never a local flag.** If `gh` fails, the
status uses the local view (`deploy_pending`/`deployed` = merged) for
everything except a terminal `done`, reports `pr_state: null`, and appends `GitHub unavailable, local view: …` to `why`.
`cost_usd` is the sum of `runs.cost_usd` where
`(app, direction_id)` matches or `story_id` is one of the job's stories.

## Cancel

Review 2026-11-02 rules (`status.cancel_job`), applied in this order:
- A `done` job is a no-op. Nothing is written and the real state is
  returned. Status also reports a fully confirmed job as `done` even if a
  cancel marker exists.
- Every non-finished story is parked, including stuck sinks
  (`blocked_ci_unresolved`, `blocked_deploy_failed`, …). Before parking, any
  open PR is disarmed, whatever the story's state.
- `closed_by_operator` and `quarantined_invalid_state` rows are left as
  they are.
- Each story is handled under `delivery_gate.story_lock` and parked with
  `delivery_gate.cas_story_state`. This is the same lock the auto-merge pass
  holds around its merge.
- `ci_pending` counts as in flight (`status._LIVE_BY_OMISSION`).

The job-level `delivery` is the explicit `--delivery` request. Without one,
it is the level stamped on the job's stories at spawn
(`status._job_level`), not today's app default.

Sets `state.yaml: job_cancelled`, moves every IN-FLIGHT story to
`closed_by_operator`, and closes the direction (`mark_direction_status`).
Finished work is never parked: `deploy_pending`/`deployed`, `delivered_*`
(`status.CANCEL_PROTECTED_STATES`), or a story whose PR GitHub reports
merged. A story with an open PR has its GitHub auto-merge disarmed
(`delivery_gate.disable_auto_merge`) before it is parked. If GitHub cannot
say whether the PR merged, or the disarm fails, the story is NOT parked and
is returned in `stories_left` with the reason (fail safe; re-run cancel).
`closed_by_operator` is terminal, not mergeable and not auto-recoverable.
Nothing is deleted: worktrees, branches, PRs, logs and spend all stay. Cancel
does not close PRs or issues; `factory reconcile-issues` closes the issues of
a closed direction.

There is no tick lock. An in-flight handler can write a parked story back to
a live state. When that happens, status does NOT report `cancelled`, and its
`why` says to re-run cancel. Cancel is idempotent.

## Follow

`follow` polls `job_status` every `--interval` seconds (GitHub at most every
15 s) and each story's `state/logs/<id>-<slug>.log` (the `factory trace`
stream). It prints one plain line per new event, story transition, PR link,
cost change or job-state change. It exits 0 when the job is terminal. A
terminal verdict is always re-confirmed with GitHub before it exits.

## Tests

`tests/test_jobs_cli.py`: everything runs against a `tmp_path` factory root
(`cli_jobs._FACTORY_ROOT` is patched), with `gh` mocked at
`factory.jobs.github._run_gh`.
