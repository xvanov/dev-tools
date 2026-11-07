# Factory ⇄ Personal Assistant job contract (v1, 2026-11-02)

The one interface between the personal assistant (PA, dev-tools/personal-assistant) and the
software factory (software-factory). The PA never imports factory code or reads its sqlite; it
runs these CLI commands on the factory's machine (locally, or typed into a termhub session on
that machine) and parses the JSON they print. Both sides build against this file in parallel.

All commands: `uv run factory <cmd>` from the factory checkout. Every `--json` command prints
exactly ONE JSON object on stdout and nothing else (logs go to stderr). Exit code 0 = the JSON
is a success shape; non-zero = stdout is `{"error": "<code>", "message": "..."}`.

## Delivery levels (shared vocabulary, ordered least → most autonomous)

`none` < `branch` < `draft_pr` < `pr` < `auto_merge` < `push_to_main`

- `none`      — work stays in the factory's worktree/local branch; nothing pushed.
- `branch`    — push the branch; open no PR.
- `draft_pr`  — push + open a DRAFT PR; never mark ready, never merge.
- `pr`        — open a ready PR; never merge.
- `auto_merge`— today's behaviour: merge when chain gates (+ required CI) pass.
- `push_to_main` — gates pass → fast-forward the default branch directly (no PR).

Per-app config (`apps/<app>/config.yaml`) sets only `delivery.default`. There is NO per-app
ceiling: a job's requested level wins in either direction (operator decision 2026-11-02 — the
operator tells the personal assistant the end state, and the assistant passes it on every job).
`delivery.max` in a config is refused at load. A malformed request resolves to `none`. Existing
apps with no `delivery` block behave exactly as today (`auto_merge`).

The PA always sends `--delivery` explicitly, chosen from what the operator asked for; the app
default applies only when a job omits it.

How the factory enforces it (see `factory/chain/delivery_gate.py`):

- The level is resolved ONCE when the job's story is spawned and recorded on the story
  (`StoryRecord.delivery_level` + a `delivery_level_resolved` event). Later app-config edits
  never change an in-flight story's level. An unknown/unreadable level resolves to `none`. A
  story with NO recorded level predates stamping and is backfilled with the pre-existing
  default, `auto_merge`.
- Every level runs the same chain (dev, review, tech_writer, docs enforcer) up to the point
  where work would leave the factory. Story end states, all terminal:
  `none` → `delivered_local` (committed on the local `story/<n>-<slug>` branch, nothing
  pushed); `branch` → `delivered_branch`; `draft_pr` / `pr` → `delivered_pr` (with the PR
  number, once its CI has been watched — see below); `auto_merge` / `push_to_main` → `deployed` (via `deploy_pending`).
- `push_to_main` first checks GitHub (`delivery_gate.push_to_main_preflight`):
  - if the default branch's own CI is red or still running, or GitHub cannot be read, the story
    is HELD (the same main-green hold PR merges get): untouched, re-checked every tick, with a
    `ci_hold_main_red:` reason visible in `factory inbox`. This is checked first: a red base
    holds even when it is also protected.
  - if the (green) default branch requires status checks or a pull request (branch protection
    or a ruleset), the factory never pushes directly and never forces. It FALLS BACK to
    `auto_merge` for that story (operator decision 2026-11-02): it opens a ready PR, re-stamps
    the story's level as `auto_merge`, and from then on the normal auto-merge path applies —
    main-green hold, the repo's required checks, the full gate set, then `gh pr merge --auto`.
    The fallback is recorded as a `push_to_main_fell_back_to_pr` story event with reason
    `push_to_main_fell_back_to_pr:<why>`, and `factory job status` reports it per story as
    `delivery_note`. When that PR merges, the push_to_main job is `done`. If opening the PR
    fails twice, the story parks in `blocked_deploy_failed`.
  - a hold is capped at 24 h: after that the story falls back to level `pr` (a ready PR for a
    human, ending `delivered_pr`), recorded the same way (`push_to_main_fell_back_to_pr:held
    since …`).
  Then it runs the full merge gate set against the worktree commit and pushes that exact
  commit to the default branch without force. Gate failures are capped at 3 per STORY (not per
  commit), then the story parks in `blocked_ci_unresolved`. If the push is not a fast-forward
  (or is rejected) it falls back to `pr`: the story's level is recorded as `pr`, a ready PR is
  opened, and the story ends in `delivered_pr`. Factory self-edits (`apps/factory`) are always
  treated as `pr` instead of `push_to_main`, because they must pass the PR staging gate.
