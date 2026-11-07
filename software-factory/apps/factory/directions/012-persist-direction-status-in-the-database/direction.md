---
title: Persist direction status in the database
type: refactor
priority: p2
explore: false
created_at: '2026-07-29T22:50:47.202203+00:00'
---

<!-- Sibling: flow.md carries the operator flow. The storage contract is inline below. -->

# Persist direction status in the database

## Why

A direction's status lives only in `apps/<app>/directions/<id>/state.yaml`, a file
the machine rewrites on every transition and appends an audit entry to. Three
problems follow from that:

1. **It is machine state committed as source.** Every tick that touches a
   direction dirties the working tree of the factory's own repo, so `git status`
   is never clean and real edits are hard to see among the churn.
2. **Two writers, one fact.** The DB already holds the control plane — the
   `stories` table carries 40 columns of per-story truth including
   `direction_id` — while direction status sits on disk. The repo's own rule is
   one writer per fact.
3. **A capability is blocked on it.** `compose_context_prelude` used to append an
   ancestor direction's shipped-story record to the persona context. It read a
   path that never existed and silently produced nothing (removed 2026-07-29).
   It cannot be restored from filenames, because nothing in a story file's name
   identifies its direction — only `stories.direction_id` does. A direction row
   in the database is what makes that lookup possible.

## What

Add a `directions` table as the authoritative store for a direction's *status*,
keep `direction.md` and its text siblings as the source of *intent* on disk, and
make `state.yaml` a regenerable projection rather than the record.

Then restore the ancestor-story context section using the database link.

## Acceptance Criteria

- A `directions` table exists with one row per direction, keyed by app and
  direction id, holding at minimum: status, tracker issue number, created-at, and
  the last transition's timestamp and actor.
- `pending_directions` returns the same directions as before when the database
  is populated, reading status from the database rather than from `state.yaml`.
- A direction whose `state.yaml` is deleted keeps its status across a factory
  restart, and `pm-sync` does not re-triage it.
- Every existing on-disk direction is imported into the table by a one-time
  backfill that is safe to run twice and reports how many rows it wrote.
- `compose_context_prelude` includes a "Merged Story / Dev Agent Record" section
  for an ancestor direction that has at least one deployed story, resolved
  through the database, and omits the section when there is none.
- `state.yaml` is still written for human inspection, and a test asserts the file
  can be deleted and regenerated from the database without changing status.

## Storage contract

No HTTP surface changes. This documents the storage contract and the CLI verb, so
the change has a reviewable interface rather than only an implementation.

### Table: `directions`

| column | type | notes |
|---|---|---|
| `id` | int, pk | surrogate |
| `app` | text, not null | e.g. `factory`, `sacrifice` |
| `direction_id` | text, not null | zero-padded, e.g. `012` |
| `slug` | text, not null | hyphenated slug |
| `status` | text, not null | `created`, `pm-validated`, `needs-direction`, `closed` |
| `tracker_issue` | int, null | GitHub issue for the direction tracker |
| `created_at` | datetime, not null | from the direction's frontmatter |
| `updated_at` | datetime, not null | last transition |
| `updated_by` | text, null | e.g. `factory.chain.pm_sync` |

Unique on `(app, direction_id)`. Index on `(app, status)` — the hot read is
"pending directions for this app".

Statuses are exactly today's set. Do not add a `completed` status: a successful
direction terminates at `pm-validated`, and completion is signalled by its child
stories reaching `deployed`.

### Read path

`pending_directions(app, root, db_path)` keeps its signature and returns the same
objects. Status resolution changes to: the `directions` row when one exists, else
the on-disk `state.yaml`, else `created`. The on-disk fallback is what keeps a
direction created by hand between ticks from being invisible.

### Write path

`mark_direction_status(direction, status, by, details)` keeps its signature and
becomes a database write plus a best-effort `state.yaml` projection. A failure to
write the file must NOT fail the transition; a failure to write the row MUST.

### CLI

```
factory directions-backfill --app <app> [--dry-run]
```

Imports every on-disk direction that has no row yet. Idempotent. Prints
`imported=<n> skipped=<n>`. `--dry-run` reports without writing, and is the
default, matching the other destructive-ish verbs in this CLI.

### Ancestor-story context

`compose_context_prelude` gains an optional `db_path`. When supplied, for each
ancestor direction it selects that direction's stories in state `deployed` via
`stories.direction_id`, reads each one's `story_file_path`, and appends the
existing "Merged Story / Dev Agent Record" section. With no `db_path`, or no
deployed story, it appends nothing — the current behaviour.

## Out of scope

- Moving `direction.md`, `flow.md` or `api_spec.md` into the database. They are
  human-authored source and stay in git.
- Moving story markdown into the database, and removing `apps/<app>/stories/`
  from git. Separate direction once this one has shipped.
- Rewriting git history to drop already-committed artifacts.
- Any change to the direction contract that personas parse.

## Open questions

- Whether the backfill should run automatically on first tick or stay an explicit
  CLI command. Prefer explicit; a silent schema-populating migration on a live
  factory is hard to audit.
