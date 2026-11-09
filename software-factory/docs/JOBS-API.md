# Factory ⇄ Personal Assistant job contract (v1, 2026-11-02; v1.2 additions 2026-11-06, v1.3 and v1.4 additions 2026-11-07, v1.5 and v1.6 2026-11-08, v1.7 2026-11-08, v1.8 2026-11-09, at the end)

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
  no-progress abort, ≤ 3 dev attempts) → [review] → tech-writer → docs-enforcer → the
  story's delivery level → the SAME merge gates and CI as `chain`. The review runs on the
  `api` runtime only: the chain's reviewer persona (routes.yaml's model, never a dev tier's;
  one resolving to the dev's model is refused) for at most 2 cycles, so a blocking finding
  gets ONE fix round and one that survives it parks the story in
  `blocked_review_nonconvergent`. A `claude_session` solo story has no reviewer.
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

## Transport (plan 2.1)

Every command below is the `factory` CLI. A caller on the factory's machine may
instead send it to a running `factory serve`:

    POST http://127.0.0.1:7330/api/cli      (header X-Factory: 1)
    {"argv": ["job", "status", "<job_id>", "--json"]}
    -> {"code": <exit code>, "stdout": "<exactly the CLI's stdout>", "stderr": "...", "ms": n}

Same command, same validation, same JSON (it runs in serve's warm process, so it
skips the 5–10 s `uv run`). `job status`, `job list` and `app list` answer from
local state plus a background GitHub snapshot (v1.7); every other verb runs the
CLI in-process. Allowed: every `job` verb except `follow`, and every
`app` verb; anything else is HTTP 400. Nothing listening (serve not running or
restarting) means the command did not run: use the CLI. `factory serve` also POSTs
job state changes to the personal assistant (`/api/factory/events`). See
`docs/WINDOWS.md`.

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
`file_unreadable`, `gates_not_configured` and `gate_requirements_missing` (code jobs; see
"Gates" below), plus the routing refusals above, which submit gets from
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
`{"jobs": [<status object>, ...]}`. The CLI does one `gh pr list` per repo, however
many jobs. `factory serve` serves the same objects from the v1.7 snapshot.

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

### Gates (2026-11-09)

Each of `gates.lint_command`, `format_check_command`, `type_check_command` and
`test_command` is in one of three states (`factory/gate_model.py`):

- a shell command, run in the story worktree;
- `none`: the repo has no such check (a docs-only repo has no tests). Skipped, and reported as
  `not configured: skipped`, never as passing;
- empty: not configured yet.

`gates.requires: {test: [lychee], lint: [docker]}` names executables a gate needs on PATH. They
are checked up front: at submit, and before a dev run (a missing one blocks the story with
`gate test needs lychee, not on PATH` and costs no dev retry).

A code job is refused at submit, before anything is written, with:

- `gates_not_configured`: the test gate is empty and the repo has no `tests/` for the default
  `python -m pytest`, so no job could pass it. The message names the fix
  (`factory app set <app> --gate test="<cmd>"` or `--gate test=none`). An empty test gate on a repo
  that has `tests/` (or no checkout to look at) is a submit `warnings` entry instead.
- `gate_requirements_missing`: a gate that will run requires a binary not on PATH.

### `factory app add --json`
```
--repo <owner/name>          required
--path <local clone>         optional; clones to ../<name> (sibling of the factory) if absent
--name <app>                 optional; default = the repo name, slugged
--delivery-default <level>   default draft_pr for newly added repos (any level allowed)
--pipeline-default chain|solo|auto   default chain
--gate NAME=COMMAND          optional, repeatable; NAME lint|format_check|type_check|test;
                             COMMAND `none` = no such check. Overrides detection.
--requires NAME=tool,tool    optional, repeatable
--enable-tick / --force      optional
```
Registers any repo as a factory app: writes `apps/<app>/config.yaml` with detected gate commands
(deterministic toolchain detection: Makefile, Python, Node/TS, Go, Rust, .NET, JVM, Ruby, PHP;
an unrecognised repo still registers, with empty gates listed in `missing_gates`), creates
`directions/`. For a gate detection left empty, `suggested_gates` proposes one: mirrored from the
repo's CI (`.github/workflows/*.yml`, `.gitlab-ci.yml`; setup steps such as `npm ci` kept as a
prefix; the tools named become `requires`), else `none` for a docs-only repo. Suggestions are
written as comments only; confirm them with `--gate`.
`{"app", "repo", "path", "config_path", "gates": {...}, "requires": {...}, "delivery": {"default"},
"pipeline_default", "missing_gates": [...], "suggested_gates": {"<field>": {"command",
"requires", "source"}}, "docs_only", "ci": [{"gate", "command", "requires", "source"}],
"readiness": {...}, "toolchains": [...], "notes": [...], "cloned", "tick"}`
Errors: `invalid_repo`, `invalid_name`, `invalid_delivery`, `invalid_pipeline`, `invalid_gate`,
`invalid_requires`, `app_exists`, `repo_already_registered`, `not_a_git_repo`, `repo_mismatch`,
`clone_failed`, `enable_tick_failed`.

