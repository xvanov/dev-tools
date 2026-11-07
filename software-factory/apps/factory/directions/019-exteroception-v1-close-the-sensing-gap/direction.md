---
title: Exteroception v1 — close the sensing gap
type: infra
priority: p0
explore: false
created_at: '2026-08-07T18:05:00+00:00'
related_directions: []
---

<!-- Sibling: flow.md carries the verification and triage flows. -->

# Exteroception v1 — close the sensing gap

## Why

The five-arm benchmark (2026-08-04, audited 2026-08-07) measured the chain at no
lift over a single agent on the same model, at 2.8× the cost — and the mechanism
is that every feedback signal the chain trusts originates inside the process
being judged: the dev authors the tests that grade it (verdict precision 40%, a
zero-byte production patch certified green), the one independent oracle is
switched off because its in-process green is forgeable by three lines of
production code, and even an independent check can be satisfied by a no-op when
the criterion asserts only status codes and absences (the password-reset
incident: a feature with no transport layer, certified by three green tests,
filed four times). Meanwhile the goal-supply loop manufactured 70% of the
backlog as machine-filed noise and the idle detector fired 957 times without
ever reaching a human. Until a green verdict means something observed from
outside the dev's process, every dollar spent on generation buys unverified
output, and every measurement of the architecture is uninterpretable.

## Acceptance Criteria

- [x] **Vacuity gate at triage.** Given a direction whose acceptance criteria
  are all satisfiable by a fixed-response no-op (only status-code assertions and
  absence assertions), `pm-sync` returns it as `needs-direction` with a named
  vacuous-criteria reason in `missing[]`; given at least one criterion stating a
  positive outcome observable at the system boundary, triage proceeds.
  Calibration first: run the check read-only against the 45 held-out
  pm-validated sacrifice directions and record the flag rate before it becomes
  blocking.
- [x] **Gutted-implementation control run.** Before `acceptance_verified`
  credits any oracle green, the oracle is also executed against a stubbed no-op
  implementation of the story's surface; a criterion that still passes the stub
  is excluded from crediting, and a criterion set in which nothing fails the
  stub blocks with a named reason. Cannot-run blocks (fail-safe), never credits.
- [x] **Out-of-process verdict.** The acceptance oracle's verdict is computed by
  a separate process driving a booted instance of the app over HTTP (the
  `smoke_green` pattern), not by pytest importing the diff's code. The pinned
  `xfail(strict=True)` in-process-forgery test flips to a hard pass: a story
  whose production code reassigns pytest's test-runner machinery is blocked,
  not credited.
