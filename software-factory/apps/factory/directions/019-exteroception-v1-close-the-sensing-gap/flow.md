# Flows — Exteroception v1

Four flows. A and B are the sensor layer; C and D replace the deleted
goal-manufacturing loop.

## Flow A — direction triage with the vacuity gate

1. Operator writes `apps/<app>/directions/NNN-slug/direction.md` with acceptance
   criteria.
2. `factory pm-sync --app <app>` runs. Before the PM persona is called, the
   vacuity check classifies each parsed criterion:
   - `positive-observable` — names an outcome a user/client could observe at the
     system boundary ("an email arrives containing a link that opens a working
     reset form", "GET /goals/{id} returns the created goal with status
     'active'").
   - `vacuous-satisfiable` — a fixed-response no-op handler could satisfy it
     (bare status-code assertions: "returns 202"; pure absences: "does not leak
     the token"; "no error is raised").
3. If **zero** criteria classify `positive-observable`, the direction goes to
   `needs-direction`; `state.yaml.missing[]` gains `vacuous_criteria`, and the
   tracker comment names each vacuous criterion and shows one rewritten example.
4. If at least one criterion is `positive-observable`, triage proceeds
   unchanged. Vacuous criteria are still listed as warnings in the tracker
   comment.
5. Rollout: the classifier first runs read-only over the 45 held-out
   pm-validated sacrifice directions; the flag rate is recorded in the story's
   PR description before the gate is made blocking.

## Flow B — story verification through the out-of-process oracle

1. Story spawn (unchanged): the acceptance oracle is authored from the
   direction's ACs + `flow.md`/`api_spec.md` only, before dev dispatch, stored
   outside the factory root and outside the dev worktree
   (`StoryRecord.acceptance_test_ref`).
2. Dev works to green on its own tests (unchanged).
3. At merge time, `acceptance_verified` (still ordered **last**) computes its
   verdict out of process:
   a. Build a throwaway judge worktree: production code from HEAD, test surface
      from BASE, `[tool.pytest.*]` tables spliced per the A.1c rules.
   b. **Boot the app** from that worktree on an ephemeral port with an isolated
      database (the `smoke_green`/`scripts/smoke.sh` pattern; for sacrifice:
      uvicorn + the `sacrifice-db` container, which must be up or the gate
      blocks with `environment_unavailable`, never credits).
   c. Run the oracle's journeys **from a separate process over HTTP** against
      that instance. The oracle process never imports the diff's production
      code, so reassigning pytest internals inside the app cannot forge a
      verdict.
   d. Red-at-base check (existing `red_green.py` semantics): the same journey
      must fail against a boot of the merge base. Errors-only at base ⇒
      `unknown` ⇒ fall through to the ablation check (`check_can_fail`), never
      authoritative red.
   e. **Gutted-implementation control:** run the journey against a stubbed
      no-op of the story's surface (fixed 2xx responder mounted at the routes
      the story touches). A criterion that passes the stub is excluded; if
      every criterion passes the stub, the gate blocks with
      `vacuous_oracle`.
   f. Credit only: red at base ∧ green at HEAD ∧ at least one criterion failed
      the stub. Anything unreadable falls back to regression-only selection —
      never to approve.
4. Failure surfaces: every blocked outcome appears in `factory inbox` with the
   named reason (`environment_unavailable`, `vacuous_oracle`,
   `authoring_exhausted`, …); `factory acceptance-waive` remains the recorded
   operator override.
5. Flip prerequisites (from the retired plan, still true): sacrifice only;
   `hypothesis` added to sacrifice's backend dev extra first (EARS-form
   criteria fail collection without it); never `template-probe` (TypeScript app,
   pytest-only oracle).

## Flow C — idle becomes a ping

1. A tick finds an app with zero dispatchable stories and zero live human-filed
   directions.
2. The factory writes one `operator_ping` inbox entry for that app —
   deduplicated per idle episode (a new ping only after work happened since the
   last one). `factory inbox` shows: app, idle-since, last delivered unit.
3. No machine-authored direction is filed. The scanners that used to
   manufacture work here are deleted.
4. Operator responds by filing a direction (Flow A) or ignoring; the ping does
   not repeat until the factory has been non-idle in between.

## Flow D — detector→direction, deduped on signature

1. A registered detector (pure Python, `factory/manager/detectors/`) fires
   during a tick with a stable signature (detector name + normalized subject,
   e.g. `review_churn:story-142`).
2. The chain checks for a live direction carrying that signature. If one
   exists: no-op (this is what kills the 33×-re-file class and the manager's
   78% redundancy).
3. If none exists: file one machine direction whose body names the detector,
   the signature, and the firing evidence. Its acceptance criterion is built
   in: **the detector no longer fires on the same subject** — independently
   authored (the detector predates the fault), out-of-process, and impossible
   to satisfy with a no-op.
4. The direction enters the normal operator-approval gate for machine-filed
   directions (`factory approve-direction`) — spend on self-improvement stays
   operator-ratified.