### `factory app set <app> --json`
```
--delivery-default <level>           optional
--pipeline-default chain|solo|auto   optional
--gate NAME=COMMAND                  optional, repeatable; `none` = no such check, empty = unset
--requires NAME=tool,tool            optional, repeatable; empty removes the gate's list
```
At least one is required. Changes a registered app's defaults and gates in place (only those lines
of `config.yaml`; comments kept; `requires` is written as one flow-style line).
`{"app", "config_path", "delivery": {"default"}, "pipeline_default", "gates": {...},
"readiness": {...}, "changed": [...], "comments_preserved": bool}`
Errors: `unknown_app`, `invalid_name`, `nothing_to_set`, `invalid_delivery`, `invalid_pipeline`,
`invalid_gate`, `invalid_requires`, `invalid_config` (the result would not load, e.g. a leftover
`delivery.max`).

`gates` (here, `app show` and `app list`): `{"lint"|"format_check"|"type_check"|"test":
{"field", "state": "command"|"none"|"unset", "command", "requires": [...], "missing"?: [...]}}`.
`readiness`: `{"status": "configured"|"not_configured"|"missing_tool", "unset": [...],
"missing_tools": {gate: [tool]}, "blocking": "<why a code job is refused>"|null, "warnings": [...]}`.

### `factory app show <app> --json`
One app: `{"app", "repo", "path", "path_exists", "config_path", "delivery", "pipeline_default",
"gates", "readiness", "detected", "suggested_gates", "docs_only", "ci", "toolchains", "notes"}`.
Runs detection on the checkout (file reads only). Read-only; served by `factory serve`.
Errors: `invalid_name`, `unknown_app`, `invalid_config`.

### `factory app list --json`
`{"apps": [{"app", "repo", "path", "delivery": {"default"}, "pipeline_default", "ticked", "gates",
"readiness"}]}`. No detection: a config parse, a PATH lookup per required tool and a stat.


## v1.2 additions (2026-11-06): job kinds, runtimes, runs, reports

Additive: every v1/v1.1 call keeps working and means what it meant.

### Submit: new flags

```
--kind code|research|report      default code
--runtime api|claude_session     default api
```

- `kind=code`: today's behaviour (a direction → stories → PRs at the job's delivery level).
- `kind=research`: answer a question or investigate. The deliverable is a markdown REPORT kept by
  the factory (`factory job report`). No branch, no PR, no issue. `--app`/`--repo` are OPTIONAL:
  with one, the agent works read-only in a fresh checkout of that repo; without one, it works in
  the factory's scratch workspace (no repo). `--done` lines are the questions the report must
  answer. Delivery: only `none` (anything else → `invalid_delivery`). No flow.md/api_spec.md
  needed (no backpressure gate, never `needs_human` for lack of them).
- `kind=report`: like research, but the ask is to WRITE a document (a summary, a write-up, a
  plan). Same deliverable, same rules.
- `runtime=api`: the factory's own model routing (LiteLLM, routes.yaml, `--model` overrides,
  keys from env). Unchanged for code. For research/report: one tool-using agent (OpenHands, as
  the dev runs today) with the `dev` route (or `--model researcher=<id>`).
- `runtime=claude_session`: Claude Code (the `claude` CLI on the factory machine, the operator's
  subscription, not an API key) does the agent work:
  - code: the dev step (solo pipeline: one Claude Code conversation in the story worktree; the
    usual gates, CI watch and delivery). `--pipeline chain` with this runtime → the dev persona
    only is Claude Code; other personas follow routes.yaml.
  - research/report: one Claude Code conversation writes `report.md`.
  - Each Claude Code run is started as a termhub session on the factory machine, so a human can
    open it live. `--model` for it is a Claude model name (`claude_session=<model>`, e.g.
    `claude-sonnet-5-5`); default: the CLI's default.
  - Not available (no `claude` on PATH, not logged in) → submit refuses with
    `{"error": "runtime_unavailable"}`.