- `draft_pr` / `pr` WATCH THE PR'S CI before delivering (2026-11-02; before this a story was
  `delivered_pr` the moment its PR opened, so a red CI never reached the dev). After the PR
  opens the story sits in `pr_open` (job `in_progress`, `why`: `… (watching CI on PR #N before
  delivery)`) and the factory reads ALL of the PR's checks every tick
  (`auto_merge._watch_ci_then_deliver`; required-only would miss repos with no branch
  protection):
  - green → `delivered_pr`.
  - red → the failing CI log goes back to the dev as a finding (the same CI-fix loop
    `auto_merge` has, `ci_fix_redispatch` events); the fix is pushed to the SAME PR and the
    watch restarts on the new head. At most 3 CI-fix cycles, and none when the last fix
    reproduced the identical failure.
  - The fix is pushed fast-forward only. If the PR branch has commits the factory did not
    write (a human pushed), the fix is NOT pushed — the factory never forces over a human.
  - The watch grades only the commit the factory pushed: if the PR head is someone else's
    commit, a red CI is not sent to the dev.
  - The dev is only sent a red run it can act on: a red made only of cancelled / timed-out /
    errored runs (infra), a red check with no fetchable GitHub Actions log, and a red on a
    docs-chain story are delivered with a note instead.
  - If the dev runs out of attempts on a CI fix, the failed fix is not pushed; the story is
    delivered (the PR still holds the last pushed commit) with a note.
  - The watch runs even when `auto_merge.enabled` is false in `factory_settings.yaml` (it never
    merges); with it off, nothing else in the auto-merge pass runs.
  - still red after that, no verdict within 2 h, or no checks at all within 10 min → STILL
    `delivered_pr` (the PR is the deliverable; the factory never closes it), with a `ci_note`
    on the story's `delivered` event (every "delivered with a note" case above), which
    `factory job status` reports as that story's
    `delivery_note` (e.g. `CI is RED on PR #18 (docker build) after 3 CI-fix cycle(s) (cap 3)
    — delivered for a human to fix`). A failing PR is also named in `why`.
  - never merged, never marked ready (a draft stays a draft), and the factory does not merge
    the base branch into a watched PR. A `factory job cancel` during the watch wins: the
    watch re-checks the durable cancel marker under the per-story lock before every write. A
    human closing the PR during the watch settles the story to `closed_by_operator`, as for a
    delivered PR. Solo-pipeline stories go through the same watch.
  - Exception: a `push_to_main` story that falls back to level `pr` (refused fast-forward, or
    the 24 h hold cap) is still settled to `delivered_pr` as soon as its PR opens, without the
    watch.
- Whenever a story with a PR settles below `auto_merge`, the factory disarms any GitHub
  auto-merge on that PR (`gh pr merge --disable-auto`), so an earlier `--auto` cannot merge it
  behind the job's back. `factory job cancel` does the same.
- A `delivered_pr` story whose PR a human merges is picked up by the factory's GitHub
  reconciliation and continues to `deploy_pending` → `deployed` like any merged work. If the
  human CLOSES it unmerged, the story settles to `closed_by_operator`.
- The `delivered_*` states never close the story's GitHub issue (the change is not on the
  default branch yet). They DO count as finished for the direction: once every story of a job
  is `delivered_*` (or otherwise resolved), the direction is complete and its tracker issue is
  closed by the factory's hourly issue hygiene.
