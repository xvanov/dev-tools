---
name: new-direction
description: Interview the operator and draft a new factory direction (the factory's PRD unit) for an app under apps/<app>/directions/. Use when the user wants to give the software factory new work, start a new direction, write a PRD for sacrifice or factory, or turn a rough idea into something the PM persona will accept. Covers the interview, the on-disk artifacts, the backpressure gate, and handoff to pm-sync.
---

# Draft a new factory direction

A direction is the factory's unit of intent — the thing an operator writes and the
PM persona decomposes into dev-sized stories. This skill turns a rough idea into a
direction that clears the PM gate on the first pass and decomposes into slices the
chain can actually finish.

Your job here is **mostly interviewing**, not writing. The writing is 20 minutes of
markdown; the value is in what you extract before that.

Read `references/contract.md` before drafting — it is the exact machine contract
(parsed fields, headings, the gate) with source references. Don't draft from memory.

## Phase 0 — Orient (do this before asking anything)

1. Confirm the target app. `ls apps/` — today that's `sacrifice` and `factory`.
   Note (operator decision 2026-08-07): `sacrifice` is a **benchmark corpus and
   sensor testbed**, not a product with real users — apply the business/user
   lenses accordingly.
2. Skim what already exists so you don't propose a duplicate or an orphan:
   - `ls apps/<app>/directions/ | tail -20` — recent directions
   - `apps/<app>/context/` — the app's canonical context modules, if present
   - `uv run factory queue --app <app> | tail -20` — what's in flight right now
3. Note the next id: `apps/<app>/directions/` highest `NNN-` prefix + 1.

If the idea overlaps an existing direction, say so early. Overlap usually means
this should be an iteration (`parent_direction` in frontmatter) rather than a new
root direction.

## Phase 1 — Interview (the core of this skill)

The operator opens with a rough idea. Your job is to interrogate it from whatever
angles actually matter *for this idea*, until you could write the acceptance
criteria yourself and defend every one of them.

**There is no question list. Do not invent one.** A direction born from a customer
complaint needs different interrogation than one born from a production incident or
an architectural itch. Diagnose the origin first, then pick your angles.

### Lenses to draw from

Use the ones that bite. Skip the ones that don't. Two or three deep threads beat
ten shallow ones.

- **Origin** — what happened that made this worth doing *now*? A real event, a
  complaint, a metric, a hunch? The answer tells you which lenses below matter.
- **User / job-to-be-done** — who hits this, what are they trying to accomplish,
  what do they do today instead, and what does the workaround cost them?
- **Business** — what changes if this ships? Revenue, retention, risk, support
  load, unblocking a demo or a deal? What changes if it never ships?
- **Technical shape** — which subsystems does this touch? What's the smallest
  correct abstraction? Is there an existing pattern in the repo to follow?
- **Contract** — what's the exact observable interface: endpoints, payloads,
  status codes, UI states, error states? This is what becomes `api_spec.md` /
  `flow.md`, so drive hard here.
- **Boundary** — what is explicitly *out* of scope? Operators under-specify
  exclusions and the chain happily builds the adjacent thing.
- **Failure modes** — what does this do when the dependency is down, the input is
  hostile, the user double-submits, the payment half-completes?
- **Verification** — how would a skeptic prove this works without trusting anyone?
  If nobody can name the observation, the AC isn't real yet.
- **Sequencing** — does something else have to land first? Is this blocked by an
  in-flight story or direction?
- **Done-ness** — what's the smallest version that's genuinely shippable, and what
  is the operator hoping for beyond it?

### Rules of engagement

- **Ask in small batches** (2–4 at a time), and prefer `AskUserQuestion` with
  concrete options when the choice is discrete — it's faster to pick than to prose.
  Use open prose questions when you need the operator's reasoning, not a selection.
- **Only ask what changes the artifact.** If the answer wouldn't move a word of the
  direction, don't ask it. If you can infer it from the repo, infer it, state the
  assumption, and let the operator correct you.
- **Follow the thread.** A surprising answer is worth three planned questions.
  Chase it.
- **Push back on vibes.** "Should feel fast" is not a criterion — the PM persona
  will flag it as missing and the direction rots. Convert it on the spot: fast
  compared to what, measured where, above what threshold?
- **Argue when you disagree.** If the idea seems like the wrong solution to the
  stated problem, say so once, with the alternative, then build what the operator
  decides. You're a skeptical collaborator, not a form.
- **Surface what the operator hasn't considered** — the failure mode they skipped,
  the migration they'll need, the auth boundary they crossed without noticing.
  This is where the interview earns its cost.

### Stop test

Stop interviewing when all of these hold:

- You can state the *why* in one paragraph without hedging.
- Every acceptance criterion you'd write names an observable trigger and an
  observable response.
- You know the exact contract (flow steps or API shape) well enough to write the
  sibling file without inventing anything.
- You know what's out of scope.
- The next question you can think of would only refine wording.

Then say what you're about to write and confirm before creating files.

## Phase 2 — Draft

Write to `apps/<app>/directions/NNN-slug/` (see `references/contract.md` for the
exact schema, frontmatter fields, and the slug rule).

Guidance beyond the schema:

- **`## Why`** — one paragraph, the problem and its cost. Not the solution. The PM
  persona quotes this into the tracker issue; make it stand alone.
- **`## Acceptance Criteria`** — one observable behavior per bullet, phrased as
  trigger → response. Aim for 3–8. Each bullet should be something a test could
  fail on. Bullets are also the PM's raw material for story slicing, so keep them
  independently shippable rather than "and also" compounds.
- **`flow.md` or `api_spec.md`** — write at least one, non-empty. This is the gate
  (see below). Make it specific: real paths, real payloads, real status codes, real
  screen states.
- **Out of scope** — put exclusions in the body as a short `## Out of scope`
  section. It's not a parsed field, but personas read `raw_body`, so it lands.
- Set `parent_direction: NNN-slug` in frontmatter if this iterates on an existing
  direction. Iterations are **additive** to the parent's criteria — if yours
  contradicts the parent, the PM flags it for clarification instead of building.

## Phase 3 — Precheck before spending a PM call

```bash
uv run python .claude/skills/new-direction/scripts/precheck.py apps/<app>/directions/NNN-slug
```

It parses the direction exactly as the factory does and reports what the PM will
see: parsed AC count, flow/api-spec presence, the backpressure verdict, and
heuristic warnings for untestable phrasing. A typo in the `## Acceptance Criteria`
heading silently yields zero criteria — this catches that.

Fix anything it flags, then show the operator the final files.

## Phase 4 — Hand off

Explain both paths and let the operator choose:

- **Local, immediate:** `uv run factory pm-sync --app <app>` (no `--dry-run`;
  dry-run is preview-only and does no LLM triage). The direction goes to
  `pm-validated` with child stories, or back to `needs-direction` with the gaps.
- **Autonomous:** do nothing. `factory-tick@<app>.timer` (systemd *user* unit,
  every 5 min) runs auto_pm_sync and picks it up.

Afterwards, `apps/<app>/directions/NNN-slug/state.yaml` holds the verdict —
`status`, `pm_result.confidence`, and `missing[]` if it was rejected. Read it and
report the outcome rather than assuming it passed.

## The gate — why directions rot

The PM persona spawns zero stories unless **at least one** of these is true:
non-empty `flow.md`, non-empty `api_spec.md`, or `explore: true` in frontmatter.
Everything else — good prose, sharp criteria — does not substitute.

Real evidence from this repo:

- `019-harden-stripe-webhook-verification-and-replay-handling` — sound security
  direction, clear criteria, no sibling file, `explore: false`. It sat at
  `needs-direction` from 2026-06-11 to 2026-07-07 and was eventually closed
  unbuilt.
- `101-add-a-database-readiness-healthz-endpoint` — same size of idea, but shipped
  with a six-line `api_spec.md`. PM validated it at 0.97 confidence and it shipped.

The difference was the sibling file. Treat `explore: true` as a deliberate choice
for genuine research spikes, not as a way to skip the work — an explore direction
gets triaged, but with a much vaguer mandate.
