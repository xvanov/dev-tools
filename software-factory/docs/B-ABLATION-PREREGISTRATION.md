# Workstream B — oracle-author information-budget ablation: PRE-REGISTRATION

**Status: PRE-REGISTERED, NOT RUN — deferred 2026-08-09 with reason (below).**
Written before any data exists, per the plan's requirement and the
`ablation_gate_dormant_and_broken` / `bench_artifacts_overwritten_2026_08_02`
lessons. Do not edit the arms or metrics after the first run starts; a change
means a NEW pre-registration file, never an edit here.

## Question

Does giving the dev-blind acceptance author more API-surface information
reduce false blocks without increasing the false-green (waiver) rate?

## Arms (same stories, same models, k repeats, pre-declared)

1. **criteria-only** — no `acceptance_harness_hint`. NOTE: this mode has
   NEVER run in production (the hint is always supplied today); it is a new
   condition, not a baseline.
2. **prose hint** — today's ACTUAL behaviour. **This is the control.** Every
   comparison is reported against this arm. CONFOUND, stated before any run:
   today's author ALSO receives the direction's `api_spec.md` verbatim, and
   since factory PR #269 that file is written by the contract persona from a
   PARSED route table — so arm 2 is already partially derived-surface-informed
   for any direction with a contract-written api_spec. Arm comparisons must
   report whether each story's direction carried one.
3. **derived base surface** — the author additionally receives the routes the
   direction's api_spec names (plus auth) from a surface derived at the BASE
   commit (`scripts/generate_sacrifice_api_surface.py` mechanism).
4. *(optional)* **HEAD surface** — expected to demonstrate the false-green
   risk that justifies deriving at base.

## Metrics (all four, pre-declared; no post-hoc additions)

- **false-block rate**: correct implementation rejected by the gate.
- **false-green rate**: gutted implementation accepted (the stub control
  measures this).
- **waiver / `oracle_not_discriminating` rate per arm** — THE risk metric.
  More base information can produce oracles that MIRROR the base contract,
  which land green-at-base → waivable → `_unverifiable` returns passed=True.
  **Threshold, pre-registered: if arm 3's waiver rate exceeds arm 2's, A1's
  richer feeding is rejected regardless of the false-block numbers.**
- authoring cost (USD) and time-to-merge per story.

Supporting diagnostics (advisory, shipped 2026-08-09): per-evaluation
`run_ids.json`, `details["base_failures_matching_stub"]` (A2),
`details["head_setup_failures"]` (A3).

## Procedure constraints

- Archive artifacts per run under a timestamped directory; NEVER re-run a
  sweep into an existing artifact directory (a re-run destroys
  published-number artifacts — happened 2026-08-02).
- `bench/**` is operator-PR-only; the harness change implementing arm
  selection lands as an operator PR referencing this file.
- Expected outcome to beat: arm 3 ≥ arm 2 on false-block with no waiver-rate
  regression. If arm 3 does not beat arm 2, STOP and report that — do not
  ship richer feeding on faith.

## Why the run is DEFERRED (2026-08-09)

Arm 3 requires feeding the derived surface to the author, and the plan itself
gates that on preconditions that are deliberately not yet built (A1 shipped
only the CI cross-check): base-sha verification with a named gate block on
mismatch, refusal to re-derive on `force=True` re-authoring, and a
`_unverifiable` path back for the "expected but no oracle" branch. Running
the ablation before arm 3 can exist would compare arm 2 against nothing.
Deferral is the honest state; the benchmark-readiness definition-of-done item
4 is therefore NOT met in this pass, and the final readiness report says so
plainly.