- [x] **Flag flip on sacrifice.** `gates.acceptance_oracle: true` in
  `apps/sacrifice/config.yaml`, and one real story passes end to end: oracle
  authored from the spec before dev dispatch, red at the merge base, green at
  HEAD through the out-of-process runner, with `acceptance_verified` still
  ordered last. (Prerequisites recorded in flow.md: `sacrifice-db` up,
  `hypothesis` added to sacrifice's dev extras, never `template-probe`.)
- [x] **Dead chain code deleted.** `idle.py`, `rollback.py`,
  `review_events.py`, `ears.py`, the scanner personas (`bug_hunter`, `ralph`)
  with their schedule entries and rate-limit settings, and the three orphan
  personas (`architect`, `release_manager`, `ux_designer`) are removed together
  with tests that exist only to guard them; the full suite is green and a
  seeded `factory tick` behaves identically before/after.
- [x] **Idle becomes a ping.** When an app has no dispatchable work and no live
  human-filed direction, the factory surfaces exactly one deduplicated operator
  notification per idle episode in `factory inbox`, and files zero
  machine-authored directions.
- [x] **Detector→direction trigger, deduped on signature.** When a registered
  detector fires, the chain files at most one direction keyed on that
  detector's stable signature while one is live; the filed direction names the
  detector, so "the detector stops firing" is its built-in acceptance
  criterion. Verified with a seeded fault that fires a detector twice and
  yields one direction.

## Out of scope

- **`factory/manager/**` and `bench/**` changes** — operator-PR-only by hard
  guardrail. The paired operator queue (tracked in `STATUS.md`): delete the four
  manager LLM tiers (~4,704 LOC; move `_any_path_is_forbidden_in_patch` out of
  `apply.py` first), retire `factory_improver_apply` (manager imports it), wire
  `conformance_breach` and `fms_yield` into whatever replaces the watcher loop,
  run `check_can_fail` over all 11 detectors, the bench 429-retry and aggregate
  recompute, and the clean reviewer-ablation re-run (~$62).
- **Sacrifice CI un-hollowing** (remove the forced `exit 0` typecheck, gate
  Jest and `tsc`, make the 21 self-skipping Playwright tests runnable) — a
  separate sacrifice-app direction, after this one proves the oracle runner on
  a booted sacrifice.
- **Browser-level (tier-5) journeys** — Exteroception v2; v1 stops at HTTP.
- **Solo chain mode (B.1)** — must not load without the acceptance oracle; it
  is a follow-up direction gated on the flag-flip criterion above.
- **Commit0-Lite and any new benchmark sweep** — operator decision 2026-08-07:
  experiments run LAST, only after this direction is complete and soaked.

## Context

- The strategic review this implements is the audited "Sensor Problem" artifact
  (v5); its audit summary is memory `sensor_report_audit_2026_08_07`, and the
  operator's four standing decisions are memory `operator_decisions_2026_08_07`
  (thesis = throughput; Commit0 last; ~2 h/day operator ratification budget;
  sacrifice = benchmark corpus + sensor testbed).
- The in-process forgery hole and the reasons `gates.acceptance_oracle` stayed
  off are recorded in `STATUS.md` and the retired plan
  (`docs/archive/PLAN-2026-08-07-retired.md`, Phase A.1).
- Existing primitives to build on, not reinvent: `factory/chain/red_green.py`
  (harness-owned red→green with the regression-only fallback),
  `check_can_fail` (attributable-red ablation), `factory/chain/acceptance.py`
  (spec-only early authoring, store outside the worktree),
  `factory/chain/gates/smoke_green.py` (the out-of-process pattern, 578 blocked
  merge evaluations).
- Design rule carried from the audit: a criterion set must force a positive
  observable outcome (a no-op can satisfy status codes and absences — vacuity,
  Beer et al. 2001); and an import/collection error at HEAD is non-authoritative
  whenever the environment rollback set is non-empty.

## Outcome (2026-08-07)

Closed. Implemented by an operator agent (loop 3 with subagents), **not the
chain** — eight PRs against the seven ACs above plus the paired P0 (manager
deletion, out of scope of this direction itself). Detail lives in
`STATUS.md`; this section is the pointer.

| AC | PR |
|---|---|
| Vacuity gate at triage | #248 |
| Gutted-implementation control run | #251 |
| Out-of-process verdict | #251 |
| Flag flip on sacrifice | #254 (prep: #253) |
| Dead chain code deleted | #249 |
| Idle becomes a ping | #252 |
| Detector→direction trigger, deduped on signature | #250 |
| (paired, out of scope) delete the four manager LLM tiers | #247 |

Two findings the adversarial review passes caught that the authors' own green
tests did not:

1. **The out-of-process oracle (#251) relocated the forgery instead of
   closing it.** Moving the verdict to a separate process closed the
   in-process attack the direction named, but the booted app still ran as
   the same uid and received `TMPDIR`, so its production code could plant a
   `conftest.py` in the oracle's own run directory or overwrite the oracle
   file — review reproduced both attacks end to end. Closed by run-directory
   tamper-evidence (oracle sha256 + exact expected file set, checked before
   junit is parsed) + `--noconftest` + dropping `TMPDIR` from
   `env_passthrough`. Four risks remain open (documented in the gate's module
   docstring, summarized in `STATUS.md`) — read them before any soak.
2. **The detector→direction trigger (#250) would have filed 48 unfixable
   directions in its first ~16 ticks** against real live state, before
   liveness/recency scoping fixed it. It ships disabled
   (`detector_watch.enabled: false`) pending a soak, not on by default.