- Multi-story jobs below `auto_merge`: a later story does not wait for an earlier sibling to
  deploy (it never will without a human); a sibling in `delivered_*` satisfies the ordering.
  The later story is STACKED: its branch is cut from the latest delivered sibling's branch (the
  local branch at `none`, `origin/<branch>` once pushed), so it builds on that work. Its PR still
  targets the default branch and its body says `Stacked on <branch> (PR #n)` — merge in order.
- Cancel vs. merge: the final merge / fast-forward and its `deploy_pending` write run under a
  per-story lock (`state/locks/story-<id>.lock`) that `factory job cancel` also takes, after a
  re-read of the story; a story cancelled while its gates ran is never merged or pushed.
  Cancellation is also recorded durably per job (`job_cancellations` table, written only by
  `factory job cancel`): the locked merge section refuses a cancelled job's story, the
  orchestrator never dispatches one (it re-parks it), and `persist_story` refuses to move a row
  out of `closed_by_operator` (a stale handler write-back); only `factory resume-story` may.
- Known gap: at `none`, the factory still opens the story's GitHub ISSUE (no code is pushed).

PA mode → delivery mapping (PA side owns this): plan→(not a factory job), local→none,
branch→branch, mr→draft_pr, full→draft_pr.

## Pipelines

`chain` (PM→SM→dev→reviewer→gates), `solo` (single dev agent + gates, B.1 solo mode), `auto`
(factory decides; v1: = app default, else `chain`).

Sharpened 2026-11-02 (`factory/job_routing.py`):
- Written to the direction frontmatter as `pipeline:`; absent = `auto`. `auto` resolves to the
  app's `pipeline_default` (`apps/<app>/config.yaml`; `chain | solo | auto`, default `chain`;
  an app default of `auto` also means `chain`). Change it with `factory app set <app>
  --pipeline-default`.
- Resolved ONCE at story spawn and stamped on the story (`StoryRecord.pipeline`); editing the
  direction or app config afterwards does not change an in-flight story.
- **`solo` is accepted** (production engine: `factory/chain/solo.py`). A solo story runs
  SM → ONE dev conversation (5400 s wall clock, up to 3 in-conversation gate rounds, a
  no-progress abort, ≤ 3 dev attempts) → tech-writer → docs-enforcer → the story's delivery
  level → the SAME merge gates and CI as `chain`. Only the reviewer round-trip is removed.
  The acceptance oracle is NOT required: when the app enables it, it is a required merge gate
  and its leak check blocks every solo dev dispatch; otherwise the independent checks are
  the test command, the merge gates and CI. A solo job is always ONE story and ONE PR: PM's
  slices are merged into one story (`solo_story_collapsed` event) and the dual-draft branch is
  skipped. Inside the conversation the gate also runs the app's own `lint_command`,
  `format_check_command` and `type_check_command`, measured first on a throwaway checkout of
  the base commit. Red on the dev's tree blocks the round when the base was green or unknown,
  or when the base was red but the tree's output names a file the base's did not (or names no
  file). Only a red whose flagged files were all flagged on the base passes, so the dev is never
  sent to fix unrelated files but cannot add to them (`solo_static_baseline` event). Each story logs
  what gated it (`solo_checks`, `solo_dev_rounds` events). `job_routing.SOLO_PIPELINE_IMPLEMENTED = False` is the kill
  switch (new solo requests → `pipeline_unavailable`; in-flight solo stories still finish
  as solo).
  The factory's own app (`apps/factory`) refuses solo with `pipeline_unavailable` unless its
  `config.yaml` sets `solo_allowed: true` (a reviewer-less self-edit is an operator decision).

## Model overrides

`--model <persona>=<model_id>` (repeatable) is written to the direction frontmatter as
`models: {persona: model_id}`.
- Keys: a persona name (`dev`, `reviewer`, `sm`, `pm`, `acceptance_author`, …) or
  `<persona>.<difficulty>` (`dev.hard`); the tiered key wins over the bare one.
- Values: `<provider>/<model>` LiteLLM ids. Providers: `azure/`, `azure_ai/`, `deepseek/`,
  `anthropic/` (ANTHROPIC_API_KEY), `openrouter/` (OPENROUTER_API_KEY), `openai/`,
  `openai_compat/` (generic OpenAI-compatible endpoint; OPENAI_COMPAT_API_KEY +
  OPENAI_COMPAT_API_BASE, both required). Full table: `factory/routes.yaml` header.
