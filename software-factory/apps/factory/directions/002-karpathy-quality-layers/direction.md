---
title: Karpathy quality layers — runtime verifier, goal-spec, per-app workshop
type: feature
priority: p0
explore: false
created_at: 2026-06-13
related_directions: [001-factory-management-system]
---

# Karpathy quality layers — runtime verifier, goal-spec, per-app workshop

## Why

The factory shipped the entire sacrifice backlog (D007–D010, ~40 stories)
end-to-end, every gate green — and the product still could not log in, start a
goal, or submit proof without an operator hand-fixing it through Claude. The
chain certified "done" on software that did not run. That is not a model-quality
problem; it is a **verification-oracle** problem, and it is the dominant source
of the bad output we observed.

Andrej Karpathy's framing (AISN 2026) names three layers every effective
AI build loop needs. Auditing the factory against them shows exactly where the
quality leaks:

1. **The Spec.** We have directions → PM → architect → SM → stories, with a
   backpressure validator that requires a user-flow or API spec plus acceptance
   criteria. But there is **no goal-discovery step** (a direction is whatever a
   human wrote, goal assumed), **no precision check on the acceptance criteria**
   (a vague AC sails straight to dev), and **no human checkpoint** between
   "16 stories generated" and "16 stories built" — it is waterfall at the
   direction level.

2. **The Verifier.** The reviewer already runs on a *different model* from the
   dev (gpt-5.4 vs deepseek) — the "second critic" exists — plus a hard severity
   rubric, a deterministic slop detector, and tests-green/meaningful/lint/types
   gates. The fatal gap: **the app is never run.** `e2e_harness_ready: false`,
   and `backend/e2e_test.py` is explicitly "the operator's smoke gate, not the
   dev-loop gate." The dev writes both the code and the tests, and nothing
   executes the running product. There is no external signal — no boot, no
   browser, no deploy probe. This is the precise gap that let the login bug ship.

3. **The Environment.** The factory has excellent *self*-context (six auto-gen
   modules) and a hard dispatch enforcer. But **per app** the workshop is thin:
   sacrifice has no `CLAUDE.md`, no factory-side freshness gate on its context
   docs (agents rediscover the app every story), **no reusable skills** for the
   builds that recur across directions (023–029 are variations on the same
   shapes), and the dev's "forbidden paths" are a **prompt request**, not a
   tool-level block the model cannot cross.

Karpathy's thesis — *you can outsource thinking but not understanding* — is the
through-line: each layer is a mechanism for transferring the operator's
understanding into the loop and verifying the result against reality instead of
against the model's own assertions.

## Design principles

1. **Green must mean "the product runs."** No gate may certify "done" on
   software that has never been booted and exercised through a real user journey
   when the app opts into a runtime harness.
2. **Regression-safe rollout.** Required-gate changes must be per-app opt-in.
   A new required gate that every app must satisfy re-creates the PRs 110/111
   deadlock (all merges blocked). New gates default to skipped until an app
   declares the capability.
3. **Verification is the only real lever.** Prefer adding external signal
   (boot, probe, reference-diff) over adding more prompt instructions.
4. **Spec precision upstream beats review churn downstream.** Catch a vague goal
   or untestable AC before it becomes N stories, not after.
5. **The workshop compounds.** Knowledge and skills accrete per app; the 30th
   endpoint must not be built like the 1st.

## Phases

### P0 — Runtime verifier (closes the login-bug class) — IN PROGRESS

- **P0.1 `smoke-green` gate (config-guarded).** Add `smoke_command` +
  `smoke_harness_ready` to `AppGatesConfig`. New gate
  `factory/chain/gates/smoke_green.py` that **skips (passes) when not
  configured**, runs the command in real-run, and reads a recorded flag in
  dry-run. Make the merge-required set **per-app computed**
  (`required_gate_labels(app_config)`) instead of the static
  `LOOP4_REQUIRED_GATE_LABELS`, appending `smoke-green` only when
  `smoke_harness_ready` is true. Wire into `evaluate_all_gates` + `auto_merge`.