- Refusals: `invalid_kind`, `invalid_runtime`, `runtime_unavailable`, `invalid_delivery`.

Success JSON adds `"kind"` and `"runtime"`.

### Status / list: new fields

```
"kind": "code|research|report",
"runtime": "api|claude_session",
"report": {"title", "path", "excerpt": "<first ~600 chars>", "words": n} | null,
"runs": [{"id", "story_id": n|null, "persona", "runtime", "model", "state": "running|ok|failed",
          "cost_usd": number, "billing": "metered|subscription",
          "started_at", "ended_at": ISO|null,
          "session": {"machine", "termhub_session_id", "url"} | null}],
"cost_usd": number,                 // METERED spend only (API keys) — unchanged meaning
"subscription_equiv_usd": number    // what Claude Code runs would have cost at API prices
```

A research/report job is `done` when its report exists, `failed` when the agent ended without one,
`in_progress` while it runs. `runs[]` lists every agent/LLM run of the job, newest first, with the
termhub link while one is live (and after, for the transcript).

### New command

`factory job report <job_id>` prints the report markdown (not JSON). With `--json`:
`{"job_id", "title", "markdown", "path"}`. No report yet → `{"error": "no_report"}`.

### v1.2 as implemented (2026-11-06) — precisions the spec above left open

Everything above holds. These are the details the implementation had to fix; the PA can rely on
them.

**Job ids.** A research/report job is NOT a direction (no PM, stories, issue or PR, so pm-sync
never sees it). Its id is `<app>:r<NNNN>` (e.g. `demo:r0007`), or `scratch:r<NNNN>` when the job
names no app. The `r` prefix keeps it apart from direction ids (all digits); both match the PA's
`JOB_ID` pattern. Ids are global (one sequence for all apps). It lives in
`state/jobs/<task_id>-<slug>/` (`job.yaml`, `ask.md`, `brief.md`, `report.md`, the workspace, the
Claude run dir, `worker.log`).

**Submit success shape for research/report.** `job_id`, `app` (`null` without an app),
`direction_id` (= the task id, `r0007`), `direction_path` (the job dir), `pipeline: null`,
`delivery: "none"`, `delivery_requested: null`, `created`, `kind`, `runtime`, `warnings`.
`--pipeline` (other than `auto`), `--flow-file` and `--api-spec-file` are ignored for these kinds,
with a warning. Idempotency on `(source, external-id)` spans both kinds: a resubmit returns the
original job, whatever kind it is.

**Status shape for research/report.** The v1 keys are all present: `stories: []`, `pr_urls: []`,
`merged: false`, `pipeline: null`, `delivery: "none"`, `app` (`null` without an app). States:
`queued` (waiting for a dispatch; `blocked` instead while the factory is halted or paused),
`in_progress` (starting / running; also while a cancel is being carried out), `done`, `failed`,
`cancelled`. `report.title` is the report's first `# ` heading (else the job title); `excerpt` is
its first 600 characters; `words` is a whitespace word count.

**Status for code jobs** gains the same v1.2 keys: `kind: "code"`, `runtime`, `report: null`,
`runs[]` (every run row of the job's app+direction or any of its stories), and
`subscription_equiv_usd`.

**runs[].** `model` is the LiteLLM id for `api` runs and `claude_session/<model>` for Claude Code
runs (`claude_session/default` until the run reports which model the CLI chose). `state` is
`running` while the run row is still provisional. `started_at` is recorded for new runs; for older
rows it is derived as `ended_at - duration`. A Claude Code run's `cost_usd` is always `0` (nothing
is metered, so the spend caps never count it); its API-price equivalent is summed into
`subscription_equiv_usd`. `session` is `null` for a Claude Code run that had to start without
termhub (termhub unreachable → the run starts as a local process, output in the run dir, and the
run cannot be watched live).