- **Precedence per key: job (`models:`) > app (`config.yaml::models`) > `factory/routes.yaml`.**
- Resolved at spawn and stamped on the story (`StoryRecord.model_overrides_json`); every run
  row records the model actually used, so cost/audit attribution follows the override.
- A model whose provider key (or required base URL) is not set degrades to the routes.yaml
  fallback with a warning, like a routes.yaml entry does — it is not an error.
- **Reviewer independence**: the reviewer must not share a model with any dev tier, checked on
  the MERGED map, and again on the models that will actually run here after missing-key
  degradation — both an override degrading onto the dev model and a routes.yaml dev tier
  degrading onto a job-named reviewer. A collision is refused with
  `{"error": "review_independence"}` — never auto-fixed; `FACTORY_ALLOW_REVIEW_COLLISION`
  does not apply to job/app overrides.
- Other refusals: `bad_model_flag` (not `persona=id`, or a persona given twice),
  `unknown_persona`, `bad_model_id` (no `<provider>/` prefix), `bad_pipeline`.
- Submit should call `factory.job_routing.resolve_job_routing(app_cfg, job_models=…,
  pipeline=…)` before writing the direction. A direction that reaches triage with a bad
  request anyway is set to `needs-direction` with `state.yaml::job_routing_error: {code,
  message}` before any PM call is spent.

## Commands

### `factory job submit --json`
```
--app <app>                      required unless --repo given
--repo <owner/name>              resolve to the registered app for that repo; error `unknown_repo` if none
--title <text>                   required
--ask-file <path> | --ask <text> required; the ask, in the requester's words + context (markdown)
--done <text>                    repeatable; acceptance criteria (one per flag)
--pipeline chain|solo|auto       default auto
--delivery <level>               optional; any level incl. push_to_main (no ceiling, see above)
--model <persona>=<model_id>     repeatable; per-job route override
--source <name>                  REQUIRED (no default); recorded on the direction; pa|human
                                 are auto-approved (see Approval)
--external-id <id>               the PA's run id; idempotency key per (source, external-id):
                                 a resubmit returns the existing job, does not create a second
--flow-file <path>               optional (added v1.1): becomes the direction's flow.md
--api-spec-file <path>           optional (added v1.1): becomes the direction's api_spec.md
```
Creates a direction (pre-approved for `--source pa|human`, see Approval below) so auto_pm_sync triages it on the next tick.
Success: `{"job_id": "<app>:<direction_id>", "app": "...", "direction_id": "...",
"direction_path": "...", "pipeline": "...", "delivery": "<effective>",
"delivery_requested": "<or null>", "created": true|false, "warnings": ["..."]}`

`pipeline` is the RESOLVED pipeline (`auto` → app default, else `chain`); the frontmatter keeps
the request. `warnings` (added v1.1, may be empty) — most importantly: the factory's backpressure
gate needs a `flow.md`, an `api_spec.md` or an explore tag. A job with none of them is created but
pm-sync deterministically marks it needs-direction, so `status` reports `needs_human`. Pass
`--flow-file` (numbered user steps) or `--api-spec-file` (METHOD /path → status) to avoid that.
A resubmit (`created: false`) returns the ORIGINAL job; the new flags are ignored.

`--title`, `--source`, `--external-id` and each `--done` must be single lines: a CR/LF is refused
with `invalid_argument` (it would inject sections into `direction.md`). A missing positional
job id on `status`/`cancel` is a `missing_argument` JSON error under `--json`.

Validation errors (`{"error": code, ...}`, exit 1): `missing_argument`, `invalid_argument`,
`unknown_app`, `unknown_repo`, `ambiguous_repo`, `app_repo_mismatch`, `invalid_delivery`,
`file_unreadable`, plus the routing refusals above, which submit gets from
`factory.job_routing.resolve_job_routing` unchanged: `bad_pipeline`, `pipeline_unavailable`,
`bad_model_flag`, `unknown_persona`, `bad_model_id` (a bare id with no `<provider>/` prefix),
`bad_models`, `review_independence`. Unexpected failures: `internal`, exit 2. Routing warnings
(e.g. a provider key not set here) are passed through in `warnings`.

