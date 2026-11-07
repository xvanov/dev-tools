# The direction contract (what the factory actually parses)

Everything here is enforced by code or by a persona's hard rule. Source references
are to the `software-factory` repo. Verify against source if something looks stale.

## Directory layout

```
apps/<app>/directions/<NNN>-<slug>/
  direction.md      # REQUIRED — YAML frontmatter + markdown body
  flow.md           # optional — user flow
  api_spec.md       # optional — API contract
  artifacts/        # optional — mockups, binaries, screenshots
  state.yaml        # AUTO-MANAGED — never hand-write; the chain owns it
```

- `NNN` is zero-padded, next-highest across the app's existing direction dirs
  (`next_direction_id`, `factory/directions/parser.py:244`).
- `slug` must match `[A-Za-z0-9_-]+`, lowercased and hyphenated, **capped at 60
  chars** (`slugify`, `parser.py:287`) — long titles get truncated mid-word in the
  directory name, which is normal and harmless.
- `state.yaml` is written by the creator/ingester and updated by `pm_sync`. Creating
  a direction by hand means writing it once with `status: created` **and
  `source: operator`**; the chain takes over from there.
- `source` is what the **operator-approval gate** reads
  (`factory/directions/approval.py`). A human/deterministic source
  (`operator*`, `cli*`, `user*`, `human*`, `github`, `github_issue`, `ci-health`,
  `flake-quarantine`) auto-triages as always. Anything else — every
  `scheduled-<persona>` direction, and **any direction whose `source` cannot be
  determined** (missing `state.yaml`, no `source` key) — is parked until
  `factory approve-direction <NNN> --app <app>`. So omitting `source` does not
  lose the direction, it just costs you a manual approval; `factory inbox` lists
  everything parked.

## `direction.md` frontmatter

| Field | Required | Values / notes |
|---|---|---|
| `title` | yes | Falls back to the first `# ` heading, then the slug |
| `type` | yes | `feature`, `bug`, `security`, `refactor`, `deploy`, `chore`, `infra`, `ux`, `docs` |
| `priority` | yes | `p0`–`p3`; the PM may re-classify |
| `explore` | yes | bool; `true` satisfies the backpressure gate on its own |
| `created_at` | yes | ISO-8601 UTC |
| `parent_direction` | no | `NNN-slug` of the direction this iterates on |
| `related_directions` | no | list of `NNN-slug` |
| `source_issue` | no | set by the GitHub ingester |

`parent_direction` is cycle-checked and self-reference-checked at parse time
(`parser.py:311`, `parser.py:320`); the chain resolves ancestors up to depth 8.

## Body headings that are parsed literally

- `## Why` → `direction.why` (`_parse_why`, `parser.py:112`). Case-insensitive,
  must be exactly the word "why". Content runs to the next heading.
- `## Acceptance Criteria` (or `## Acceptance`) → `direction.acceptance`
  (`_parse_acceptance`, `parser.py:85`). Bullets accepted as `- [ ]`, `- [x]`,
  `- `, or `* `. Parsing stops at the next heading of any level.

Any other section is not extracted into a field, but personas read the full
`raw_body` — so `## Out of scope`, `## Open questions`, and `## Context` all reach
the model. Use them freely.

## The backpressure gate (HARD)

`factory/personas/pm.md:199`. The PM emits `has_sufficient_backpressure: true`
**iff at least one** of:

1. `flow.md` exists and is non-empty, **or**
2. `api_spec.md` exists and is non-empty, **or**
3. frontmatter `explore: true`.

On failure: `child_stories: []`, direction status → `needs-direction`, and the
tracker issue gets a `needs-direction` label plus a comment listing `missing[]`
(typical values: `user_flow`, `api_spec`, `acceptance_criteria`,
`explore_tag_or_artifacts`). Nothing is built until the direction is edited; the
next pm-sync re-evaluates automatically.

Two more PM hard rules (`pm.md:227`):

- **It will not invent acceptance criteria.** Missing AC is reported, never filled.
- **Untestable-as-written AC counts as missing** — no observable trigger/response,
  no measurable threshold, pure vibes ("should feel fast", "works well"). A
  criterion nobody can write a failing test against gets flagged rather than passed
  downstream for dev and reviewer to guess at.

## Story sizing — why AC phrasing matters

The PM decomposes the direction into child stories, each capped by thresholds the
chain rejects on (`pm.md:45`):

- `estimated_new_files` ≤ 5
- `estimated_modified_files` ≤ 2
- `estimated_sandbox_iterations` ≤ 200

Decomposition is by **vertical slice** (independently shippable end-to-end value),
never by horizontal scope group ("all backend changes"). Docs-only work goes to its
own `chain_kind: docs` story and is never bundled with code.

Practical consequence for drafting: write acceptance criteria that each describe
one shippable behavior. A compound bullet ("add the endpoint, migrate the schema,
and update the client") either becomes an oversized story that gets rejected, or
forces the PM to guess at the split.

## Intake paths

| Path | Command / trigger | Notes |
|---|---|---|
| Hand-written | write the dir, then `pm-sync` | Highest fidelity; reviewable as a diff |
| Interactive CLI | `uv run factory new-direction --app <app>` | Prompt loop, opens `$EDITOR` (`factory/directions/creator.py:225`) |
| One-liner | `uv run factory tell --app <app> "..."` | Prose only, no siblings → lands at `needs-direction` |
| GitHub, automatic | open issue labeled **`user-report`** | Every tick, max 3/issue-batch; labels `intake-accepted` + comments a back-link (`factory/chain/issue_intake.py`, defaults at `factory/settings/loader.py:181`) |
| GitHub, manual | issue labeled `direction`, then `uv run factory ingest-issue <N> --app <app>` | See gotcha below |

**Label gotcha:** `apps/sacrifice/.github/ISSUE_TEMPLATE/direction.md` applies the
`direction` label and states the factory ingests it automatically. That is stale.
Auto-intake looks for `user-report` (default in `loader.py:195`, not overridden in
`factory_settings.yaml`). The webhook handler does recognize the `direction` label
but only records intent without calling the ingester
(`factory/webhook/github.py:100`), and `factory webhook-serve` isn't running. So a
`direction`-labeled issue needs the manual `ingest-issue` step.

Issue bodies are ingested verbatim into `direction.md`; `## User flow` and
`## API spec` sections are extracted into `flow.md` / `api_spec.md` with those
exact headings (`factory/directions/ingester.py:39`).

## What happens after pm-sync

`created` / `needs-direction` → PM triage → `pm-validated` + child stories →
tracker issue → per-story chain (test design → test impl → dev → reviewer → CI →
auto-merge → deploy).

`factory tick` runs auto_intake then auto_pm_sync every run, so nothing waits on an
operator (`factory_settings.yaml`, `auto_pm_sync.enabled: true`). Ticks fire from
the systemd **user** units `factory-tick@sacrifice.timer` and
`factory-tick@factory.timer` (every 5 min) — check them with
`systemctl --user list-timers`, not `systemctl`.

`pm-sync --dry-run` skips LLM and GitHub entirely — it is a pure preview and will
not triage anything.

## Useful commands

```bash
uv run factory pm-sync --app <app>          # triage now
uv run factory queue --app <app>            # in-flight stories + block reasons
uv run factory status --app <app>           # where every story is right now
uv run factory why --story <id>             # why a story is stuck
uv run factory inbox                        # items needing human attention
```