**Watchable api runs (native plan E2).** An api sandbox run (OpenHands) streams its turns —
model text, tool calls and results, diff summaries, gate results, tokens and cost — to
`state/api_runs/<app>-<story>-<persona>-<stamp>/stream.jsonl`, in Claude Code's stream-json
shape plus `{"type": "factory", "subtype": "usage|diff|gate|prompt|error"}` records, ending with
one `result` record. When termhub is reachable, the step's start opens a read-only termhub
session running `python -m factory.claude_session.pretty --follow <stream.jsonl>` (built per
platform by `factory.api_watch.follow_command`: bash on POSIX; PowerShell, or cmd with
`FACTORY_TERMHUB_SHELL=cmd`, on Windows); it exits after the `result` record and the session
stays open for review. The run's row is opened at once
(`state: running`) with `session` = `{"machine", "termhub_session_id", "url", "stream"}`, and the
finished row keeps it. Without termhub the file is still written and `session` is `null`.
`FACTORY_API_WATCH=auto|termhub|file|off` (default `auto`). Re-running `pretty --follow` on a
finished file replays the run.

**Models.** `--model claude_session=<name>` requires `--runtime claude_session` (else
`bad_model_flag`); it is stored as `claude_model` in the frontmatter / `job.yaml`, never in
`models:`. `researcher` is a persona (`factory/personas/researcher.md`), so
`--model researcher=<provider>/<model>` validates like any other persona override. Without it an
api research/report job uses the `dev` route (job, then app overrides, then routes.yaml).

**Pipeline with `claude_session`.** `--pipeline auto` (or none) resolves to `solo` for a
`claude_session` code job, and the submit/status `pipeline` says `solo`. Solo's refusals still
apply: `apps/factory` without `solo_allowed: true` → `pipeline_unavailable`; submit there with
`--pipeline chain`.