A job IS a direction: `apps/<app>/directions/<id>-<slug>/`, frontmatter keys `source`,
`external_id`, `pipeline` (as requested), `delivery` (as requested, or null), `models` (the
job's own `persona → <provider>/<model>` map) — exactly the keys spawn's
`job_routing.resolve_for_direction` reads.

Approval: only `--source pa` and `--source human` are auto-approved. Those jobs get a signed
`operator_approval` record (and `pa` is also allowlisted as delegated operator intent, so a lost
`state.yaml` does not strand it). Any OTHER source's job is written WITHOUT an approval record
and waits under the normal approval policy (`factory.directions.approval`; human-prefixed
sources such as `operator-*` still auto-build there): `status` reports `needs_human` and
`warnings` names the `factory approve-direction <id> --app <app>` command.

### `factory job status <job_id> --json`
```
{"job_id", "app", "title", "source", "external_id",
 "state": "queued|triaging|in_progress|blocked|needs_human|done|failed|cancelled",
 "terminal": bool, "pipeline", "delivery",
 "stories": [{"id", "state", "pr_url", "pr_state": "open|merged|closed|null", "branch",
              "delivery_level", "delivery_note": "<or null>",
              "ci": {"state": "passing|failing|pending|none", "failing": [...], "pending": [...]}
                    | null}],
 "pr_urls": [...], "merged": bool, "cost_usd": number, "updated_at": ISO-8601 UTC,
 "why": "<one line: why blocked / what is happening, or null>"}
```
`done` = every story reached its delivery level's end. The level is the one the chain STAMPED on
each story at spawn (`stories[].delivery_level`), never recomputed from today's app config, and
the end state is the chain's own: `delivered_local` (none), `delivered_branch` (branch exists on
GitHub), `delivered_pr` (PR open or merged on GitHub; closed unmerged → `failed`), or merged
(`deploy_pending`/`deployed`): the PR is MERGED on GitHub, or for `push_to_main` (no PR) the
default branch ON GITHUB contains the fast-forwarded commit (compare API). A PR GitHub reports
merged counts as delivered whatever the local row says. A delivery only the local view claims
is never `done`. A `push_to_main` job whose default branch is protected is delivered through an
auto-merge PR instead (see delivery levels above): that story's `delivery_level` reads
`auto_merge`, its `delivery_note` is `push_to_main_fell_back_to_pr:<why>`, and its merged PR
makes the job `done`.

While any delivered PR's CI is still `pending` the job stays `in_progress` (`why`: `PR #N is
open; waiting for its CI (…)`), for at most 2 h after the story's last update. After that, or
once CI finishes, `done` says the delivery exists, NOT that its CI is green. For every still-OPEN PR the status
reads the PR's check rollup into `stories[].ci` (`null` when the PR is not open or GitHub could
not be asked), and any failing PR is named in `why` (`PR #N CI failing: <checks>`). A caller
reporting a job to a human must surface a failing `ci`.

State mapping, first match wins: cancel requested and no story live → `cancelled`; no stories →
direction `created`→`queued`, `pm-validated`→`triaging`, `needs-direction`→`needs_human`,
`closed`→`failed`; all stories delivered AND GitHub confirmed it → `done` (a delivery only the
local view claims stays `in_progress` with a `why`, never a terminal verdict from a local flag); any story in a pending-human sink →
`needs_human`; any story live → `in_progress` (`blocked` if the factory is halted/paused or every
live story is waiting on a dependency); else `failed`. Dual-draft losers are ignored. If `gh`
fails, PR fields fall back to the local view (`pr_state: null`) and `why` says
`GitHub unavailable, local view: …`. `--no-github` (added v1.1) skips GitHub on purpose.