- **P0.2 App-side smoke harness (sacrifice repo). DONE (journey) / FOLLOW-UP
  (worktree boot).** Shipped `scripts/smoke_journey.py` (stdlib HTTP:
  register → login → create → activate → submit-proof, offline/deterministic —
  the api_endpoint goal points at the backend's own `/api/health`, no
  Celery/LLM/network), `scripts/smoke.sh` (reuse-or-boot, isolation-safe), and
  a `make smoke` target. Validated green in reuse mode against the live backend.
  `smoke_command: "make smoke"` wired in `apps/sacrifice/config.yaml`.
  Findings surfaced while building it: (a) `create goal` accepts an invalid
  `goal_type` that `submit-proof` later rejects (data-integrity gap); (b) there
  is **no `backend/Dockerfile`** — the compose backend service can't build, the
  backend is host-run; (c) the dev-loop `test_command` `--ignore`s the auth /
  email-auth / api-verification unit tests, so nothing was verifying the broken
  flows. **`smoke_harness_ready` left FALSE**: the gate must boot the PR's own
  code in the per-story worktree on an isolated port before it can be trusted —
  today `make smoke` reuses whatever backend is on :8000 (the operator's
  checkout), which would false-green a PR. Flipping it true is the follow-up:
  worktree-local backend boot (backend Dockerfile, or venv-bootstrap +
  per-worktree port).
  **Flag-flip prerequisites (2026-07-06 audit):** (1) nothing writes
  `StoryRecord.smoke_passed` yet — `handle_dev` must run the smoke in the
  sandbox and record the result, else the dry-run gate blocks every merge for
  an opted-in app; (2) the auto-merge worker constructs `FixturePR` with
  `repo_root=None` in both production paths, so the gate's real-run boot
  branch is unreachable — plumb the local checkout through; (3) an end-to-end
  test must drive `auto_merge_tick` with an opted-in app (the current tests
  cover the gate only in isolation).
- **P0.3 Adversarial refute-critic.** A critic pass whose only job is to refute
  ("assume this is broken; find the user path the tests miss"), distinct from
  the approving reviewer.
- **P0.4 Deploy probe.** When `deploy.enabled`, a post-deploy health/journey
  probe recorded as a gate, so "deployed" is verified, not assumed.

### P1 — Goal-spec (stops bad specs entering)

- **P1.1 Goal-discovery persona.** Interviews a thin direction for the decision
  it serves, the user at the moment of use, and what "done" feels like; enriches
  or kicks back. Generalizes the sacrifice `direction_synth` pattern into core.
- **P1.2 AC-precision gate.** Backpressure validator checks each AC is
  observable and testable; rejects "looks good," requires measurable criteria.
- **P1.3 Agile first-slice checkpoint.** For non-trivial directions, ship the
  riskiest 1–2 vertical slices, surface them on the running app (P0), and gate
  the remaining fan-out on operator confirmation.

### P2 — Per-app workshop (compounds quality)

- **P2.1 Per-app `CLAUDE.md`** + freshness-gated onboarder context (stale →
  regenerate) instead of write-once-and-rot.
- **P2.2 Reusable skills** for recurring builds (add goal type, add
  authenticated route, add proof-capture affordance).
- **P2.3 Tool-level guardrails.** Promote critical forbidden-path rules from the
  dev prompt to a pre-tool-use hook that blocks the Edit/Write at the tool level;
  bucket all guardrails into always-do / ask-first / never-do.

## Acceptance Criteria

- [ ] `AppGatesConfig` has `smoke_command` and `smoke_harness_ready`; both
      optional and default to skip/false.
- [ ] `smoke_green.evaluate` passes when no harness configured, reflects the
      command result in real-run, and reads the recorded flag in dry-run.
- [ ] Merge-required gate set is computed per-app; `smoke-green` is required
      only when `smoke_harness_ready` is true; apps without it are unaffected
      (no new merge blocks).
- [ ] `evaluate_all_gates` runs the smoke gate; `auto_merge` enforces the
      computed required set.
- [ ] Unit tests cover: skip-when-unconfigured, real-run pass/fail, dry-run
      flag, and required-set computation for both opt-in and opt-out apps.
- [ ] P1/P2 items captured as child stories with their own acceptance criteria.