**`runtime_unavailable`** is returned when `claude` is not found (PATH, `~/.local/bin`,
`FACTORY_CLAUDE_BIN`), when `claude auth status` (run with the API-key variables removed) does not
report `loggedIn: true`, or when it reports a login other than `claude.ai` (an API-key login would
bill the key, which this runtime exists to avoid). The check runs at submit only; a stamped story
whose CLI later disappears fails its dev step as infrastructure (bounded retries, no dev retry
spent). It cannot see the subscription's usage limit (that costs a model call): a run that hits it
ends at once with Claude's message (`Claude Code error: You've hit your … limit …`), which a
research/report job carries in `why` (state `failed`) and a code job's dev step treats as
infrastructure (no dev retry spent; the bounded infra retries, then the story blocks loudly).

**`factory job report`** on a code job → `{"error": "no_report"}` (exit 1); an unknown id →
`not_found` as for `status`.

**Cancel** of a research/report job returns the v1 cancel shape (`stories_parked: []`,
`stories_left: []`). A queued job is cancelled at once; a running one is stopped (the Claude Code
run's termhub session is killed, an OpenHands worker's process group is signalled) and reads
`cancelled` once the worker has stopped. A `done` job is left alone, as for code jobs.

**Scheduling.** Every `factory tick` (any app) starts queued research/report jobs as detached
workers (`python -m factory.jobs.worker`), at most `FACTORY_TASK_MAX_WORKERS` (default 2) at a
time, and marks a running job whose worker died as `failed`. `factory job dispatch [--json]
[--dry-run]` does the same on demand. A tick never waits for the agent.

**Bounds.** A research/report agent run has a 5400 s wall clock and at most 2 in-conversation
checks of "the report file exists" (a missing report is sent back into the same conversation
once). A `claude_session` code dev step has solo's bounds (5400 s, ≤ 3 gate rounds, the
no-progress abort); under `--pipeline chain` it has the chain's dev timeout and no gate loop.

## v1.3 additions (2026-11-07): pick up existing work, resume a job

Additive: every v1–v1.2 call keeps working and means what it meant. How it works, with
examples: `docs/RESUME.md`.

### Submit: continue on an existing branch or PR

```
--branch <name>                  work on this EXISTING branch of the app's repo
--pr <number>                    work on this EXISTING open PR (its head branch); `#42` is accepted
```

Code jobs only. Submit asks GitHub once (one `gh api graphql` read of the PR, or of the branch
and its open PRs, review threads included; on `claude_session` the runtime check runs alongside
it) and writes what it found to the direction
frontmatter as `base: {branch, pr, into}`; the chain stamps it on the story at spawn
(`StoryRecord.pickup_branch / pickup_pr / pickup_into`) like the delivery level, so it never
drifts mid-flight.

- `--pr N`: the PR must be OPEN and from a branch of the app's own repo. `branch` = its head
  branch, `into` = its base branch.
- `--branch B`: the branch must exist on GitHub and must not be the default branch. If an open PR
  (not from a fork) has `B` as its head, the job adopts it exactly as if `--pr` had been given.
  Otherwise `pr` is `null`.
- The job is always ONE story (no PM slices, no dual-draft): two stories cannot share a branch.
- The story worktree is cut from `origin/<branch>` (the human's tip), never from the default
  branch. Before every writing step and before every push the factory fetches and merges
  `origin/<branch>` (commits a human pushed meanwhile) and then `origin/<into>` (a clean merge,
  aborted on conflict, exactly like the existing base refresh).
- Pushes to the branch are plain fast-forward pushes, never `--force` or `--force-with-lease`. A
  CI-fix push is refused (and the story delivered with a note) if the branch has commits the
  factory did not write, as for `draft_pr`/`pr` today.
- With a PR: delivery UPDATES that PR. `gh pr create` is never run, and the PR's title, body,
  draft state and base are never changed. The story's `github_pr_number` is set to it when the
  delivery step runs; from then on the usual CI watch / CI-fix loop / auto-merge run on it. If
  the PR is no longer open at that point nothing is pushed and the bounded PR-open retry parks
  the story.
- Without a PR: levels `draft_pr`/`pr`/`auto_merge` open one from the branch into the default
  branch (or relink one opened since); `branch` just pushes; `none` commits locally.
- Never destructive on a picked-up branch: no conflict rebuild (it would close the PR and delete
  the branch; the story parks in `blocked_deploy_failed` for a human instead, event
  `conflict_rebuild_refused_pickup`), and no `--delete-branch` after an auto-merge.
- With a PR, its UNRESOLVED review threads (any reviewer, human or bot) are read at submit and
  appended to the ask (also `artifacts/pr_review_threads.md`, at most 30 threads), so the dev
  addresses them. This is a snapshot: comments posted after submit are not read.
- `--delivery push_to_main` cannot be combined with `--branch`/`--pr`.

Success JSON adds `"base": {"branch", "pr", "into"} | null` (`null` for every other job,
including research/report). Warnings may name a PR into a non-default branch or review threads
missing from GitHub's answer. A resubmit with the same `(source, external-id)` returns the original job
without asking GitHub.

Refusals (exit 1): `invalid_argument` (both flags; `--branch`/`--pr` on a research/report job;
a non-numeric `--pr`), `invalid_branch`, `branch_is_default`, `branch_not_found`, `pr_not_found`,
`pr_not_open` (merged or closed), `pr_from_fork`, `github_unavailable` (GitHub could not be asked;
fail safe, nothing is written), `branch_busy` (another unfinished job of the app already works on
that branch), `invalid_delivery` (`push_to_main` with a pickup).

### Status / list: new fields

```
"base": {"branch": "<name>", "pr": n | null, "into": "<branch>"} | null,
"stalled": bool
```

`stalled` is true when the job reads `in_progress` or `blocked` (but NOT because the factory is
halted or paused) and nothing about it (no story row, direction audit entry, or agent run start
or end) changed for 3 h. `FACTORY_JOB_STALL_S` overrides it (60 s minimum). 3 h is longer than
any bounded step (a 5400 s dev conversation, the 2 h CI watch), so a healthy job never reads
stalled. Research/report jobs always report `stalled: false` (a dead worker is already reaped to
`failed`).

### New command: `factory job resume <job_id> --json [--no-github]`

Picks a job back up. Allowed when the job is `failed`, `cancelled`, `needs_human` with stories
parked for a human, or `stalled`.

- Finished stories are kept: merged (`deploy_pending`/`deployed`), `delivered_*`, and dual-draft
  losers.
- Every other story is re-entered with the operator story-resume (`factory resume-story`, point
  `auto`, `factory/chain/resume.py`). It keeps the story's branch, worktree state, PR, issue,
  story file, dev/review history and spend, and resets only the counters that would re-park it.
  A story with a PR goes back to the merge gates / CI watch (`pr_open`, no persona re-runs); one
  whose dev or SM ran goes back to dev (`dev_retry`) on its existing branch; a docs-chain story
  whose SM ran goes back to the docs onboarder (`docs_sm_done`, point `docs`), never to dev; only a
  story that never started goes back to `story_created`. Each writes a `story_resumed` event (actor
  `factory job resume`) that also resets the merge-gate block and CI-fix windows.
- A cancelled job is un-cancelled first: its `job_cancellations` row is deleted and
  `state.yaml::job_cancelled` moves to `previous_cancel` (plus a `job_resumed` audit entry). Its
  closed direction re-opens as `pm-validated` when it has stories (never re-triaged) or `created`
  when it was cancelled before triage (PM triages it again). The resumed stories' GitHub issues
  are re-opened (best effort; skipped with `--no-github`).
- Everything is planned before anything is written: if no story can be resumed, nothing changes.
- A picked-up story whose PR a human closed is not resumed (the factory never re-opens a human's
  PR); it is listed in `stories_left`.
- Research/report jobs: `failed`/`cancelled` → `queued`; the agent runs again from a fresh
  workspace on the next tick (`job.yaml::resumed` keeps the history).

Success:
`{"job_id", "state": "<state after>", "was": "<state before>", "resumed": [{"id", "from_state",
"to_state", "point"}], "kept": [{"id", "state"}], "stories_left": [{"id", "state", "reason"}],
"requeued": bool, "why"}`. `requeued` is true when the job went back to triage (code) or to the
dispatch queue (research/report) rather than resuming stories.

Refusals (exit 1): `job_running` (queued, triaging, or in_progress/blocked and not stalled),
`job_done`, `not_resumable` (no stories, and the direction is `created` awaiting approval or
`needs-direction`: resubmit with what is missing), `resume_refused` (every unfinished story's
resume was refused; `message` lists why, e.g. the per-story spend cap, a PR GitHub could not
read, a dependency in a dead sink), plus `not_found` / `invalid_job_id` / `missing_argument`.

### The "ready to merge" bar: what exists and what does not

- Local dev loop (tests until green): yes. Chain dev retries; solo / `claude_session` run
  in-conversation gate rounds.
- Local review loop: yes for `chain` (reviewer ↔ dev, 3 cycles; a medium finding is a
  cycle) and `api`-runtime `solo` (2 cycles: one fix round, and only for a high-severity
  finding; medium and low are posted on the PR). `claude_session` `solo` has no reviewer.
- CI watch + CI-fix loop on the PR: yes. `draft_pr`/`pr` watch before delivery; `auto_merge`
  fixes before merging; at most 3 cycles. The watch (and `ci` in `factory job status`, and
  the `push_to_main` main-green hold) counts only the checks that decide something
  (`factory/ci_scope.py`): GitHub's required checks (branch protection / rulesets) when set;
  else the app config's `ci_required_checks`; else every check except
  `ci_informational_checks` (fnmatch patterns) and `continue-on-error` jobs in the repo's
  workflows. Ignored checks are listed under `ignored`.
- Automated review comments (e.g. a review bot): partly. A picked-up PR's unresolved threads are
  fed to the dev at submit (a snapshot). Comments posted later are not read, and threads are
  never replied to or resolved.
- Merge: only at `auto_merge` (gates + required CI). A draft PR is never merged or marked ready.

## v1.4 additions (2026-11-07): one id chain

Additive: every v1–v1.3 call keeps working and means what it meant. The point is that a caller
can get from a job to each agent step, its live session and its PR (and back) from stored ids,
never by reading titles.

### Status / list: new fields

```
"stories": [{..., "pr_number": n | null}],
"runs": [{..., "job_id": "<app>:<direction_id>",
          "session": {"machine", "termhub_session_id", "url",
                      "links": {"job", "step", "story"?, "external"?}?} | null}]