### `factory job list --json [--source pa] [--active] [--app <app>] [--no-github]`
`{"jobs": [<status object>, ...]}` — one `gh pr list` per repo, however many jobs.

### `factory job follow <job_id>`
Human-readable, NOT JSON (`--interval <s>`, default 3). Streams the job's events (story transitions, handler runs, gate
results, PR links, cost) as they happen, and exits 0 when the job is terminal. This is what a
termhub session runs so the user can "walk into" a factory job.

### `factory job cancel <job_id> --json`
Stops further dispatch for the job's stories (park/close), never deletes evidence.
`{"job_id", "state": "cancelled", "stories_parked": [<story id>, ...],
"stories_left": [{"id", "state", "reason"}, ...]}`

A job that is already `done` is NOT cancelled: cancel is a no-op returning
`{"job_id", "state": "done", "stories_parked": [], "stories_left": [], "why"}` and writes
nothing (a cancel cannot un-deliver work). And `status` reports a fully delivered and
GitHub-confirmed job as `done` even if a cancel marker landed late, with a `why` saying so.

Otherwise every story that is not finished moves to `closed_by_operator`. That covers in-flight
stories and also the stuck sinks (`blocked_ci_unresolved`, `blocked_deploy_failed`,
`blocked_review_nonconvergent`, …). The direction is closed. FINISHED work is left alone:
`deploy_pending`/`deployed` (merged), `delivered_*`, the superseded dual-draft loser, and any
story whose PR GitHub reports merged. Every remaining story with an OPEN PR has GitHub
auto-merge disarmed (`gh pr merge --disable-auto`) before it is parked, whatever its state.
Open PRs are NOT closed. Each story is handled under the same per-story lock the auto-merge pass
holds around a merge: it is re-read inside the lock and parked with a compare-and-set. So a
cancel can never be overwritten by a merge, nor a merge by a cancel. Fail safe: lock busy,
GitHub unable to say whether the PR merged, or a failed disarm → that story is not parked and is
listed in `stories_left` with the reason; re-run cancel. Idempotent. Cancel first records a
durable per-job marker; an in-flight handler that later writes a stale state back cannot reopen
a parked story, and the orchestrator re-parks any story of a cancelled job instead of
dispatching it.

### `factory app add --json`
```
--repo <owner/name>          required
--path <local clone>         optional; clones to ../<name> (sibling of the factory) if absent
--name <app>                 optional; default = the repo name, slugged
--delivery-default <level>   default draft_pr for newly added repos (any level allowed)
--pipeline-default chain|solo|auto   default chain
--enable-tick / --force      optional
```
Registers any repo as a factory app: writes `apps/<app>/config.yaml` with detected gate commands
(deterministic toolchain detection: Makefile, Python, Node/TS, Go, Rust, .NET, JVM, Ruby, PHP;
an unrecognised repo still registers, with empty gates listed in `missing_gates`), creates
`directions/`.
`{"app", "repo", "path", "config_path", "gates": {...}, "delivery": {"default"},
"pipeline_default", "missing_gates": [...], "toolchains": [...], "notes": [...], "cloned", "tick"}`
Errors: `invalid_repo`, `invalid_name`, `invalid_delivery`, `invalid_pipeline`, `app_exists`,
`repo_already_registered`, `not_a_git_repo`, `repo_mismatch`, `clone_failed`, `enable_tick_failed`.

### `factory app set <app> --json`
```
--delivery-default <level>           optional
--pipeline-default chain|solo|auto   optional (at least one of the two)
```
Changes a registered app's defaults in place (only those lines of `config.yaml`; comments kept).
`{"app", "config_path", "delivery": {"default"}, "pipeline_default", "changed": [...],
"comments_preserved": bool}`
Errors: `unknown_app`, `invalid_name`, `nothing_to_set`, `invalid_delivery`, `invalid_pipeline`,
`invalid_config` (the result would not load, e.g. a leftover `delivery.max`).

### `factory app list --json`
`{"apps": [{"app", "repo", "path", "delivery": {"default"}, "pipeline_default"}]}`