```

- `stories[].pr_number`: the PR the story opened, the same PR as `pr_url` (null without one).
- `runs[].job_id`: the job the run (step) belongs to; `runs[].id` is the step id.
- `runs[].session.links`: what the factory told termhub the session belongs to when it started
  it (`POST /api/sessions {links}`, termhub `lib/sessionLinks.js`): the job, the step (`runs.id`),
  the story and the job's `external_id`. termhub returns the same object in `GET /api/sessions`,
  so a terminal leads back to its job; a caller that submitted the job maps `external` to its own
  records. A termhub without links ignores them, and a session started before v1.4 has none. An
  API-runtime step's `session` is null until it has a session of its own (plan E2); the shape is
  the same when it does.

## v1.5 additions (2026-11-08): when a research/report job started

Additive. A research/report job's status carries `"started_at": ISO-8601 UTC | null`: the moment
its worker began the job (`job.yaml` `started_at`, before the checkout and the brief), null while
it is queued. A caller times "approval to started" from it instead of from its own poll. A code
job has no such key; its first `runs[].started_at` is the nearest stamp.

## v1.6 additions (2026-11-08): is the job's app ticked?

Additive. A code job moves only when its app is ticked (`factory tick --app <app>`: pm-sync, every
chain step, the CI watch). `factory serve` ticks only the apps it was started with (`serve_tick:
true`, `--app`, `FACTORY_SERVE_APPS`) and lists them in `state/scheduler/serve.json`; a Linux host
not yet on serve ticks from `factory-tick@<app>.timer`. A job for an app neither covers used to
be accepted and then sat `queued` forever ("waiting for pm-sync on the next factory tick").

`"ticked": true | false | null` on submit, status/list (code jobs) and every `app list` row:
`true` when a running serve lists the app or its timer is active; `false` when neither does;
`null` when this host cannot tell (no serve has ever run here and no timer is active), never
reported as `false`. A serve whose status is under 60 s old counts as running, so a restart does
not flip it. Research/report jobs report `null`: serve dispatches them whatever their app.

The factory **warns, it does not refuse**: the operator may tick an app by hand, and refusing
would strand a PA run that cannot know the host's ticker. With `ticked: false`:

- submit adds a warning `ticker: app <app> is not ticked: … ; until then this job stays queued`,
  naming what serve does tick and the fix (`serve_tick: true` in `apps/<app>/config.yaml` and a
  serve restart, or `factory tick --app <app>`);
- status sets `why` to `waiting: app <app> is not ticked: …` for a queued job, and appends the same
  reason to `why` for a triaging, in-progress or blocked one. The state is unchanged.

A caller should treat `ticked: false` on a live job as waiting on a human, not as running.

## v1.7 additions (2026-11-08): millisecond reads on factory serve

Additive. The CLI (`factory job status`, `factory job list`, `factory app list`) still
asks GitHub, and on Linux the timers, in that process. A human's answer is current.

`factory serve`'s `POST /api/cli` for those three reads does not call `gh`, git, or
`systemctl`. Story and direction state come from the factory db and the direction
files. GitHub-derived fields (`pr_state`, `ci`, whether a delivery is confirmed so
the job can be `done`) come from a snapshot a background thread refreshes about
every 10 s: one `gh pr list` per registered repo, then CI and branch reads for the
stories that need them. `ticked` comes from the same snapshot (serve's status file
and, on Linux, the last timer scan). A cold serve, before the first good refresh,
behaves as GitHub unavailable (local view, `why` says so). A failed refresh keeps
the previous good snapshot.

### Status / list: new field

`"github_as_of": ISO-8601 UTC | null`

When those GitHub fields were read. A live CLI read stamps the request. A serve
read stamps the snapshot. `null` with `--no-github`, on a research/report job, or
when GitHub could not be asked (no snapshot yet, or `gh` failed and no older
snapshot is kept). The state machine is unchanged: a delivery only the local view
claims is still not `done`.

## v1.8 additions (2026-11-09): the read-only `plan` kind

Additive. `--kind plan` is a fourth job kind, a task job like `research`/`report` (same id
shape `<app>:r<NNNN>`, same lifecycle, states, `report`, `job report`, cancel and resume; no
branch, no PR, `delivery: "none"`). The ask is "write an implementation plan and a sketch of the
diff, change nothing". The PA sends every plan-mode run as one (it used to start a raw Claude Code
session outside the factory, unmetered and invisible on Build).

- `runtime=claude_session`: Claude Code starts with `--permission-mode plan` INSTEAD of
  `--dangerously-skip-permissions`, so the read-only limit is Claude Code's, not the prompt's.
  Headless, nothing approves a write, so every write is refused, including the report file. The
  factory therefore saves the plan itself: the last `ExitPlanMode` plan in the stream, else the
  run's final message, becomes `report.md`. There is no in-conversation report check (one round).
  A run that ended in a Claude Code error saves nothing and the job is `failed` with that error.
  The run is metered like any `claude_session` run (`subscription_equiv_usd`, and its usage goes
  to the PA's Meter / credit pool).
- `runtime=api`: as research (the agent writes `FACTORY_REPORT.md`); its workspace is a throwaway
  clone with pushes blocked, so nothing it changes leaves it. Metered on the API keys.

Refusals are research's: `--branch`/`--pr` → `invalid_argument`; a delivery other than `none` →
`invalid_delivery`. A factory older than v1.8 refuses `--kind plan` with `invalid_kind`.
